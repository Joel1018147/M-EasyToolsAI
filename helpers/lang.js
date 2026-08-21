/* ═══════════════════════════════════════════════════════════════════════════
   LANGUAGE — the three codes, and text metrics that survive leaving English
   ───────────────────────────────────────────────────────────────────────────
   Shared by the trilingual generation layer and the image lane. One place
   knows what 'ms' means and how to count a Chinese word.

   ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
   Recurring-bugs class #7: CJK text broken by a whitespace/\b word boundary.
   It was live in this repo before this round. generateWithGroq() scored every
   document with:

       text.split(/\s+/).filter(Boolean).length

   Chinese does not put spaces between words, so a 2,000-character Chinese
   article counted as ONE word. Measured, not assumed:

       ZH  chars=59   wordCount=1    sentences=1   readability=100
       EN  chars=170  wordCount=24   sentences=3   readability=30
       BM  chars=150  wordCount=19   sentences=2   readability=30

   The consequences were not cosmetic. documents.word_count stored 1. The SEO
   gate `wordCount >= 300 ? 25 : Math.floor(wordCount/12)` awarded ZERO to
   every Chinese document however long. And the Flesch formula — which is
   defined over English syllables — returned a flattering 100 for the one
   language it cannot describe at all.

   Shipping Chinese generation on top of that scorer would have told every
   Chinese-writing customer their best work was worthless.

   ── HOW WORDS ARE COUNTED NOW ─────────────────────────────────────────────
   Intl.Segmenter, which is in Node 20 and uses ICU's real per-language word
   dictionaries. It is not a regex over character ranges: for Chinese it does
   dictionary segmentation, so 人工智能 is two words rather than four
   characters or one blob.

   ICU's Chinese dictionary is imperfect — it splits 马来西亚 into 马来 + 西亚.
   That is a real limitation and it is recorded here rather than hidden,
   because a number that is approximately right is a completely different
   object from a number that is 1. The alternative is a segmentation
   dependency, and the Engineering Bar's preference for lean equivalents plus
   the fact that nothing downstream needs better than ±10% says no.

   FALLBACK, AND WHY IT IS NOT SILENT: a Node built with small-icu has
   Intl.Segmenter but only English data, and would silently return 1 again for
   Chinese — the exact bug, wearing the fix's clothes. So the fallback is
   detected at load by segmenting a known Chinese string and checking the
   answer is plural, and every metric carries the basis it was computed with.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/** The three languages this ecosystem ships. Order is display order. */
const LANGS = ['en', 'ms', 'zh'];

const LANG_LABELS = { en: 'English', ms: 'Bahasa Malaysia', zh: '中文' };
const LANG_SHORT = { en: 'EN', ms: 'BM', zh: '中文' };

/** BCP-47 tags for the html lang attribute and Intl. zh is Simplified. */
const LANG_TAGS = { en: 'en', ms: 'ms', zh: 'zh-Hans' };

/**
 * Anything unrecognised becomes null, never a default.
 *
 * A silent fallback to English is how a Chinese request comes back in English
 * and nobody can tell whether the model ignored the instruction or the code
 * dropped it. Callers decide what to do with null; this function does not
 * decide for them.
 */
function normaliseLang(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (LANGS.includes(v)) return v;
  // Accept the common BCP-47 spellings that reach us from Accept-Language
  // and from the i18n layer, but nothing looser than a real prefix match.
  if (v === 'zh-hans' || v === 'zh-cn' || v === 'zh-sg' || v.startsWith('zh-')) return 'zh';
  if (v === 'ms-my' || v.startsWith('ms-')) return 'ms';
  if (v === 'en-my' || v.startsWith('en-')) return 'en';
  return null;
}

/* ── Script detection ──────────────────────────────────────────────────────
   Used to answer "did the model actually answer in the language it was
   asked for", which is a check M-EasyMember's copywriter does not do and
   which this platform's Localization Bar requires. */

const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/;
const HAN_GLOBAL_RE = /[㐀-䶿一-鿿豈-﫿]/g;

/* Malay function words. Deliberately words that are common in Malay AND rare
   in English, so an English text does not trip this. 'dan' and 'atau' carry
   most of the signal; the rest raise confidence on short strings.
   \b is safe here — Malay is Latin-script and space-separated. */
const MALAY_WORDS = [
  'dan', 'atau', 'yang', 'untuk', 'dengan', 'daripada', 'kepada', 'ini', 'itu',
  'anda', 'kami', 'kita', 'akan', 'boleh', 'tidak', 'adalah', 'dalam', 'pada',
  'perniagaan', 'pelanggan', 'jenama', 'kandungan', 'percuma', 'sekarang',
];
const MALAY_RE = new RegExp('\\b(' + MALAY_WORDS.join('|') + ')\\b', 'i');

/** Proportion of the string that is Han characters, 0..1. */
function hanRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  const han = (s.match(HAN_GLOBAL_RE) || []).length;
  // Measured against non-whitespace, so trailing layout does not dilute it.
  const solid = s.replace(/\s+/g, '').length || 1;
  return han / solid;
}

/**
 * Best-effort language of a piece of text.
 *
 * Han script is decisive — no amount of Latin text makes a Han-bearing string
 * English, because mixed Chinese copy routinely carries brand names and "RM".
 * Otherwise it is a lexical test for Malay, then English as the residual.
 */
function detectLang(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  if (HAN_RE.test(s) && hanRatio(s) >= 0.10) return 'zh';
  if (MALAY_RE.test(s)) return 'ms';
  return 'en';
}

/* ── Segmentation ──────────────────────────────────────────────────────────*/

const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

/* One line per distinct problem per process. A degraded segmenter would
   otherwise print on every generation and be scrolled past, which is the same
   as not printing at all. */
const _warned = new Set();
function warnOnce(key, message) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn('helpers/lang.js: ' + message);
}

/* Does this runtime's ICU actually carry Chinese word data, or is it
   small-icu pretending? Segment a string whose correct answer is "several"
   and check we did not get back "one". Computed once, at load. */
const SEGMENTER_HAS_CJK = (() => {
  if (!HAS_SEGMENTER) return false;
  try {
    const probe = '人工智能正在改变营销方式';
    const n = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(probe)]
      .filter((s) => s.isWordLike).length;
    if (n < 3) {
      warnOnce('icu-small', 'this Node has Intl.Segmenter but no Chinese word data ' +
        '(small-icu). Chinese word counts will be estimates, not segmentation.');
      return false;
    }
    return true;
  } catch (err) {
    // false is a real answer here — it means "no CJK segmentation available" —
    // but the reason is worth one line, because the symptom downstream is
    // merely a slightly different number and nobody would trace it back.
    warnOnce('icu-probe', 'Intl.Segmenter probe threw (' + err.message +
      ') — treating this runtime as having no CJK segmentation');
    return false;
  }
})();

/**
 * The word-like segments of a Latin-script string, as strings.
 *
 * Exists so that anything computing a PER-WORD average counts the same words
 * countWords() counted. A metric whose numerator and denominator disagree
 * about what a word is produces a number that is not wrong by a little.
 *
 * Not used for Han text — countWords() estimates there rather than listing.
 */
function wordList(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  if (HAS_SEGMENTER) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'word' });
      const out = [];
      for (const part of seg.segment(s)) if (part.isWordLike) out.push(part.segment);
      return out;
    } catch (err) {
      warnOnce('segmenter-list', 'Intl.Segmenter word listing failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to a whitespace split');
    }
  }
  // Whitespace tokens that actually contain a letter or digit. Bare "-" and
  // "##" are not words and must not enter a per-word average.
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/**
 * Word count that means the same thing in all three languages.
 *
 * @returns {{count: number, basis: string}} basis names the method, so a
 *   caller can report how a number was reached instead of implying precision
 *   it does not have.
 */
function countWords(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return { count: 0, basis: 'empty' };
  const l = normaliseLang(lang) || detectLang(s) || 'en';

  if (HAS_SEGMENTER && (l !== 'zh' || SEGMENTER_HAS_CJK)) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'word' });
      let n = 0;
      for (const part of seg.segment(s)) if (part.isWordLike) n++;
      return { count: n, basis: 'intl-segmenter:' + LANG_TAGS[l] };
    } catch (err) {
      // RULE 6: not swallowed. The estimate below is a real answer, but it is
      // a WORSE one, so the caller is told which it got — `basis` carries the
      // degradation into every metrics payload and into the reports built on
      // them. Logged once per process so a broken ICU is visible in the
      // Railway log rather than inferred later from odd word counts.
      warnOnce('segmenter-word', 'Intl.Segmenter word segmentation failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to an estimate');
    }
  }

  // Fallback. For Han text, count Han characters and divide by the mean
  // characters-per-word for modern written Chinese (~1.5), then add any
  // Latin-script words present. Approximate and LABELLED as approximate —
  // what it must never do is return 1 for a whole article.
  const han = (s.match(HAN_GLOBAL_RE) || []).length;
  // Same "contains a letter or digit" rule wordList() uses, so the fallback
  // path cannot disagree with the fallback list about what a word is.
  const latin = s.replace(HAN_GLOBAL_RE, ' ').split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (han > 0) {
    return { count: Math.round(han / 1.5) + latin, basis: 'han-char-estimate' };
  }
  return { count: latin, basis: 'whitespace' };
}

/**
 * Sentence count. The point of using Segmenter here rather than /[.!?]+/ is
 * that Chinese ends sentences with 。！？ and Malay abbreviations carry dots
 * that are not sentence ends.
 */
function countSentences(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  if (HAS_SEGMENTER) {
    try {
      const seg = new Intl.Segmenter(LANG_TAGS[l], { granularity: 'sentence' });
      let n = 0;
      for (const part of seg.segment(s)) if (part.segment.trim()) n++;
      if (n > 0) return n;
    } catch (err) {
      // RULE 6, as above. The regex below is a genuine fallback and it does
      // include the full-width terminators, so it is not silently wrong for
      // Chinese — but it is coarser, and a failure here is worth seeing.
      warnOnce('segmenter-sentence', 'Intl.Segmenter sentence segmentation failed for ' +
        LANG_TAGS[l] + ' (' + err.message + ') — falling back to a terminator split');
    }
  }
  // Full-width terminators included, or every Chinese text is one sentence.
  const n = s.split(/[.!?。！？…]+/).filter((x) => x.trim()).length;
  return n || 1;
}

/**
 * Syllables in one English word.
 *
 * Flesch is 84.6 × (syllables / words), so every syllable the counter invents
 * costs the score about twelve points. Two counters were tried and both
 * over-counted the same way:
 *
 *   vowel LETTERS  "generates" → e,e,a,e            = 4   (it is 3)
 *   vowel GROUPS   "generates" → e,e,a,e            = 4   (it is 3)
 *                  "queueing"  → ueuei              = 1   (it is 3)
 *
 * Three syllables of error over an eight-word sentence moved
 * "The platform generates marketing content for small businesses." from its
 * textbook ~30 to 8 — the reading difficulty of a tax statute, for a sentence
 * a child could read. The old code hid that behind a floor of 30; removing the
 * floor is what made it visible.
 *
 * So: drop the silent terminal -e / -es, then chunk vowels in ones and twos
 * rather than in unbounded runs. This is the standard textbook heuristic. It
 * is still an estimate — "business" is two syllables in speech and three here
 * — but it is an estimate that agrees with a dictionary on ordinary marketing
 * prose, which the previous two did not. (Lane C.)
 */
function syllablesEn(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/**
 * Readability.
 *
 * THIS FUNCTION IS ALLOWED TO SAY IT DOES NOT KNOW, and that is the point.
 * Flesch Reading Ease is defined over English syllables and validated on
 * English prose. Applying it to Chinese produced a serene 100 for text it
 * cannot parse at all — a number that was not merely wrong but confidently
 * wrong in the flattering direction.
 *
 * - en: real Flesch, with a vowel-group syllable count.
 * - ms: NOT Flesch. Malay orthography is near-phonemic and its syllable
 *       structure differs enough that Flesch's constants do not transfer;
 *       reporting one would be borrowing English's authority for a number
 *       nobody validated. Mean words-per-sentence, mapped to 0..100.
 * - zh: mean characters-per-sentence, mapped to 0..100. Chinese readability
 *       research uses character and stroke counts, not syllables.
 *
 * @returns {{score: number|null, basis: string}}
 */
function readability(text, lang) {
  const s = String(text || '');
  if (!s.trim()) return { score: null, basis: 'empty' };
  const l = normaliseLang(lang) || detectLang(s) || 'en';
  const sentences = countSentences(s, l) || 1;

  /* No words, no readability. "... !!! ???" has a length and a sentence count
     and nothing to read, and every formula below divides by a word count. The
     old code returned 100 for it — the flattering-wrong direction that §0.7 is
     about — so this says so instead. (Lane C, found by wiring these metrics
     into scoreContent() and reading the corpus output.) */
  const wordsHere = countWords(s, l).count;
  if (wordsHere === 0) return { score: null, basis: l + '-no-words' };

  if (l === 'zh') {
    const han = (s.match(HAN_GLOBAL_RE) || []).length;
    const perSentence = han / sentences;
    // Anchors: 15 Han chars per sentence is short and plain, 55 is the dense
    // officialese register. Calibrated so ORDINARY marketing copy lands in the
    // 70s-80s rather than pinned at 100 — a scale whose normal case is the
    // ceiling cannot tell good from adequate, which is the only comparison
    // anyone actually uses it for.
    const score = clamp(Math.round(100 - ((perSentence - 15) / 40) * 100), 0, 100);
    return { score, basis: 'zh-chars-per-sentence' };
  }

  const words = wordsHere;
  const wps = words / sentences;

  if (l === 'ms') {
    // Anchors: 8 words per sentence is plain Malay, 30 is the formal register
    // of a government circular. Same calibration reasoning as zh above.
    const score = clamp(Math.round(100 - ((wps - 8) / 22) * 100), 0, 100);
    return { score, basis: 'ms-words-per-sentence' };
  }

  /* English: Flesch Reading Ease.
     Syllables by vowel GROUPS, not by vowel letters — the previous code
     counted every vowel character, so "queueing" scored 6.

     THE NUMERATOR AND THE DENOMINATOR MUST COUNT THE SAME WORDS. This used to
     sum syllables over `s.split(/\s+/)` while dividing by the SEGMENTER's word
     count, so every whitespace token that is not a word — a markdown "-", a
     bare "##" — added a syllable to a denominator that had never counted it.
     "- one\n- two\n- three" came out at 7 syllables over 3 words and scored 8
     out of 100, which is roughly the reading difficulty of a tax statute.
     Counting both over the same word list fixes it; it scores 93.
     (Lane C, found by wiring these metrics into scoreContent().) */
  const syllables = wordList(s, l).reduce((acc, w) => acc + syllablesEn(w), 0);
  const score = clamp(
    Math.round(206.835 - 1.015 * wps - 84.6 * (syllables / (words || 1))),
    0,
    100
  );
  return { score, basis: 'flesch-en' };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/**
 * Everything a caller needs about a piece of generated text, in one shape.
 * `basis` fields travel with the numbers so a report can say how it counted.
 */
function textMetrics(text, lang) {
  const s = String(text || '');
  const l = normaliseLang(lang) || detectLang(s);
  const w = countWords(s, l);
  const sentences = countSentences(s, l);
  const r = readability(s, l);
  return {
    lang: l,
    chars: s.length,
    charsNoSpace: s.replace(/\s+/g, '').length,
    words: w.count,
    wordBasis: w.basis,
    sentences,
    readability: r.score,
    readabilityBasis: r.basis,
    hanRatio: Number(hanRatio(s).toFixed(3)),
  };
}

/**
 * Did the model answer in the language it was told to use?
 *
 * The Localization Bar requires this because the reference implementation it
 * benchmarks against does not do it: M-EasyMember asks for Bahasa Malaysia
 * and ships whatever comes back, so a model that silently answered in English
 * is indistinguishable from one that complied.
 *
 * Deliberately tolerant of the mixed reality of Malaysian copy — a Chinese ad
 * carries "RM", a brand name and often an English CTA — so this asks whether
 * the text is *predominantly* right, not whether it is pure.
 */
function looksLikeLang(text, lang) {
  const want = normaliseLang(lang);
  const s = String(text || '');
  if (!want || !s.trim()) return { ok: false, detected: null, reason: 'empty' };

  const ratio = hanRatio(s);
  const detected = detectLang(s);

  if (want === 'zh') {
    if (ratio >= 0.30) return { ok: true, detected: 'zh', hanRatio: ratio };
    return { ok: false, detected, hanRatio: ratio, reason: 'too little Han script for Chinese output' };
  }
  if (ratio >= 0.15) {
    return { ok: false, detected: 'zh', hanRatio: ratio, reason: 'Han script in non-Chinese output' };
  }
  if (want === 'ms') {
    if (MALAY_RE.test(s)) return { ok: true, detected: 'ms', hanRatio: ratio };
    return { ok: false, detected, hanRatio: ratio, reason: 'no Malay function words found' };
  }
  // English: the residual. Refuse only on positive evidence of another
  // language, because English shares too much surface with everything.
  if (MALAY_RE.test(s) && !/\b(the|and|you|your|we|is|are|to|of)\b/i.test(s)) {
    return { ok: false, detected: 'ms', hanRatio: ratio, reason: 'reads as Malay, not English' };
  }
  return { ok: true, detected: 'en', hanRatio: ratio };
}

module.exports = {
  LANGS,
  LANG_LABELS,
  LANG_SHORT,
  LANG_TAGS,
  normaliseLang,
  detectLang,
  hanRatio,
  wordList,
  countWords,
  syllablesEn,
  countSentences,
  readability,
  textMetrics,
  looksLikeLang,
  // Exported so a diagnostic surface can report the runtime's real capability
  // rather than assuming it. See the header on small-icu.
  SEGMENTER_HAS_CJK,
};

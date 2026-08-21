/* ═══════════════════════════════════════════════════════════════════════════
   LANE C — trilingual generation (Localization Bar §L)
   ───────────────────────────────────────────────────────────────────────────
   No database and no Groq key are available to this suite, so the Groq wire
   call is stubbed and the pool is a spy. What is NOT stubbed is anything the
   lane actually wrote: the metrics, the language resolution, the prompts, the
   verification, and the contract.

   ── THE SIX THINGS THE LANE BRIEF REQUIRES, AND WHERE THEY ARE ────────────
     §1  the CJK metrics are correct
     §2  language codes normalise
     §3  an unknown language does NOT silently become English
     §4  looksLikeLang() catches wrong-language output
     §5  the prompt actually carries language instruction — and carries MORE
         of it than the benchmark, which is what §L asks for
     §6  the generateWithGroq() signature and return contract are preserved

   plus §7 (what happens when verification fails), §8 (the prompt channel
   genlang.js uses), and §9 (the cross-lane contract genlang.js owes Lane E).

   ── WHY THE BENCHMARK IS READ OUT OF GAUNTLET.md ──────────────────────────
   §L's reference is M-EasyMember-AI's Campaign AI+. Reaching into a sibling
   repo from a test would make this suite fail on any machine that does not
   have that repo checked out beside this one — and GAUNTLET-CORE's repo
   boundary says read those, never depend on them. GAUNTLET.md §L quotes the
   reference's LANG_INSTRUCTIONS verbatim for exactly this reason, so the
   comparison below parses them out of that document. If the quote cannot be
   located, this suite STOPS rather than skipping the comparison — a benchmark
   that silently evaporates is worse than no benchmark.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.log('  ✗ ' + m); };
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 66 - m.length)));

console.log('\ntrilingual — EN / BM / ZH generation, metrics and contract\n');

/* ── the stub, installed BEFORE helpers/generation.js is required ──────────
   generation.js destructures `chat` out of helpers/groq at load, so a patch
   applied afterwards would never be seen. Patching the cached module's
   exports first is the only ordering that works, and getting it wrong would
   produce a suite that silently made real network calls. */
const groqPath = require.resolve('../helpers/groq');
require(groqPath);

const calls = [];
let scripted = [];
require.cache[groqPath].exports.chat = async function stubChat(args) {
  calls.push(args);
  if (!scripted.length) {
    throw new Error('stub chat(): called ' + calls.length + ' time(s) but only ' +
      'a shorter script was set up — the test is not describing what the code does');
  }
  return { text: scripted.shift(), model: 'stub/model', raw: {} };
};

const gen = require('../helpers/generation');
const lang = require('../helpers/lang');

/* Prove the stub really is in the loop before anything is concluded from it. */
{
  const wired = require('../helpers/groq').chat.name === 'stubChat';
  if (wired) pass('the Groq stub is installed (no network call can happen in this suite)');
  else {
    fail('the Groq stub is NOT installed — every result below would be meaningless');
    process.exit(1);
  }
}

const inserts = [];
const pool = {
  query: async (sql, params) => {
    inserts.push({ sql, params });
    return { rows: [{ id: 4242 }] };
  },
};
const { generateWithGroq } = gen.createGenerator({ pool, groqKey: 'stub-key' });
const USER = { id: 7, groq_key: null, brand_desc: 'Kopitiam chain in Penang' };

async function main() {

function reset(...responses) {
  calls.length = 0;
  inserts.length = 0;
  scripted = responses;
}

/* Sample outputs in each language, used as the model's scripted answers. */
const OUT = {
  en: 'Fresh kopi, every morning. Visit our Penang kopitiam today and enjoy RM5 off your first order. Bring a friend and the second cup is on us.',
  ms: 'Kopi segar setiap pagi. Kunjungi kedai kopi kami di Pulau Pinang hari ini dan nikmati diskaun RM5 untuk pesanan pertama anda. Bawa rakan dan cawan kedua adalah percuma.',
  zh: '每天早晨，新鲜香浓的咖啡等着您。今天就到我们槟城的咖啡店坐坐，首次消费即可享有 RM5 折扣。带上朋友，第二杯由我们请客。',
};

/* ══ §1 — the CJK metrics are correct ═══════════════════════════════════════*/
head('§1  CJK metrics (UPGRADE-SPEC §0.7)');
{
  const article = ('人工智能正在改变马来西亚中小企业的营销方式。').repeat(40);
  const s = gen.scoreContent(article);

  if (s.wordCount > 100) pass('a ' + article.length + '-char Chinese article counts ' + s.wordCount + ' words, not 1');
  else fail('Chinese word count is ' + s.wordCount + ' — §0.7 is not closed');

  if (s.seoScore > 40) pass('its SEO score is ' + s.seoScore + ', above the floor of 40');
  else fail('its SEO score is still the floor (' + s.seoScore + ') — the length gate awards it nothing');

  if (s.readability !== 100) pass('its readability is ' + s.readability + ' via ' + s.readabilityBasis + ', not a flattering 100');
  else fail('readability is 100 again — English Flesch is being applied to Chinese');

  if (s.readabilityBasis === 'zh-chars-per-sentence') pass('and it says which method it used');
  else fail('readabilityBasis is ' + JSON.stringify(s.readabilityBasis) + ' for Chinese');

  // Length has to move the number. A metric that returns the same answer for
  // 44 characters and 880 is not measuring the text (recurring-bugs #14).
  const short = gen.scoreContent('人工智能正在改变马来西亚中小企业的营销方式。');
  if (short.wordCount > 1 && short.wordCount < s.wordCount) {
    pass('and it scales with length: ' + short.wordCount + ' words for one sentence, ' +
         s.wordCount + ' for forty');
  } else {
    fail('the Chinese word count does not scale with length (' + short.wordCount +
         ' vs ' + s.wordCount + ') — it is not measuring the text');
  }

  // Malay must not be scored with a formula defined over English syllables.
  const bm = gen.scoreContent('Platform kami membantu perniagaan anda menjana kandungan pemasaran dengan pantas.');
  if (bm.readabilityBasis === 'ms-words-per-sentence') pass('Malay is scored on a Malay scale (' + bm.readabilityBasis + '), not Flesch');
  else fail('Malay readability basis is ' + JSON.stringify(bm.readabilityBasis));

  // English still gets real Flesch.
  const en = gen.scoreContent('The platform generates marketing content for small businesses.');
  if (en.readabilityBasis === 'flesch-en') pass('English still gets Flesch (' + en.readabilityBasis + ')');
  else fail('English readability basis is ' + JSON.stringify(en.readabilityBasis));
}

/* ══ §2 — language codes normalise ══════════════════════════════════════════*/
head('§2  language codes normalise');
{
  const cases = [
    ['en', 'en'], ['EN', 'en'], [' en ', 'en'], ['en-MY', 'en'], ['en-US', 'en'],
    ['ms', 'ms'], ['MS', 'ms'], ['ms-MY', 'ms'],
    ['zh', 'zh'], ['ZH', 'zh'], ['zh-Hans', 'zh'], ['zh-CN', 'zh'], ['zh-SG', 'zh'],
  ];
  const bad = cases.filter(([input, want]) => lang.normaliseLang(input) !== want);
  if (!bad.length) pass('all ' + cases.length + ' accepted spellings normalise: ' + cases.map((c) => c[0]).join(', '));
  else fail('these did not normalise as expected: ' +
    bad.map(([i, w]) => JSON.stringify(i) + '→' + JSON.stringify(lang.normaliseLang(i)) + ' (wanted ' + w + ')').join(', '));
}

  /* zh-Hant is NOT zh. This platform ships Simplified only — §L's register is
     简体中文 for Malaysian Chinese readers — so collapsing a Traditional
     request onto the Simplified pipeline answers a question nobody asked and
     never mentions that it did. Refusing is the only non-silent option, and it
     lands in §3's refusal path. Found by the blind critic running the model. */
  {
    const traditional = ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW', 'zh-yue'];
    const collapsed = traditional.filter((v) => lang.normaliseLang(v) !== null);
    if (!collapsed.length) {
      pass('Traditional/regional tags are refused, not collapsed onto Simplified: ' + traditional.join(', '));
    } else {
      fail('these silently became ' + JSON.stringify(lang.normaliseLang(collapsed[0])) +
           ': ' + collapsed.join(', ') + ' — a Traditional request answered in Simplified, unremarked');
    }
    // …while the Simplified spellings still resolve, or the block above would
    // be asserting that nothing works rather than that the right things do.
    if (['zh', 'zh-Hans', 'zh-CN', 'zh-SG'].every((v) => lang.normaliseLang(v) === 'zh')) {
      pass('and the Simplified spellings still resolve to zh');
    } else {
      fail('the refusal is too broad — a Simplified tag stopped resolving');
    }
  }

/* ══ §3 — an unknown language does NOT silently become English ══════════════
   This is the one that matters most, because the failure is invisible: a
   caller who asked for French and got confident English back cannot tell
   whether the model ignored the instruction or the code dropped it. */
head('§3  an unknown language is refused, never defaulted');
{
  const unknown = ['fr', 'de', 'ta', 'jp', 'english', 'chinese', 'zz', 'en_US', 'xx-YY'];
  const leaked = unknown.filter((v) => lang.normaliseLang(v) !== null);
  if (!leaked.length) pass('normaliseLang() returns null for all ' + unknown.length + ' unknown codes (never "en")');
  else fail('these unknown codes resolved to something: ' +
    leaked.map((v) => v + '→' + lang.normaliseLang(v)).join(', '));

  // …and the call site honours it, which is a separate fact from the helper
  // returning null. A helper that says null into a caller that does `|| 'en'`
  // is the same bug with an extra step.
  let threw = null;
  try {
    gen.resolveRequestedLang('fr', null, null);
  } catch (err) {
    threw = err;
  }
  if (threw && /unsupported output language/i.test(threw.message)) {
    pass('resolveRequestedLang("fr") throws: ' + JSON.stringify(threw.message));
  } else {
    fail('resolveRequestedLang("fr") did not throw — it returned ' +
      JSON.stringify(threw ? threw.message : gen.resolveRequestedLang('fr', null, null)));
  }

  // End to end, through the real function.
  let genThrew = null;
  reset(OUT.en);
  try {
    (await generateWithGroq(USER, 'Write an ad', 'ads', 'Ads', 'Bold', 1, { lang: 'fr' }));
  } catch (err) {
    genThrew = err;
  }
  if (genThrew && /unsupported output language/i.test(genThrew.message)) {
    pass('generateWithGroq(..., {lang:"fr"}) throws before spending a token');
  } else {
    fail('generateWithGroq accepted lang="fr"');
  }
  if (calls.length === 0) pass('and no model call was made for the refused language');
  else fail('a model call was made anyway (' + calls.length + ')');

  // Absent is not unknown. No language asked for = no language layer.
  if (gen.resolveRequestedLang(undefined, null, null).lang === null &&
      gen.resolveRequestedLang(null, null, null).lang === null &&
      gen.resolveRequestedLang('', null, null).lang === null) {
    pass('an absent/empty language resolves to null (no directive), which is not the same as unknown');
  } else {
    fail('an absent language did not resolve to null');
  }
}

/* ══ §4 — looksLikeLang() catches wrong-language output ═════════════════════*/
head('§4  wrong-language output is detected');
{
  const checks = [
    ['zh asked, English returned', OUT.en, 'zh', false],
    ['zh asked, Chinese returned', OUT.zh, 'zh', true],
    ['ms asked, English returned', OUT.en, 'ms', false],
    ['ms asked, Malay returned', OUT.ms, 'ms', true],
    ['en asked, Chinese returned', OUT.zh, 'en', false],
    ['en asked, English returned', OUT.en, 'en', true],
    ['zh asked, empty returned', '', 'zh', false],
  ];
  for (const [label, text, want, expected] of checks) {
    const v = lang.looksLikeLang(text, want);
    if (v.ok === expected) {
      pass(label.padEnd(30) + ' → ok=' + v.ok + (v.reason ? ' (' + v.reason + ')' : ''));
    } else {
      fail(label + ' → ok=' + v.ok + ', expected ' + expected + ' · ' + JSON.stringify(v));
    }
  }
  // Malaysian Chinese copy carries RM and Latin brand names. A checker that
  // demands purity would reject every real piece of copy the platform makes.
  const mixedReal = OUT.zh + ' — M-EasyTools AI+, RM49/bulan.';
  if (lang.looksLikeLang(mixedReal, 'zh').ok) {
    pass('Chinese copy carrying "RM49" and a Latin brand name still passes as Chinese');
  } else {
    fail('the checker rejects realistic Malaysian Chinese copy — it is too strict to use');
  }
}

/* ── §4a — TRADITIONAL CHINESE, which hanRatio() cannot see ────────────────
   Found by the blind critic RUNNING the live model, not by reading code. One
   ZH generation in six came back entirely in 繁體字 — 46 distinct
   Traditional-only characters, 144 occurrences — and localised the currency as
   馬幣, which this platform's own ZH directive explicitly forbids. The checker
   answered {ok:true, detected:'zh', hanRatio:0.833} and the row saved
   langVerified:true with no warning: two §L criteria broken in one output,
   passed as verified. On this one criterion the test arm was measured WORSE
   than the benchmark, which produced Simplified 5 times out of 5.

   hanRatio cannot possibly see it — 繁體 and 简体 are both Han script. The
   check has to know about the orthography, not merely about the script. */
{
  const HANT = '在繁忙的早晨或午後的疲憊時刻，一杯手沖咖啡總能帶來慰藉。我們的門市提供來自檳城的優質豆子，' +
    '無論在風味、香氣還是整體體驗上，都遠勝於工業化的速溶產品。現在購買即可享有馬幣49元的優惠，歡迎親臨體驗。';
  const HANS = '在繁忙的早晨或午后的疲惫时刻，一杯手冲咖啡总能带来慰藉。我们的门市提供来自槟城的优质豆子，' +
    '无论在风味、香气还是整体体验上，都远胜于工业化的速溶产品。现在购买即可享有 RM49 的优惠，欢迎亲临体验。';

  // Positive control: the OLD measure really does wave this through. Without
  // this line the assertion below could pass because the sample is not Chinese
  // at all, which would be the right answer for the wrong reason.
  if (lang.hanRatio(HANT) > 0.5) {
    pass('positive control: the Traditional sample is ' + Math.round(lang.hanRatio(HANT) * 100) +
         '% Han, so hanRatio alone would have called it verified Chinese');
  } else {
    fail('the Traditional sample is not Han-dense enough to reproduce the defect');
  }

  const v = lang.hanVariant(HANT);
  if (v.variant === 'hant') {
    pass('hanVariant() reads it as Traditional (' + v.traditional + ' Traditional-only vs ' +
         v.simplified + ' Simplified-only characters)');
  } else {
    fail('hanVariant() says ' + JSON.stringify(v) + ' for an all-Traditional article');
  }

  const verdict = lang.looksLikeLang(HANT, 'zh');
  if (verdict.ok === false) pass('and looksLikeLang(zh) REFUSES it — the defect is closed');
  else fail('Traditional Chinese still passes as verified Simplified: ' + JSON.stringify(verdict));
  if (verdict.reason && /traditional|繁/i.test(verdict.reason)) {
    pass('naming the actual problem: ' + JSON.stringify(verdict.reason));
  } else {
    fail('the refusal does not say it was Traditional: ' + JSON.stringify(verdict.reason));
  }
  if (verdict.detected === 'zh-Hant') pass('and reports detected="zh-Hant", not a bare "zh"');
  else fail('detected is ' + JSON.stringify(verdict.detected));

  // The other half: real Simplified copy must still pass, or the fix has
  // broken Chinese generation rather than checked it.
  const good = lang.looksLikeLang(HANS, 'zh');
  if (good.ok === true) pass('the same sentence in Simplified passes');
  else fail('Simplified Chinese now fails verification too: ' + JSON.stringify(good));
  if (lang.hanVariant(HANS).variant === 'hans') pass('and reads as hans');
  else fail('the Simplified sample reads as ' + JSON.stringify(lang.hanVariant(HANS)));

  // Not over-corrected: one incidental Traditional character inside otherwise
  // Simplified copy — a quoted brand, a place name — is not a Traditional
  // article, and failing it would send good copy round the retry loop.
  const incidental = HANS + '（原名「臺灣珍珠奶茶」）';
  if (lang.looksLikeLang(incidental, 'zh').ok === true) {
    pass('a Simplified article carrying an incidental Traditional character still passes');
  } else {
    fail('over-correction: incidental Traditional characters now fail a Simplified article');
  }

  // Non-vacuity: the two character sets must be real, disjoint, and neither
  // empty. A checker built on an empty set is a checker that always passes.
  const sets = lang.HAN_VARIANT_SETS;
  const overlap = [...sets.simplified].filter((c) => sets.traditional.has(c));
  if (sets.simplified.size > 100 && sets.traditional.size > 100) {
    pass('the variant sets carry ' + sets.simplified.size + ' Simplified-only and ' +
         sets.traditional.size + ' Traditional-only characters');
  } else {
    fail('the variant sets are too small to mean anything: ' +
         sets.simplified.size + ' / ' + sets.traditional.size);
  }
  if (!overlap.length) pass('and no character sits in both sets');
  else fail('these characters are in BOTH sets, so they prove nothing: ' + overlap.join(''));
}

/* ── §4b — Malay verification was a single-token OR ────────────────────────
   Also found by running the model. MALAY_RE.test() passed on one hit anywhere
   in the text, where the ZH path uses a 0.30 proportion. Two live failures:

     · a wholly English answer containing the token "Dan" — an English given
       name as well as the Malay word for "and" — verified as Malay.
     · Indonesian verified cleanly, using `bisa` and `gratis`: the exact two
       words this platform's own BM directive names as forbidden Indonesian.
       The directive knew about them and the checker did not. */
{
  const EN_WITH_DAN = 'Hi [Name], Dan from [Business] here! We miss you. Claim your RM10 voucher ' +
    'before it expires and enjoy your favourite drinks with us again.';
  const INDONESIAN = 'Halo [Name], kami kangen kamu. Gratis voucher RM10 buat kamu, bisa dipakai hari ini!';

  const a = lang.looksLikeLang(EN_WITH_DAN, 'ms');
  if (a.ok === false) pass('an English answer containing one "Dan" no longer verifies as Malay');
  else fail('the single-token OR is still live: ' + JSON.stringify(a));

  const b = lang.looksLikeLang(INDONESIAN, 'ms');
  if (b.ok === false) pass('Indonesian no longer verifies as Bahasa Malaysia');
  else fail('Indonesian still passes as Malay: ' + JSON.stringify(b));
  if (b.reason && /indonesian/i.test(b.reason)) {
    pass('and the refusal names the markers it found: ' + JSON.stringify(b.reason));
  } else {
    fail('the refusal does not mention Indonesian: ' + JSON.stringify(b.reason));
  }

  // The directive and the checker must agree about which words are forbidden.
  // A rule stated in the prompt and unenforced in the check is a rule the model
  // can break for free — which is exactly what happened.
  const forbidden = ['bisa', 'gratis', 'banget', 'gimana'];
  const unchecked = forbidden.filter((w) => lang.looksLikeLang(
    'Kami ada tawaran istimewa untuk anda dan rakan anda hari ini, ' + w + ' digunakan sekarang.', 'ms').ok);
  if (!unchecked.length) {
    pass('every Indonesian word the BM directive forbids is also refused by the checker: ' + forbidden.join(', '));
  } else {
    fail('the directive forbids these and the checker accepts them: ' + unchecked.join(', '));
  }

  // And real Malay still passes, or this is not a check, it is an outage.
  if (lang.looksLikeLang(OUT.ms, 'ms').ok === true) pass('genuine Bahasa Malaysia still verifies');
  else fail('real Malay now fails verification: ' + JSON.stringify(lang.looksLikeLang(OUT.ms, 'ms')));

  // The proportion has to be a proportion. One Malay word in a long English
  // text and many Malay words in a short one must not score the same.
  const m1 = lang.malayMetrics(EN_WITH_DAN);
  const m2 = lang.malayMetrics(OUT.ms);
  if (m2.ratio > m1.ratio * 3) {
    pass('the Malay signal is proportional: ' + m1.ratio.toFixed(3) + ' for the English sample vs ' +
         m2.ratio.toFixed(3) + ' for the Malay one');
  } else {
    fail('the Malay ratio does not separate the two samples: ' + m1.ratio + ' vs ' + m2.ratio);
  }

  // detectLang must not label it Malay either, or the scorer would run Malay
  // metrics over English text.
  if (lang.detectLang(EN_WITH_DAN) === 'en') pass('and detectLang() calls the English sample English');
  else fail('detectLang() says ' + JSON.stringify(lang.detectLang(EN_WITH_DAN)) + ' for plain English');
}

/* ══ §5 — the prompt carries language instruction, and beats the benchmark ══*/
head('§5  the prompt carries real language instruction (§L benchmark)');

/* The benchmark, parsed out of GAUNTLET.md §L rather than out of a sibling
   repo. Hard-fails if it cannot be found. */
const BENCHMARK = (() => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'gauntlet', 'GAUNTLET.md'), 'utf8');
  const out = {};
  for (const code of ['en', 'ms', 'zh']) {
    const m = new RegExp('^\\s*' + code + ":\\s*'([^']+)',\\s*$", 'm').exec(doc);
    if (m) out[code] = m[1];
  }
  return out;
})();
{
  const got = Object.keys(BENCHMARK).length;
  if (got === 3) {
    pass('parsed the §L benchmark (M-EasyMember Campaign AI+ LANG_INSTRUCTIONS) out of GAUNTLET.md');
    for (const c of ['en', 'ms', 'zh']) console.log('      ' + c + ': ' + BENCHMARK[c]);
  } else {
    console.error('\n  ✗ could not parse the §L benchmark out of docs/gauntlet/GAUNTLET.md (' +
      got + ' of 3 found). This suite compares against a real quoted reference and');
    console.error('    will not proceed with an imaginary one.');
    process.exit(1);
  }
}

{
  // 5a — a directive exists at all, per language, and is in the system prompt.
  for (const code of ['en', 'ms', 'zh']) {
    const sys = gen.buildSystemPrompt({ lang: code, tone: 'Friendly', brand: 'Kopitiam' });
    if (sys.indexOf(gen.LANG_DIRECTIVES[code]) !== -1) pass(code + ': the system prompt contains the language directive');
    else fail(code + ': the language directive is not in the system prompt');
  }

  // 5b — MORE guidance than the reference. The reference is one sentence with
  // no register content; §L says matching that is not passing.
  for (const code of ['en', 'ms', 'zh']) {
    const refLines = BENCHMARK[code].split(/[.。]/).filter((x) => x.trim()).length;
    const ourLines = gen.LANG_DIRECTIVES[code].split('\n').filter((x) => x.trim()).length;
    if (ourLines > refLines + 3) {
      pass(code + ': ' + ourLines + ' lines of guidance vs the reference\'s ' + refLines + ' sentence(s)');
    } else {
      fail(code + ': only ' + ourLines + ' lines of guidance against the reference\'s ' + refLines +
           ' — that is matching a weakness, not beating it');
    }
  }

  // 5c — the register rules §L names, present in ours and absent from the
  // reference. Each one is a named criterion, not an impression of fluency.
  const REGISTER = {
    ms: [
      ['formal-polite "anda"', /\banda\b/i],
      ['baku spelling, not Indonesian', /bahasa indonesia|baku|dewan bahasa/i],
      ['no Manglish particles', /manglish|"lah"|lah/i],
      ['RM left un-localised', /\bRM\b/],
      ['emoji as structure markers', /emoji/i],
    ],
    zh: [
      ['polite 您', /您/],
      ['Simplified, not Traditional', /简体/],
      ['full-width punctuation', /全角/],
      ['RM left un-localised', /\bRM\b/],
      ['no Mainland-specific idiom', /大陆|种草|内卷/],
      ['emoji as structure markers', /emoji/i],
    ],
    en: [
      ['RM left un-localised', /\bRM\b/],
      ['en-MY dates', /en-MY|21 August/],
      ['emoji as structure markers', /emoji/i],
    ],
  };
  for (const code of Object.keys(REGISTER)) {
    const ours = gen.LANG_DIRECTIVES[code];
    const missing = REGISTER[code].filter(([, re]) => !re.test(ours)).map(([name]) => name);
    if (!missing.length) {
      pass(code + ': all ' + REGISTER[code].length + ' §L register rules are stated in the directive');
    } else {
      fail(code + ': the directive says nothing about — ' + missing.join('; '));
    }
    const refHas = REGISTER[code].filter(([, re]) => re.test(BENCHMARK[code])).map(([name]) => name);
    console.log('      (the reference states ' + refHas.length + ' of these ' + REGISTER[code].length + ')');
  }

  // 5d — the reference's SPECIFIC weakness: its prompt CONTEXT stays English
  // even when generating Chinese. Ours does not. Measured, not asserted.
  {
    const zhSys = gen.buildSystemPrompt({ lang: 'zh', tone: 'Friendly', brand: '槟城咖啡店' });
    const ratio = lang.hanRatio(zhSys);
    if (ratio >= 0.5) {
      pass('the ZH system prompt is ' + Math.round(ratio * 100) + '% Han script — the instruction ' +
           'is written in the language it is asking for, which the reference is not');
    } else {
      fail('the ZH system prompt is only ' + Math.round(ratio * 100) + '% Han script; it is still ' +
           'an English prompt with a Chinese sentence bolted on, which is the reference\'s defect');
    }
    const msSys = gen.buildSystemPrompt({ lang: 'ms', tone: 'Friendly', brand: 'Kedai kopi' });
    if (/\banda\b/i.test(msSys) && /Nada:/.test(msSys)) {
      pass('the BM system prompt is written in Malay (persona, tone label and register together)');
    } else {
      fail('the BM system prompt is not written in Malay end to end');
    }
  }

  // 5e — the tone label is localised too. The reference interpolates English
  // segment/type strings into a Chinese prompt; this is that same defect in
  // the one field this platform has.
  {
    const zhSys = gen.buildSystemPrompt({ lang: 'zh', tone: 'Empathetic', brand: 'x' });
    if (zhSys.indexOf('体贴共情') !== -1 && zhSys.indexOf('Empathetic') === -1) {
      pass('tone "Empathetic" reaches a Chinese prompt as 体贴共情, not as the English word');
    } else {
      fail('the English tone label is interpolated into the Chinese prompt (the reference\'s defect)');
    }
    const msSys = gen.buildSystemPrompt({ lang: 'ms', tone: 'Empathetic', brand: 'x' });
    if (msSys.indexOf('Empati') !== -1) pass('and reaches a Malay prompt as "Empati"');
    else fail('the tone label is not localised for Malay');

    // An unknown tone is the user's words and is passed through, not replaced.
    const odd = gen.buildSystemPrompt({ lang: 'zh', tone: 'Deadpan Cantonese uncle', brand: 'x' });
    if (odd.indexOf('Deadpan Cantonese uncle') !== -1) {
      pass('an unrecognised tone is passed through verbatim, not silently swapped for a default');
    } else {
      fail('an unrecognised tone was silently replaced — the user asked for something and got another thing');
    }
  }

  // 5f — the brand fallback is localised as well.
  {
    const zhSys = gen.buildSystemPrompt({ lang: 'zh', tone: 'Professional', brand: '' });
    if (zhSys.indexOf('General marketing') === -1) pass('the empty-brand fallback is not the English string in a Chinese prompt');
    else fail('"General marketing" is interpolated into the Chinese prompt');
  }

  // 5g — no language asked for means the prompt is EXACTLY what it was before
  // this lane. Callers who never opt in must not see a behaviour change.
  {
    const legacy = 'You are M-EasyTools AI, an elite marketing copywriter with 15+ years experience. ' +
      'Tone: Bold. Brand: Kopitiam chain in Penang. Be persuasive, specific, and conversion-focused.';
    const now = gen.buildSystemPrompt({ lang: null, tone: 'Bold', brand: 'Kopitiam chain in Penang' });
    if (now === legacy) pass('with no language requested the system prompt is byte-identical to the pre-lane one');
    else fail('the no-language system prompt changed:\n      was: ' + legacy + '\n      is:  ' + now);
  }

  // 5h — the variant marker stays English in every language, because eight
  // module pages split the response on /═══\s*VARIANT \d+\s*═══/i.
  for (const code of ['en', 'ms', 'zh']) {
    const ins = gen.variantInstruction(3, code);
    if (/═══ VARIANT 1 ═══/.test(ins)) pass(code + ': the variant label stays "═══ VARIANT 1 ═══" (the pages split on it)');
    else fail(code + ': the variant label was translated — the pages would render one blob instead of three cards');
  }
  if (gen.variantInstruction(1, 'zh') === '') pass('and no variant instruction is added for a single variant');
  else fail('a variant instruction was added for variants=1');
}

/* ══ §6 — the ecosystem contract ════════════════════════════════════════════*/
head('§6  the generateWithGroq() contract (Reusable Module Registry)');
{
  // Arity: five required parameters, exactly as before. `variants` has had a
  // default since before this lane, so Function.length was 5 then too.
  if (generateWithGroq.length === 5) {
    pass('arity is still 5 required params (user, prompt, toolId, toolName, tone) — variants and options are optional');
  } else {
    fail('arity changed to ' + generateWithGroq.length + ' — every copy of this function in the ecosystem breaks');
  }

  // A six-argument call, the way every existing caller writes it, must work
  // and must behave exactly as it did.
  reset(OUT.en);
  const legacyCall = (await generateWithGroq(USER, 'Write a launch email', 'mail', 'Email', 'Professional', 1));
  const FROZEN = ['text', 'wordCount', 'docId', 'seoScore', 'readability'];
  const missing = FROZEN.filter((k) => !(k in legacyCall));
  if (!missing.length) pass('a legacy 6-argument call still returns ' + FROZEN.join(', '));
  else fail('the returned object lost: ' + missing.join(', '));

  if (legacyCall.docId === 4242 && inserts.length === 1 && /INSERT INTO documents/.test(inserts[0].sql)) {
    pass('and still auto-saves one document row');
  } else {
    fail('the auto-save changed: ' + inserts.length + ' insert(s)');
  }

  if (typeof legacyCall.text === 'string' && typeof legacyCall.wordCount === 'number' &&
      typeof legacyCall.seoScore === 'number') {
    pass('the frozen fields still have their original types');
  } else {
    fail('a frozen field changed type');
  }

  if (legacyCall.langRequested === null && legacyCall.langVerified === null) {
    pass('a legacy call reports langRequested=null / langVerified=null — "not asked", not "verified English"');
  } else {
    fail('a legacy call claims a language it was never given: ' +
      JSON.stringify({ langRequested: legacyCall.langRequested, langVerified: legacyCall.langVerified }));
  }

  // The system prompt the model actually received on that legacy call.
  if (calls.length === 1 && calls[0].system.indexOf('OUTPUT LANGUAGE') === -1) {
    pass('and no language directive was added to a call that did not ask for one');
  } else {
    fail('a language directive was added to a legacy call');
  }
}

/* ══ §7 — verification, and what happens when it fails ══════════════════════*/
head('§7  post-generation verification');
{
  // 7a — happy path.
  reset(OUT.zh);
  const good = (await generateWithGroq(USER, '写一封推广邮件', 'mail', 'Email', 'Friendly', 1, { lang: 'zh' }));
  if (calls.length === 1) pass('a correct answer costs exactly one model call');
  else fail('a correct answer made ' + calls.length + ' calls');
  if (good.langVerified === true && good.langWarning === null) pass('and is reported langVerified=true with no warning');
  else fail('a correct Chinese answer was not verified: ' + JSON.stringify({ v: good.langVerified, w: good.langWarning }));
  if (good.lang === 'zh' && good.wordCount > 1) pass('and is scored as Chinese (' + good.wordCount + ' words)');
  else fail('the Chinese answer was scored as ' + good.lang + ' / ' + good.wordCount + ' words');

  // 7b — wrong once, right after the corrective turn.
  reset(OUT.en, OUT.zh);
  const fixed = (await generateWithGroq(USER, '写一封推广邮件', 'mail', 'Email', 'Friendly', 1, { lang: 'zh' }));
  if (calls.length === 2) pass('an English answer to a Chinese request triggers exactly one corrective turn');
  else fail('the corrective turn did not happen as expected (' + calls.length + ' calls)');
  if (calls[1] && calls[1].messages.length === 3 && calls[1].messages[1].role === 'assistant') {
    pass('and the corrective turn keeps the wrong answer in the transcript, so the model is correcting rather than restarting');
  } else {
    fail('the corrective turn does not carry the failed answer: ' +
      JSON.stringify(calls[1] && calls[1].messages.map((m) => m.role)));
  }
  if (calls[1] && calls[1].messages[2].content === gen.CORRECTION.zh) {
    pass('and the correction is written in Chinese, not in English about Chinese');
  } else {
    fail('the correction message is not the in-language one');
  }
  if (fixed.text === OUT.zh && fixed.langVerified === true && fixed.langRetried === true) {
    pass('the corrected text is what is returned, flagged langRetried=true and langVerified=true');
  } else {
    fail('the corrected result is wrong: ' + JSON.stringify({
      verified: fixed.langVerified, retried: fixed.langRetried, isZh: fixed.text === OUT.zh }));
  }

  // 7c — wrong twice. NOT silent, NOT discarded.
  reset(OUT.en, OUT.en);
  const bad = (await generateWithGroq(USER, '写一封推广邮件', 'mail', 'Email', 'Friendly', 1, { lang: 'zh' }));
  if (calls.length === 2) pass('a second failure does NOT trigger a third call (one retry, bounded)');
  else fail('the retry is not bounded: ' + calls.length + ' calls');
  if (bad.langVerified === false) pass('the result is flagged langVerified=false');
  else fail('a wrong-language result was returned as verified');
  if (bad.langDetected === 'en') pass('and names what it actually got (langDetected=en)');
  else fail('langDetected is ' + JSON.stringify(bad.langDetected));
  if (typeof bad.langWarning === 'string' && lang.hanRatio(bad.langWarning) > 0.3) {
    pass('and carries a warning written in the language the user asked for: ' + JSON.stringify(bad.langWarning));
  } else {
    fail('the warning is missing or is not in the requested language: ' + JSON.stringify(bad.langWarning));
  }
  if (bad.text && bad.text.length) pass('the text is still returned — the user does not lose work they paid for');
  else fail('the text was discarded');
  if (inserts.length === 1) pass('and it is still saved, flagged rather than dropped');
  else fail('the document was not saved (' + inserts.length + ' inserts)');
  /* It must be scored as what it IS. Scoring an English answer with the
     Chinese metrics gives it 0 Han characters per sentence, which the zh scale
     reads as maximally readable — §0.7's flattering 100, back again on exactly
     the requests that already went wrong. */
  if (bad.lang === 'en' && bad.metrics.readabilityBasis === 'flesch-en') {
    pass('and it is scored as the English it actually is (' + bad.metrics.readabilityBasis +
         '), not with the Chinese scale it was asked for');
  } else {
    fail('a wrong-language result was scored as the REQUESTED language: lang=' +
      bad.lang + ' basis=' + bad.metrics.readabilityBasis);
  }

  // The negative control for this whole section: if verification were removed,
  // 7c would report langVerified=true. Prove the field really tracks the text.
  reset(OUT.zh);
  const control = (await generateWithGroq(USER, '写一封推广邮件', 'mail', 'Email', 'Friendly', 1, { lang: 'zh' }));
  if (control.langVerified === true && bad.langVerified === false) {
    pass('langVerified varies with the actual text (true for Chinese, false for English) — it is a check, not a constant');
  } else {
    fail('langVerified does not vary with the text; it is decorative');
  }
}

  /* 7d — the Traditional case, end to end. This is the path the live defect
     took: a zh request, a Traditional answer, and a row saved verified. */
  const HANT_OUT = '在繁忙的早晨或午後的疲憊時刻，一杯手沖咖啡總能帶來慰藉。我們的門市提供來自檳城的優質豆子，' +
    '無論在風味、香氣還是整體體驗上，都遠勝於工業化的速溶產品。現在購買即可享有馬幣49元的優惠。';
  const HANS_OUT = '在繁忙的早晨或午后的疲惫时刻，一杯手冲咖啡总能带来慰藉。我们的门市提供来自槟城的优质豆子，' +
    '无论在风味、香气还是整体体验上，都远胜于工业化的速溶产品。现在购买即可享有 RM49 的优惠。';

  reset(HANT_OUT, HANS_OUT);
  const rescued = (await generateWithGroq(USER, '写一篇咖啡文章', 'content', 'Content', 'Friendly', 1, { lang: 'zh' }));
  if (calls.length === 2) pass('a Traditional answer triggers the corrective turn (it used to pass silently)');
  else fail('Traditional output made ' + calls.length + ' call(s) — it is not being caught');
  if (calls[1] && /繁體|繁体/.test(calls[1].messages[2].content)) {
    pass('and the correction names the actual problem — Traditional characters — not just "answer in Chinese"');
  } else {
    fail('the correction is the generic one; a model that just produced 繁體 needs telling that specifically');
  }
  if (rescued.langVerified === true && rescued.text === HANS_OUT) {
    pass('the Simplified rewrite is what gets returned and saved');
  } else {
    fail('the corrective turn did not rescue it: ' + JSON.stringify({ v: rescued.langVerified }));
  }

  reset(HANT_OUT, HANT_OUT);
  const stillHant = (await generateWithGroq(USER, '写一篇咖啡文章', 'content', 'Content', 'Friendly', 1, { lang: 'zh' }));
  if (stillHant.langVerified === false) pass('Traditional twice is reported langVerified=false, not verified');
  else fail('Traditional output was saved as verified — the live defect is still open');
  if (stillHant.langDetected === 'zh-Hant') pass('and names it: langDetected="zh-Hant"');
  else fail('langDetected is ' + JSON.stringify(stillHant.langDetected));
  if (typeof stillHant.langWarning === 'string' && /繁體|繁体/.test(stillHant.langWarning)) {
    pass('and the user-facing warning says so, in Chinese: ' + JSON.stringify(stillHant.langWarning));
  } else {
    fail('the warning does not tell the user it is Traditional: ' + JSON.stringify(stillHant.langWarning));
  }

  /* 7e — the Indonesian case, end to end. Same shape, other language. */
  reset('Halo [Name], kami kangen kamu. Gratis voucher RM10 buat kamu, bisa dipakai hari ini!', OUT.ms);
  const bmFixed = (await generateWithGroq(USER, 'Tulis promosi', 'social', 'Social', 'Friendly', 1, { lang: 'ms' }));
  if (calls.length === 2 && bmFixed.langVerified === true && bmFixed.text === OUT.ms) {
    pass('an Indonesian answer to a BM request is caught and corrected, not accepted');
  } else {
    fail('Indonesian was accepted for a Bahasa Malaysia request: ' +
      JSON.stringify({ calls: calls.length, verified: bmFixed.langVerified }));
  }

/* ══ §8 — the prompt channel genlang.js uses ════════════════════════════════*/
head('§8  the GENLANG prompt channel');
{
  const raw = 'Write a Hari Raya promo for our kopitiam.\n\n[[GENLANG lang=ms]]\nWrite the entire response in Bahasa Malaysia.\n[[/GENLANG]]';
  const s = gen.stripGenlangDirective(raw);
  if (s.lang === 'ms') pass('the language is read out of the block');
  else fail('the block language was not read: ' + JSON.stringify(s.lang));
  if (s.prompt.indexOf('GENLANG') === -1) pass('and the block is removed from the prompt');
  else fail('the marker survives into the prompt: ' + JSON.stringify(s.prompt));
  if (s.prompt.indexOf('Hari Raya') !== -1) pass('while the user\'s own prompt is left intact');
  else fail('the strip ate the user\'s prompt: ' + JSON.stringify(s.prompt));

  // End to end: the marker must never reach the model or the documents table.
  reset(OUT.ms);
  const r = (await generateWithGroq(USER, raw, 'content', 'Content', 'Friendly', 1));
  const sentPrompt = calls[0].messages[0].content;
  if (sentPrompt.indexOf('GENLANG') === -1) pass('the model never sees the marker');
  else fail('the marker was sent to the model: ' + JSON.stringify(sentPrompt));
  if (String(inserts[0].params[2]).indexOf('GENLANG') === -1) pass('and it never reaches documents.content');
  else fail('the marker was saved into the document');
  if (r.langRequested === 'ms' && r.langSource === 'prompt') {
    pass('the block is honoured as an explicit request (langSource=prompt), so the selector works with no server.js change');
  } else {
    fail('the block was not honoured: ' + JSON.stringify({ lang: r.langRequested, src: r.langSource }));
  }
  if (calls[0].system.indexOf(gen.LANG_DIRECTIVES.ms) !== -1) {
    pass('and the FULL register directive is applied server-side, not the one line in the block');
  } else {
    fail('the block\'s one line was used instead of the real directive');
  }

  // options.lang wins over the block.
  reset(OUT.zh);
  const both = (await generateWithGroq(USER, raw, 'content', 'Content', 'Friendly', 1, { lang: 'zh' }));
  if (both.langRequested === 'zh' && both.langSource === 'option') pass('options.lang wins over an embedded block');
  else fail('the embedded block overrode an explicit options.lang');

  // A block with an unusable code is refused, not defaulted — and is still
  // stripped, so nothing leaks even on the error path.
  const junk = gen.stripGenlangDirective('Hello\n\n[[GENLANG lang=fr]]\nx\n[[/GENLANG]]');
  if (junk.prompt.indexOf('GENLANG') === -1) pass('an unusable block is still stripped from the prompt');
  else fail('an unusable block was left in the prompt');
  let blockThrew = false;
  try { gen.resolveRequestedLang(undefined, junk.lang, junk.raw); } catch (err) { blockThrew = /unsupported/i.test(err.message); }
  if (blockThrew) pass('and an unusable block language is refused rather than defaulted to English');
  else fail('an unusable block language silently became something');
}

/* ══ §9 — the cross-lane contract owed to Lane E ════════════════════════════*/
head('§9  public/js/genlang.js — the contract Lane E builds against');
{
  const p = path.join(ROOT, 'public', 'js', 'genlang.js');
  if (!fs.existsSync(p)) {
    fail('public/js/genlang.js does not exist — Lane E has nothing to mount');
  } else {
    const src = fs.readFileSync(p, 'utf8');

    if (/data-genlang-mount/.test(src)) pass('it mounts on [data-genlang-mount]');
    else fail('it does not look for [data-genlang-mount] — the agreed mount point');

    // Self-contained: no import, no require, no external <script> dependency.
    if (!/\brequire\s*\(|\bimport\s+[\w{*]/.test(src)) pass('it is self-contained (no require/import)');
    else fail('it depends on a module loader — a plain <script defer> would not work');

    // It must not need an init call from the page.
    if (/DOMContentLoaded/.test(src)) pass('it initialises itself on DOMContentLoaded — no init call needed from the page');
    else fail('it appears to need an explicit init call, which breaks the contract');

    // Visual Bar §V: no raw colour literal on a lane surface.
    const literals = src.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g) || [];
    if (!literals.length) pass('no colour literal — every colour is var(--token) or currentColor (§V)');
    else fail('colour literal(s) in genlang.js: ' + literals.slice(0, 5).join(', '));

    // It must document the contract, because Lane E reads this file and not
    // this test.
    if (/CONTRACT FOR LANE E/.test(src) && /<script src="\/js\/genlang\.js" defer><\/script>/.test(src)) {
      pass('the contract is documented at the top, including the exact script tag');
    } else {
      fail('the contract is not documented at the top of the file');
    }

    // It must send the language somewhere the server can see it.
    if (/\/api\/generate/.test(src) && /\[\[GENLANG/.test(src)) {
      pass('it attaches the language to POST /api/generate via the GENLANG channel');
    } else {
      fail('it never attaches the language to a request — the selector would be a dead control');
    }

    // And it must surface a failed verification, or §7's flag dies in the JSON.
    if (/langVerified/.test(src) && /langWarning/.test(src)) {
      pass('it reads langVerified/langWarning off the response and shows the warning');
    } else {
      fail('nothing surfaces langVerified=false to the user — the flag would be invisible in the product');
    }
  }

  // The locale keys it uses must resolve in all three languages, or
  // test/ui-contract.js's parity rule is broken the moment a page uses them.
  const KEYS = ['genlang.label', 'genlang.aria', 'genlang.hint', 'genlang.warn_title', 'genlang.dismiss'];
  const deep = (o, k) => k.split('.').reduce((n, part) => (n && typeof n === 'object' ? n[part] : undefined), o);
  for (const code of ['en', 'ms', 'zh']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', code + '.json'), 'utf8'));
    const missing = KEYS.filter((k) => typeof deep(dict, k) !== 'string');
    if (!missing.length) pass(code + '.json: all ' + KEYS.length + ' genlang.* keys resolve');
    else fail(code + '.json is missing: ' + missing.join(', '));
  }
  // …and they must not be the English string copied into the other two files,
  // which is the way a "translated" locale passes a parity check and ships
  // English to a Malay user.
  {
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', 'en.json'), 'utf8'));
    const ms = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', 'ms.json'), 'utf8'));
    const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'locales', 'zh.json'), 'utf8'));
    const copied = KEYS.filter((k) => deep(en, k) === deep(ms, k) || deep(en, k) === deep(zh, k));
    if (!copied.length) pass('and none of them is the English string pasted into ms.json or zh.json');
    else fail('these genlang keys are identical across languages: ' + copied.join(', '));
  }
}

/* ══ §10 — genlang.js, EXECUTED, not scanned ════════════════════════════════
   CLAUDE.md records a standing gap on this platform: content.html's save
   handling is covered only by a static token scan, and a scan cannot tell an
   `.ok` check from an inverted one. §9 above is that same kind of scan. So
   this section runs the real file in a vm sandbox against a minimal DOM —
   the pattern test/fetch-contract.js already uses for seller.html — and
   asserts on what it DOES: that it mounts, that it rewrites the request, and
   that it leaves every other request alone.

   The DOM stub is small and dumb on purpose. It implements exactly the API
   surface genlang.js touches; anything genlang.js starts using that is not
   here will throw, which is the right outcome — the stub failing loudly beats
   the stub quietly pretending. */
head('§10  genlang.js executed against a DOM stub');
{
  const vm = require('vm');

  function qsaMatch(el, sel) {
    if (sel.charAt(0) === '.') return el._classes.has(sel.slice(1));
    if (sel.charAt(0) === '[') {
      const name = sel.slice(1, -1);
      return Object.prototype.hasOwnProperty.call(el.attrs, name);
    }
    throw new Error('DOM stub: unsupported selector ' + JSON.stringify(sel));
  }
  function descendants(root, out) {
    for (const c of root.children) { out.push(c); descendants(c, out); }
    return out;
  }
  function qsa(root, sel) {
    const scoped = /^:scope\s*>\s*(.+)$/.exec(sel);
    if (scoped) return root.children.filter((c) => qsaMatch(c, scoped[1].trim()));
    return descendants(root, []).filter((c) => qsaMatch(c, sel));
  }

  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      _classes: new Set(),
      _text: '',
      parentNode: null,
      listeners: {},
    };
    Object.defineProperty(el, 'textContent', {
      get() { return el._text; },
      set(v) { el._text = String(v); if (v === '') el.children.length = 0; },
    });
    Object.defineProperty(el, 'className', {
      get() { return [...el._classes].join(' '); },
      set(v) { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(el, 'nextSibling', {
      get() {
        if (!el.parentNode) return null;
        const i = el.parentNode.children.indexOf(el);
        return el.parentNode.children[i + 1] || null;
      },
    });
    el.classList = {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      contains: (c) => el._classes.has(c),
      toggle: (c, on) => { if (on) el._classes.add(c); else el._classes.delete(c); },
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null);
    el.appendChild = (c) => { c.parentNode = el; el.children.push(c); return c; };
    el.insertBefore = (n, ref) => {
      const i = ref ? el.children.indexOf(ref) : -1;
      n.parentNode = el;
      if (i === -1) el.children.push(n); else el.children.splice(i, 0, n);
      return n;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      return c;
    };
    el.addEventListener = (t, f) => { (el.listeners[t] = el.listeners[t] || []).push(f); };
    el.fire = (t, ev) => { (el.listeners[t] || []).forEach((f) => f(ev || {})); };
    el.querySelector = (s) => qsa(el, s)[0] || null;
    el.querySelectorAll = (s) => qsa(el, s);
    el.closest = () => null;
    return el;
  }

  const store = {};
  const doc = makeEl('#document');
  doc.readyState = 'complete';
  doc.head = makeEl('head');
  doc.documentElement = makeEl('html');
  doc.createElement = makeEl;
  doc.createTextNode = (txt) => { const n = makeEl('#text'); n._text = String(txt); return n; };
  doc.getElementById = (id) => descendants(doc, []).concat(descendants(doc.head, []))
    .find((e) => e.attrs.id === id) || null;
  doc.dispatchEvent = () => true;
  doc.appendChild(doc.documentElement);

  const mount = makeEl('div');
  mount.setAttribute('data-genlang-mount', '');
  const shell = makeEl('div');
  shell.appendChild(mount);
  doc.documentElement.appendChild(shell);

  const requests = [];
  let nextResponseBody = { success: true, text: 'ok' };
  const baseFetch = (input, init) => {
    requests.push({ input, init });
    const body = JSON.stringify(nextResponseBody);
    const res = { ok: true, status: 200, json: async () => JSON.parse(body) };
    res.clone = () => ({ json: async () => JSON.parse(body) });
    return Promise.resolve(res);
  };

  const sandbox = {
    console,
    Promise,
    Set,
    Object,
    JSON,
    String,
    Array,
    Error,
    document: doc,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    navigator: { language: 'en-MY' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    fetch: baseFetch,
  };
  sandbox.window = sandbox;
  sandbox.localStorage = sandbox.localStorage;

  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'genlang.js'), 'utf8');
  let ran = true;
  try {
    vm.runInNewContext(src, vm.createContext(sandbox), { filename: 'genlang.js' });
  } catch (err) {
    ran = false;
    fail('genlang.js threw while loading in the sandbox: ' + err.message);
  }

  if (ran) {
    pass('genlang.js loaded and ran');

    // 10a — it mounted itself, with no page code calling anything.
    const opts = mount.querySelectorAll('.genlang-opt');
    if (opts.length === 3) pass('it built a three-option selector into [data-genlang-mount] unprompted');
    else fail('it built ' + opts.length + ' options, not 3');
    const codes = opts.map((o) => o.getAttribute('data-genlang')).join(',');
    if (codes === 'en,ms,zh') pass('the options are en, ms, zh in display order');
    else fail('the options are ' + JSON.stringify(codes));

    // 10b — it wrapped fetch, and a NON-target request is untouched.
    if (sandbox.fetch !== baseFetch) pass('it wrapped window.fetch');
    else fail('window.fetch was not wrapped — the selector could not reach the server');

    const untouchedBody = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    (await sandbox.fetch('/api/chat', { method: 'POST', body: untouchedBody }));
    const chatReq = requests[requests.length - 1];
    if (chatReq.init.body === untouchedBody) {
      pass('POST /api/chat passes through byte-identical (gao.html\'s JSON prompts are not mangled)');
    } else {
      fail('/api/chat was rewritten: ' + chatReq.init.body);
    }

    (await sandbox.fetch('/api/documents'));
    if (requests[requests.length - 1].init === undefined) pass('a plain GET passes through untouched');
    else fail('a plain GET was rewritten');

    // 10c — the target request IS rewritten, in the selected language.
    const zhBtn = opts.find((o) => o.getAttribute('data-genlang') === 'zh');
    zhBtn.fire('click');
    if (sandbox.window.GenLang.get() === 'zh') pass('clicking 中文 selects zh');
    else fail('clicking 中文 did not change the selection (' + sandbox.window.GenLang.get() + ')');
    if (store.msm_genlang === 'zh') pass('and persists it under msm_genlang, leaving msm_lang alone');
    else fail('the choice was not persisted, or was written to the UI-language key');
    if (!('msm_lang' in store) && !('modus-lang' in store)) {
      pass('and it never writes the interface-language key (they are separate preferences)');
    } else {
      fail('genlang wrote the interface-language key: ' + JSON.stringify(store));
    }

    (await sandbox.fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Write a promo', toolId: 'content', variants: 1 }),
    }));
    const genReq = requests[requests.length - 1];
    const sent = JSON.parse(genReq.init.body);
    if (sent.lang === 'zh') pass('POST /api/generate carries lang:"zh" for server.js to read');
    else fail('the request body has no lang field: ' + genReq.init.body);
    if (/\[\[GENLANG lang=zh\]\][\s\S]*\[\[\/GENLANG\]\]/.test(sent.prompt)) {
      pass('and the prompt carries the GENLANG block, so it works before server.js reads `lang`');
    } else {
      fail('the prompt carries no GENLANG block: ' + JSON.stringify(sent.prompt));
    }
    if (sent.prompt.indexOf('Write a promo') === 0) pass('with the page\'s own prompt untouched at the front');
    else fail('the page\'s prompt was altered: ' + JSON.stringify(sent.prompt));

    // The server strips what the client attached. Prove the two halves agree,
    // rather than each being correct on its own.
    const round = gen.stripGenlangDirective(sent.prompt);
    if (round.lang === 'zh' && round.prompt === 'Write a promo') {
      pass('and helpers/generation.js strips exactly that block back off — the two ends agree');
    } else {
      fail('the server does not round-trip what the client sent: ' + JSON.stringify(round));
    }

    // A caller that set its own lang is not overridden.
    (await sandbox.fetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'x', lang: 'ms' }),
    }));
    if (JSON.parse(requests[requests.length - 1].init.body).lang === 'ms') {
      pass('an explicit lang in the caller\'s own body is not overridden by the selector');
    } else {
      fail('the selector overrode an explicit caller-supplied language');
    }

    // 10d — a failed verification becomes something the user can see.
    nextResponseBody = {
      success: true, text: 'English text', langVerified: false,
      langWarning: '模型没有以简体中文作答。',
    };
    (await sandbox.fetch('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) }));
    await new Promise((r) => setImmediate(r));   // let the response .json() settle
    const warn = shell.querySelectorAll('.genlang-warn');
    if (warn.length === 1) pass('langVerified:false renders a visible warning beside the selector');
    else fail('no warning was rendered for langVerified:false (' + warn.length + ' found)');

    // …and it goes away again on the next good response. A warning that never
    // clears is a warning people learn to ignore.
    nextResponseBody = { success: true, text: 'ok', langVerified: true, langWarning: null };
    (await sandbox.fetch('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) }));
    await new Promise((r) => setImmediate(r));
    if (shell.querySelectorAll('.genlang-warn').length === 0) pass('and it clears on the next verified response');
    else fail('the warning stayed up after a verified response');
  }
}

  console.log('');
  if (failures) {
    console.error('✗ ' + failures + ' trilingual check(s) failed\n');
    process.exit(1);
  }
  console.log('✓ trilingual generation, metrics and contract all hold\n');
}

/* An unhandled rejection inside main() would otherwise print a warning and, on
   some Node builds, exit 0 — a suite that crashed reported as a suite that
   passed (recurring-bugs #14). */
main().catch((err) => {
  console.error('\n✗ trilingual suite threw: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});

/* ═══════════════════════════════════════════════════════════════════════════
   GENERATION — the one place this platform turns a prompt into content
   ───────────────────────────────────────────────────────────────────────────
   Extracted from server.js in Round 1 Foundation as a pure refactor. LANE C
   (trilingual, Localization Bar §L) owns it from there and this is that lane's
   work: the language layer, and the CJK scoring fix from UPGRADE-SPEC §0.7.

   ── WHY THIS IS THE CHOKE POINT, AND WHY THAT MATTERS ─────────────────────
   Eleven module pages generate content — content, social, mail, ads, seo,
   sales, commerce, audiobook, gao, aichat, pr. Every one of them builds its
   prompt in the browser and posts it to /api/generate, which is a nine-line
   wrapper around generateWithGroq(). So there is ONE place to add language,
   not eleven, and two named exceptions that do not pass through here:

     POST /api/chat        — its own system prompt, its own call
     the GAO/PR score call — server.js, a direct chat() call

   Neither is reachable from this file. Both are handled explicitly in Lane
   C's report, with the exact server.js edit each one needs, rather than being
   quietly left to look covered because "generation is trilingual now".

   ── ECOSYSTEM CONTRACT (unchanged, and checked by test/trilingual-test.js) ─
   The Reusable Module Registry records "AI generation (Groq) — BUILT IN
   M-EasyTools — reuse method: copy generateWithGroq()". This repo is the
   origin of that module for the whole ecosystem, so the exported shape here
   is an interface other platforms have copied, not a local convenience.

     generateWithGroq(user, prompt, toolId, toolName, tone, variants)

   Those six parameters keep their names, their order and their meaning. The
   language layer arrives as an OPTIONAL SEVENTH argument, so every existing
   caller — including the copies living in other repos — is byte-compatible.
   The returned object keeps text / wordCount / docId / seoScore / readability
   and only GAINS fields. Widening is safe; changing or removing is not.

   ── HOW A LANGUAGE ACTUALLY REACHES THIS FUNCTION ─────────────────────────
   Two channels, because Lane C may not edit server.js or any HTML:

     1. options.lang — the clean path. Requires one line in server.js (see the
        report); an external /api/chat-style integration can use it the day it
        lands.
     2. A GENLANG directive block embedded in the prompt by public/js/genlang.js
        and stripped here before the prompt reaches the model. This is what
        makes the selector work end-to-end with NO server.js change at all,
        because `prompt` is a field server.js already forwards verbatim.

   Channel 1 wins when both are present. The block is ALWAYS stripped, so the
   marker can never leak into a model prompt or into saved content.

   ── WHAT HAPPENS WHEN NO LANGUAGE IS REQUESTED ────────────────────────────
   Nothing. No directive is added and no verification runs — the behaviour is
   exactly what it was before this lane. That is deliberate: several module
   pages let the user write "tulis dalam Bahasa Malaysia" inside their own
   prompt, and a system prompt that asserted English would silently override
   the user's own instruction. Guessing a language from the prompt text would
   do the same thing, so this file does not guess. Scoring still gets the §0.7
   fix, because that reads the OUTPUT, which is a fact rather than a guess.

   ── WHAT HAPPENS WHEN THE MODEL ANSWERS IN THE WRONG LANGUAGE ─────────────
   The benchmark (M-EasyMember Campaign AI+) never checks. We do:

     attempt 1 → looksLikeLang() → if wrong, ONE corrective turn written IN
     the target language, with the failed answer left in the transcript so the
     model is correcting rather than starting over → verify again.

     Still wrong → the text is returned and saved, with langVerified:false,
     the detected language, and a human-readable warning IN THE REQUESTED
     LANGUAGE. It is not discarded (the user paid for those tokens and the
     copy may still be usable) and it is not passed off as correct.
     public/js/genlang.js renders that warning above the result, so the
     failure is visible in the product and not only in the JSON.

   Throwing was considered and rejected: /api/generate turns a throw into a
   bare 500 with no text, which loses work AND tells the user nothing about
   what went wrong. A flagged result loses neither.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { GROQ_MODEL, chat } = require('./groq');
const {
  LANGS,
  LANG_LABELS,
  normaliseLang,
  textMetrics,
  looksLikeLang,
} = require('./lang');

/* ── The GENLANG prompt channel ────────────────────────────────────────────
   Deliberately ugly and deliberately ASCII. It has to survive being pasted
   through a JSON body and a textarea, and it has to be impossible to confuse
   with something a copywriter would type. */
const GENLANG_OPEN = '[[GENLANG';
const GENLANG_BLOCK_RE = /\[\[GENLANG\s+lang=([a-z-]{2,7})\]\][\s\S]*?\[\[\/GENLANG\]\]/gi;

/**
 * Pull the genlang directive block out of a prompt.
 *
 * ALWAYS strips, even when the language is unusable — a marker that reached
 * the model would be read as content, and a marker that reached `documents`
 * would be saved into the customer's copy.
 *
 * @returns {{prompt: string, lang: string|null, found: boolean, raw: string|null}}
 */
function stripGenlangDirective(prompt) {
  const src = String(prompt == null ? '' : prompt);
  if (src.indexOf(GENLANG_OPEN) === -1) {
    return { prompt: src, lang: null, found: false, raw: null };
  }
  let raw = null;
  const cleaned = src.replace(GENLANG_BLOCK_RE, (match, code) => {
    if (raw === null) raw = code;
    return '';
  });
  return {
    prompt: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    lang: normaliseLang(raw),
    found: raw !== null,
    raw,
  };
}

/* ── Tone, in the language the copy is being written in ────────────────────
   The reference implementation interpolates ENGLISH context strings into a
   Chinese prompt ("targeting your loyal active members" inside 用简体中文写).
   §L names that as a weakness, not a thing to copy. These are the six tones
   the module pages actually offer, checked against the tone arrays in
   content/social/mail/ads/seo/sales/commerce/app.html.

   An unrecognised tone is passed through VERBATIM rather than mapped onto a
   default — a user-supplied tone is content, and silently replacing it with
   "Professional" is the same class of lie as silently replacing a language. */
const TONE_LABELS = {
  en: {
    Professional: 'Professional', Friendly: 'Friendly', Witty: 'Witty',
    Bold: 'Bold', Empathetic: 'Empathetic', Casual: 'Casual',
  },
  ms: {
    Professional: 'Profesional', Friendly: 'Mesra', Witty: 'Bijak dan jenaka',
    Bold: 'Berani dan tegas', Empathetic: 'Empati', Casual: 'Santai',
  },
  zh: {
    Professional: '专业', Friendly: '亲切友好', Witty: '风趣机智',
    Bold: '大胆有力', Empathetic: '体贴共情', Casual: '轻松随意',
  },
};

function toneLabel(tone, lang) {
  const t = (tone && String(tone).trim()) || 'Professional';
  const table = TONE_LABELS[lang] || TONE_LABELS.en;
  return table[t] || t;
}

/* ── The house register, per language ──────────────────────────────────────
   §L's standard comes from M-EasyMember's HAND-WRITTEN corpus in
   helpers/asha.js — human copy, not model output, which is why it is a
   legitimate standard. What that corpus does, and what these blocks encode:

     BM  formal-polite `anda`, baku spelling, no Manglish particles, emoji as
         structure markers in front of a line rather than decoration inside a
         sentence, RM left un-localised.
     ZH  Simplified, polite 您, full-width punctuation ，。！？：、, RM left
         un-localised, no Mainland-specific idiom.

   Written IN the target language on purpose. The reference's single English
   sentence of guidance is the thing we are trying to beat, and a model that
   has already been reading Malay for two hundred words is measurably more
   likely to keep writing it than one told in English to switch. */
const LANG_DIRECTIVES = {
  en: [
    'OUTPUT LANGUAGE — ENGLISH. This is not negotiable and overrides any',
    'language habit the topic suggests.',
    '',
    'REGISTER — follow exactly:',
    '• Write the ENTIRE response in English. Do not append a translation.',
    '• Malaysian English for a Malaysian audience: plain, direct, no American',
    '  hard-sell superlatives ("crush it", "insane results").',
    '• Currency stays "RM" (RM49). Never MYR, never $, never "ringgit" spelled',
    '  out in running copy.',
    '• Dates in en-MY order: 21 August 2026.',
    '• Emoji only as a structure marker at the head of a heading or list item,',
    '  never as decoration inside a sentence. At most one per paragraph.',
  ].join('\n'),

  ms: [
    'BAHASA OUTPUT — BAHASA MALAYSIA. Ini wajib dan mengatasi apa-apa',
    'kebiasaan bahasa yang dicadangkan oleh topik.',
    '',
    'DAFTAR BAHASA — ikut dengan tepat:',
    '• Tulis KESELURUHAN jawapan dalam Bahasa Malaysia. Jangan sertakan',
    '  terjemahan bahasa Inggeris di bawahnya.',
    '• Gunakan "anda" untuk merujuk pembaca, konsisten dari awal hingga akhir.',
    '  Jangan guna "kau", "korang", "kalian" atau "engkau".',
    '• Ejaan baku Dewan Bahasa dan Pustaka. Bahasa Malaysia, BUKAN Bahasa',
    '  Indonesia: tulis "boleh" bukan "bisa", "sangat" bukan "banget",',
    '  "bagaimana" bukan "gimana", "percuma" bukan "gratis".',
    '• Tiada partikel Manglish: jangan tulis "lah", "lor", "meh", "je", "kan",',
    '  "gua", "lu", "cun", "power" sebagai penegas.',
    '• Mata wang kekal "RM" (contoh: RM49). Jangan tukar kepada MYR, $,',
    '  atau "ringgit" dalam ayat.',
    '• Tarikh dalam susunan Malaysia: 21 Ogos 2026.',
    '• Emoji hanya sebagai penanda struktur di hadapan tajuk atau butir',
    '  senarai — bukan hiasan di dalam ayat. Maksimum satu setiap perenggan.',
    '• Istilah teknikal yang tiada padanan baku boleh kekal dalam bahasa',
    '  Inggeris, tetapi jelaskan sekali pada penggunaan pertama.',
  ].join('\n'),

  zh: [
    '输出语言 —— 简体中文。这是硬性要求，优先于主题本身可能带来的语言习惯。',
    '',
    '文风规范 —— 请严格遵守：',
    '• 全文必须使用简体中文，不得使用繁体字，也不要在下方附上英文翻译。',
    '• 称呼读者一律用「您」，全文保持一致；不要用「你们」「亲」「宝宝」。',
    '• 标点一律使用全角：，。！？：、；「」（）。不要使用半角逗号或句号。',
    '• 货币写作 RM，保留不译（例如：RM49）。不要写成「令吉」「马币」「元」或「￥」。',
    '• 日期写作 2026年8月21日。',
    '• 面向马来西亚华人读者：避免中国大陆特有的用语与网络流行语，例如',
    '  「种草」「内卷」「yyds」「包邮」「亲」；除非用户明确提到，否则不要出现',
    '  微信、支付宝、淘宝等平台名称。',
    '• emoji 只用作段落或列表项开头的结构标记，不在句子中间作装饰，每段最多一个。',
    '• 品牌名称、产品型号等专有名词保留原文，不要音译。',
  ].join('\n'),
};

/* The identity line, also in-language. The reference leaves this in English
   even when generating Chinese. */
const PERSONA = {
  en: (tone, brand) =>
    'You are M-EasyTools AI, an elite marketing copywriter with 15+ years of ' +
    'experience writing for Malaysian businesses.\n' +
    'Tone: ' + tone + '. Brand: ' + brand + '.\n' +
    'Be persuasive, specific, and conversion-focused.',
  ms: (tone, brand) =>
    'Anda ialah M-EasyTools AI, penulis salinan pemasaran elit dengan lebih 15 ' +
    'tahun pengalaman menulis untuk perniagaan di Malaysia.\n' +
    'Nada: ' + tone + '. Jenama: ' + brand + '.\n' +
    'Tulisan anda mesti meyakinkan, khusus dan menumpukan penukaran (conversion).',
  zh: (tone, brand) =>
    '你是 M-EasyTools AI，一位拥有15年以上经验、专为马来西亚企业撰稿的顶尖营销文案。\n' +
    '语气：' + tone + '。品牌：' + brand + '。\n' +
    '文案必须具说服力、内容具体，并以促成转化为目标。',
};

/* Fallback brand description, in-language — "General marketing" interpolated
   into a Chinese system prompt is exactly the reference's defect. */
const BRAND_FALLBACK = {
  en: 'General marketing',
  ms: 'Pemasaran am',
  zh: '一般营销',
};

/* The corrective turn. Sent as a THIRD message with the wrong-language answer
   still in the transcript, so the model is fixing its own output rather than
   being asked cold a second time. */
const CORRECTION = {
  en: 'NOTICE: that answer was not written in English. Rewrite the entire ' +
      'piece in English only, keeping the same structure, length and offer. ' +
      'Return only the rewritten piece — no apology, no explanation.',
  ms: 'PERINGATAN: jawapan tadi bukan dalam Bahasa Malaysia. Tulis semula ' +
      'KESELURUHAN kandungan dalam Bahasa Malaysia sahaja, dengan struktur, ' +
      'panjang dan tawaran yang sama. Berikan kandungan yang ditulis semula ' +
      'sahaja — tanpa permohonan maaf dan tanpa penjelasan.',
  zh: '提醒：上一次的回答没有使用简体中文。请只用简体中文重新撰写全部内容，' +
      '保持相同的结构、篇幅与优惠内容。只输出重写后的正文，不要道歉，也不要解释。',
};

/* Shown to the user when both attempts failed. In the language they asked
   for, because a user who asked for Chinese is the person who has to read it. */
const WRONG_LANG_WARNING = {
  en: (got) => 'The model did not answer in English (it looks like ' + got + '). ' +
      'The draft below is kept so nothing is lost — review it before you use it.',
  ms: (got) => 'Model tidak menjawab dalam Bahasa Malaysia (kelihatan seperti ' + got + '). ' +
      'Draf di bawah dikekalkan supaya tiada kerja hilang — sila semak sebelum digunakan.',
  zh: (got) => '模型没有以简体中文作答（看起来像' + got + '）。' +
      '下面的草稿已保留，不会丢失，请先检查再使用。',
};

const LANG_NAME_IN = {
  en: { en: 'English', ms: 'Malay', zh: 'Chinese' },
  ms: { en: 'bahasa Inggeris', ms: 'Bahasa Malaysia', zh: 'bahasa Cina' },
  zh: { en: '英文', ms: '马来文', zh: '中文' },
};

function nameLangIn(detected, inLang) {
  const table = LANG_NAME_IN[inLang] || LANG_NAME_IN.en;
  return table[detected] || (LANG_LABELS[detected] || 'another language');
}

/**
 * The full system prompt.
 *
 * With no language: byte-for-byte the pre-Lane-C string, because a caller who
 * did not ask for a language must not have their behaviour changed.
 *
 * @param {object}      opts
 * @param {string|null} opts.lang   already normalised, or null
 * @param {string}      opts.tone
 * @param {string}      opts.brand  users.brand_desc
 */
function buildSystemPrompt({ lang, tone, brand }) {
  if (!lang) {
    return 'You are M-EasyTools AI, an elite marketing copywriter with 15+ years experience. ' +
      'Tone: ' + (tone || 'Professional') + '. Brand: ' + (brand || 'General marketing') + '. ' +
      'Be persuasive, specific, and conversion-focused.';
  }
  const persona = PERSONA[lang] || PERSONA.en;
  const brandText = (brand && String(brand).trim()) || BRAND_FALLBACK[lang] || BRAND_FALLBACK.en;
  return persona(toneLabel(tone, lang), brandText) + '\n\n' + LANG_DIRECTIVES[lang];
}

/**
 * The variant instruction, localised — EXCEPT the label itself.
 *
 * content/social/mail/ads/seo/sales/commerce/app.html all split the response
 * on /═══\s*VARIANT \d+\s*═══/i. A translated label ("═══ VERSI 1 ═══") would
 * produce one blob instead of three cards, so the marker is pinned as English
 * and the model is told in its own language to leave it alone.
 */
function variantInstruction(variants, lang) {
  const n = Number(variants) || 1;
  if (n <= 1) return '';
  if (lang === 'ms') {
    return '\n\nHasilkan ' + n + ' versi yang berbeza. Labelkan setiap satu TEPAT begini, ' +
      'kekalkan label dalam bahasa Inggeris: ═══ VARIANT 1 ═══, ═══ VARIANT 2 ═══, dan seterusnya.';
  }
  if (lang === 'zh') {
    return '\n\n请生成 ' + n + ' 个不同的版本，并严格使用以下英文标签分隔（标签必须保持英文原样）：' +
      '═══ VARIANT 1 ═══、═══ VARIANT 2 ═══，依此类推。';
  }
  return '\n\nGenerate ' + n + ' distinct variants labeled: ═══ VARIANT 1 ═══, ═══ VARIANT 2 ═══, etc.';
}

/**
 * Resolve the requested language from the two channels.
 *
 * An UNRECOGNISED code throws. It does not become English. A caller that sent
 * "fr" and got confident English back would have no way to tell whether the
 * model ignored the instruction or the code dropped it on the floor, which is
 * the failure helpers/lang.js's normaliseLang() exists to prevent — this is
 * the call site that honours it.
 *
 * @returns {{lang: string|null, source: 'option'|'prompt'|'none'}}
 */
function resolveRequestedLang(optionLang, promptBlockLang, promptBlockRaw) {
  if (optionLang !== undefined && optionLang !== null && String(optionLang).trim() !== '') {
    const l = normaliseLang(optionLang);
    if (!l) {
      throw new Error(
        'Unsupported output language: "' + String(optionLang) + '". Supported: ' + LANGS.join(', ')
      );
    }
    return { lang: l, source: 'option' };
  }
  if (promptBlockRaw) {
    if (!promptBlockLang) {
      throw new Error(
        'Unsupported output language: "' + String(promptBlockRaw) + '". Supported: ' + LANGS.join(', ')
      );
    }
    return { lang: promptBlockLang, source: 'prompt' };
  }
  return { lang: null, source: 'none' };
}

/**
 * Generate content, score it, and auto-save it as a document.
 *
 * @param {object}   deps        injected, so this module has no import cycle
 *                               back to server.js and can be tested without one
 * @param {object}   deps.pool   pg Pool
 * @param {string}   deps.groqKey  the platform key, used when the user has none
 */
function createGenerator({ pool, groqKey }) {
  /**
   * @param {object} user     the users row — supplies groq_key, brand_desc, id
   * @param {string} prompt   the fully-built prompt from the module page
   * @param {string} toolId
   * @param {string} toolName
   * @param {string} tone
   * @param {number} variants
   * @param {object} [options]        WIDENING ONLY — every existing caller is
   *                                  byte-compatible without it.
   * @param {string} [options.lang]   'en' | 'ms' | 'zh'. Anything else throws.
   */
  async function generateWithGroq(user, prompt, toolId, toolName, tone, variants = 1, options = {}) {
    const key = user.groq_key || groqKey;
    if (!key) throw new Error('Groq API key not configured');

    const opts = options || {};
    const stripped = stripGenlangDirective(prompt);
    const { lang, source: langSource } = resolveRequestedLang(opts.lang, stripped.lang, stripped.raw);

    const basePrompt = stripped.prompt;
    const fullPrompt = basePrompt + variantInstruction(variants, lang);
    const systemPrompt = buildSystemPrompt({ lang, tone, brand: user.brand_desc });

    const messages = [{ role: 'user', content: fullPrompt }];
    let out = await chat({
      apiKey: key,
      model: GROQ_MODEL,
      system: systemPrompt,
      messages,
      maxTokens: 2500,
      temperature: 0.75,
    });
    let text = out.text;

    /* ── Verification. The benchmark does not do this at all (§L). ────────── */
    let verdict = null;
    let retried = false;   // true once a corrective turn has been ISSUED, whatever it returned
    if (lang) {
      verdict = looksLikeLang(text, lang);
      if (!verdict.ok) {
        console.warn(
          'helpers/generation.js: model answered ' + (verdict.detected || 'unknown') +
          ' when ' + lang + ' was requested (' + (verdict.reason || 'no reason') +
          ') — issuing one corrective turn'
        );
        const retry = await chat({
          apiKey: key,
          model: GROQ_MODEL,
          system: systemPrompt,
          messages: [
            ...messages,
            { role: 'assistant', content: text },
            { role: 'user', content: CORRECTION[lang] },
          ],
          maxTokens: 2500,
          // Lower than the first pass on purpose: the first answer already
          // proved the model will wander at 0.75 for this prompt.
          temperature: 0.4,
        });
        const second = looksLikeLang(retry.text, lang);
        retried = true;
        if (second.ok || retry.text.trim()) {
          // Keep the retry even when it is still wrong — it is at worst no
          // worse than the first, and when it is right it is the answer.
          text = retry.text;
          verdict = second;
        }
        if (!second.ok) {
          console.warn(
            'helpers/generation.js: corrective turn STILL not ' + lang +
            ' (detected ' + (second.detected || 'unknown') + ') — returning flagged, not silently'
          );
        }
      }
    }

    /* Score the text as what it IS, not as what was asked for.
       Scoring an English answer with the Chinese metrics gives it zero Han
       characters per sentence, which the zh readability scale reads as
       maximally readable and clamps to 100 — §0.7's flattering-wrong number,
       reappearing on exactly the requests that already went wrong. So when
       verification failed, the language is re-detected from the text. */
    const scoreLang = (lang && verdict && !verdict.ok) ? null : lang;
    const scored = scoreContent(text, scoreLang);

    // Auto-save document
    const doc = await pool.query(
      'INSERT INTO documents (user_id,title,content,tool_id,tool_name,word_count,seo_score,readability) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [user.id, `${toolName || 'Content'} — ${new Date().toLocaleDateString()}`, text, toolId, toolName,
        scored.wordCount, scored.seoScore, scored.readability]
    );

    const result = {
      // ── the frozen ecosystem shape ───────────────────────────────────────
      text,
      wordCount: scored.wordCount,
      docId: doc.rows[0].id,
      seoScore: scored.seoScore,
      readability: scored.readability,
      // ── additive: what language this is, and whether we checked ──────────
      lang: scored.lang,
      langRequested: lang,
      langSource,
      langVerified: lang ? Boolean(verdict && verdict.ok) : null,
      langDetected: verdict ? verdict.detected : scored.lang,
      langRetried: retried,
      langWarning: lang && verdict && !verdict.ok
        ? (WRONG_LANG_WARNING[lang] || WRONG_LANG_WARNING.en)(nameLangIn(verdict.detected, lang))
        : null,
      metrics: scored.metrics,
    };
    return result;
  }

  return { generateWithGroq };
}

/* ── Deterministic content score ───────────────────────────────────────────
   UPGRADE-SPEC §0.7 IS CLOSED HERE. What this used to be:

       const wordCount = text.split(/\s+/).filter(Boolean).length;

   Chinese does not put spaces between words, so a 880-character Chinese
   article counted as ONE word: documents.word_count stored 1, the SEO gate
   `wordCount >= 300 ? 25 : Math.floor(wordCount/12)` awarded 0 however long
   the piece was, and Flesch — a formula defined over English syllables —
   returned a serene 100 for the one language it cannot describe at all.
   Generating Chinese on top of that scorer would have told every
   Chinese-writing customer their best work was worthless.

   helpers/lang.js does the counting now (Intl.Segmenter with ICU's real
   Chinese word dictionary, a labelled estimate when the runtime's ICU cannot,
   and a readability metric per language that is allowed to say which method
   it used). This function keeps its exported name, its arguments-compatible
   call, and every field it returned.

   TWO DELIBERATE CHANGES BEYOND CJK, both recorded rather than slipped in:

   1. English readability moves. The old syllable counter counted vowel
      CHARACTERS ("queueing" = 6 syllables); lang.js counts vowel GROUPS
      ("queueing" = 2). English scores shift, in the direction of being right.
   2. The old readability floor of 30 is gone. A floor that lifts unreadable
      text to 30 is a scale that cannot report unreadable text. Range is now
      0..100, and null for text with nothing in it — null being the honest
      answer to "how readable is an empty string", where both 0 and 30 are
      confident lies. documents.readability is a nullable INTEGER, so a NULL
      stores fine.

   The SEO thresholds (300 / 800 words) are unchanged. They were tuned for
   English and 300 segmented Chinese words is roughly 450 Han characters,
   which is a comparable piece of writing — close enough that re-tuning them
   would be a second, unreviewed change riding along with this one.

   @param {string}  text
   @param {string} [lang]  the REQUESTED language, when there is one. Omitted,
                           the language is detected from the text — which is a
                           measurement of what was produced, not a guess about
                           what was wanted.
*/
function scoreContent(text, lang) {
  const src = String(text == null ? '' : text);
  const m = textMetrics(src, lang);

  const wordCount = m.words;
  const sentences = m.sentences || 1;
  const avgWordsPerSentence = wordCount / sentences;
  const hasStructure = /#{1,3}\s|^[*-]\s/m.test(src);

  const seoScore = Math.min(100, Math.max(40,
    (wordCount >= 300 ? 25 : Math.floor(wordCount / 12)) +
    (wordCount >= 800 ? 15 : 0) +
    (hasStructure ? 15 : 5) +
    (avgWordsPerSentence < 20 ? 15 : avgWordsPerSentence < 30 ? 10 : 5) + 20
  ));

  return {
    // ── the shape every existing caller reads ────────────────────────────
    wordCount,
    sentences,
    seoScore,
    readability: m.readability,
    // ── additive: how each number was reached ────────────────────────────
    lang: m.lang,
    wordBasis: m.wordBasis,
    readabilityBasis: m.readabilityBasis,
    metrics: m,
  };
}

module.exports = {
  createGenerator,
  scoreContent,
  // Exported for test/trilingual-test.js and for the two call sites that do
  // not pass through generateWithGroq() — /api/chat and the PR GEO score —
  // so that when server.js is edited to cover them it consumes THESE strings
  // rather than growing a second copy of the register guidance.
  buildSystemPrompt,
  variantInstruction,
  stripGenlangDirective,
  resolveRequestedLang,
  toneLabel,
  LANG_DIRECTIVES,
  TONE_LABELS,
  CORRECTION,
  WRONG_LANG_WARNING,
  GENLANG_BLOCK_RE,
};

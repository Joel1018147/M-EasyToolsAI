/* ═══════════════════════════════════════════════════════════════════════════
   GENERATION — the one place this platform turns a prompt into content
   ───────────────────────────────────────────────────────────────────────────
   Extracted from server.js in Round 1. THIS EXTRACTION IS A PURE REFACTOR:
   the behaviour below is byte-for-byte what server.js did, including the
   defects. Behaviour changes belong to the trilingual lane, which owns this
   file from here on; Foundation only moved it, so that a lane could own it
   without owning server.js.

   ── WHY THIS IS THE CHOKE POINT, AND WHY THAT MATTERS ─────────────────────
   Eleven module pages generate content — content, social, mail, ads, seo,
   sales, commerce, audiobook, gao, aichat, pr. Every one of them builds its
   prompt in the browser and posts it to /api/generate, which is a nine-line
   wrapper around generateWithGroq(). So there is ONE place to add language,
   not eleven, and two named exceptions that do not pass through here:

     POST /api/chat        — its own system prompt, its own call
     the GAO scoring call  — server.js, a direct fetch

   Both are listed so the trilingual lane treats them explicitly rather than
   discovering them later.

   ── ECOSYSTEM CONTRACT ────────────────────────────────────────────────────
   The Reusable Module Registry records "AI generation (Groq) — BUILT IN
   M-EasyTools — reuse method: copy generateWithGroq()". This repo is the
   origin of that module for the whole ecosystem, so the exported shape here
   is an interface other platforms have copied, not a local convenience.
   Widening the return value is safe; changing or removing a field is not.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { GROQ_MODEL, chat } = require('./groq');

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
   */
  async function generateWithGroq(user, prompt, toolId, toolName, tone, variants = 1) {
    const key = user.groq_key || groqKey;
    if (!key) throw new Error('Groq API key not configured');

    const fullPrompt = variants > 1
      ? prompt + `\n\nGenerate ${variants} distinct variants labeled: ═══ VARIANT 1 ═══, ═══ VARIANT 2 ═══, etc.`
      : prompt;

    const systemPrompt = `You are M-EasyTools AI, an elite marketing copywriter with 15+ years experience. Tone: ${tone || 'Professional'}. Brand: ${user.brand_desc || 'General marketing'}. Be persuasive, specific, and conversion-focused.`;

    const { text } = await chat({
      apiKey: key,
      model: GROQ_MODEL,
      system: systemPrompt,
      messages: [{ role: 'user', content: fullPrompt }],
      maxTokens: 2500,
      temperature: 0.75,
    });

    const scored = scoreContent(text);

    // Auto-save document
    const doc = await pool.query(
      'INSERT INTO documents (user_id,title,content,tool_id,tool_name,word_count,seo_score,readability) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [user.id, `${toolName || 'Content'} — ${new Date().toLocaleDateString()}`, text, toolId, toolName,
        scored.wordCount, scored.seoScore, scored.readability]
    );

    return {
      text,
      wordCount: scored.wordCount,
      docId: doc.rows[0].id,
      seoScore: scored.seoScore,
      readability: scored.readability,
    };
  }

  return { generateWithGroq };
}

/* ── Deterministic content score ───────────────────────────────────────────
   KNOWN DEFECT, PRESERVED DELIBERATELY BY THIS EXTRACTION.

   split(/\s+/) counts a whole Chinese article as one word, because Chinese
   does not put spaces between words. Measured: a 59-character Chinese
   paragraph returns wordCount 1, seoScore floor(1/12)=0, readability 100.

   helpers/lang.js already carries the script-aware replacement. It is NOT
   wired in here, because Foundation's job was to move this function without
   changing what it does — a refactor that also changes behaviour is a
   refactor nobody can review. The trilingual lane owns this file and closes
   this defect; UPGRADE-SPEC §0.7 and GAUNTLET.md §L record it as in scope. */
function scoreContent(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim()).length || 1;
  const avgWordsPerSentence = wordCount / sentences;
  const hasStructure = /#{1,3}\s|^[*-]\s/m.test(text);

  const seoScore = Math.min(100, Math.max(40,
    (wordCount >= 300 ? 25 : Math.floor(wordCount / 12)) +
    (wordCount >= 800 ? 15 : 0) +
    (hasStructure ? 15 : 5) +
    (avgWordsPerSentence < 20 ? 15 : avgWordsPerSentence < 30 ? 10 : 5) + 20
  ));

  const syllables = text.split(/\s+/).reduce(
    (acc, w) => acc + Math.max(1, w.replace(/[^aeiouy]/gi, '').length), 0);
  const readability = Math.min(100, Math.max(30, Math.round(
    206.835 - 1.015 * avgWordsPerSentence - 84.6 * (syllables / (wordCount || 1))
  )));

  return { wordCount, sentences, seoScore, readability };
}

module.exports = { createGenerator, scoreContent };

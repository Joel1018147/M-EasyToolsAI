'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   THE FOUR GUARDS.                                       lib/docintel/guards.js
   GAUNTLET.md §H · UPGRADE-SPEC.md §1.2
   ───────────────────────────────────────────────────────────────────────────
   The design is M-EasyDo's `lib/docintel/guards.js`, read as a reference
   pattern and re-authored here against this platform's own field map. That
   repository is not touched from here.

     GUARD 1 · THE MODEL IS A LOCATOR, NEVER A SOURCE. It names a field and
       quotes the document; the value that gets written is then SLICED OUT OF
       THE DOCUMENT'S OWN TEXT by `sliceValue()` below, at the offsets where
       the quote was found. `model_value` — what the model typed — is stored
       for the audit trail and is NEVER what reaches a column. A model that
       quotes a real sentence and then types a different number gets nothing:
       the typed value is not inside the quote, so the proposal dies.

     GUARD 2 · EVERY PROPOSAL NEEDS A VERBATIM QUOTE, looked up in the
       document's own extracted text — whitespace-collapsed and case-folded so
       a PDF line wrap cannot fail a correct quote. Not found, or too short to
       be evidence, and it is auto-rejected before any person sees it.
       Unevidenced proposals are dropped, never guessed.

     GUARD 3 · AN UNKNOWN FIELD KEY OR AN UNPARSEABLE VALUE IS DROPPED, not
       coerced. There is no branch anywhere in this feature that builds a
       column name out of model output: `fieldMap.getField()` returns a
       definition a person authored, or null. A value the field's normaliser
       refuses is dropped with the refusal recorded.

     GUARD 4 · A VERIFIED PROPOSAL IS STILL A PROPOSAL. Nothing in this file
       writes to a business table. Everything it produces is a row in
       docintel_proposals with status 'pending', and only service.js's
       acceptProposal() — one field, one server-issued nonce, one human —
       turns one of those into a write.

   ── WHY THE REJECTIONS ARE KEPT ───────────────────────────────────────────
   A rejected claim is evidence about the model's reliability ON THIS
   DOCUMENT. They are stored with status 'auto_rejected' and a reason, and the
   review page shows them, so a reviewer can see when extraction is going
   badly instead of seeing a short clean list and assuming the document was
   thin. The migration's own comment on that column says the same thing.
   ═══════════════════════════════════════════════════════════════════════════ */

const { getField } = require('./fieldMap');

/* A quote shorter than this is not evidence. "Name", "Tel" and "Region" appear
   on every form ever printed, and a model can satisfy a naive substring check
   with one common word. */
const MIN_QUOTE_CHARS = 25;

/* An upper bound so a model cannot "evidence" a field by quoting the whole
   document back. Evidence a human cannot read at a glance is not evidence. */
const MAX_QUOTE_CHARS = 400;

/**
 * Whitespace-collapsed, case-folded text, PLUS the index of the original
 * character each canonical character came from.
 *
 * The index is what makes GUARD 1 possible. Matching happens on the canonical
 * form, so a quote broken across a PDF line wrap still matches; the value that
 * gets WRITTEN is then cut from the ORIGINAL text at the mapped offsets, so it
 * keeps the document's own capitalisation and punctuation rather than the
 * model's rendering of them.
 */
function canonWithIndex(s) {
  const src = String(s == null ? '' : s);
  const chars = [];
  const idx = [];
  let prevSpace = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ') {
      if (!prevSpace) { chars.push(' '); idx.push(i); prevSpace = true; }
      continue;
    }
    chars.push(c.toLowerCase());
    idx.push(i);
    prevSpace = false;
  }
  while (chars.length && chars[chars.length - 1] === ' ') { chars.pop(); idx.pop(); }
  idx.push(src.length);                       // sentinel, so an end offset maps
  return { text: chars.join(''), idx, src };
}

/** The canonical form on its own — the comparison key, nothing more. */
const canon = (s) => canonWithIndex(s).text;

/**
 * GUARD 2. Locate a quote in the document.
 *
 * Checked block by block against the WHOLE block, so a correct quote is not
 * rejected merely because the extractor split a line oddly.
 *
 * Returns {block, start, end, verbatim} on success — `verbatim` being the
 * DOCUMENT'S own text at those offsets, not the model's copy of it — or
 * {reason} naming which check failed. "Too short" and "not found" are kept
 * apart deliberately: one is a model being lazy and quoting a common word, the
 * other is a model that fabricated the sentence, and an auditor reading the
 * rejection list needs to tell them apart.
 */
function locateQuote(quote, blocks) {
  const q = canon(quote);
  if (q.length < MIN_QUOTE_CHARS) {
    return { reason: `the quote is ${q.length} characters; at least ${MIN_QUOTE_CHARS} are needed to be evidence` };
  }
  if (q.length > MAX_QUOTE_CHARS) {
    return { reason: `the quote is ${q.length} characters; at most ${MAX_QUOTE_CHARS} can be read at a glance` };
  }
  const list = Array.isArray(blocks) ? blocks : [];
  for (let b = 0; b < list.length; b++) {
    const c = canonWithIndex(list[b]);
    const at = c.text.indexOf(q);
    if (at === -1) continue;
    const start = c.idx[at];
    const end = c.idx[at + q.length - 1] + 1;
    return { block: b, start, end, verbatim: c.src.slice(start, end) };
  }
  return { reason: 'the quote does not appear anywhere in the text extracted from this document' };
}

/**
 * GUARD 1. Cut the value out of the document.
 *
 * `located` is what locateQuote() returned. `modelValue` is what the model
 * typed. This finds the model's value INSIDE the located quote span and
 * returns the DOCUMENT'S own characters at that position. If it is not in
 * there, nothing is returned and the proposal dies — that is the check that
 * stops a model quoting "Spokesperson: Aisyah Rahman, Kuala Lumpur" and then
 * proposing the spokesperson "Nurul Hidayah".
 */
function sliceValue(modelValue, located, blocks) {
  const wanted = canon(modelValue);
  if (!wanted) return { reason: 'the model proposed an empty value' };
  const block = (Array.isArray(blocks) ? blocks : [])[located.block];
  if (typeof block !== 'string') return { reason: 'the quote was located in a block that is no longer readable' };
  const quoteSrc = block.slice(located.start, located.end);
  const c = canonWithIndex(quoteSrc);
  const at = c.text.indexOf(wanted);
  if (at === -1) {
    return { reason: 'the proposed value does not appear inside the quote the model gave as its evidence' };
  }
  const start = c.idx[at];
  const end = c.idx[at + wanted.length - 1] + 1;
  return { raw: c.src.slice(start, end) };
}

/**
 * GUARD 3, the parse.
 *
 * One line per proposal: `field|verbatim quote|value`. Anything that does not
 * match the shape, or names a field the category does not have, is DISCARDED
 * rather than repaired. Nothing here turns a field name into a column name;
 * `getField` either returns a definition authored in fieldMap.js, or null.
 *
 * A `dropped` entry is returned for every line the guards can name, so the
 * caller can persist it as evidence about the model rather than losing it.
 */
function parseProposals(reply, categoryKey) {
  const kept = [];
  const dropped = [];
  for (const raw of String(reply == null ? '' : reply).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\s*"?([A-Za-z_][A-Za-z0-9_]{0,40})"?\s*\|\s*(.+?)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!m) { dropped.push({ line: line.slice(0, 200), reason: 'the line is not `field|quote|value`' }); continue; }
    const fieldKey = m[1].trim();
    if (!getField(categoryKey, fieldKey)) {
      dropped.push({
        line: line.slice(0, 200),
        fieldKey,
        reason: `"${fieldKey}" is not a field of ${categoryKey} in M-EasyTools' field map`,
      });
      continue;
    }
    const quote = m[2].replace(/^["'`]|["'`]$/g, '').trim();
    const value = m[3].replace(/^["'`]|["'`]$/g, '').trim();
    if (!quote || !value) { dropped.push({ line: line.slice(0, 200), fieldKey, reason: 'empty quote or value' }); continue; }
    kept.push({ fieldKey, quote, value });
  }
  return { kept, dropped };
}

/**
 * Guards 1–3 run end to end over one parsed line.
 *
 * Returns either
 *   {ok:true,  fieldKey, evidenceQuote, evidenceBlock, rawValue, normalisedValue, modelValue}
 * or
 *   {ok:false, fieldKey, reason, modelValue, evidenceQuote}
 *
 * There is no third answer and no partial one. A caller cannot accidentally
 * treat a rejection as a proposal, because the fields that carry the value
 * only exist on the ok:true shape.
 */
function verify(parsed, categoryKey, blocks) {
  const field = getField(categoryKey, parsed.fieldKey);
  if (!field) {
    return { ok: false, fieldKey: String(parsed.fieldKey), modelValue: parsed.value, evidenceQuote: parsed.quote,
             reason: `"${parsed.fieldKey}" is not a field of ${categoryKey} in M-EasyTools' field map` };
  }

  const located = locateQuote(parsed.quote, blocks);                       // GUARD 2
  if (!located.verbatim) {
    return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value, evidenceQuote: parsed.quote,
             reason: located.reason };
  }

  const sliced = sliceValue(parsed.value, located, blocks);                // GUARD 1
  if (!sliced.raw) {
    return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value, evidenceQuote: located.verbatim,
             reason: sliced.reason };
  }

  const normalised = field.normalise(sliced.raw);                          // GUARD 3
  if (!Object.prototype.hasOwnProperty.call(normalised, 'value')) {
    return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value, evidenceQuote: located.verbatim,
             reason: `the document says ${JSON.stringify(sliced.raw)} and that is ${normalised.reason}` };
  }

  return {
    ok: true,
    fieldKey: parsed.fieldKey,
    evidenceQuote: located.verbatim,      // the DOCUMENT's characters, not the model's
    evidenceBlock: located.block,
    rawValue: sliced.raw,                 // the DOCUMENT's characters, not the model's
    normalisedValue: normalised.value,
    modelValue: parsed.value,             // kept ONLY so the audit row can show what it typed
  };
}

module.exports = {
  canon, canonWithIndex, locateQuote, sliceValue, parseProposals, verify,
  MIN_QUOTE_CHARS, MAX_QUOTE_CHARS,
};

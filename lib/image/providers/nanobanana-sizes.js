/* ═══════════════════════════════════════════════════════════════════════════
   NANOBANANA SIZES — this provider's own legal set, not DashScope's
   ───────────────────────────────────────────────────────────────────────────
   ../sizes.js is DashScope's file: five `width*height` strings with an
   asterisk, measured against that vendor's live API. Google's Nano Banana 2
   Lite (served here via fal.ai, ../providers/nanobanana.js) takes a
   completely different shape — an `aspect_ratio` enum string like `16:9` —
   so per ../provider.js's own interface contract ("legalSizes() ... brings
   its own; nothing here assumes DashScope's five"), it gets its own file
   rather than a special case bolted onto the DashScope one.

   THE SET BELOW IS A CURATED SUBSET of fal.ai's documented enum for this
   model (`auto, 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 4:1, 1:4,
   8:1, 1:8` — fal.ai model docs, read 2026-09-18), not the whole thing:

     - `auto` is excluded on purpose. It is not a concrete size — it asks the
       model to pick — and this platform's whole design is that a caller who
       named no size still gets a NAMED, published default (mirroring
       ../sizes.js's `1328*1328`), never a value nobody can point to before
       the fact.
     - The extreme banner ratios (`4:1`, `1:4`, `8:1`, `1:8`) are excluded
       because nothing in this platform's UI or prompt surfaces asks for a
       banner strip, and an unused legal value is a value nobody has tested
       end to end.

   The five kept are the same five ORIENTATIONS ../sizes.js offers — square,
   wide landscape, landscape, portrait, tall portrait — so swapping the
   default provider does not also silently remove a shape the picker already
   offered. All five are verbatim values from fal.ai's own enum above; none is
   invented.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const LEGAL_SIZES = Object.freeze([
  '16:9',  // wide landscape
  '4:3',   // landscape
  '1:1',   // square — the default
  '3:4',   // portrait
  '9:16',  // tall portrait
]);

const LEGAL_SIZE_SET = new Set(LEGAL_SIZES);

/** The square, matching ../sizes.js's own choice of the square as the default. */
const DEFAULT_SIZE = '1:1';

function parseRatio(size) {
  if (typeof size !== 'string') return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(size.trim());
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

function describeSize(size) {
  const parsed = parseRatio(size);
  if (!parsed) return null;
  const { w, h } = parsed;
  const orientation = w === h ? 'square' : w > h ? 'landscape' : 'portrait';
  return { size, width: w, height: h, orientation, megapixels: null };
}

/** All legal aspect ratios with their derived descriptions. What /options hands a UI. */
function catalogue() {
  return LEGAL_SIZES.map(describeSize);
}

function isLegalSize(size) {
  return typeof size === 'string' && LEGAL_SIZE_SET.has(size.trim());
}

/**
 * Resolve a caller-supplied size, or the default when none was supplied.
 *
 * Mirrors ../sizes.js's resolveSize() exactly in shape and in NOT being
 * forgiving: an aspect ratio this model does not offer is refused with the
 * legal set attached, never silently substituted, for the same reason
 * ../sizes.js gives — a caller whose stored preset is wrong deserves to find
 * out, not to keep succeeding against a shape it never asked for.
 *
 * @returns {{ok: true, size: string} | {ok: false, code: string, message: string, legal: string[]}}
 */
function resolveSize(requested) {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, size: DEFAULT_SIZE };
  }
  if (typeof requested !== 'string') {
    return {
      ok: false,
      code: 'illegal_size',
      message: 'size must be a string aspect ratio of the form width:height.',
      legal: LEGAL_SIZES.slice(),
    };
  }
  const trimmed = requested.trim();
  if (LEGAL_SIZE_SET.has(trimmed)) return { ok: true, size: trimmed };

  // Name the specific mistake, matching ../sizes.js's "you used an x" courtesy:
  // the DashScope shape (`1328*1328`) is the size format most likely to arrive
  // here from a caller written against the OTHER provider, or from a stale
  // preset saved back when DashScope was the default.
  const looksLikeDashScope = /^\d{2,5}\s*\*\s*\d{2,5}$/.test(trimmed);
  const message = looksLikeDashScope
    ? `"${trimmed}" is a DashScope pixel size, not an aspect ratio — this provider takes width:height, ` +
      `e.g. "16:9". Legal values: ${LEGAL_SIZES.join(', ')}.`
    : `"${trimmed}" is not one of the aspect ratios this model offers. Legal values: ${LEGAL_SIZES.join(', ')}.`;

  return { ok: false, code: 'illegal_size', message, legal: LEGAL_SIZES.slice() };
}

/** Throwing form, for internal call sites that have already validated. */
function assertLegalSize(size) {
  const r = resolveSize(size);
  if (!r.ok) {
    const err = new Error(r.message);
    err.code = r.code;
    err.legal = r.legal;
    throw err;
  }
  return r.size;
}

module.exports = {
  LEGAL_SIZES,
  DEFAULT_SIZE,
  parseRatio,
  isLegalSize,
  resolveSize,
  assertLegalSize,
  describeSize,
  catalogue,
};

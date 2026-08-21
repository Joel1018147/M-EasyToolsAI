/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE SIZES — the one place that knows what this model family will accept
   ───────────────────────────────────────────────────────────────────────────
   MEASURED, NOT READ OFF A DOC PAGE. UPGRADE-SPEC §0.9: Alibaba's own
   documentation says this model family accepts anything in the range
   512×512–2048×2048. The live service, probed with the real key on
   2026-08-21, disagrees:

     InvalidParameter: The size does not match the allowed size
     1664*928,1472*1104,1328*1328,1104*1472,928*1664.

   So `1024*1024` — the value every example on the internet uses, and the
   value a model would reach for from memory — IS REJECTED. It is not a
   degradation, it is a 400 on every single call.

   TWO SEPARATE FACTS, AND BOTH BREAK THE INTEGRATION ON THEIR OWN:

     1. The SEPARATOR is an ASTERISK. `1328x1328` is not this API's format.
     2. The VALUE must be one of exactly five. A legal separator around an
        illegal value fails just as hard as an illegal separator.

   WHY THE VALIDATION IS LOCAL AND NOT LEFT TO THE API. A 400 from DashScope
   is free in money terms, but it is not free in every other term: it costs a
   round trip, it arrives as a vendor error string the user cannot act on, and
   — the part that actually matters — it teaches the code nothing. Rejecting
   here means the caller gets the legal set back in the error body, so the
   next request is right. See `assertLegalSize`.

   THIS FILE IS THE SINGLE SOURCE OF TRUTH. `.env.example` deliberately does
   NOT list the legal set; it points here. A second copy of these five strings
   anywhere is a second thing to forget to update the day Alibaba adds a
   sixth.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * The only values this model family accepts, in the API's own order.
 * Frozen so a caller cannot mutate the shared array and widen the guard for
 * every other caller in the process.
 */
const LEGAL_SIZES = Object.freeze([
  '1664*928',   // landscape 16:9-ish
  '1472*1104',  // landscape 4:3
  '1328*1328',  // square — the default
  '1104*1472',  // portrait 3:4
  '928*1664',   // portrait 9:16
]);

const LEGAL_SIZE_SET = new Set(LEGAL_SIZES);

/**
 * The square. Chosen as the default because it is the middle of the set and
 * the one measured end to end in §0.9 across all four models.
 */
const DEFAULT_SIZE = '1328*1328';

/**
 * Human-facing aspect labels, derived from the strings themselves rather than
 * written out a second time — so adding a size to LEGAL_SIZES cannot leave a
 * label behind (recurring-bugs #24: derive the subject list, never enumerate
 * it twice).
 */
function describeSize(size) {
  const parsed = parseSize(size);
  if (!parsed) return null;
  const { width, height } = parsed;
  const orientation = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
  return { size, width, height, orientation, megapixels: Math.round((width * height) / 10000) / 100 };
}

/** All legal sizes with their derived descriptions. What the API hands a UI. */
function catalogue() {
  return LEGAL_SIZES.map(describeSize);
}

/**
 * Split `width*height`. Returns null for anything that is not exactly that
 * shape — including `1328x1328`, which is the spelling this integration is
 * most likely to be given by a caller working from memory or from another
 * vendor's API.
 */
function parseSize(size) {
  if (typeof size !== 'string') return null;
  const m = /^(\d{2,5})\*(\d{2,5})$/.exec(size.trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function isLegalSize(size) {
  return typeof size === 'string' && LEGAL_SIZE_SET.has(size.trim());
}

/**
 * Resolve a caller-supplied size, or the default when none was supplied.
 *
 * DELIBERATELY NOT FORGIVING. An `x` is not silently rewritten to a `*`, and
 * `1024*1024` is not silently snapped to the nearest legal square. Both would
 * be helpful exactly once and then hide the fact that the caller's stored
 * preset is wrong — the request would keep succeeding while the size the user
 * actually asked for was never honoured. Reject and say what is legal.
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
      message: 'size must be a string of the form width*height.',
      legal: LEGAL_SIZES.slice(),
    };
  }
  const trimmed = requested.trim();
  if (LEGAL_SIZE_SET.has(trimmed)) return { ok: true, size: trimmed };

  // Name the specific mistake. "Invalid size" tells the caller nothing they
  // did not already know; "you used an x" is a fix.
  const usedX = /^\d{2,5}\s*[xX×]\s*\d{2,5}$/.test(trimmed);
  const parsed = parseSize(trimmed);
  const message = usedX
    ? `size must use an asterisk, not an "x" — this API's format is width*height. ` +
      `Legal values: ${LEGAL_SIZES.join(', ')}.`
    : parsed
      ? `${trimmed} is not one of the sizes this model family accepts. ` +
        `Legal values: ${LEGAL_SIZES.join(', ')}.`
      : `size must be one of ${LEGAL_SIZES.join(', ')}.`;

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
  parseSize,
  isLegalSize,
  resolveSize,
  assertLegalSize,
  describeSize,
  catalogue,
};

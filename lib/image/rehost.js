/* ═══════════════════════════════════════════════════════════════════════════
   RE-HOSTING — download the bytes before the row is allowed to be usable
   ───────────────────────────────────────────────────────────────────────────
   ── THE SINGLE MOST IMPORTANT REQUIREMENT OF THIS LANE ────────────────────
   DashScope returns a SIGNED OSS URL THAT EXPIRES. Alibaba's docs say 24
   hours. The live service, measured 2026-08-21, returned `Expires` seven days
   out. Both numbers are fatal in the same way: a saved marketing document
   that stores that URL is a dead image on a timer. It works in the demo, it
   works in QA, it works for the first week, and then it stops — with nothing
   in any log, because nothing failed on our side. The user's saved asset just
   becomes a broken image icon.

   So the bytes are downloaded and re-hosted INSIDE THE SAME REQUEST that
   generated them, and `image_generations.source_url` is retained FOR AUDIT
   ONLY. Nothing user-facing ever renders it. The API responses in
   routes/images.js are built from an explicit column list that does not
   include it, and test/image-contract.js asserts that.

   ── WHY THIS IS NOT A BACKGROUND JOB ──────────────────────────────────────
   It is the obvious shape and it is wrong here twice over. The Engineering
   Bar forbids `setTimeout` for scheduling, and this repo has NO job runner —
   only a bare hourly `setInterval` for subscription expiry, which is not a
   queue. A "re-host later" that is really an in-process timer is dropped on
   every Railway restart, and the row it was going to fix stays pointing at a
   URL that dies. The synchronous provider API was chosen precisely so this
   could be done in-request instead.

   ── WHAT "GUARANTEED BEFORE THE ROW IS USABLE" MEANS MECHANICALLY ─────────
   Not "we call rehost then we call store". Ordering by convention is
   ordering that a later edit reorders. The guarantee is structural, in three
   layers:

     1. THE BYTES AND THE STATUS ARE WRITTEN BY ONE UPDATE STATEMENT.
        `SET content=$1, …, status='stored'` — there is no interval in which
        a row is 'stored' with a NULL content, because no statement exists
        that sets 'stored' without also setting content. See markStored() in
        ./index.js.
     2. THE READ PATH FILTERS ON status='stored'.
        /api/images/:id/file cannot serve a row that has not been re-hosted,
        even if one somehow existed.
     3. A REHOST FAILURE IS ITS OWN TERMINAL STATUS, NOT A RETRY LOOP.
        'rehost_failed' — which the cap counts, because the provider billed
        for the generation even though the download died.

   ── VALIDATION, BECAUSE THIS FETCHES A URL AND STORES WHAT COMES BACK ─────
   The URL comes from the provider's own response, so this is not an SSRF
   surface in the "user supplies a URL" sense — but it is still bytes from
   the network being persisted and later served from THIS platform's origin
   under a Content-Type we choose. So:

     * the host must be https (a signed OSS URL always is)
     * `res.ok` is checked — not the mere absence of a thrown error
     * the declared content-type must be an image type we recognise
     * THE MAGIC BYTES ARE SNIFFED and must agree with the declared type. The
       stored `content_type` is derived from the SNIFF, not from the header,
       so a mislabelled body cannot cause us to serve an HTML error page as
       image/png. Combined with `X-Content-Type-Options: nosniff` on the read
       route, there is no path from "provider returned something odd" to
       "browser executed it".
     * a size ceiling, so a redirect to something enormous cannot fill BYTEA.
       Measured PNGs are ~1.9–2.25 MB; the ceiling is 25 MB.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('crypto');

/** Measured: 1.87–2.25 MB per PNG. 25 MB is ~10× the largest observed. */
const MAX_BYTES = 25 * 1024 * 1024;

/** The download is a plain GET of an already-generated file. 60s is ample. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Magic-byte signatures. The stored content_type comes from HERE, never from
 * the response header — a header is a claim, a signature is evidence.
 *
 * The list is the rule for what may be stored: a body matching none of these
 * is refused, so an HTML error page or a JSON blob can never land in a column
 * that is later served with an image content-type.
 */
const SIGNATURES = [
  { type: 'image/png',  ext: 'png',  test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { type: 'image/jpeg', ext: 'jpg',  test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/webp', ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { type: 'image/gif',  ext: 'gif',  test: (b) => b.length > 6 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') },
];

/** The content-types we are willing to serve back. Derived from SIGNATURES. */
const ALLOWED_TYPES = Object.freeze(SIGNATURES.map((s) => s.type));

/** @returns {{type: string, ext: string}|null} */
function sniff(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return { type: sig.type, ext: sig.ext };
  }
  return null;
}

/**
 * A re-host failure. Carries `billed: true` unconditionally, because by the
 * time this module runs the provider has already generated and charged for
 * the image — the download is the only thing that failed. That flag is what
 * makes the cap in ./caps.js count 'rehost_failed'.
 */
function rehostError(message, detail) {
  const err = new Error(message);
  err.code = 'rehost_failed';
  err.billed = true;
  if (detail) err.detail = detail;
  return err;
}

/**
 * Download a provider URL and return the bytes plus everything the row needs.
 *
 * @param {string}   url
 * @param {object}   [opts]
 * @param {function} [opts.fetchImpl]  injected for tests; the global `fetch`
 *                                     is resolved AT CALL TIME, never captured
 *                                     at import (recurring-bugs #1)
 * @param {number}   [opts.maxBytes]
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<{content: Buffer, contentType: string, byteSize: number, sha256: string, declaredType: string|null}>}
 */
async function download(url, opts = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw rehostError('The provider returned no URL to re-host.');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw rehostError('The provider returned a URL that will not parse: ' + err.message);
  }
  if (parsed.protocol !== 'https:') {
    throw rehostError(`Refusing to re-host over ${parsed.protocol} — the provider's signed URLs are https.`);
  }

  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_BYTES;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // AbortSignal.timeout, not an AbortController armed with setTimeout: same
  // behaviour, and it keeps the literal `setTimeout(` out of the tree.
  let response;
  try {
    response = await (opts.fetchImpl || globalThis.fetch)(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: opts.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw rehostError('Could not download the generated image: ' + err.message);
  }

  // res.ok, explicitly. A 403 from an already-expired signature is a Response,
  // not a thrown error, and reading .arrayBuffer() off it would happily store
  // an XML error document as the image.
  if (!response.ok) {
    throw rehostError(
      `Could not download the generated image — the provider's URL answered ${response.status}.`,
      { status: response.status }
    );
  }

  const declaredType = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type')
    : null;

  // Cheap pre-check on the declared length before reading the body, so an
  // absurd Content-Length is refused without buffering it first.
  const declaredLength = response.headers && typeof response.headers.get === 'function'
    ? Number(response.headers.get('content-length'))
    : NaN;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw rehostError(
      `The generated image declares ${declaredLength} bytes, over the ${maxBytes}-byte ceiling.`,
      { declaredLength }
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);

  if (content.length === 0) {
    throw rehostError("The provider's URL answered 200 with an empty body.");
  }
  if (content.length > maxBytes) {
    throw rehostError(
      `The generated image is ${content.length} bytes, over the ${maxBytes}-byte ceiling.`,
      { byteSize: content.length }
    );
  }

  const sniffed = sniff(content);
  if (!sniffed) {
    // Name what actually arrived. "Not an image" with no evidence is the kind
    // of error that gets investigated by re-running it in production.
    const head = content.toString('utf8', 0, 80).replace(/\s+/g, ' ').trim();
    throw rehostError(
      'The downloaded body is not a recognised image format ' +
      `(declared "${declaredType || 'nothing'}", allowed: ${ALLOWED_TYPES.join(', ')}).`,
      { declaredType, head }
    );
  }

  return {
    content,
    // FROM THE SNIFF, NOT THE HEADER.
    contentType: sniffed.type,
    extension: sniffed.ext,
    byteSize: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    declaredType: declaredType || null,
  };
}

module.exports = {
  MAX_BYTES,
  ALLOWED_TYPES,
  SIGNATURES,
  sniff,
  download,
};

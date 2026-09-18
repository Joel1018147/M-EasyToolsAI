/* ═══════════════════════════════════════════════════════════════════════════
   NANOBANANA (Google Nano Banana 2 Lite, via fal.ai) — the default image
   provider as of 2026-09-18, replacing DashScope/Qwen-Image on Joel's call
   ("qwen generates ai slop").
   ───────────────────────────────────────────────────────────────────────────
   ONE PROVIDER BEHIND ONE INTERFACE, same as ../providers/dashscope.js: the
   host, the path, the request envelope, the response shape, and this
   provider's two vendor-specific gotchas all live in this one file.
   `routes/images.js` never mentions "nanobanana" or "fal" — see
   ../provider.js.

   ── THE CONTRACT, PER fal.ai's OWN MODEL PAGE, READ 2026-09-18 ───────────
   NOT YET MEASURED against a real key — see docs/BUILD_BRIEF_NANOBANANA_SWAP.md
   §2 claim 1. Documented, not verified, and the file says so rather than
   claiming otherwise.

     POST https://fal.run/google/nano-banana-2-lite
     Authorization: Key $FAL_API_KEY
     Content-Type: application/json

     { "prompt": "<prompt, plus an appended Avoid: clause — see below>",
       "aspect_ratio": "1:1",
       "num_images": 1,
       "output_format": "png" }

   Response: `images[]`, an array of `{ url, content_type, file_name, ... }`.
   Read by SEARCHING the array for the first entry carrying a string `url`,
   never by indexing `images[0]` — the same discipline as DashScope's
   `extractImageUrl`, and for the same reason: an ordering assumption that
   holds today costs a paid generation the day it stops holding.

   ── TWO FACTS THAT BREAK THIS IF THEY ARE "CORRECTED" FROM MEMORY ─────────
   1. THERE IS NO NATIVE `negative_prompt` PARAMETER. fal.ai's documented
      input schema for this model is prompt / aspect_ratio / num_images /
      seed / output_format / safety_tolerance / sync_mode / thinking_level —
      no negative-prompt field, because the underlying Gemini image model
      is not a diffusion model with CFG-style negative conditioning the way
      Qwen-Image is. So a caller's negative prompt is folded into the TEXT
      prompt as a visible "Avoid: …" clause (buildBody, below) rather than
      silently dropped — RULE 6a: finish the path, do not launder a missing
      feature into a fallback that pretends the field was honoured. This
      means the text actually sent to the vendor is NOT always
      byte-identical to `image_generations.prompt` the way it is for
      DashScope — see index.js's `baseFields.prompt` and the note in
      test/image-contract.js §2c. The negative prompt itself is still
      recorded verbatim in `image_generations.negative_prompt`, so nothing
      about what was asked for is lost from the audit row; it is simply
      carried by a different column than the exact provider payload for
      THIS provider, exactly as the schema already allows.
   2. `sync_mode` MUST STAY UNSET/false. Setting it true makes fal.ai return
      the image as an inline base64 `data:` URI instead of a hosted https
      URL. ../rehost.js REFUSES anything that is not `https:` on principle
      (SSRF-adjacent hardening, not specific to this vendor), so a data: URI
      here would not "work a little worse" — it would make EVERY generation
      fail rehosting. Never add `sync_mode: true` to buildBody without
      teaching ../rehost.js to accept a data URI first.

   ── EXPIRY IS UNKNOWN, NOT ASSUMED ZERO ───────────────────────────────────
   Unlike DashScope's signed OSS URL, fal.ai's own docs do not document a
   query-string expiry on the media URL this model returns. `extractExpiry`
   here always returns null rather than guessing a number — ./rehost.js does
   not gate on this value (it downloads unconditionally, in the same request,
   regardless of whether or when a URL might expire), so an honest "we do not
   know" costs nothing and an invented number would be a fact this file does
   not have.

   ── LAZY CONSTRUCTION (recurring-bugs #1) ─────────────────────────────────
   No client object, no key read, and no config resolution happens at import
   time — identical discipline to dashscope.js. `create()` is called per
   request; everything reads `process.env` inside a function.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { has } = require('../../../helpers/capabilities');
const sizes = require('./nanobanana-sizes');

const PROVIDER_NAME = 'nanobanana';

/** fal.ai's synchronous REST host. Overridable, never hardcoded at a call site. */
const DEFAULT_BASE_URL = 'https://fal.run';

/** The model slug IS the path fal.ai routes on: POST {base}/{model}. */
const DEFAULT_MODEL = 'google/nano-banana-2-lite';

/** Documented ~4s generations (fal.ai, read 2026-09-18). 60s is generous. */
const DEFAULT_TIMEOUT_MS = 60_000;

const ENV = Object.freeze({
  key: 'FAL_API_KEY',
  baseUrl: 'FAL_BASE_URL',
  model: 'FAL_MODEL',
});

/** Resolve the base URL at CALL time, trailing slash stripped. */
function resolveBaseUrl() {
  const raw = process.env[ENV.baseUrl];
  const base = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

/** Resolve the model at CALL time. */
function resolveModel() {
  const raw = process.env[ENV.model];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_MODEL;
}

/**
 * The clause folded into the prompt for a supplied negative prompt, because
 * this model has no native negative-prompt parameter (see header §1). Kept as
 * a named function so buildBody's shape is exactly what a test can assert
 * without a network call.
 */
function withAvoidClause(prompt, negativePrompt) {
  if (typeof negativePrompt !== 'string' || negativePrompt.trim() === '') return prompt;
  return prompt + '\n\nAvoid: ' + negativePrompt.trim();
}

/**
 * Find the URL in `images[]`. A search, not an index — see header.
 * @returns {{url: string|null, note: string|null}}
 */
function extractImageUrl(payload) {
  const images = payload && payload.images;
  if (!Array.isArray(images) || images.length === 0) {
    return { url: null, note: 'response carried no images[] array' };
  }
  for (const entry of images) {
    if (entry && typeof entry.url === 'string' && entry.url.trim() !== '') {
      return { url: entry.url.trim(), note: null };
    }
  }
  return { url: null, note: 'no entry in images[] carried a "url" key' };
}

/** fal.ai does not document an expiring signed URL for this model. See header. */
function extractExpiry() {
  return null;
}

/**
 * A provider error that carries whether the money was spent — same contract
 * as dashscope.js's providerError, so ../../index.js's classification logic
 * (billed vs not) needs no provider-specific branch.
 */
function providerError(message, { status = null, code = null, requestId = null, billed = false } = {}) {
  const err = new Error(message);
  err.provider = PROVIDER_NAME;
  err.providerStatus = status;
  err.providerCode = code;
  err.providerRequestId = requestId;
  err.billed = billed;
  return err;
}

/**
 * Construct a client. LAZILY — call this per request, never at module scope.
 *
 * @param {object}   [opts]
 * @param {function} [opts.fetchImpl]  injected for tests
 * @param {number}   [opts.timeoutMs]
 */
function create(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    name: PROVIDER_NAME,

    /** has() semantics: EXISTS is not HAS A VALUE. See helpers/capabilities.js. */
    isConfigured() {
      return has(ENV.key);
    },

    missingVars() {
      return has(ENV.key) ? [] : [ENV.key];
    },

    legalSizes() {
      return sizes.LEGAL_SIZES.slice();
    },

    defaultSize() {
      return sizes.DEFAULT_SIZE;
    },

    /** This provider's own size vocabulary — see ../index.js's per-provider delegation. */
    resolveSize(requested) {
      return sizes.resolveSize(requested);
    },

    sizeCatalogue() {
      return sizes.catalogue();
    },

    model() {
      return resolveModel();
    },

    endpoint() {
      return resolveBaseUrl() + '/' + resolveModel();
    },

    /**
     * Build the exact request body. Exposed separately from `generate` so a
     * test can assert the wire shape without a network call and without a
     * paid generation.
     */
    buildBody({ prompt, negativePrompt, size, n = 1 }) {
      const legalSize = sizes.assertLegalSize(size);
      return {
        prompt: withAvoidClause(String(prompt), negativePrompt),
        aspect_ratio: legalSize,
        num_images: n,
        // Fixed, deliberately: rehost.js sniffs magic bytes rather than
        // trusting a declared content-type, but requesting a format we
        // actually test against (png, matching dashscope's output and
        // rehost.js's SIGNATURES) is still the honest default rather than
        // leaving it to the vendor's own default.
        output_format: 'png',
        // sync_mode intentionally ABSENT — see header §2. Adding it here
        // without first teaching rehost.js to accept a data: URI breaks
        // every generation's re-hosting step.
      };
    },

    /**
     * One synchronous generation. fal.ai's own docs describe ~4s latency for
     * this model, so as with DashScope, NO JOB QUEUE and NO setTimeout are
     * introduced anywhere in this lane.
     *
     * @returns {Promise<{url, expiresAt, requestId, model, size, raw}>}
     */
    async generate({ prompt, negativePrompt, size, n = 1, signal }) {
      const apiKey = process.env[ENV.key];
      if (!has(ENV.key)) {
        throw providerError(
          'FAL_API_KEY is not set to a non-empty value; image generation is unavailable on this deployment.',
          { code: 'not_configured' }
        );
      }

      const body = this.buildBody({ prompt, negativePrompt, size, n });
      const url = this.endpoint();

      let response;
      try {
        response = await (opts.fetchImpl || globalThis.fetch)(url, {
          method: 'POST',
          headers: {
            Authorization: 'Key ' + apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: signal || AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A transport failure never reached the model, so nothing was billed.
        throw providerError(
          `Could not reach the image provider at ${url}: ${err.message}`,
          { code: 'transport', billed: false }
        );
      }

      const requestId = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('x-fal-request-id')
        : null;

      if (!response.ok) {
        // Read as text first — a gateway HTML page thrown at .json() surfaces
        // as a parse error, which names the wrong problem. Same reasoning as
        // dashscope.js and helpers/groq.js, kept consistent on purpose.
        const raw = await response.text();
        let code = null;
        let message = null;
        const trimmed = raw.trimStart();
        if (trimmed.startsWith('{')) {
          const parsed = parseJsonOrNull(raw);
          if (parsed) {
            code = (parsed.error && parsed.error.type) || parsed.code || null;
            message = (parsed.error && parsed.error.message) || parsed.message || parsed.detail || null;
          }
        }
        const snippet = raw.trim().slice(0, 300).replace(/\s+/g, ' ');
        throw providerError(
          `Image provider returned ${response.status}` +
          (code ? ` ${code}` : '') +
          (message ? `: ${message}` : snippet ? ` — ${snippet}` : ''),
          // Assumed not billed on a non-2xx, matching dashscope.js's policy.
          // NOT verified end-to-end against fal.ai's real billing behaviour —
          // flagged in docs/BUILD_BRIEF_NANOBANANA_SWAP.md §2.
          { status: response.status, code, requestId, billed: false }
        );
      }

      const rawOk = await response.text();
      const payload = parseJsonOrNull(rawOk);
      if (!payload) {
        // 200 with an unparseable body: the image was generated and billed.
        throw providerError(
          'Image provider answered 200 with a body that is not JSON — the generation was billed but produced no usable URL.',
          { status: 200, requestId, billed: true }
        );
      }

      const { url: imageUrl, note } = extractImageUrl(payload);
      if (!imageUrl) {
        throw providerError(
          `Image provider answered 200 but ${note}. The generation was billed.`,
          { status: 200, code: payload.code || null, requestId: payload.request_id || requestId, billed: true }
        );
      }

      return {
        url: imageUrl,
        expiresAt: extractExpiry(imageUrl),
        requestId: payload.request_id || requestId || null,
        model: resolveModel(),
        size: body.aspect_ratio,
        raw: payload,
      };
    },
  };
}

/**
 * JSON.parse that answers "is this JSON at all" without a bare catch.
 * Identical contract to dashscope.js's parseJsonOrNull, duplicated rather
 * than shared — see that file's own comment on why this is a per-provider
 * primitive, not a shared utility a third provider would have to import
 * correctly.
 */
function parseJsonOrNull(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('lib/image/providers/nanobanana.js: response looked like JSON but did not parse — ' + err.message);
    return null;
  }
}

module.exports = {
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENV,
  create,
  extractImageUrl,
  extractExpiry,
  withAvoidClause,
  resolveBaseUrl,
  resolveModel,
};

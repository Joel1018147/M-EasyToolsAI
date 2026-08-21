/* ═══════════════════════════════════════════════════════════════════════════
   DASHSCOPE (Alibaba Cloud Model Studio) — Qwen-Image
   ───────────────────────────────────────────────────────────────────────────
   ONE PROVIDER BEHIND ONE INTERFACE. Everything vendor-specific in this lane
   is in this file: the host, the path, the request envelope, the response
   shape, and the two facts below that the vendor's documentation gets wrong.
   `routes/images.js` never mentions DashScope, so a second provider (fal.ai,
   Replicate) is a sibling file plus one line in ../provider.js — not a route
   rewrite. See ../provider.js for the interface every provider must satisfy.

   ── THE CONTRACT, MEASURED 2026-08-21 AGAINST THE REAL KEY ────────────────
   UPGRADE-SPEC §0.9. Probed live, because the docs and the service disagree
   in two places that would each have shipped a broken integration.

     POST {base}/api/v1/services/aigc/multimodal-generation/generation
     Authorization: Bearer $DASHSCOPE_API_KEY
     Content-Type: application/json

     { "model": "qwen-image-plus",
       "input": { "messages": [ { "role": "user",
                                  "content": [ { "text": "<prompt>" } ] } ] },
       "parameters": { "size": "1328*1328", "n": 1,
                       "watermark": false, "prompt_extend": false,
                       "negative_prompt": "<optional>" } }

   Response: `output.choices[0].message.content[]` — an ARRAY of parts, and
   the URL is on the part carrying an `image` key. It is not always index 0
   and it is not `output.results[0].url` (that is the older text2image API on
   a different path). The extractor below searches the array rather than
   indexing into it.

   ── THREE FACTS THAT BREAK THIS IF THEY ARE "CORRECTED" FROM MEMORY ───────
   1. REGION IS SINGAPORE. This key returns `401 InvalidApiKey` against the
      Beijing host. The base URL comes from DASHSCOPE_BASE_URL with the
      international host as the code default, so migrating to the newer
      workspace-scoped form (https://{WorkspaceId}.ap-southeast-1.maas.
      aliyuncs.com) is a Railway variable change and not a code push. Note
      the current docs document ONLY the workspace-scoped form and do not
      mention the host below at all — and the host below is what answers.

   2. SIZE IS `width*height` WITH AN ASTERISK, AND `1024*1024` IS REJECTED.
      Owned entirely by ../sizes.js; this file validates against it before
      building the body so an illegal size never becomes a paid round trip.

   3. THE RETURNED URL EXPIRES. Docs say 24 hours; the live service returned
      `Expires` seven days out. This provider therefore returns the URL and
      an expiry, and NEVER claims the image is durable. Re-hosting is
      ../rehost.js's job and it happens inside the same request. Anything
      that persists this URL as a user-facing address has shipped a dead
      image on a timer.

   ── LAZY CONSTRUCTION (recurring-bugs #1) ─────────────────────────────────
   No client object, no key read, and no config resolution happens at import
   time. `create()` is called per request. A module-level
   `new Client(process.env.KEY)` captures whatever the environment held the
   instant the file was first required — which on Railway is before the
   variables a later deploy sets, and in a test harness is before the harness
   has set anything. Everything here reads `process.env` inside a function.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { has } = require('../../../helpers/capabilities');
const { assertLegalSize, LEGAL_SIZES, DEFAULT_SIZE } = require('../sizes');

const PROVIDER_NAME = 'dashscope';

/** The host this key is actually provisioned for. Overridable, never hardcoded at a call site. */
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com';

/** The multimodal-generation path. NOT the older text2image path. */
const GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/** Measured: qwen-image-max is 16.4s; the default is 3.6s. 90s is generous for the slowest. */
const DEFAULT_TIMEOUT_MS = 90_000;

const DEFAULT_MODEL = 'qwen-image-plus';

const ENV = Object.freeze({
  key: 'DASHSCOPE_API_KEY',
  baseUrl: 'DASHSCOPE_BASE_URL',
  model: 'QWEN_IMAGE_MODEL',
});

/**
 * Resolve the base URL at CALL time, trailing slash stripped so joining the
 * path can never produce a double slash (which Alibaba's gateway 404s).
 */
function resolveBaseUrl() {
  const raw = process.env[ENV.baseUrl];
  const base = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

/** Resolve the model at CALL time. Code default per .env.example's measured table. */
function resolveModel() {
  const raw = process.env[ENV.model];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_MODEL;
}

/**
 * Find the URL in `output.choices[0].message.content[]`.
 *
 * Written as a search, not an index. The response is an array of content
 * parts and the vendor is free to put a `text` part in front of the image —
 * `content[0].image` is an assumption that costs a paid generation the day it
 * stops holding, and returns `undefined` rather than an error when it does.
 *
 * @returns {{url: string|null, note: string|null}}
 */
function extractImageUrl(payload) {
  const choices = payload && payload.output && payload.output.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { url: null, note: 'response carried no output.choices array' };
  }
  for (const choice of choices) {
    const content = choice && choice.message && choice.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part.image === 'string' && part.image.trim() !== '') {
        return { url: part.image.trim(), note: null };
      }
    }
  }
  return { url: null, note: 'no content part carried an "image" key' };
}

/**
 * Read the expiry out of the signed OSS URL's own query string.
 *
 * `Expires` is a unix timestamp in seconds. This is recorded for audit in
 * `source_url_expires_at` — it is NOT a reason to trust the URL for that
 * long. Nothing in this lane defers work until it expires.
 *
 * @returns {Date|null}
 */
function extractExpiry(url) {
  if (typeof url !== 'string') return null;
  const m = /[?&]Expires=(\d{9,12})(?:&|$)/.exec(url);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * A provider error that carries whether the money was spent.
 *
 * `billed` is the field the whole cap design depends on. A 400 on an illegal
 * parameter generated nothing and must not consume budget; a 200 whose body
 * we could not parse generated an image that WAS billed.
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
 * @param {function} [opts.fetchImpl]  injected for tests; defaults to the
 *                                     global fetch resolved AT CALL TIME
 * @param {number}   [opts.timeoutMs]
 */
function create(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return {
    name: PROVIDER_NAME,

    /**
     * has() semantics, from the one file that defines them: a variable that
     * EXISTS is not a variable that HAS A VALUE. `DASHSCOPE_API_KEY=` present
     * and empty is not configured, and reporting it as configured is exactly
     * the Campus incident helpers/capabilities.js was written after.
     */
    isConfigured() {
      return has(ENV.key);
    },

    /** Names only — a diagnostics surface must never echo a credential. */
    missingVars() {
      return has(ENV.key) ? [] : [ENV.key];
    },

    legalSizes() {
      return LEGAL_SIZES.slice();
    },

    defaultSize() {
      return DEFAULT_SIZE;
    },

    model() {
      return resolveModel();
    },

    endpoint() {
      return resolveBaseUrl() + GENERATION_PATH;
    },

    /**
     * Build the exact request body. Exposed separately from `generate` so a
     * test can assert the wire shape without a network call and without a
     * paid generation — the shape is the thing most likely to be silently
     * "corrected" by a later edit.
     */
    buildBody({ prompt, negativePrompt, size, n = 1 }) {
      const legalSize = assertLegalSize(size);
      const parameters = {
        size: legalSize,
        n,
        // No watermark: these are the customer's marketing assets.
        watermark: false,
        // prompt_extend rewrites the user's prompt server-side before
        // generating. Off, deliberately: the prompt stored in
        // image_generations.prompt must be the prompt that produced the
        // image, or the audit row describes something that did not happen.
        prompt_extend: false,
      };
      if (typeof negativePrompt === 'string' && negativePrompt.trim() !== '') {
        parameters.negative_prompt = negativePrompt.trim();
      }
      return {
        model: resolveModel(),
        input: { messages: [{ role: 'user', content: [{ text: String(prompt) }] }] },
        parameters,
      };
    },

    /**
     * One synchronous generation. Completes in a few seconds (§0.9), which is
     * exactly why this API was chosen: NO JOB QUEUE AND NO setTimeout are
     * introduced anywhere in this lane. The Engineering Bar forbids
     * scheduling and this repo has no job runner.
     *
     * The timeout is `AbortSignal.timeout` (Node 20 global) rather than an
     * AbortController armed with setTimeout — same behaviour, and it keeps
     * the literal `setTimeout(` out of the tree, which Gate 3 scans for.
     *
     * @returns {Promise<{url, expiresAt, requestId, model, size, raw}>}
     */
    async generate({ prompt, negativePrompt, size, n = 1, signal }) {
      const apiKey = process.env[ENV.key];
      if (!has(ENV.key)) {
        throw providerError(
          'DASHSCOPE_API_KEY is not set to a non-empty value; image generation is unavailable on this deployment.',
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
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: signal || AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // A transport failure never reached the model, so nothing was billed.
        // The error is re-thrown with that fact attached, not swallowed.
        throw providerError(
          `Could not reach the image provider at ${url}: ${err.message}`,
          { code: 'transport', billed: false }
        );
      }

      const requestId = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('x-request-id')
        : null;

      if (!response.ok) {
        // Read as text first. A gateway HTML page thrown at .json() surfaces
        // as a parse error, which names the wrong problem — same reasoning as
        // helpers/groq.js, kept consistent on purpose.
        const raw = await response.text();
        let code = null;
        let message = null;
        const trimmed = raw.trimStart();
        if (trimmed.startsWith('{')) {
          const parsed = parseJsonOrNull(raw);
          if (parsed) {
            code = parsed.code || null;
            message = parsed.message || null;
          }
        }
        const snippet = raw.trim().slice(0, 300).replace(/\s+/g, ' ');
        throw providerError(
          `Image provider returned ${response.status}` +
          (code ? ` ${code}` : '') +
          (message ? `: ${message}` : snippet ? ` — ${snippet}` : ''),
          { status: response.status, code, requestId, billed: false }
        );
      }

      const rawOk = await response.text();
      const payload = parseJsonOrNull(rawOk);
      if (!payload) {
        // 200 with an unparseable body: the image was generated and billed.
        // Marking this `billed: true` is what stops a flaky gateway from
        // becoming an unmetered spend path.
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
        model: body.model,
        size: body.parameters.size,
        raw: payload,
      };
    },
  };
}

/**
 * JSON.parse that answers "is this JSON at all" without a bare catch, and
 * without substituting a plausible empty object for a real failure (RULE 6).
 * Returns null; every caller decides what null means and says so.
 */
function parseJsonOrNull(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('lib/image/providers/dashscope.js: response looked like JSON but did not parse — ' + err.message);
    return null;
  }
}

module.exports = {
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  GENERATION_PATH,
  ENV,
  create,
  extractImageUrl,
  extractExpiry,
  resolveBaseUrl,
  resolveModel,
};

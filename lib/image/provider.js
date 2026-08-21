/* ═══════════════════════════════════════════════════════════════════════════
   PROVIDER REGISTRY — the seam a second vendor arrives through
   ───────────────────────────────────────────────────────────────────────────
   The route does not know the word "DashScope". It asks this file for a
   provider, gets an object satisfying the interface below, and calls it.
   Adding fal.ai or Replicate is a sibling of providers/dashscope.js plus one
   entry in PROVIDERS — no change to routes/images.js, no change to the
   service, no change to the schema (`image_generations.provider` is already a
   TEXT column defaulting to 'dashscope').

   ── THE INTERFACE ─────────────────────────────────────────────────────────
   A provider module exports `create(opts) -> client`, and the client is:

     name           string, matching its registry key and what is written to
                    image_generations.provider
     isConfigured() boolean, via helpers/capabilities.js `has()` semantics —
                    a variable that EXISTS is not a variable that HAS A VALUE
     missingVars()  string[] of variable NAMES (never values) that are absent
     legalSizes()   string[] — the provider's own legal set, not a shared one.
                    Sizes are a per-model-family fact, so a second provider
                    brings its own; nothing here assumes DashScope's five.
     defaultSize()  string
     model()        string, resolved at call time from the environment
     endpoint()     string, for diagnostics and error messages
     buildBody(x)   the wire body, exposed so a test can assert the request
                    shape without a paid call
     generate(x)    Promise<{url, expiresAt, requestId, model, size, raw}>

   `generate` MUST NOT persist anything and MUST NOT claim durability. It
   returns a URL that expires. Re-hosting is ./rehost.js's job, and it happens
   in the same request. That division is the reason a provider can be swapped
   without re-auditing the expiry problem.

   ── LAZY, PER REQUEST ─────────────────────────────────────────────────────
   `get()` constructs on every call. Nothing is cached at module scope and no
   environment variable is read while this file is being required
   (recurring-bugs #1). The cost is a plain object allocation per request.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const dashscope = require('./providers/dashscope');

/**
 * The registry. A key here is a legal value for `image_generations.provider`.
 * Derived from this object everywhere it is needed, never re-listed.
 */
const PROVIDERS = Object.freeze({
  [dashscope.PROVIDER_NAME]: dashscope,
});

/** The provider used when a caller names none. */
const DEFAULT_PROVIDER = dashscope.PROVIDER_NAME;

function names() {
  return Object.keys(PROVIDERS);
}

/**
 * Construct a provider client.
 *
 * Throws for an unknown name rather than falling back to the default: a typo
 * that silently routes to a different vendor is a bill on the wrong account
 * and an audit row that names the wrong provider.
 *
 * @param {string} [name]
 * @param {object} [opts]  forwarded to the provider's create()
 */
function get(name, opts = {}) {
  const key = typeof name === 'string' && name.trim() !== '' ? name.trim().toLowerCase() : DEFAULT_PROVIDER;
  const mod = PROVIDERS[key];
  if (!mod) {
    const err = new Error(`Unknown image provider "${key}". Known providers: ${names().join(', ')}.`);
    err.code = 'unknown_provider';
    throw err;
  }
  return mod.create(opts);
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, names, get };

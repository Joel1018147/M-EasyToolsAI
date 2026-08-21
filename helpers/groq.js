/* ═══════════════════════════════════════════════════════════════════════════
   GROQ — model resolution and the wire call, in one place
   ───────────────────────────────────────────────────────────────────────────
   MOVED HERE FROM server.js IN ROUND 1, and the move is the point.

   The rule in CLAUDE.md has always been "one reader of process.env.GROQ_MODEL,
   everything else imports the constant". That rule is unchanged and still
   enforced — what changed is WHERE the one reader lives. It was server.js,
   which meant every module needing the model had to be reachable from
   server.js, which meant the generation layer could not be extracted without
   a require cycle. Eight of the nine platforms in this ecosystem already
   resolve the model in helpers/groq.js (or lib/groq.js); this repo was the
   outlier, and the outlier is what blocked the extraction.

   So: this file is now the single source of truth. server.js imports
   GROQ_MODEL from here. Nothing else in the repo may read
   process.env.GROQ_MODEL — one env var must still switch every call site.

   ── THE MODEL ─────────────────────────────────────────────────────────────
   Groq serves qwen/qwen3.6-27b on its PREVIEW tier, so it can be rate-limited,
   degraded or withdrawn with little notice. GROQ_MODEL overrides it without a
   code change — set it on Railway and redeploy. Documented fallback:
   openai/gpt-oss-120b. See .env.example and CLAUDE.md.

   Note the exact string: the `qwen/` provider prefix is required and the
   version is 3.6, not 2.6. A near-miss variant is not a typo that degrades,
   it is a hard model_not_found on every call.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// llama-3.1-8b-instant and llama-3.3-70b-versatile were decommissioned by Groq
// on 2026-08-16; neither name may appear in new code.
const DEFAULT_GROQ_MODEL = 'qwen/qwen3.6-27b';

/** THE single reader of process.env.GROQ_MODEL in this repository. */
const GROQ_MODEL = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/* POST /api/chat lets an API-key holder name a model, and that name is
   published in public/api-docs.html — so there are external integrations out
   there with a now-dead model string hardcoded, and no way for them to know
   until every request starts returning model_decommissioned. Map the known-dead
   names onto the current model instead of forwarding a guaranteed 400.

   An unrecognised model is still passed through untouched: this is a
   compatibility shim, not a whitelist, and silently rewriting a model somebody
   deliberately chose would be worse than letting Groq answer for itself. The
   consequence, recorded in CLAUDE.md: GROQ_MODEL does NOT override a model an
   external integration hardcodes. */
const DEPRECATED_MODELS = new Set([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'llama3-70b-8192',
]);

function normaliseModel(requested) {
  if (!requested || DEPRECATED_MODELS.has(requested)) return GROQ_MODEL;
  return requested;
}

/* `reasoning_effort` / `reasoning_format` are supported by qwen/qwen3.6-* ONLY.
   Sending them to any other model risks a 400 — and /api/chat accepts a
   caller-supplied model, so the gate is checked against the model actually
   being sent, never against the default. Ported verbatim from
   Dragon-Ginseng-CS-AI. */
function supportsReasoningEffortNone(model) {
  return /^qwen\/qwen3\.6/.test(model);
}

/**
 * Adds the reasoning params when, and only when, the model in the body
 * supports them.
 *
 * The effort is a trailing optional argument rather than a constant so a
 * future feature that genuinely needs deliberation can request 'default'
 * without a second copy of this gate appearing somewhere else.
 */
function withReasoning(body, effort = 'none') {
  if (supportsReasoningEffortNone(body.model)) {
    body.reasoning_effort = effort;   // marketing copy, nothing to reason about
    body.reasoning_format = 'hidden'; // and never emit a reasoning block
  }
  return body;
}

/**
 * JSON.parse that answers "is this JSON at all" without a bare catch.
 * Returns null for anything unparseable; the caller decides what that means,
 * and here it means "not Groq's own error shape", which is information.
 */
function safeJsonParse(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A body that starts like JSON and does not parse is a truncated or
    // corrupted response — worth a line, unlike an HTML page which the
    // shape test above already rejected without ever reaching here.
    console.warn('helpers/groq.js: response looked like JSON but did not parse — ' + err.message);
    return null;
  }
}

/**
 * One Groq chat completion.
 *
 * Throws on a non-2xx rather than returning a falsy value, because every
 * caller here treats "no text" as a failure and a silent empty string would
 * be indistinguishable from a model that had nothing to say.
 *
 * @returns {Promise<{text: string, model: string, raw: object}>}
 */
async function chat({ apiKey, model, system, messages, maxTokens = 1024, temperature = 0.7, effort = 'none' }) {
  if (!apiKey) throw new Error('Groq API key not configured');
  const useModel = model || GROQ_MODEL;

  const body = withReasoning({
    model: useModel,
    max_tokens: maxTokens,
    temperature,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
  }, effort);

  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Read the error body as text first. A non-JSON body here — an HTML proxy
    // page, a gateway timeout — would throw inside .json() and surface as a
    // parse error, which names the wrong problem.
    const raw = await response.text();

    // RULE 6: the non-JSON branch is not a swallow, it is the more informative
    // path. Groq's own errors are JSON and carry a usable message; an HTML
    // proxy page or a gateway timeout is NOT Groq answering, and reporting it
    // as a bare status code throws away the only evidence of what actually
    // replied. So a body that will not parse is carried into the message
    // rather than discarded, truncated because it can be a whole error page.
    const parsed = safeJsonParse(raw);
    if (parsed?.error?.message) throw new Error(parsed.error.message);
    const snippet = raw.trim().slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      `Groq error ${response.status}` + (snippet ? ` — non-JSON response: ${snippet}` : '')
    );
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    model: data.model || useModel,
    raw: data,
  };
}

module.exports = {
  DEFAULT_GROQ_MODEL,
  GROQ_MODEL,
  GROQ_ENDPOINT,
  DEPRECATED_MODELS,
  normaliseModel,
  supportsReasoningEffortNone,
  withReasoning,
  chat,
};

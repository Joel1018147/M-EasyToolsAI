'use strict';
// lib/mai/provider.js — the ONE place Groq's wire shape is translated into the
// `generate` contract that lib/mai/ asks to be injected with.
//
// ── This file sits in lib/mai/ and is NOT part of the shared framework ─────
// `index.js`, `registry.js`, `dispatcher.js`, `validate.js` and
// `confirmations.js` are platform-free and provider-free BY CONSTRUCTION: the
// dispatcher takes `generate` as an ARGUMENT and would work identically against
// Anthropic, OpenAI or a scripted test double. That boundary only survives if
// nothing inside it imports this file.
//
// So the rule, and test/mai-boundary-test.js asserts it in both directions:
//
//     NOTHING IN lib/mai/{index,registry,dispatcher,validate,confirmations}.js
//     MAY require('./provider'). The adapter is INJECTED, at the wiring point
//     in lib/mai/tools/index.js, exactly as M-EasyDo does it.
//
// It lives here rather than at lib/maiProvider.js only because Lane A owns
// `lib/mai/**` and does not own `lib/`. The import direction is what makes it
// safe: this file requires ../../helpers/groq, and no framework file requires
// this one, so the eventual @modus/mai lift is still a move of five files.
//
// It is also not inside routes/mai.js. The route's job is identity and HTTP;
// mixing "who is asking" with "what shape does Groq return tool calls in" makes
// both harder to read and makes the adapter untestable without an Express app.
//
// ── The contract, quoted from lib/mai/dispatcher.js ────────────────────────
//   generate({messages, tools, toolChoice, maxTokens, temperature}) →
//   {content, toolCalls:[{id,name,args}], model, inputTokens, outputTokens}
//
// ── THE MODEL HAS ONE READER AND IT IS NOT THIS FILE ───────────────────────
// CLAUDE.md: helpers/groq.js (GROQ_MODEL) is the single source of truth, and
// nothing else may read process.env.GROQ_MODEL. There is no
// `process.env.GROQ_MODEL` below and there must never be one — one Railway
// variable still has to switch every call site.
//
// Note what this file does NOT do: it never lets a caller name a model. That
// is a deliberate divergence from POST /api/chat, which does (server.js:600,
// via normaliseModel) and which CLAUDE.md records as the reason GROQ_MODEL
// cannot override an external integration's hardcoded model. M-Ai is internal,
// so it takes the constant and there is nothing to override.

const {
  chat,
  GROQ_MODEL,
  GROQ_ENDPOINT,
  withReasoning,
  supportsReasoningEffortNone,
} = require('../../helpers/groq');
const { has } = require('../../helpers/capabilities');

/** The single environment variable this adapter cannot work without. */
const REQUIRED_ENV = 'GROQ_API_KEY';

/**
 * Why helpers/capabilities.has() and not `!!process.env.GROQ_API_KEY`: A
 * VARIABLE THAT EXISTS IS NOT A VARIABLE THAT HAS A VALUE. has() requires a
 * non-empty trimmed string, which is the local precedent set at the top of that
 * file for the empty-secret incident it documents.
 */
function isConfigured() {
  return has(REQUIRED_ENV);
}

/** The platform key. Read per call, never captured at module load, so a key
 *  rotated on Railway between deploys is picked up by the next request rather
 *  than by the next restart. */
function apiKey() {
  const v = process.env[REQUIRED_ENV];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * What GET /api/mai/status reports. Never echoes the key — NAMES ONLY.
 * "Unconfigured is not broken, but it is never silently fine."
 */
function providerStatus() {
  const configured = isConfigured();
  return {
    configured,
    model: GROQ_MODEL,
    // Observable rather than assumed: the reasoning params are only sent when
    // the model actually supports them, and this says which way that resolved.
    reasoningParams: supportsReasoningEffortNone(GROQ_MODEL),
    missing: configured ? [] : [REQUIRED_ENV],
    reason: configured
      ? null
      : `M-Ai cannot reach a model: ${REQUIRED_ENV} is not set on this deployment. ` +
        'Every question will be refused with an explicit error rather than an empty answer. ' +
        'Set it on Railway and redeploy.',
  };
}

/**
 * Groq's `tool_calls` → the framework's `toolCalls`.
 *
 * `args` is passed through as the RAW value the provider sent — a JSON string
 * on the wire. It is deliberately NOT parsed here: dispatcher.normaliseArgs()
 * already decodes it, and already enforces the rule that a string which does
 * not decode to a plain object passes through untouched so validateArgs
 * rejects it. Parsing here as well would create a second place where a
 * malformed argument list could be quietly "repaired", and the repaired
 * version is the one that would reach an executor.
 *
 * A malformed entry — no `function`, no name — is DROPPED rather than mapped
 * to a blank name, because a call with an empty name would take the
 * dispatcher's Guard 2 path ("model selected \"\"") and report a transport
 * defect as a model hallucination.
 */
function toToolCalls(message) {
  const raw = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
  return raw
    .filter(tc => tc && tc.function && typeof tc.function.name === 'string' && tc.function.name)
    .map((tc, i) => ({
      // Echoed back in the `tool` turn on a multi-round conversation. Providers
      // always send one; the fallback exists so a provider that does not cannot
      // produce an undefined tool_call_id in the next request body.
      id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${i}`,
      name: tc.function.name,
      args: tc.function.arguments,
    }));
}

/**
 * JSON.parse that answers "is this JSON at all" without a bare catch. Mirrors
 * helpers/groq.js safeJsonParse(), which is not exported.
 */
function parseErrorBody(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A body that starts like JSON and does not parse is a truncated or
    // corrupted response — worth a line, unlike an HTML page, which the shape
    // test above already rejected without ever reaching here.
    console.warn('lib/mai/provider.js: error body looked like JSON but did not parse — ' + err.message);
    return null;
  }
}

/**
 * ONE tool-calling chat completion.
 *
 * helpers/groq.js `chat()` cannot do this: it builds no `tools` field and
 * returns `text` rather than the assistant message, so a tool call would be
 * dropped on the floor before this file ever saw it. Everything else about the
 * call — the endpoint, the reasoning-parameter gate, the error shape — is
 * imported from that module rather than restated, so a change there still
 * reaches this path.
 *
 * Throws on a non-2xx, exactly as chat() does, because the dispatcher turns a
 * throw into an explicit `llm_error` refusal and a silent empty response would
 * be indistinguishable from "no tool fits".
 */
async function callGroqTools({ messages, tools, toolChoice = 'auto', maxTokens = 400, temperature = 0 }) {
  const key = apiKey();
  if (!key) throw new Error(providerStatus().reason);

  const body = withReasoning({
    model: GROQ_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages,
    tools,
    tool_choice: toolChoice,
  }, 'none');

  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Read the error body as TEXT first. A non-JSON body here — an HTML proxy
    // page, a gateway timeout — would throw inside .json() and surface as a
    // parse error, which names the wrong problem. Same handling as
    // helpers/groq.js chat(), deliberately.
    const raw = await response.text();
    const parsed = parseErrorBody(raw);
    if (parsed && parsed.error && parsed.error.message) throw new Error(parsed.error.message);
    const snippet = raw.trim().slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`Groq error ${response.status}` + (snippet ? ` — non-JSON response: ${snippet}` : ''));
  }

  const data = await response.json();
  const choice = (data.choices && data.choices[0]) || {};
  return {
    message: choice.message || {},
    model: data.model || GROQ_MODEL,
    usage: data.usage || {},
  };
}

/**
 * Build the `generate` function to inject into createMaiAssistant().
 *
 * ── Two legs, one adapter ──────────────────────────────────────────────────
 * The dispatcher calls generate() twice for a phrased answer: once WITH a
 * `tools` array (selection) and once WITHOUT one (phrasing). The second leg
 * needs no tool-calling at all, so it goes through helpers/groq.js `chat()` —
 * the function eight other call sites in this repo already use — rather than
 * through a second copy of a plain completion. Production wiring sets
 * `phrase: false`, so that leg is normally not reached; it stays wired because
 * a path that only exists in theory is a path nobody notices breaking.
 *
 * ── What happens when the model returns NO tool call ────────────────────────
 * Exactly nothing special: this returns `{content: <the model's prose>,
 * toolCalls: []}` and lets the dispatcher's Guard 1 discard the prose and
 * refuse. Throwing instead would turn a routing outcome ("no tool fits") into
 * `llm_error` ("the provider is down"), which sends the reader to the wrong
 * place; and RETURNING the prose as an answer is the single failure the whole
 * M-Ai design exists to prevent — a model answering from its own weights,
 * wearing M-Ai's voice. The content is handed over because the framework asks
 * for it in the contract; the framework is what drops it on the floor.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger] Needs .warn.
 * @returns {Function} generate
 */
function createMaiGenerate({ logger = console } = {}) {
  return async function generate({ messages, tools, toolChoice = 'auto', maxTokens = 400, temperature = 0 } = {}) {
    // Checked per CALL, not at construction. The assistant is built once at
    // module load and the key can be present then and rotated away later; a
    // construction-time check would report a deployment as healthy forever.
    if (!isConfigured()) throw new Error(providerStatus().reason);

    // ── The phrasing leg: no tools, so no tool-calling call ────────────────
    if (!Array.isArray(tools) || !tools.length) {
      const out = await chat({
        apiKey: apiKey(),
        // No `model` argument: chat() falls back to GROQ_MODEL, which is the
        // one reader. Passing a model here would be a second source of truth.
        messages,
        maxTokens,
        temperature,
      });
      return {
        content: typeof out.text === 'string' ? out.text : '',
        toolCalls: [],
        model: out.model,
        inputTokens: Number(out.raw && out.raw.usage && out.raw.usage.prompt_tokens) || 0,
        outputTokens: Number(out.raw && out.raw.usage && out.raw.usage.completion_tokens) || 0,
      };
    }

    // ── The selection leg ──────────────────────────────────────────────────
    const r = await callGroqTools({ messages, tools, toolChoice, maxTokens, temperature });
    const message = r.message || {};
    const toolCalls = toToolCalls(message);

    // Loud, because it is invisible in the response otherwise: a tool_calls
    // entry the provider sent that this adapter could not map is a dropped
    // instruction, and the staff member would just see a refusal.
    const sent = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0;
    if (sent > toolCalls.length) {
      logger.warn(`[M-Ai provider] dropped ${sent - toolCalls.length} malformed tool_call(s) from the ` +
                  'provider response (no function name)');
    }

    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      model: r.model,
      inputTokens: Number(r.usage && r.usage.prompt_tokens) || 0,
      outputTokens: Number(r.usage && r.usage.completion_tokens) || 0,
    };
  };
}

module.exports = { createMaiGenerate, providerStatus, isConfigured, toToolCalls, callGroqTools, REQUIRED_ENV };

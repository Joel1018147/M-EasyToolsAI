'use strict';
// Tool registry for M-Ai, M-EasyDo's staff-only assistant.
//
// Platform-agnostic by construction: this file must never mention a table, a
// column, a currency or a business concept, and must never require db.js or a
// model client. Tool DEFINITIONS live in ./tools; only the mechanism lives here,
// so the eventual lift into @modus/mai is a move rather than a rewrite.
//
// The contract in one line: a tool's executor is the only thing that may produce
// a figure, and the registry is what decides whether a given role is allowed to
// reach it.
//
// Provenance: the shape is M-EasyCommerce's `src/services/secretary/registry.js`
// read as a reference pattern. Two deliberate differences are marked below with
// "M-EasyDo:".

const { validateArgs } = require('./validate');

// Groq/OpenAI require function names to be short identifiers. Enforced at
// registration so a bad name fails at boot rather than mid-conversation.
const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Sentinel for a tool every role may use. You must ask for it BY NAME.
 *
 * "Every role" means every AUTHENTICATED role. A caller with no role at all
 * (undefined, null, blank, whitespace) reaches nothing — not even an ANY_ROLE
 * tool. The looser reading, where marking a tool public also exposes it to
 * callers who never identified themselves, is how a permission model quietly
 * becomes an anonymous API. On M-EasyDo that is the whole ballgame: the
 * customer surface here is ANONYMOUS (a WhatsApp webhook and a public AI
 * proxy), so "a customer session" and "a caller with no role" are the same
 * thing, and this is the line that keeps them out.
 *
 * `requiredRoles: []` is REJECTED rather than read as "no restriction". An
 * empty array is what an accidentally-filtered `.filter()`, a bad merge or a
 * half-written migration produces, and reading it as world-readable is the
 * fail-open-by-omission shape this ecosystem has already had to fix in its
 * webhook guards. Making the permissive case a deliberate, greppable token
 * means it can never be arrived at by accident.
 *
 * M-EasyDo: the constant exists because the mechanism must be able to express
 * it and the tests must be able to prove it fails closed. NO M-Ai TOOL USES IT.
 * See tools/index.js, which asserts that at build time.
 */
const ANY_ROLE = '*';

function assert(cond, msg) {
  if (!cond) throw new Error(`M-Ai registry: ${msg}`);
}

// ── The confirmation sentence, composed rather than recited ─────────────────
// `sideEffect` on a tool definition is a STATIC sentence: "change one support
// ticket's priority. The previous priority is reported back so it can be set
// again; …". The comment on the assertion below has always set a higher bar
// than that — "reassign ticket TKT-014 from Aisyah to Rahim" — and it was not
// being met, because the definition is written once and the arguments are not
// known until a question is asked.
//
// They ARE known at the moment the confirmation is issued, though: the model
// has chosen, the validator has accepted, and nothing has run yet. So a write
// tool may declare `describe(args) → string`, a PURE function of the validated
// arguments that returns the specific opening clause. The generic caveats that
// follow the first sentence of the static `sideEffect` are kept and appended,
// because they are the part a human still needs and the part that does not vary.
//
// A tool with no describer, or a describer that cannot name its target, does
// not get a faked-up specific sentence. It gets the static one plus an explicit
// admission that the exact row is not named — an approval prompt that sounds
// precise and is not is worse than one that says what it does not know.

// Splits "First sentence. The rest of it." into [headline, tail]. Requires the
// terminator to be followed by whitespace and a capital, so a decimal or an
// abbreviation mid-sentence does not split it.
const FIRST_SENTENCE_RE = /^\s*(.*?[.!?])\s+([A-Z].*)$/s;

function splitSideEffect(sentence) {
  const m = FIRST_SENTENCE_RE.exec(String(sentence || ''));
  return m ? { head: m[1].trim(), tail: m[2].trim() } : { head: String(sentence || '').trim(), tail: '' };
}

// A describer is handed VALIDATED arguments, and validated does not mean tame:
// a lead name or a ticket reference is a free-text string the MODEL wrote, and
// it is about to be rendered to a staff member as the thing they are approving.
// It has to appear — naming the target is the entire point — but it appears as
// one line of plain text and nothing else: no control characters, no newlines
// to fake a second paragraph, no unbounded length.
// Written as a codepoint test rather than a regex character class on purpose: the
// class would be a run of backslash escapes that a careless edit turns into literal
// control bytes without the file failing to parse.
function isControlCode(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
}

function stripControls(s) {
  let out = '';
  for (const ch of String(s)) out += isControlCode(ch.codePointAt(0)) ? ' ' : ch;
  return out;
}
const MAX_HEADLINE = 300;

function cleanHeadline(s) {
  let out = stripControls(s).replace(/\s+/g, ' ').trim();
  if (!out) return null;
  if (out.length > MAX_HEADLINE) out = out.slice(0, MAX_HEADLINE - 1).trimEnd() + '…';
  if (!/[.!?…]$/.test(out)) out += '.';
  return out;
}

function createRegistry() {
  const tools = new Map();

  function register(tool) {
    assert(tool && typeof tool === 'object', 'a tool definition object is required');

    const { name, description, parameters, requiredRoles, executor,
            kind = 'read', reversible = false, sideEffect = null, describe = null } = tool;

    // A tool that CHANGES something is a different object than one that reads,
    // and the difference is DECLARED rather than inferred. The dispatcher has
    // to know before it calls: a read can be retried, run speculatively or
    // discarded when the model picks badly, and a write cannot. Defaulting to
    // 'read' means an author who forgets to declare a write gets a tool the
    // dispatcher will happily re-run — so the assertions below make a write
    // impossible to declare halfway.
    assert(kind === 'read' || kind === 'write',
      `"${name}": kind must be 'read' or 'write' — got ${JSON.stringify(kind)}`);

    // sideEffect is the sentence shown to a human before the thing happens, and
    // it is mandatory for writes because confirm mode is worthless without it.
    // "Run reassign_ticket?" is not a question anyone can answer; "reassign
    // ticket TKT-014 from Aisyah to Rahim" is.
    assert(kind === 'read' || (typeof sideEffect === 'string' && sideEffect.trim().length >= 15),
      `"${name}": a write tool must declare sideEffect — a human-readable sentence describing what it will change`);

    assert(typeof name === 'string' && NAME_RE.test(name),
      `name must match ${NAME_RE} — got ${JSON.stringify(name)}`);
    assert(!tools.has(name), `duplicate tool name "${name}"`);

    // The description is the ONLY thing the model uses to decide whether this
    // tool answers the question, and the lexical narrowing step in the
    // dispatcher reads it too. A stub description is a silent accuracy bug, so
    // a minimum length is enforced rather than merely "is a string".
    assert(typeof description === 'string' && description.trim().length >= 15,
      `"${name}": description must be a meaningful string (>= 15 chars) — the model routes on it`);

    assert(parameters && parameters.type === 'object' && parameters.properties
           && typeof parameters.properties === 'object',
      `"${name}": parameters must be an object schema with a properties map (use {} for no arguments)`);

    assert(Array.isArray(requiredRoles) && requiredRoles.length > 0
           && requiredRoles.every(r => typeof r === 'string' && r.trim()),
      `"${name}": requiredRoles must be a non-empty array of role names, or [ANY_ROLE] to allow everyone`);

    assert(typeof executor === 'function', `"${name}": executor must be a function`);

    // Optional, and only meaningful on a write. See the composition note above.
    assert(describe === null || describe === undefined || typeof describe === 'function',
      `"${name}": describe must be a function of the validated arguments, or absent`);
    assert(!describe || kind === 'write',
      `"${name}": describe is the confirmation sentence for a WRITE — a read tool is never confirmed`);

    const split = kind === 'write' ? splitSideEffect(sideEffect) : { head: '', tail: '' };

    tools.set(name, {
      name,
      description: description.trim(),
      parameters,
      // Copied, and trimmed on the way in. A caller holding a reference to the
      // array it passed must not be able to widen a tool's permissions after
      // registration by pushing onto it.
      requiredRoles: requiredRoles.map(r => r.trim()),
      executor,
      kind,
      reversible: !!reversible,
      sideEffect: sideEffect ? sideEffect.trim() : null,
      describe: typeof describe === 'function' ? describe : null,
      // The generic half of the static sentence, computed once at registration
      // so the per-request path does no parsing.
      sideEffectTail: split.tail,
    });
    return name;
  }

  /**
   * The sentence a human is shown before this write happens, resolved against
   * the arguments that are actually about to run.
   *
   * This is the ONLY producer of that sentence. The dispatcher calls it at the
   * moment it decides to ask, the confirmation token stores exactly what it
   * returned, and the audit row records the same string — so "what did the
   * person actually see" has one answer rather than three approximations.
   *
   * @param {string} name
   * @param {object} args  VALIDATED arguments.
   * @returns {string|null} null for a read tool or an unknown name.
   */
  function sideEffectFor(name, args) {
    const t = tools.get(typeof name === 'string' ? name : '');
    if (!t || t.kind !== 'write') return null;

    let headline = null;
    if (typeof t.describe === 'function') {
      try {
        headline = cleanHeadline(t.describe(args && typeof args === 'object' ? args : {}));
      } catch (_err) {
        // A throwing describer must not take the confirmation down with it. It
        // degrades to the honest generic sentence below, which says out loud
        // that the row is not named.
        headline = null;
      }
    }

    if (!headline) {
      // No faked specificity. The reader is told the sentence is generic and
      // pointed at the arguments, which the API returns alongside it.
      return `${t.sideEffect} (M-Ai could not name the exact target row in this sentence — ` +
             `read the arguments shown with it before approving.)`;
    }
    return t.sideEffectTail ? `${headline} ${t.sideEffectTail}` : headline;
  }

  const get = (name) => tools.get(name) || null;
  const list = () => [...tools.values()];
  const has = (name) => (typeof name === 'string' ? tools.has(name) : false);

  /**
   * Fails closed on anything that is not a non-empty role string, so an
   * unauthenticated request (role undefined) reaches nothing at all — including
   * a tool marked ANY_ROLE. The blank check runs BEFORE the ANY_ROLE check for
   * exactly that reason; swapping the two lines is the whole bug.
   *
   * ── The incoming role is matched EXACTLY, not trimmed ────────────────────
   * This line used to read `const r = role.trim();`, which made `' admin '` a
   * valid admin. Nothing asked for that. It was not reachable over HTTP —
   * routes/mai.js runs normaliseRole() first, and that lowercases and trims to
   * one of two literals or to null — but this file is the one earmarked for
   * lifting into a shared package, and a permission check that normalises its
   * input is a permission check whose behaviour depends on which caller found
   * it. M-EasyCommerce's equivalent does not trim, so the divergence was ours
   * and unexplained.
   *
   * `requiredRoles` is still trimmed, once, at REGISTRATION — that is a
   * definition being tidied, not an authorisation input being reshaped. The
   * blank check below deliberately keeps `.trim()`, because there it TIGHTENS:
   * a whitespace-only role is rejected rather than compared.
   *
   * Callers that hold a role from anywhere other than a normaliser must
   * normalise before asking. lib/mai/tools/index.js does exactly that at the
   * framework boundary.
   */
  function canAccess(name, role) {
    const t = tools.get(typeof name === 'string' ? name : '');
    if (!t) return false;
    if (typeof role !== 'string' || !role.trim()) return false;
    return t.requiredRoles.includes(ANY_ROLE) || t.requiredRoles.includes(role);
  }

  const listForRole = (role) => list().filter(t => canAccess(t.name, role));

  /**
   * The tool list handed to the model. Filtered by role BEFORE the model sees
   * it, so an out-of-scope tool is not merely refused — its existence is never
   * disclosed, and the model cannot select what it was never shown.
   */
  const toolSpecsForRole = (role) => listForRole(role).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  /**
   * Run a tool. Returns a result envelope rather than throwing, because every
   * failure here is a thing the dispatcher must turn into an honest refusal.
   *
   * @returns {Promise<{ok:true, result:{display:string,data:object,rows:string[]},
   *                    args:object, ignoredArgs:string[]}
   *                 | {ok:false, reason:string, detail:string}>}
   */
  async function execute(name, rawArgs, ctx) {
    const tool = tools.get(typeof name === 'string' ? name : '');
    if (!tool) return { ok: false, reason: 'unknown_tool', detail: `no tool named ${JSON.stringify(name)}` };

    // Re-checked even though toolSpecsForRole already filtered. The model can
    // name a tool it was never shown — it has seen thousands of APIs in
    // training and will occasionally invent a plausible one — so authorisation
    // is enforced at the point of EXECUTION, not only at the point of offer.
    const role = ctx && ctx.role;
    if (!canAccess(name, role)) {
      return { ok: false, reason: 'forbidden', detail: `role ${JSON.stringify(role)} may not use "${name}"` };
    }

    const v = validateArgs(tool.parameters, rawArgs);
    // Returned BEFORE the executor is reached. A tool whose arguments did not
    // validate has not run, and a spy on the executor must see zero calls.
    if (!v.ok) return { ok: false, reason: 'bad_arguments', detail: v.errors.join('; ') };

    let result;
    try {
      result = await tool.executor(v.value, ctx);
    } catch (err) {
      return { ok: false, reason: 'executor_error', detail: err && err.message ? err.message : String(err) };
    }

    // An executor that returns the wrong shape must fail LOUDLY. If `display`
    // were allowed to be missing, the dispatcher would have nothing
    // authoritative to fall back on and would be left with only the model's
    // prose — which is precisely the state this whole design exists to prevent.
    if (!result || typeof result !== 'object' || typeof result.display !== 'string' || !result.display.trim()) {
      return {
        ok: false,
        reason: 'executor_error',
        detail: `"${name}" returned no display string — executors must return { display, data, rows? }`,
      };
    }

    return {
      ok: true,
      args: v.value,
      ignoredArgs: v.ignored,
      kind: tool.kind,
      reversible: tool.reversible,
      sideEffect: tool.sideEffect,
      result: {
        display: result.display.trim(),
        data: result.data && typeof result.data === 'object' ? result.data : {},
        rows: Array.isArray(result.rows) ? result.rows.map(String) : [],
      },
    };
  }

  return { register, get, has, list, listForRole, toolSpecsForRole, canAccess, execute,
           sideEffectFor, size: () => tools.size };
}

module.exports = { createRegistry, ANY_ROLE, NAME_RE, splitSideEffect, cleanHeadline };

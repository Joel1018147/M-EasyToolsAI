'use strict';
// M-Ai — M-EasyTools' tool pack, and the ONLY place the framework in lib/mai/
// is joined to this platform.
//
// `lib/mai/{registry,dispatcher,validate,confirmations,index}.js` name no
// table, no column and no business concept, and import nothing from outside
// that folder. `lib/mai/provider.js` names Groq. Everything M-EasyTools-shaped
// lives in THIS directory, and the two dependencies arrive here by INJECTION:
//
//     createMaiAssistant({ generate })   ← the provider, injected
//     ask({ ..., ctx: { db, ownerId } }) ← the database, injected per request
//
// That division is what makes the eventual @modus/mai extraction a move of five
// files rather than a rewrite, and it is why the wiring entry point is here
// rather than in lib/mai/index.js: importing the tool pack from the framework's
// index would put a table name one `require` away from the shared boundary.
//
// ── What this file guarantees at BUILD time, not at review time ────────────
// createMaiRegistry() refuses to return a registry that violates any of these,
// so a tool added later cannot quietly weaken the boundary:
//
//   · no tool is registered ANY_ROLE
//   · every tool's requiredRoles is a non-empty subset of THIS platform's two
//     real staff roles (admin, owner) — no wildcards, no invented role, and
//     specifically never 'user', which is the users.role DEFAULT that every
//     self-registered account and every /api/chat API-key holder carries
//   · every write declares reversible: true, a sideEffect sentence and a
//     describer that can name the row it is about to change
//   · the two tools that read a table with NO tenancy column are ADMIN_ONLY
//   · no two tools share a name
//
// A registry that cannot be built is a deploy-time failure — routes/mai.js
// builds the assistant at module load, so the process does not start. A
// registry that builds with a hole in it is a Tuesday nobody notices.

const { createRegistry, ANY_ROLE } = require('../registry');
const { createDispatcher } = require('../dispatcher');
const { ALL_ROLES, ADMIN, normaliseRole } = require('../roles');

const PACKS = [
  require('./content'),
  require('./pr'),
  require('./workspace'),
  require('./billing'),
];

/** Every M-Ai tool definition, in registration order. */
const MAI_TOOLS = PACKS.flatMap(p => p.TOOLS);

/** Names only — the set the disjointness assertion compares against. */
const MAI_TOOL_NAMES = MAI_TOOLS.map(t => t.name);

const ROLE_SET = new Set(ALL_ROLES);

/**
 * The tools whose tables carry no tenancy column at all — `media_outlets` /
 * `journalists` (the shared Modus media directory) and `platform_modules` (the
 * deployment's module switchboard). Both are seeded in server.js initDB() and
 * are the same rows for every account, so there is nothing account-specific to
 * leak; but a read that CANNOT be scoped to ctx.ownerId is not a read that a
 * self-assignable role should reach, and `owner` is self-assignable (any
 * authenticated account reaches it by calling POST /api/teams — see
 * lib/mai/roles.js). They are pinned to ADMIN_ONLY here, at build time, rather
 * than left to whoever edits the tool definition next.
 */
const UNSCOPED_READS = new Set(['media_directory_summary', 'platform_module_status']);

// ── The refusal sentence ───────────────────────────────────────────────────
// dispatcher.DEFAULT_REFUSAL names M-EasyDo, because the framework files are
// copied VERBATIM from that repo and are not edited on the way across — editing
// them is what turns a shared module into two diverging modules. The dispatcher
// takes `refusal` as an option for exactly this, so the platform-specific
// sentence is supplied HERE, next to everything else platform-specific.
const REFUSAL =
  "I can't answer that from the data I have access to. " +
  'Try asking about your documents, scores, press releases, team, or subscription — or rephrase the question.';

// ── The confirmation sentence, per write tool ──────────────────────────────
// registry.js can COMPOSE a specific sentence but cannot AUTHOR one: it is
// forbidden from knowing what a document or a press release is. So the
// M-EasyTools-shaped half lives here, as a PURE function of the VALIDATED
// arguments.
//
// Each returns the opening clause only. registry.sideEffectFor() appends the
// generic caveats that already follow the first sentence of each tool's static
// `sideEffect`, so nothing a tool author wrote is lost and nothing is repeated.
//
// ── Why "matching", and why that word is not hedging ──────────────────────
// rename_document and set_pr_release_status take a SEARCH string, not a
// resolved id: the executor looks it up when it runs. So the honest sentence is
// "the press release matching \"Q3 results\"", not "press release 14" — the
// second promises a specific row this process has not looked at yet. It is not
// a hedge hiding a guess either: both lookups REFUSE on an ambiguous match
// rather than picking one (shared.js refusedAmbiguous), so "matching" describes
// exactly what will happen.
//
// The argument values are model-authored free text. registry.cleanHeadline()
// strips control characters, collapses whitespace and bounds the length before
// any of this reaches a screen. Quoting here is for the reader, not a security
// control.

/** Quote a free-text argument for display inside a sentence. */
function q(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (!s) return '(nothing)';
  return `"${s.replace(/"/g, "'")}"`;
}

/**
 * An enum value — a status, a tone. Rendered BARE rather than quoted, because
 * it reads as English ("to status published") rather than as a search term, and
 * because it is not free text: the tool's own schema pins it to a fixed list
 * and validateArgs has already rejected anything outside it. The character
 * filter is belt and braces against a schema that loses its `enum` in a future
 * edit, not against anything reachable today.
 */
function enumOf(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().replace(/[^\w .-]/g, '');
  return s || '(nothing)';
}

const DESCRIBERS = {
  rename_document: (a) =>
    `retitle the document matching ${q(a.document)} to ${q(a.title)}.`,

  set_brand_tone: (a) =>
    `set this account's brand tone to ${enumOf(a.tone)}.`,

  set_pr_release_status: (a) =>
    `set the press release matching ${q(a.release)} to status ${enumOf(a.status)}.`,
};

/**
 * Build the M-Ai registry.
 *
 * @returns {object} a registry from lib/mai/registry.js with every M-Ai tool
 *                   registered and every invariant above already asserted.
 */
function createMaiRegistry() {
  const registry = createRegistry();
  for (const tool of MAI_TOOLS) {
    // ── The disjointness invariants, enforced BEFORE registration ──────────
    if (!Array.isArray(tool.requiredRoles) || !tool.requiredRoles.length) {
      throw new Error(`M-Ai: "${tool.name}" declares no requiredRoles. M-Ai is staff-only; there is no default.`);
    }
    if (tool.requiredRoles.includes(ANY_ROLE)) {
      throw new Error(`M-Ai: "${tool.name}" is registered ANY_ROLE. No M-Ai tool may be reachable by any role — ` +
                      'this registry is staff-only by construction, not by convention.');
    }
    for (const r of tool.requiredRoles) {
      if (!ROLE_SET.has(r)) {
        throw new Error(`M-Ai: "${tool.name}" requires role ${JSON.stringify(r)}, which is not one of ` +
                        `M-EasyTools' staff roles (${ALL_ROLES.join(', ')}). users.role DEFAULTS to 'user' — ` +
                        'every self-registered account and every /api/chat API-key holder carries it — so a tool ' +
                        "that named 'user' would hand the staff registry to the customer surface.");
      }
    }
    if (UNSCOPED_READS.has(tool.name)) {
      const adminOnly = tool.requiredRoles.length === 1 && tool.requiredRoles[0] === ADMIN;
      if (!adminOnly) {
        throw new Error(`M-Ai: "${tool.name}" reads a table with no tenancy column, so it cannot be scoped to ` +
                        `ctx.ownerId, and it must therefore be ADMIN_ONLY. It declares ` +
                        `${JSON.stringify(tool.requiredRoles)}. The 'owner' role is self-assignable — any ` +
                        'authenticated account reaches it by creating a team — so it may only reach reads that ' +
                        'the SQL itself confines to that account.');
      }
    }
    if (tool.kind === 'write' && tool.reversible !== true) {
      throw new Error(`M-Ai: write tool "${tool.name}" does not declare reversible: true. Every M-Ai write must be ` +
                      'undoable by a human without a database restore — no DELETE, no one-way transition.');
    }
    // Every write must be able to name what it is about to change. A write
    // added later with no describer would silently fall back to the generic
    // sentence plus an "M-Ai could not name the exact target row" admission —
    // honest, but a worse prompt than the one this pack already gives, and a
    // regression nobody would notice at review time. So it is a BUILD failure,
    // the same way a missing sideEffect already is.
    if (tool.kind === 'write' && typeof DESCRIBERS[tool.name] !== 'function') {
      throw new Error(`M-Ai: write tool "${tool.name}" has no entry in DESCRIBERS. A confirmation sentence that ` +
                      'cannot name the row it is about to change is not a question a human can answer — add one ' +
                      'in lib/mai/tools/index.js next to the others.');
    }

    // Spread, not mutated: MAI_TOOLS is exported and read by the test suite, and
    // a registry build must not leave a field behind on the shared definition.
    registry.register(tool.kind === 'write' ? { ...tool, describe: DESCRIBERS[tool.name] } : tool);
  }
  return registry;
}

// ── The write log ──────────────────────────────────────────────────────────
/**
 * Record a write ATTEMPT, in the DATABASE and on the process log.
 *
 * ── Two sinks, and the reason there are two ───────────────────────────────
 * `audit_log` (migrations/004, Foundation-owned, applied on startup by the
 * migration runner in server.js) is the DURABLE record: a UUID primary key,
 * the account it belongs to, the exact sentence the human approved, and a
 * non-secret handle tying that approval to its use. It is queryable six months
 * from now, which a process log is not.
 *
 * The console line is kept ANYWAY, and it is written FIRST. A database that is
 * unreachable at exactly the moment of a write is the case an audit trail
 * exists for, and a single sink that happens to be the thing that just failed
 * is not an audit trail. So the row can be missing and the evidence is still
 * somewhere.
 *
 * It is passed to the dispatcher as `onAction` rather than being called from
 * inside the framework, so lib/mai/{registry,dispatcher,validate}.js keep no
 * logging and no database dependency at all.
 *
 * BOTH successes and FAILURES are recorded, the failures with `ok = false`. An
 * unrecorded failed write is the one an investigation cannot find later.
 */

/**
 * What each write touches. Explicit and greppable rather than inferred from the
 * result shape: an entity guessed from whichever id happened to be present is
 * an entity that silently changes the day an executor adds a field.
 */
const ENTITY_OF = {
  rename_document: 'documents',
  set_brand_tone: 'users.brand_tone',
  set_pr_release_status: 'pr_releases',
};

/** A confirmation HANDLE is 12 hex characters. A full token is 64. */
const HANDLE_RE = /^[0-9a-f]{12}$/;

/**
 * The only value allowed into `approval_ref`.
 *
 * Belt and braces against a caller that passes the TOKEN where the HANDLE
 * belongs: anything that is not exactly a 12-hex handle is dropped, and the
 * drop is reported rather than done quietly. The plaintext token is a bearer
 * credential — a copy of it sitting in a table operators read is a copy
 * anybody with read access can spend, and it would outlive the five-minute
 * expiry that is supposed to bound it. test/mai-framework-test.js asserts the
 * token appears in no parameter of the insert and in no log line.
 */
function safeApprovalRef(ref) {
  if (typeof ref !== 'string' || !HANDLE_RE.test(ref)) return null;
  return ref;
}

/** The row this write is about, taken from what the EXECUTOR reported — never
 *  from anything the model typed. */
function entityIdOf(payload, ctx) {
  const data = (payload.result && payload.result.data) || {};
  if (data.documentId !== undefined && data.documentId !== null) return String(data.documentId);
  if (data.releaseId !== undefined && data.releaseId !== null) return String(data.releaseId);
  // set_brand_tone changes a column on the asking account's own row, so the
  // account IS the entity. Read from ctx, not from the result.
  if (ENTITY_OF[payload.tool] === 'users.brand_tone' && ctx.ownerId !== undefined && ctx.ownerId !== null) {
    return String(ctx.ownerId);
  }
  return null;
}

/** A positive integer, or null. `audit_log.user_id` is NOT NULL and references
 *  users(id), so a row with no identity cannot be written — and must not be
 *  faked into existence with a 0 or a -1 that attributes a real write to an
 *  account that does not exist. */
function positiveInt(v) {
  const n = typeof v === 'number' ? v
          : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function auditOnAction(payload) {
  const ctx = (payload && payload.ctx) || {};
  const data = (payload.result && payload.result.data) || {};

  // 'token' — a server-issued confirmation token was presented and spent.
  //           `approval_ref` is that token's non-secret handle (its first 12
  //           hex characters — enough to correlate the issue with the use, not
  //           enough to spend) and `approved_shown` is the EXACT sentence that
  //           was on the staff member's screen.
  // 'none'  — no human approved this one. Only reachable when a deployment
  //           builds the dispatcher with writeMode:'auto'; routes/mai.js does
  //           not, and refuses a body that mentions the field.
  const approval = payload.approval === 'token' ? 'token' : 'none';

  /* CARRIED THROUGH, NEVER RECOMPOSED. `sideEffectShown` is the string
     registry.sideEffectFor() produced at issue time, that the confirmation
     token stored, and that the confirm leg handed back. Re-deriving it here
     from the tool definition and the arguments would produce a sentence that is
     probably the same and is evidence of nothing — an audit row saying what we
     WOULD have shown is not a record of what WAS shown. */
  const approvedShown = approval === 'token' && typeof payload.sideEffectShown === 'string'
    ? payload.sideEffectShown.slice(0, 2000)
    : null;

  const approvalRef = approval === 'token' ? safeApprovalRef(payload.approvalId) : null;
  if (approval === 'token' && payload.approvalId && !approvalRef) {
    console.warn('[M-Ai audit] the approval reference was not a 12-character handle and was DROPPED rather ' +
                 'than stored - a full confirmation token must never reach the audit table.');
  }

  const userId = positiveInt(ctx.userId) || positiveInt(ctx.ownerId);
  const teamId = positiveInt(ctx.teamId);
  const entity = ENTITY_OF[payload.tool] || 'mai_tool';
  const entityId = entityIdOf(payload, ctx);

  /* `detail` is assembled from a NAMED list of fields. Not a spread of the
     payload: a field added to the dispatcher later would otherwise reach a
     stored column without anyone deciding it should — and one of the fields it
     could arrive carrying is the confirmation token. */
  const record = {
    at: new Date().toISOString(),
    tool: payload.tool,
    ok: !!payload.ok,
    changed: data.changed === true,
    mode: payload.mode || null,
    approval,
    approvalRef,
    role: payload.role || null,
    userId,
    ownerId: positiveInt(ctx.ownerId),
    teamId,
    reversible: !!payload.reversible,
    args: payload.args || {},
    previous: data.previousTitle || data.previousTone || data.previousStatus || null,
    error: payload.error || null,
    question: String(payload.question || '').slice(0, 500),
  };
  const detail = JSON.stringify(record).slice(0, 4000);

  /* SINK 1 — the process log. Written FIRST and unconditionally, so a database
     outage cannot leave a write with no evidence anywhere. One line, JSON,
     prefixed so it is greppable. `console.log` and not a logging library: this
     file is one require away from the shared boundary and a dependency added
     here would travel with it. */
  console.log('[M-Ai write] ' + detail);

  /* SINK 2 — the durable row. */
  const db = ctx.db;
  if (!db || typeof db.query !== 'function') {
    console.warn('[M-Ai audit] no database on ctx; "' + payload.tool +
                 '" was recorded on the process log only.');
    return;
  }
  if (userId === null) {
    console.warn('[M-Ai audit] no account id on ctx; "' + payload.tool +
                 '" could not be written to audit_log and was recorded on the process log only.');
    return;
  }

  try {
    await db.query(
      `INSERT INTO audit_log
         (user_id, team_id, actor, action, entity, entity_id, approved_shown, approval_ref, ok, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [userId, teamId, 'mai', 'mai:' + payload.tool, entity, entityId,
       approvedShown, approvalRef, !!payload.ok, detail]
    );
  } catch (err) {
    /* THE ONE PLACE A SWALLOW IS CORRECT, AND IT IS DELIBERATE (RULE 6).
       By the time this line runs THE ACTION HAS ALREADY HAPPENED — the executor
       ran and the row changed. Rethrowing would turn the response into a
       failure and tell the staff member their change did not happen: a false
       statement about the database, which sends them to re-do a thing that is
       already done, or to escalate an incident that is not one.

       It is not a silent swallow and it is not the only line of defence.
       Sink 1 above already wrote the same record, so the audit is DEGRADED
       rather than lost; the failure is named loudly here with the tool and the
       driver's own message; and the dispatcher wraps this hook in its own
       try/catch as well — that second one exists for a hook that is not ours. */
    console.warn('[M-Ai audit] could not write the audit_log row for "' + payload.tool + '": ' + err.message +
                 '. The action itself SUCCEEDED and is on the process log above; only the durable row is missing.');
  }
}

/**
 * Build a ready-to-use M-Ai assistant: registry + dispatcher + write log.
 *
 * @param {object} opts
 * @param {Function} opts.generate  The LLM callable. INJECTED — this file does
 *   not import lib/mai/provider.js, so the framework stays provider-free and
 *   the single source of truth for the model stays helpers/groq.js (GROQ_MODEL).
 * @param {'auto'|'confirm'} [opts.writeMode='confirm']
 * @param {boolean} [opts.phrase=false]  Off by default in production: `display`
 *   is already the authoritative wording, and not making a second model call
 *   means there is no model prose for the grounding guard to have to police.
 * @returns {{registry:object, ask:Function, confirm:Function, toolNames:string[]}}
 */
function createMaiAssistant({ generate, writeMode = 'confirm', phrase = false,
                              maxOfferedTools = 12, logger = console, onAction = auditOnAction,
                              maxTools = 1, maxRounds = 1 } = {}) {
  const registry = createMaiRegistry();
  const dispatcher = createDispatcher({
    registry, generate, logger, phrase, writeMode, onAction, maxTools, maxRounds,
    refusal: REFUSAL,
    // The lexical narrowing step. Every description in this pack is written as
    // the QUESTIONS staff actually ask, which is what makes a no-cost lexical
    // filter a usable recall device rather than a lottery.
    maxOfferedTools,
  });

  /**
   * The one entry point a route should call.
   *
   * THE ROLE IS NORMALISED HERE, AT THE BOUNDARY, and an unrecognised role
   * becomes null rather than a default — so a caller carrying role:'user'
   * (which is what every self-registered account and every /api/chat API-key
   * holder has), role:'member', role:'customer', role:'' or no role at all
   * arrives at the dispatcher carrying nothing the registry recognises, reaches
   * no tool, and NEVER CAUSES A MODEL CALL (dispatcher Guard 0). Normalising
   * inside the registry instead would have made the registry platform-aware,
   * which is the one thing it must not be.
   */
  async function ask(input = {}) {
    return dispatcher.ask({ ...input, role: normaliseRole(input.role) });
  }

  /**
   * Perform a write a human approved. The second half of the round trip; see
   * dispatcher.confirm() for what it does and does not do — chiefly, that it
   * does not call `generate` at all.
   */
  async function confirm(input = {}) {
    return dispatcher.confirm({ ...input, role: normaliseRole(input.role) });
  }

  return { registry, ask, confirm, toolNames: [...MAI_TOOL_NAMES] };
}

module.exports = {
  MAI_TOOLS,
  MAI_TOOL_NAMES,
  UNSCOPED_READS,
  REFUSAL,
  createMaiRegistry,
  createMaiAssistant,
  auditOnAction,
  // Exported so a test can assert the sentence a given argument set produces
  // without standing up a registry and a dispatcher first.
  DESCRIBERS,
  // The audit row's shape, exported for the same reason: a test asserting which
  // entity a write is recorded against, and that only a 12-hex handle can ever
  // reach `approval_ref`, should read the real map and the real filter rather
  // than a copy of them.
  ENTITY_OF,
  safeApprovalRef,
};

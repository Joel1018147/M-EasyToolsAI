/* ═══════════════════════════════════════════════════════════════════════════
   routes/mai.js — the M-Ai API. M-EasyTools' staff-only assistant over HTTP.
   ───────────────────────────────────────────────────────────────────────────
   Mounted by Foundation in server.js as:

       app.use('/api/mai', requireAuth, checkSub, require('./routes/mai'));

   so everything below runs with a signed-in `req.user` on a subscription that
   checkSub let through. This lane does not edit server.js and does not widen
   its own guard — the guard is the boundary and it is decided at the mount.

   ── THIS FILE'S ENTIRE JOB IS IDENTITY ────────────────────────────────────
   lib/mai/ decides what a role may reach. lib/mai/provider.js decides how to
   talk to Groq. This file decides WHO IS ASKING — and it is the only place
   that can get that wrong, because it is the only place holding both the
   session and the request body.

   So the rule here is absolute and has no exceptions anywhere below:

       Every value in `ctx` and the `role` argument is read from `req.user`.
       `req.body` is read for exactly two things: `question` and `confirmToken`.

   There is no branch, no fallback and no merge in this file that lets a request
   body, a QUERY STRING or a HEADER contribute a role, an owner id, a user id
   or a team id. A body that even MENTIONS one is refused outright (see
   IDENTITY_KEYS) rather than quietly stripped — a field that is silently
   ignored looks like a field that works, and it ships in somebody's client.

   ── WHY NOT req.query.key, THE WAY /seller DOES IT ────────────────────────
   `requireSeller` (server.js) takes its key from `req.query.key`. Query strings
   land in access logs, in Referer headers and in browser history. That is an
   acceptable risk for a read-only ops panel and NOT an acceptable one for a
   tool registry that can change a press release's status. GAUNTLET.md §S makes
   this explicit: M-Ai derives identity from the SESSION ONLY. There is no
   `req.query` and no `req.headers` read anywhere in this file.

   ── THE HARD PART, AND WHY IT IS HARDER HERE THAN ON M-EasyDo ─────────────
   M-EasyDo's customer-facing AI surfaces are ANONYMOUS, so "a customer
   session" there means "a caller with no role" and a guard that refuses null
   closes the boundary.

   HERE THEY ARE AUTHENTICATED. `POST /api/chat` and `POST /api/generate` are
   guarded by requireApiKey (server.js), which resolves a real `users` row from
   `users.api_key` and sets `req.user`. `users.role` DEFAULTS TO 'user', so an
   external integration holding an API key arrives as a real row carrying
   role='user' — and so does every self-registered account. A role check that
   only refused a blank would pass on M-EasyDo and FAIL OPEN here.

   lib/mai/roles.js normaliseRole() therefore resolves 'user' to NULL, exactly
   as it resolves undefined to null, and roleForUser() below is the only place
   a role is derived.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const { createMaiAssistant, auditOnAction } = require('../lib/mai/tools');
const { normaliseRole, ALL_ROLES } = require('../lib/mai/roles');
const { createMaiGenerate, providerStatus } = require('../lib/mai/provider');
const { createConfirmationStore, TOKEN_RE } = require('../lib/mai/confirmations');

/* ── The module gate: THERE IS NONE, and that is a decision ────────────────
   The eleven module PAGES are gated by checkModule() against
   `platform_modules`, whose eleven rows are seeded in server.js initDB() and
   whose `module_id` values are fixed there. M-Ai does not add a twelfth, for
   two reasons:

     1. A NEW KEY WOULD BE UNREACHABLE. The seed list lives in server.js, which
        this lane does not own, and there is no admin UI that can insert a row.
        Gating on a key nothing can create means shipping a feature whose only
        observable behaviour is 403.
     2. REUSING AN EXISTING KEY WOULD BE A LIE. M-Ai reads across documents, PR,
        the team and billing. Gating all 18 tools on 'pr' would hide document
        reporting behind the PR toggle.

   The honest gate already exists, PER TOOL: role is enforced by the registry on
   every call, and an account with no rows in a table gets tools/shared.js
   noneFound() — "this is an empty record, not a missing one", naming what would
   have written a row — rather than a feature-flag 403 that tells them less. */

/* ── The assistant: built ONCE, at module load ─────────────────────────────
   createMaiRegistry() asserts its invariants while building (no ANY_ROLE tool,
   every requiredRole a real staff role, every write reversible with a
   sideEffect sentence and a describer, the two unscoped reads pinned to
   ADMIN_ONLY), so a tool pack that violates the staff-only boundary takes the
   process down at BOOT instead of at 3pm on a Tuesday. Building per request
   would move that failure from deploy time to request time and pay the cost 18
   tools at a time. */
const assistant = createMaiAssistant({
  generate: createMaiGenerate({ logger: console }),

  /* Not overridable by anything on the wire. A body that could set
     writeMode:'auto' would be a permission grant with a JSON key for a
     password — see IDENTITY_KEYS, which refuses the field outright. */
  writeMode: 'confirm',

  /* Off deliberately. `display` is already the authoritative wording, and not
     making a second model call means there is no model prose for the grounding
     guard to police, no second slice of the per-minute Groq budget, and roughly
     half the latency on a path a human is watching. */
  phrase: false,

  /* The write log. Named explicitly rather than left to the default so that
     `grep auditOnAction` finds the wiring as well as the definition.

     It writes TWO records per write attempt, successes and failures alike: a
     durable row in `audit_log` (migrations/004, applied by the migration runner
     in server.js) and a structured line on the process log. The pool it uses is
     the one on `ctx.db` below — the same object the executors ran against — so
     the framework itself still holds no database dependency. See
     lib/mai/tools/index.js for why there are two sinks and why a failure to
     write the row must never fail this response. */
  onAction: auditOnAction,

  logger: console,
});

/* The longest question accepted. The dispatcher slices to 2000 internally; this
   REFUSES instead, because silently truncating a staff member's question means
   answering a question they did not ask and telling them it was theirs. */
const MAX_QUESTION = 2000;

/* ── Fields a request body may never carry ─────────────────────────────────
   Refused, not ignored. Each is either an identity claim (the whole
   vulnerability this endpoint exists to not have) or a control that would let a
   caller skip a step the dispatcher expects:

     role/ownerId/userId/teamId/ctx  — identity. Comes from the session, always.
     apiKey/api_key/key             — the shapes a caller would reach for to
                                      re-authenticate as somebody else, and the
                                      exact field name /seller takes from a
                                      query string.
     writeMode/phrase               — would turn confirm mode off from the wire.
     tool/args                      — would name a tool directly, bypassing the
                                      model-selection round and Guard 2 with it.
                                      A confirmation re-post sends the TOKEN,
                                      which already carries the tool the SERVER
                                      resolved; it never names one itself. */
const IDENTITY_KEYS = [
  'role', 'roles',
  'ownerId', 'owner_id',
  'userId', 'user_id',
  'teamId', 'team_id',
  'apiKey', 'api_key', 'key',
  'ctx', 'context',
  'writeMode', 'write_mode', 'phrase',
  'tool', 'tools', 'args',
];

/* ── The field that used to BE the confirmation, on the reference platform ──
   `confirmed: true` on the body was, on M-EasyDo, the entire human-confirmation
   gate. It was not one: nothing required that a confirmation had ever been
   ISSUED, so a single request performed a write with no sentence generated and
   none read, and because the re-post carried only the question the model was
   asked again — an approved `cancel_appointment(7)` was observed cancelling
   appointment 8. M-Ai here never had that flag. It is refused BY NAME anyway,
   so a client written against that older contract is told what to send instead
   rather than being told "unexpected field". */
const REMOVED_KEYS = {
  confirmed: 'confirmToken — the token returned in `confirm.token` on the pending_confirmation response',
  confirm: 'confirmToken — send the token itself, not the object it arrived in',
};

/* ── The confirmation store ────────────────────────────────────────────────
   One per process, built at module load next to the assistant. See
   lib/mai/confirmations.js for the design, the single-use rule, and the
   single-process caveat — which is fail-closed: a token this process cannot
   vouch for gets a refusal, never a write. */
const confirmations = createConfirmationStore();

/**
 * The staff role, derived SERVER-SIDE from the session and from nowhere else.
 *
 * `req.user` is a `users` row loaded by passport.deserializeUser(), so
 * `req.user.role` is the same column server.js checks. normaliseRole() resolves
 * anything unrecognised to NULL rather than to a default — and on this platform
 * "unrecognised" INCLUDES 'user', the column default that every self-registered
 * account and every /api/chat API-key holder carries.
 *
 * This is the line the whole file is about.
 */
function roleForUser(user) {
  return normaliseRole(user && user.role);
}

/* ── One question at a time, per user ──────────────────────────────────────
   A double-submitted form, an impatient second click on "Confirm", or a UI that
   retries on a slow response can otherwise put two confirmed writes in flight
   against the same row. In-memory, cleared in a `finally`, NO TIMER: the whole
   mechanism is a Set a request adds itself to and removes itself from.
   Single-process only — this is a UI double-click guard, not a distributed
   lock, and it is not load-bearing for correctness (every write is scoped by
   user_id in its own SQL and every write is reversible). */
const inFlight = new Set();

/* ── GET /api/mai/status ───────────────────────────────────────────────────
   What the UI needs before it renders an input box: can this deployment answer
   at all, what may THIS caller reach, and if not, why not — in words.
   Deliberately does NOT require the model to be configured; reporting "not
   configured" is its main job. */
router.get('/status', (req, res) => {
  try {
    const role = roleForUser(req.user);
    const provider = providerStatus();
    const tools = role ? assistant.registry.listForRole(role) : [];

    const reason = !role
      ? 'M-Ai is staff-only and this account carries no recognised M-EasyTools staff role ' +
        `(${ALL_ROLES.join(' or ')}), so it can reach no tool at all.`
      : provider.reason;

    res.json({
      // available = a question asked right now would reach a model and a tool.
      available: !!role && provider.configured && tools.length > 0,
      configured: provider.configured,
      missing: provider.missing,          // NAMES only — never a value
      reason: reason || null,
      model: provider.model,
      role,                               // server-derived; echoed so it is observable
      writeMode: 'confirm',
      /* How a write is approved on this deployment. 'token' means: ask, receive
         `confirm: { token, expiresAt }`, re-POST `{ confirmToken }`. A client
         that finds anything else here is talking to a build that predates the
         server-issued confirmation gate and should refuse to send a write at
         all rather than fall back to a flag. */
      confirmFlow: 'token',
      tools: {
        total: assistant.toolNames.length,
        forRole: tools.length,
        read: tools.filter(t => t.kind === 'read').length,
        write: tools.filter(t => t.kind === 'write').length,
        names: tools.map(t => t.name),
        /* The GENERIC definition sentence for every write this role can reach,
           so the UI can explain the round trip before the user meets it. The
           one a staff member is actually shown is composed against the resolved
           arguments and arrives on the pending_confirmation response. */
        writes: tools.filter(t => t.kind === 'write')
                     .map(t => ({ name: t.name, sideEffect: t.sideEffect, reversible: t.reversible })),
      },
    });
  } catch (e) {
    console.error('M-Ai status error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── POST /api/mai/ask ─────────────────────────────────────────────────────
   Body: EXACTLY ONE of
     { question: string }        the ask leg
     { confirmToken: string }    the confirm leg
   and nothing else. Sending both is refused; sending neither is refused.

   ── The confirmation round trip ────────────────────────────────────────────
   LEG 1. `{ question }`. If the model picks a write, the dispatcher resolves
   the tool and validates the arguments, composes the sideEffect sentence
   AGAINST THOSE ARGUMENTS, and returns `pending_confirmation` — BEFORE
   registry.execute is reached, so nothing has happened. This route then issues a
   token carrying that resolved {tool, args}, the question, the sentence, and the
   identity it was issued to, and returns `confirm: { token, expiresAt }`.

   LEG 2. `{ confirmToken }`. The token is SPENT — deleted on the way in, so it
   works exactly once — and what runs is the stored {tool, args}. THE MODEL IS
   NOT CONSULTED; `generate` is not called on this leg at all.

   The re-post is still a brand-new request and is still authorised from scratch:
     · requireAuth runs again — no session, no answer.
     · roleForUser(req.user) reads the session again. The body cannot name a
       role on the second request any more than on the first.
     · the token's user id and owner id must match this session's, so another
       account presenting a valid token is refused.
     · registry.canAccess() runs on the tool, and registry.execute() checks it
       again at the point of execution. A role revoked between the two legs
       refuses here.

   ── Why refusals are 200 and not 403 ──────────────────────────────────────
   The dispatcher returns the SAME refusal sentence whether a tool was forbidden
   or simply did not match, on purpose: distinguishing them turns the endpoint
   into an oracle for "does a tool named X exist and am I short of a permission
   for it". So every dispatcher outcome — answered, refused, pending — is 200,
   and `reason` carries the distinction to a caller already entitled to it.
   4xx here means the REQUEST was malformed or the CALLER cannot use M-Ai at
   all; it never means "that particular tool said no". */
router.post('/ask', async (req, res) => {
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

  // 1. Identity claims and control fields — refused before anything else, so
  //    the refusal cannot depend on the rest of this handler being correct.
  const claimed = IDENTITY_KEYS.filter(k => Object.prototype.hasOwnProperty.call(body, k));
  if (claimed.length) {
    return res.status(400).json({
      error: `M-Ai ignores nothing it is sent: this request body carries ${claimed.join(', ')}, ` +
             'which M-Ai derives from your session and never from a request. Send only ' +
             '{ question } to ask, or { confirmToken } to approve a write M-Ai already described.',
      reason: 'identity_in_body',
      rejectedFields: claimed,
    });
  }

  // 1b. Fields from the older contract. Named, with their replacement.
  const removed = Object.keys(REMOVED_KEYS)
    .filter(k => Object.prototype.hasOwnProperty.call(body, k));
  if (removed.length) {
    return res.status(400).json({
      error: `M-Ai does not accept ${removed.join(', ')}. A write is approved by presenting a ` +
             'server-issued confirmation token, not by a flag the caller sets. Send ' +
             `{ ${removed.map(k => REMOVED_KEYS[k]).join(' } / { ')} }.`,
      reason: 'confirmed_removed',
      rejectedFields: removed,
      replacement: 'confirmToken',
    });
  }

  // 2. Exactly one leg. A body carrying both a question and a token is
  //    ambiguous about which one is meant to happen, and guessing either way
  //    would make one of the two silently ignored — the failure mode step 1
  //    exists to refuse.
  const hasQuestion = Object.prototype.hasOwnProperty.call(body, 'question');
  const hasToken    = Object.prototype.hasOwnProperty.call(body, 'confirmToken');
  if (hasQuestion && hasToken) {
    return res.status(400).json({
      error: 'Send either { question } to ask, or { confirmToken } to approve a write M-Ai already described — ' +
             'not both. A token already carries the action it approves; a question alongside it would either be ' +
             'ignored or would re-ask the model, and re-asking is exactly what a confirmation must not do.',
      reason: 'ambiguous_body',
    });
  }
  if (!hasQuestion && !hasToken) {
    return res.status(400).json({ error: 'question is required', reason: 'bad_question' });
  }

  // 3. The token, if this is the confirm leg. Shape-checked here; whether it is
  //    live, unspent and this session's is decided by the store, below, and
  //    every one of those failures returns the SAME refusal.
  let confirmToken = null;
  if (hasToken) {
    if (typeof body.confirmToken !== 'string' || !TOKEN_RE.test(body.confirmToken)) {
      return res.status(400).json({
        error: 'confirmToken must be the token string M-Ai returned in confirm.token on a ' +
               'pending_confirmation response.',
        reason: 'confirm_invalid',
      });
    }
    confirmToken = body.confirmToken;
  }

  // 4. The question, if this is the ask leg.
  const question = (!hasToken && typeof body.question === 'string') ? body.question.trim() : '';
  if (!hasToken) {
    if (!question) {
      return res.status(400).json({ error: 'question is required', reason: 'bad_question' });
    }
    if (question.length > MAX_QUESTION) {
      return res.status(400).json({
        error: `question is ${question.length} characters; the limit is ${MAX_QUESTION}. ` +
               'Refused rather than truncated — a shortened question is a different question.',
        reason: 'question_too_long',
      });
    }
  }

  // 5. THE ROLE. From the session. This is the line the whole file is about.
  const role = roleForUser(req.user);
  if (!role) {
    return res.status(403).json({
      error: 'M-Ai is staff-only and this account carries no recognised M-EasyTools staff role.',
      reason: 'forbidden',
    });
  }

  /* 6. The model. Honest when absent — an empty answer would read as "M-Ai
        knows nothing about your workspace", which is a false statement about
        the data rather than a true one about the deployment.

        ASK LEG ONLY. The confirm leg does not call the provider at all, so a
        provider that goes down between the two legs must not strand a write a
        human has already approved — a 503 there would blame the approval for
        something that has nothing to do with it, and the token would be gone by
        the time they read the message. */
  if (!hasToken) {
    const provider = providerStatus();
    if (!provider.configured) {
      return res.status(503).json({
        error: provider.reason,
        reason: 'ai_unconfigured',
        missing: provider.missing,
        configured: false,
      });
    }
  }

  if (inFlight.has(req.user.id)) {
    return res.status(429).json({
      error: 'A previous M-Ai question from this account is still running. Wait for it to finish — ' +
             'a second confirmation sent while the first is in flight could perform the same write twice.',
      reason: 'in_flight',
    });
  }
  inFlight.add(req.user.id);

  try {
    /* 7. The context. Every field from `req.user`. Nothing here is read from
          `req.body`, from `req.query` or from `req.headers`, and `req.body` is
          not spread anywhere in this object — including into a nested key.

          `ownerId` is `req.user.id` because THAT IS THIS PLATFORM'S TENANCY
          COLUMN: documents, pr_releases, pr_distributions, subscriptions,
          payments, invoices and user_settings are all keyed by `user_id`, and
          every other route in this repo scopes the same way. `team_id` is
          carried for the two team reads and is never used as a scope on its
          own — a null team must never widen a query. */
    const ctx = {
      db: pool,
      ownerId: req.user.id,
      userId: req.user.id,
      userName: req.user.name || req.user.email || 'Staff',
      teamId: req.user.team_id || null,
    };

    // 8. One of two legs.
    let r;
    let asked = question;
    let approvedSideEffect = null;

    if (hasToken) {
      /* ── The confirm leg ──────────────────────────────────────────────
         The token is spent HERE, before anything else, and it is spent by being
         TOUCHED: unknown, expired, already used and issued-to-another-session
         all return the same refusal and all leave the token gone. The identity
         it is checked against is THIS request's, derived at step 7 from the
         session — not anything the body said. */
      const spent = confirmations.consume(confirmToken, { userId: req.user.id, ownerId: ctx.ownerId });
      if (!spent.ok) {
        return res.status(400).json({
          error: 'That confirmation is no longer valid. It may have expired, it may already have been used, ' +
                 'or it may not have been issued to this account. Nothing was changed. Ask the question again ' +
                 'to get a fresh one.',
          reason: 'confirm_invalid',
        });
      }

      const rec = spent.record;
      asked = rec.question;
      approvedSideEffect = rec.sideEffect;

      /* What runs is rec.tool with rec.args. The model is not called. The
         arguments are re-validated and the role is re-checked inside confirm(). */
      r = await assistant.confirm({
        tool: rec.tool,
        args: rec.args,
        question: rec.question,
        role,
        ctx,
        sideEffectShown: rec.sideEffect,
        approvalId: confirmations.handle(rec.token),
      });
    } else {
      /* ── The ask leg ──────────────────────────────────────────────────
         Three arguments and a ctx, and `role` is the derived one. There is no
         fourth argument that could perform a write: ask() has no `confirmed`
         parameter and refuses a caller that passes one. */
      r = await assistant.ask({ question, role, ctx });
    }

    const outcome = r.pendingConfirmation ? 'pending_confirmation'
                  : r.answered ? 'answered'
                  : 'refused';

    /* 9. An EXPLICIT response shape. The dispatcher result is not spread into
          the body: a field added to the framework later would otherwise reach
          the wire without anyone deciding it should. */
    const payload = {
      outcome,
      answer: r.answer,
      answered: !!r.answered,
      pendingConfirmation: !!r.pendingConfirmation,
      tool: r.tool || null,
      tools: Array.isArray(r.tools) ? r.tools : (r.tool ? [r.tool] : []),
      args: r.args || null,
      data: r.data || null,
      display: r.display || null,
      rows: Array.isArray(r.rows) ? r.rows : [],
      wrote: !!r.wrote,
      reason: r.reason || null,
      /* Bounded. Useful to a staff member debugging their own question, and
         never large enough to be a channel for anything else. */
      detail: r.detail ? String(r.detail).slice(0, 300) : null,
      droppedToolCalls: r.droppedToolCalls || 0,
      rounds: r.rounds || 1,
      usage: r.usage || null,
      /* Echoed so that "identity came from the session" is OBSERVABLE in the
         response rather than only assertable about the code: an account whose
         body claimed admin sees its real role here — and, because the body
         would have been refused at step 1, never gets this far to begin with. */
      role,
      ownerId: ctx.ownerId,
    };

    if (r.pendingConfirmation) {
      /* The token is issued HERE, after the dispatcher has resolved the tool and
         validated the arguments and BEFORE anything has run. It carries that
         resolved pair, so approving this sentence can only ever perform this
         action; and it carries this session's user id and owner id, so it is
         spendable by this account and no other. */
      payload.sideEffect = r.sideEffect || null;
      payload.sideEffectStatic = r.sideEffectStatic || null;
      payload.reversible = !!r.reversible;

      const issued = confirmations.issue({
        tool: r.tool,
        args: r.args,
        question,
        sideEffect: r.sideEffect,
        reversible: r.reversible,
        userId: req.user.id,
        ownerId: ctx.ownerId,
      });
      payload.confirm = { token: issued.token, expiresAt: issued.expiresAt };
    }

    if (r.confirmed) {
      /* Observable on the response, not merely true in the log: this write ran
         because a token was spent, and this is the sentence that was approved. */
      payload.confirmed = true;
      payload.sideEffect = approvedSideEffect;
      payload.reversible = !!r.reversible;
      payload.question = asked;
    }

    res.json(payload);
  } catch (e) {
    /* The dispatcher converts provider and executor failures into refusals, so
       reaching here means something structural (the pool, the session). */
    console.error('M-Ai ask error:', e.message);
    res.status(500).json({ error: e.message, reason: 'server_error' });
  } finally {
    inFlight.delete(req.user.id);
  }
});

module.exports = router;
/* Exported for a test author. Functions of a user object and plain constants —
   none of these is a route and mounting one is not possible. */
module.exports.roleForUser = roleForUser;
module.exports.IDENTITY_KEYS = IDENTITY_KEYS;
module.exports.REMOVED_KEYS = REMOVED_KEYS;
module.exports.MAX_QUESTION = MAX_QUESTION;
/* The live store this router uses. Exported so a test can assert single-use,
   expiry and session-binding against the SAME object the route spends from,
   rather than against a second one that proves nothing about this one. */
module.exports.confirmations = confirmations;
/* The live assistant this router uses, for the same reason: a boundary test
   that reads a registry it built itself has not read the one that is mounted. */
module.exports.assistant = assistant;

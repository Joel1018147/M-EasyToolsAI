'use strict';
// Server-issued confirmation tokens for M-Ai writes.
//
// ── What this file replaces, and why it exists at all ──────────────────────
// This used to be a boolean. `POST /api/mai/ask` accepted `{ confirmed: true }`
// off the request body and `dispatcher.ask()` turned it straight into
// `writeMode = 'auto'`. Three separate things were wrong with that, and each
// one was demonstrated against the running app rather than argued about:
//
//   1. NO ISSUE STEP. Nothing required that a `pending_confirmation` had ever
//      been returned. One request — `{"question":"cancel the appointment",
//      "confirmed":true}` — performed the write. The sideEffect sentence, the
//      entire human-confirmation artefact, was never generated and never read.
//   2. NOTHING BOUND THE APPROVAL TO THE ACTION. The re-post carried only the
//      question. Pass two re-ran the model from scratch and executed whatever
//      it named THAT time: an approved `set_ticket_priority` was observed
//      running `reassign_ticket`, and an approved `cancel_appointment(7)` was
//      observed cancelling appointment 8 — a different customer's booking.
//   3. THE AUDIT ROW COULD NOT TELL THE DIFFERENCE. Both paths logged
//      byte-identical `{"mode":"auto","confirmed":true}`.
//
// So a confirmation is no longer a claim the caller makes. It is a token this
// process issued, carrying the tool and arguments that were ALREADY resolved
// when the sentence was shown, and presenting it executes exactly those.
//
// ── Deliberate divergence from M-EasyCommerce ──────────────────────────────
// The M-Ai framework in lib/mai/ was built against M-EasyCommerce's
// `src/services/secretary/dispatcher.js` as a reference pattern, and that file
// has the same client-side-boolean confirmation defect described above. This
// module is a DELIBERATE divergence from the reference. When the shared
// @modus/mai extraction eventually happens it must carry THIS design, not
// Commerce's boolean. (Per GAUNTLET.md's repo boundary, the Commerce repo is
// not touched from here; this note is the handoff.)
//
// ── Where the token lives, and the caveat that comes with that ─────────────
// IN THIS PROCESS'S MEMORY. A `Map`, and nothing else — no new table and no
// migration, which is a hard constraint of this workstream.
//
// The honest caveat, stated the same way `routes/mai.js`'s `inFlight` Set
// states its own: THIS IS SINGLE-PROCESS. On a multi-replica deployment a
// token issued by replica A is unknown to replica B, and a restart drops every
// pending confirmation. Both of those failure modes are FAIL-CLOSED: the
// confirm leg gets a refusal and the staff member asks the question again. No
// write happens on a token this process cannot vouch for. That is the whole
// reason the store is here rather than in a signed stateless token — a signed
// token survives a restart and crosses replicas, but its single-use property
// then has nowhere to live, and a replayable approval is a worse bug than an
// approval that occasionally has to be re-issued. If M-EasyDo ever runs more
// than one replica, the fix is a shared store (Redis, or a table with a
// migration), NOT loosening single-use.
//
// ── No timers ──────────────────────────────────────────────────────────────
// Expiry is lazy: every issue() and every consume() sweeps first. There is no
// setTimeout and no setInterval anywhere in this file — the ecosystem
// engineering bar forbids them, and a sweep on a path that already runs is
// strictly cheaper than a timer that fires whether or not anyone is using the
// feature.

const crypto = require('crypto');

/** 32 random bytes, hex. Guessing is not a threat model this has to defend. */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

// Five minutes. Long enough to read a sentence naming a real row and decide;
// short enough that a token left in a closed laptop's network tab is dead
// before anyone gets to it.
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// A ceiling on how many unanswered confirmations this process will hold. Every
// entry is a few hundred bytes and only a signed-in staff member can create
// one, so this is a memory backstop rather than a rate limit — but an
// unbounded Map fed by a route is still an unbounded Map fed by a route.
const DEFAULT_MAX = 500;

/** Identity components are compared as strings so a numeric id and its decimal
 *  string can never be treated as different principals — or as the same one as
 *  null. Null/undefined is never a valid identity here. */
function idKey(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.max]
 * @param {Function} [opts.now] Injected clock, so expiry is testable without
 *   sleeping. Production never passes it.
 */
function createConfirmationStore({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, now = Date.now } = {}) {
  /** @type {Map<string, object>} token → record. Insertion-ordered, which is
   *  what makes the overflow eviction below "oldest first" for free. */
  const pending = new Map();

  function sweep(t) {
    for (const [token, rec] of pending) {
      if (rec.expiresAt <= t) pending.delete(token);
    }
  }

  /**
   * Issue a token for an ALREADY-RESOLVED action.
   *
   * `tool` and `args` are what the model chose and what the validator accepted
   * on the ask leg — resolved once, here, and never asked again. `sideEffect`
   * is the exact sentence the human is about to be shown; it is stored so the
   * audit row can record what was actually on screen rather than what the tool
   * definition says in general.
   *
   * @returns {{token:string, expiresAt:string, record:object}}
   */
  function issue({ tool, args, question, sideEffect, reversible, userId, ownerId }) {
    if (typeof tool !== 'string' || !tool.trim()) {
      throw new Error('M-Ai confirmations: a tool name is required');
    }
    const user = idKey(userId);
    const owner = idKey(ownerId);
    if (!user || !owner) {
      // Fail closed and LOUDLY. A token with no identity on it is a token
      // anybody can spend, which is the bug this module exists to remove.
      throw new Error('M-Ai confirmations: a token must be bound to both a user id and an owner id');
    }

    const t = now();
    sweep(t);
    // Deep-copied so a later mutation of the caller's object cannot change what
    // was approved. The arguments are plain JSON by construction — they came
    // off a tool call and through validateArgs.
    let frozenArgs;
    try {
      frozenArgs = JSON.parse(JSON.stringify(args === undefined || args === null ? {} : args));
    } catch (_err) {
      throw new Error('M-Ai confirmations: arguments must be JSON-serialisable');
    }

    while (pending.size >= max) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const record = {
      token,
      tool: tool.trim(),
      args: frozenArgs,
      question: typeof question === 'string' ? question : '',
      sideEffect: typeof sideEffect === 'string' ? sideEffect : null,
      reversible: !!reversible,
      userId: user,
      ownerId: owner,
      issuedAt: t,
      expiresAt: t + ttlMs,
    };
    pending.set(token, record);
    return { token, expiresAt: new Date(record.expiresAt).toISOString(), record };
  }

  /**
   * Spend a token. SINGLE USE: the entry is deleted before any check that could
   * reject it, so a token is consumed by being TOUCHED, not by succeeding.
   *
   * That ordering is deliberate and it has a cost worth naming. A token
   * presented by the wrong session is burned rather than left for its rightful
   * owner, so an attacker holding a leaked token can deny that one
   * confirmation. The alternative — leave it live — means a token that has
   * demonstrably leaked stays spendable, and the attacker only has to come back
   * with the right session cookie. A denied confirmation is a re-ask; a
   * spendable leaked approval is an unapproved write.
   *
   * Every failure returns the SAME reason. Unknown, expired, already spent and
   * issued-to-someone-else are indistinguishable to the caller on purpose:
   * distinguishing them turns this endpoint into an oracle for "is this token
   * real", which is the same oracle argument routes/mai.js already makes about
   * mapping `forbidden` to 403.
   *
   * @returns {{ok:true, record:object} | {ok:false, reason:'confirm_invalid'}}
   */
  function consume(token, { userId, ownerId } = {}) {
    const t = now();
    sweep(t);

    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, reason: 'confirm_invalid' };
    const record = pending.get(token);
    if (!record) return { ok: false, reason: 'confirm_invalid' };
    pending.delete(token);                                   // ← single use, before anything else

    if (record.expiresAt <= t) return { ok: false, reason: 'confirm_invalid' };

    const user = idKey(userId);
    const owner = idKey(ownerId);
    if (!user || !owner) return { ok: false, reason: 'confirm_invalid' };
    if (record.userId !== user || record.ownerId !== owner) return { ok: false, reason: 'confirm_invalid' };

    return { ok: true, record };
  }

  /**
   * A short, non-secret handle for the audit row. The full token is a bearer
   * credential and never leaves this process or reaches a log line; the first
   * 12 hex characters are enough to correlate an issue with its use and not
   * enough to spend.
   */
  const handle = (token) => (typeof token === 'string' && TOKEN_RE.test(token) ? token.slice(0, 12) : null);

  return {
    issue,
    consume,
    handle,
    /** Test/observability only. */
    size: () => pending.size,
    sweep: () => sweep(now()),
  };
}

module.exports = { createConfirmationStore, TOKEN_RE, DEFAULT_TTL_MS, DEFAULT_MAX };

'use strict';
// Shared helpers for every M-Ai tool pack on M-EasyTools.
//
// The packs in this folder are the M-EasyTools half of M-Ai: the five framework
// files one directory up hold the mechanism and know nothing about documents or
// press releases, and everything that names a table lives here and in its
// siblings.
//
// ── The executor contract, stated once ─────────────────────────────────────
//   async executor(args, ctx) -> { display: string, data: object, rows?: string[] }
//
//   ctx.db       Postgres pool (or anything with .query(sql, params)).
//                PARAMETERISED QUERIES ONLY. No argument and no ctx value is
//                ever interpolated into SQL text anywhere in this folder — grep
//                the pack for a `${` inside a query string and you will find
//                none, and test/mai-boundary-test.js asserts it.
//   ctx.ownerId  The account every query is scoped to. On M-EasyTools that is
//                `req.user.id` — this platform's tenancy column is `user_id` on
//                documents, pr_releases, pr_distributions, subscriptions,
//                payments, invoices and user_settings, and routes/mai.js reads
//                it from the SESSION. It is never an argument, so the model
//                cannot supply it, and validate.js strips any key a tool did
//                not declare — so a model that invents `ownerId` in its
//                argument list has that key dropped before an executor sees it.
//   ctx.role     Already checked by the registry before the executor runs.
//   ctx.userId   The asking staff member's user id.
//   ctx.userName The asking staff member's display name.
//   ctx.teamId   users.team_id. May be null — most accounts have no team.
//
//   `display` is AUTHORITATIVE. It is what the caller sees when the model's
//   phrasing is discarded by the grounding guard, and production wiring turns
//   phrasing off entirely, so it must be a complete, readable answer on its own
//   — not a fragment the model is expected to finish.
//
//   `data` must carry every figure as a NUMBER. The grounding guard compares
//   the model's prose against these values, and a figure that appears only
//   inside a formatted string in `display` cannot be matched, so the model
//   quoting it correctly would be treated as a hallucination and thrown away.
//
// ── Why time windows are computed in JavaScript ────────────────────────────
// Every "last N days" bound below is a Date computed here and passed as a BOUND
// PARAMETER, never written into SQL as an interval expression. It is the
// strongest possible form of "parameterised": there is no string concatenation
// anywhere near a model-supplied number, and the bound is clamped in JS before
// it is bound, so a hostile `days` cannot widen the window even if validate.js
// ever lost its `maximum`.

// ── Formatting ─────────────────────────────────────────────────────────────
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => Math.round(num(v));
const round1 = (n) => Math.round(num(n) * 10) / 10;
const round2 = (n) => Math.round(num(n) * 100) / 100;
const pct = (n) => `${Number(num(n)).toFixed(1)}%`;

/**
 * ONE money formatter, and it renders the ISO CODE THE ROW RECORDED rather than
 * a symbol.
 *
 * `payments.currency` and `subscriptions.currency` are VARCHAR columns with a
 * 'MYR' default — the value is data, not an assumption — so the formatter takes
 * it and prints it. It deliberately does NOT translate MYR into "RM": the
 * grounding guard compares currency UNITS as well as digits, and a symbol the
 * row never carried is exactly as invented as a number the executor never
 * produced. One formatter for the whole pack, because a pack that printed
 * "MYR 12.00" in one tool and "RM 12.00" in another would fail that guard at
 * random.
 *
 * NOT used on `pr_distributions.package_price`, which has NO currency column
 * anywhere near it. That figure is emitted bare — see prPackagePrice() below.
 */
const money = (amount, currency) => {
  const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : 'MYR';
  return `${code} ${Number(num(amount)).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * `pr_distributions.package_price` with no unit attached, on purpose.
 *
 * That table records a DECIMAL(10,2) and records no currency beside it. Every
 * price the app writes into it comes from a Malaysian package list, so it is
 * almost certainly ringgit — and "almost certainly" is the exact standard this
 * pack is not allowed to report a figure at. Emitting it bare means any
 * currency symbol the model adds is ungrounded and Guard 5 discards the prose.
 */
const prPackagePrice = (v) => `${Number(num(v)).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ISO minute / day, no timezone suffix. Staff read these as local wall-clock
// times and a trailing Z invites the reader to mentally re-offset a time that
// is already correct.
const ts = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toISOString().slice(0, 16).replace('T', ' '); };
const day = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? '—' : x.toISOString().slice(0, 10); };

/** Whole days between a timestamp and now, rounded down. Never negative. */
const daysSince = (d) => {
  if (!d) return 0;
  const x = new Date(d);
  if (isNaN(x)) return 0;
  return Math.max(0, Math.floor((Date.now() - x.getTime()) / 86400000));
};

/** Trim a free-text column for a detail row. Control characters out, bounded. */
function oneLine(v, max = 90) {
  let out = '';
  for (const ch of String(v === null || v === undefined ? '' : v)) {
    const cp = ch.codePointAt(0);
    out += (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) ? ' ' : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (!out) return '(untitled)';
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

// ── Shared argument schemas ────────────────────────────────────────────────
// Every reporting tool takes the same `days` argument with the same bounds, so
// the model sees one consistent shape across the whole pack instead of learning
// a different period convention per tool. The bounds are what makes a hostile
// argument harmless: -1, 0, 999999999 and 1e308 are all rejected by validate.js
// before an executor is reached.
const DAYS_PARAM  = { type: 'integer', minimum: 1, maximum: 365, default: 30 };
const LIMIT_PARAM = { type: 'integer', minimum: 1, maximum: 25,  default: 10 };

// Free text a staff member typed. Bounded so a model echoing a 40KB
// prompt-injection payload into a search argument cannot turn it into a query.
//
// `minLength: 1` HERE MEANS "must name something", and the enforcement of that
// meaning is in dispatcher.js (Guard 6b, blankTextArgs), which reads `minLength`
// off whatever schema each tool actually declared. validate.js compares
// `.length` without trimming — it is the shared, deliberately minimal validator
// destined for @modus/mai and has no `pattern` support — so `" "` would
// otherwise pass a minLength of 1 and reach an executor with a confirmation
// sentence naming no row.
const SEARCH_PARAM = { type: 'string', minLength: 1, maxLength: 120 };

/** The lower bound of a rolling N-day window, as a Date to be BOUND, not built. */
function sinceDays(days) {
  const d = Number.isFinite(days) ? days : 30;
  const clamped = Math.min(365, Math.max(1, Math.floor(d)));
  return new Date(Date.now() - clamped * 86400000);
}

/** The upper bound of a rolling N-day FORWARD window (for "expiring soon"). */
function untilDays(days) {
  const d = Number.isFinite(days) ? days : 30;
  const clamped = Math.min(365, Math.max(1, Math.floor(d)));
  return new Date(Date.now() + clamped * 86400000);
}

// ── Owner scope: the multi-tenant boundary ─────────────────────────────────
/**
 * The requesting account's id, or a THROWN error.
 *
 * THROWING IS THE POINT, and it is recurring-bug #4 in one function. A missing
 * ownerId is the kind of thing a query happily accepts as NULL — `WHERE
 * user_id = NULL` matches nothing, the tool reports "you have generated no
 * documents", and an account with a broken session is told everything is fine.
 * An owner-scoped query with no owner is not a query with no results; it is a
 * query that MUST NOT RUN.
 *
 * The registry turns the throw into `executor_error` and the dispatcher turns
 * that into a refusal, so the failure is visible rather than reassuring.
 */
function ownerIdOf(ctx) {
  const raw = ctx && ctx.ownerId;
  const n = typeof raw === 'number' ? raw
          : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('M-Ai: ctx.ownerId is missing or is not a positive integer. ' +
                    'Every M-Ai query is scoped to one account and this one cannot be — refusing rather than ' +
                    'running an unscoped or NULL-scoped query.');
  }
  return n;
}

function dbOf(ctx) {
  const db = ctx && ctx.db;
  if (!db || typeof db.query !== 'function') {
    throw new Error('M-Ai: ctx.db must be a Postgres pool with a .query(sql, params) method.');
  }
  return db;
}

// ── Degrading on a schema gap without swallowing a real fault ──────────────
// These three SQLSTATEs mean "this database does not have that": undefined
// table, undefined column, undefined function. The message forms are matched as
// well, because a stub pool in a test harness does not set `.code`.
//
// Everything else — a dropped connection, a deadlock, a permission denial, a
// syntax error introduced by an edit to this file — is RETHROWN. A tool that
// answered "no data" to a broken pool would be reporting an all-clear it never
// checked.
//
// Note what this does NOT catch: the error thrown by ownerIdOf() above carries
// no SQLSTATE and matches none of these patterns, so a missing owner scope can
// never be laundered into a cheerful "no rows" answer by this wrapper. There is
// a test for exactly that.
const MISSING_SCHEMA = new Set(['42P01', '42703', '42883']);
const MISSING_SCHEMA_RE = /relation "[^"]*" does not exist|column "[^"]*" does not exist|function [^ ]* does not exist/i;
const isSchemaGap = (err) =>
  !!err && (MISSING_SCHEMA.has(err.code) || (typeof err.message === 'string' && MISSING_SCHEMA_RE.test(err.message)));

/** Wrap an executor so a table this deployment does not have answers honestly
 *  instead of throwing an opaque error at a staff member. */
function safe(what, fn) {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx);
    } catch (err) {
      if (!isSchemaGap(err)) throw err;
      return {
        display: `I cannot answer that: ${what} is not present in this database, so the figure has never been ` +
                 'recorded here. Treat this as "not measured", not as a zero.',
        data: { available: false, reason: 'schema_missing', count: 0 },
        rows: [],
      };
    }
  };
}

// ── Empty-result honesty ───────────────────────────────────────────────────
/**
 * The ordinary empty result: the table exists, it IS written to, and this
 * account genuinely has nothing in it.
 *
 * `sourceNote` names the thing that WOULD have written a row, so the reader
 * knows where to go. Without it, "0 press releases" is indistinguishable from a
 * real all-clear while being a statement about a module nobody has opened — and
 * an owner who concludes a capability is missing never looks for it again. That
 * is the most expensive sentence this system can emit.
 */
function noneFound(what, sourceNote, data = {}) {
  return {
    display: `No ${what}. ${sourceNote} This is an empty record, not a missing one.`,
    data: { count: 0, empty: true, ...data },
    rows: [],
  };
}

// ── Write-tool results ─────────────────────────────────────────────────────
//
// `data.changed` IS THE CONTRACT, and it is READ rather than merely written.
// Every write executor in this folder sets `changed: true` on its one success
// path and `changed: false` on every path that deliberately touched nothing;
// dispatcher.rowChanged() derives the response's `wrote` flag from it, and
// public/mai.html decides between "Applied", "No change made" and "Refused" on
// that flag. A new write executor that returns a success without
// `changed: true` will be reported as having changed nothing — the safe
// direction, but say it explicitly rather than relying on being reported wrong.

/**
 * The result a write returns when its target does not exist FOR THIS ACCOUNT.
 *
 * The same sentence is returned whether the row does not exist at all or
 * belongs to another account, and that is deliberate: distinguishing the two
 * would turn every write tool into an oracle for "does press release 41 exist
 * somewhere on this platform". The row is not touched either way — every write
 * below carries `AND user_id = $n` in its own UPDATE as well as checking here,
 * so the refusal is enforced by the SQL and not only by this branch.
 */
function refusedTarget(what, ref) {
  return {
    display: `Refused: there is no ${what} matching ${JSON.stringify(String(ref))} on this account. ` +
             'Nothing was changed.',
    data: { changed: false, refused: true, reason: 'not_found_for_account' },
    rows: [],
  };
}

/** The result a write returns when the row is already in the requested state. */
function noChangeNeeded(what, state) {
  return {
    display: `No change made: ${what} is already ${state}.`,
    data: { changed: false, refused: false, reason: 'already_in_state' },
    rows: [],
  };
}

/** The result a write returns when a search matched more than one row. NOTHING
 *  is picked. Picking the first would change a row the staff member did not
 *  name, and the confirmation sentence they approved said "matching", not
 *  "the one I guessed". */
function refusedAmbiguous(what, ref, matches) {
  return {
    display: `Refused: ${matches.length} ${what}s match ${JSON.stringify(String(ref))}. M-Ai does not pick one. ` +
             'Nothing was changed — ask again naming exactly one.',
    data: { changed: false, refused: true, reason: 'ambiguous_match', matches: matches.length },
    rows: matches.slice(0, 10),
  };
}

/**
 * READ BACK AND THROW.
 *
 * Every write in this folder re-SELECTs the row it just changed, scoped to the
 * same owner, and throws if the column does not hold the value that was asked
 * for. An UPDATE that reports `rowCount: 1` has reported that Postgres matched
 * a row, not that the value landed — a trigger, a stale connection to a replica
 * or a column type coercion can all produce a matched row and a different
 * stored value, and the staff member would be told their change was applied.
 *
 * The throw becomes `executor_error` → a refusal, which is the honest outcome:
 * something happened that this code cannot describe, so it does not describe it.
 */
function assertReadBack(what, expected, actual) {
  if (String(actual) !== String(expected)) {
    throw new Error(`M-Ai: ${what} was updated but reads back as ${JSON.stringify(String(actual))} ` +
                    `rather than ${JSON.stringify(String(expected))}. Refusing to report a change that ` +
                    'the database does not agree happened.');
  }
}

module.exports = {
  num, int, round1, round2, pct, money, prPackagePrice, ts, day, daysSince, oneLine,
  DAYS_PARAM, LIMIT_PARAM, SEARCH_PARAM, sinceDays, untilDays,
  ownerIdOf, dbOf, safe, isSchemaGap, noneFound,
  refusedTarget, noChangeNeeded, refusedAmbiguous, assertReadBack,
};

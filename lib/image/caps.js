/* ═══════════════════════════════════════════════════════════════════════════
   BUDGET / RATE CAPS — checked before the money is spent
   ───────────────────────────────────────────────────────────────────────────
   ── WHAT COUNTS, AND WHY IT IS NOT JUST 'stored' ──────────────────────────
   Migration 004 spells this out and it is the whole reason the cap lives in
   its own file:

       rehost_failed is distinct from failed BECAUSE IT STILL COST MONEY. The
       provider generated an image and billed for it; only the download
       failed. A cap that counts 'stored' alone would let a user with a flaky
       download path spend without limit.

   This file counts a third status the migration does not name, and the reason
   is the same reason: `pending`. A row is inserted as `pending` BEFORE the
   provider call, precisely so that a crash mid-call leaves evidence. A row
   that is still `pending` is therefore a request that reached — or may have
   reached — the provider, and may have been billed. Counting it is the
   conservative direction, and the conservative direction is the correct one
   for a spend limit.

   NOT counted: `refused` (moderation stopped it before the request left the
   process — nothing was billed) and `failed` (the provider call threw before
   returning an image — a 400 on an illegal parameter, a 401, a network
   error). Both are free, and charging a user's budget for a request the
   provider rejected would be wrong in the user's favour's opposite direction.

   ── WHERE THE TIER COMES FROM, AND A REAL DEFECT FOUND WHILE LOOKING ──────
   `users.plan VARCHAR(50) DEFAULT 'free'` (server.js:74) is the column the
   brief names, and it is read here. But reading ONLY it would have shipped a
   cap that is wrong for every paying customer, because of this:

     * `users.plan` is written in exactly two places — signup/OAuth, which
       hardcodes 'free' (server.js:292, :463), and the admin route
       `UPDATE users SET plan=COALESCE($1,plan)…` (server.js:1376).
     * The iPay88 success path writes `subscriptions`, not `users`:
       `SET status='active', billing_cycle=$2, plan=$2` (server.js:1544).

   SO A CUSTOMER WHO PAYS STILL HAS `users.plan = 'free'`. That is a
   pre-existing repo defect, it is outside this lane's file ownership to fix,
   and it is reported rather than worked around silently. What this file does
   about it is resolve the EFFECTIVE tier as the more generous of the two
   signals — `users.plan` and the live subscription state that `checkSub`
   already put on `req.subscription` — so a paying customer is not capped at
   the free tier by a bug in someone else's route.

   ── UNKNOWN PLAN NAMES FAIL CLOSED ────────────────────────────────────────
   The admin route accepts an arbitrary string into `users.plan`. A tier
   lookup that returns `undefined` for an unrecognised name and then reads
   `.perDay` off it throws; one that defaults to the most generous tier hands
   an unlimited budget to a typo. Unknown resolves to the FLOOR tier, and the
   response says which tier was applied so the mismatch is visible rather than
   mysterious.

   ── THE STORAGE CONSEQUENCE, STATED IN NUMBERS ────────────────────────────
   UPGRADE-SPEC §4: the smallest legal size for this model family produces a
   ~1.9 MB PNG, there is no smaller option, and the bytes live in `BYTEA`.
   These caps are therefore a storage budget as much as a spend budget:

       tier      per 30 days   ≈ BYTEA per user
       free            15          ~29 MB
       trial           30          ~57 MB
       monthly        200         ~380 MB
       yearly         250         ~475 MB
       agency         600         ~1.1 GB

   There is no retention policy in this repo and this lane cannot add one —
   it owns no migration and the Engineering Bar forbids introducing a
   scheduler. That gap is reported, not papered over.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * Statuses that represent money already committed to the provider.
 * Frozen: a caller must not be able to shrink this set for everyone else.
 */
const BILLABLE_STATUSES = Object.freeze(['stored', 'rehost_failed', 'pending']);

/** Statuses that cost nothing and therefore must never consume budget. */
const FREE_STATUSES = Object.freeze(['refused', 'failed']);

/**
 * The two windows. A daily cap stops a single bad afternoon; a 30-day cap is
 * the actual budget. Both are rolling, not calendar — a calendar month resets
 * at midnight on the 1st and hands everybody their whole allowance at once.
 *
 * The interval strings are passed to PostgreSQL as PARAMETERS cast to
 * `interval`, never interpolated, so this stays parameterized-only under the
 * Engineering Bar even though the values are internal constants.
 */
const WINDOWS = Object.freeze({
  day:   { key: 'day',   interval: '24 hours', label: 'the last 24 hours' },
  month: { key: 'month', interval: '30 days',  label: 'the last 30 days' },
});

/**
 * Tiers, in ascending order of allowance. `rank` is what makes "the more
 * generous of two signals" a comparison rather than a chain of ifs.
 *
 * The names are the ones this schema actually holds — nothing invented:
 *   'free'                  users.plan default (server.js:74)
 *   'trial'                 subscriptions.plan on auto-provision (checkSub)
 *   'monthly' / 'yearly'    subscriptions.plan = billing_cycle (server.js:1544,
 *                           routes/subscription.js PLANS)
 *   'agency'                teams.plan default (server.js:96)
 */
const TIERS = Object.freeze({
  free:    Object.freeze({ key: 'free',    rank: 0, label: 'Free',    day: 3,  month: 15 }),
  trial:   Object.freeze({ key: 'trial',   rank: 1, label: 'Trial',   day: 5,  month: 30 }),
  monthly: Object.freeze({ key: 'monthly', rank: 2, label: 'Monthly', day: 25, month: 200 }),
  yearly:  Object.freeze({ key: 'yearly',  rank: 3, label: 'Annual',  day: 25, month: 250 }),
  agency:  Object.freeze({ key: 'agency',  rank: 4, label: 'Agency',  day: 60, month: 600 }),
});

/** The floor. Anything unrecognised lands here — fail closed, never open. */
const FLOOR_TIER = TIERS.free;

/**
 * Map a raw plan string onto a tier. Case- and whitespace-insensitive because
 * the admin route stores whatever it is given.
 *
 * @returns {{tier: object, recognised: boolean}}
 */
function tierForPlan(plan) {
  if (typeof plan !== 'string') return { tier: FLOOR_TIER, recognised: false };
  const key = plan.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIERS, key)) {
    return { tier: TIERS[key], recognised: true };
  }
  return { tier: FLOOR_TIER, recognised: false };
}

/**
 * Map `req.subscription` — the object middleware/checkSub.js already built —
 * onto a tier. checkSub does not expose the plan name, only the status, so
 * this deliberately reads only what is actually there.
 *
 *   'active' → the customer is paying. checkSub does not say monthly vs
 *              yearly, so the LOWER of the two paid tiers is applied. Being
 *              wrong by 50 images in the customer's disfavour is recoverable;
 *              being wrong in the other direction is a bill.
 *   'trial'  → the trial tier.
 *   'grace'  → expired but inside the grace window. Still the trial tier:
 *              they are not paying right now, and grace exists to let them
 *              finish work, not to fund new spend at the paid rate.
 */
function tierForSubscription(subscription) {
  const status = subscription && typeof subscription.status === 'string'
    ? subscription.status
    : null;
  if (status === 'active') return { tier: TIERS.monthly, recognised: true };
  if (status === 'trial') return { tier: TIERS.trial, recognised: true };
  if (status === 'grace') return { tier: TIERS.trial, recognised: true };
  return { tier: FLOOR_TIER, recognised: false };
}

/**
 * The effective tier: the more generous of the two signals.
 *
 * @param {object} user          the `users` row (needs .plan)
 * @param {object} subscription  req.subscription, or null
 * @returns {{tier: object, from: string, planRecognised: boolean}}
 */
function resolveTier(user, subscription) {
  const fromPlan = tierForPlan(user && user.plan);
  const fromSub = tierForSubscription(subscription);
  const winner = fromSub.tier.rank > fromPlan.tier.rank ? fromSub : fromPlan;
  return {
    tier: winner.tier,
    from: winner === fromSub ? 'subscription' : 'users.plan',
    planRecognised: fromPlan.recognised,
  };
}

/**
 * Count billable generations in both windows, in ONE round trip.
 *
 * Parameterized throughout. `status = ANY($2::text[])` rather than a built-up
 * IN-list, and the two intervals arrive as parameters cast to `interval`.
 * The outer `created_at > NOW() - $4::interval` bounds the scan to the widest
 * window so the (user_id, created_at DESC) index the migration created is the
 * access path, rather than a full scan that grows with the table.
 *
 * @param {object} pool   pg Pool (injected — this module never imports ../db)
 * @param {number} userId
 */
async function countUsage(pool, userId) {
  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - $3::interval) AS day_count,
      COUNT(*) FILTER (WHERE created_at > NOW() - $4::interval) AS month_count
    FROM image_generations
    WHERE user_id = $1
      AND status = ANY($2::text[])
      AND created_at > NOW() - $4::interval
  `;
  const { rows } = await pool.query(sql, [
    userId,
    BILLABLE_STATUSES.slice(),
    WINDOWS.day.interval,
    WINDOWS.month.interval,
  ]);
  const row = rows[0] || {};
  return {
    day: Number(row.day_count || 0),
    month: Number(row.month_count || 0),
  };
}

/**
 * The gate. Called BEFORE the provider request is built, never after.
 *
 * @returns {Promise<{allowed: boolean, tier: object, from: string,
 *                    usage: {day: number, month: number},
 *                    limits: {day: number, month: number},
 *                    remaining: {day: number, month: number},
 *                    exceeded: object|null}>}
 */
async function check(pool, user, subscription) {
  const { tier, from, planRecognised } = resolveTier(user, subscription);
  const usage = await countUsage(pool, user.id);

  const limits = { day: tier.day, month: tier.month };
  const remaining = {
    day: Math.max(0, limits.day - usage.day),
    month: Math.max(0, limits.month - usage.month),
  };

  // The month window is checked first: hitting the budget is a more useful
  // thing to be told than hitting today's throttle, when both are true.
  let exceeded = null;
  if (usage.month >= limits.month) {
    exceeded = {
      window: WINDOWS.month.key,
      windowLabel: WINDOWS.month.label,
      limit: limits.month,
      used: usage.month,
    };
  } else if (usage.day >= limits.day) {
    exceeded = {
      window: WINDOWS.day.key,
      windowLabel: WINDOWS.day.label,
      limit: limits.day,
      used: usage.day,
    };
  }

  return {
    allowed: exceeded === null,
    tier,
    from,
    planRecognised,
    usage,
    limits,
    remaining,
    exceeded,
    countedStatuses: BILLABLE_STATUSES.slice(),
  };
}

module.exports = {
  BILLABLE_STATUSES,
  FREE_STATUSES,
  WINDOWS,
  TIERS,
  FLOOR_TIER,
  tierForPlan,
  tierForSubscription,
  resolveTier,
  countUsage,
  check,
};

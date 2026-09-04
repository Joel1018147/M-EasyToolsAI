'use strict';
// M-Ai tool pack — subscription, payments and invoices.
//
// `subscriptions`, `payments` and `invoices` all carry `user_id` (migrations/
// 003_subscriptions.sql) and every query below binds ctx.ownerId to it.
//
// ── READS ONLY, AND THAT IS A RULE RATHER THAN AN OVERSIGHT ───────────────
// CLAUDE.md §C3: tax is a payment computation, do not touch one. There is no
// write tool in this pack and there must not be — a model that can change a
// plan, a paid_until or an invoice total is a model that can grant free
// service or bill somebody. Every figure here is reported exactly as the
// payment path recorded it.
//
// Money is formatted with the ISO code the ROW carries (`payments.currency`,
// `subscriptions.currency`), never with an assumed symbol. See shared.money().

const {
  int, round2, day, ts, oneLine, money,
  DAYS_PARAM, LIMIT_PARAM,
  safe, noneFound, sinceDays, ownerIdOf, dbOf, daysSince,
} = require('./shared');

const { STAFF } = require('../roles');
const { isEnforced, OPEN_NOTICE } = require('../../../helpers/subscriptionMode');

const TOOLS = [
  {
    name: 'subscription_status',
    description: 'This account\'s subscription — the plan, the billing cycle, whether it is on trial, active or ' +
                 'expired, and the dates the trial ends or the paid period runs to. Use for "what plan are we ' +
                 'on", "when does our trial end", "is our subscription active", "when do we next pay", "how long ' +
                 'is left on our plan", "are we in the grace period".',
    parameters: { type: 'object', properties: {}, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the subscriptions table', async (_args, ctx) => {
      const r = await dbOf(ctx).query(
        `SELECT plan, billing_cycle, status, trial_starts_at, trial_ends_at,
                paid_until, grace_until, amount_paid, currency, updated_at
           FROM subscriptions WHERE user_id = $1`,
        [ownerIdOf(ctx)]
      );
      if (!r.rows.length) {
        return noneFound('subscription row exists for this account',
          'Migration 003 seeds a 30-day trial row for every existing account and the signup path creates one. ' +
          'An account with none predates that seed or was created by a path that skipped it — worth checking, ' +
          'not a normal state.');
      }
      const s = r.rows[0];
      const status = String(s.status || '');
      // The deadline that actually matters is whichever of the three the row is
      // currently living on. Reported as ONE date with its name, rather than
      // three dates the reader has to rank.
      const horizon = status === 'trial' ? { label: 'trial ends', at: s.trial_ends_at }
                    : s.grace_until      ? { label: 'grace period ends', at: s.grace_until }
                    : { label: 'paid until', at: s.paid_until };
      const daysLeft = horizon.at
        ? Math.max(0, Math.ceil((new Date(horizon.at).getTime() - Date.now()) / 86400000))
        : null;

      /* The row is reported as it stands — that is what this tool is for. But
         a reader told their status is "expired" will conclude they have lost
         access, and on a deployment that enforces nothing they have not. The
         row and the consequence are two different facts and both get said.

         Read from the shared helper rather than from `ctx`: the tool ctx is
         `{db, ownerId, userId, userName, teamId}` — identity only, by an
         explicit decision documented at routes/mai.js:408 — and there is no
         request on it. Reaching for `ctx.req` here would have compiled, always
         reported "enforced", and silently done nothing. */
      const openLine = isEnforced() ? '' : ` ${OPEN_NOTICE}`;

      return {
        display: `This account is on the ${oneLine(s.plan, 30)} plan, billed ${oneLine(s.billing_cycle, 20)}, ` +
                 `with status "${status}". ` +
                 (horizon.at
                   ? `Its ${horizon.label} on ${day(horizon.at)}${daysLeft === null ? '' : `, ${daysLeft} day(s) from now`}.`
                   : `No ${horizon.label} date is recorded on the row.`) +
                 (s.amount_paid ? ` The last recorded amount paid is ${money(s.amount_paid, s.currency)}.` : '') +
                 openLine,
        data: { plan: oneLine(s.plan, 30), billingCycle: oneLine(s.billing_cycle, 20), status,
                horizonLabel: horizon.label, horizonDate: horizon.at ? day(horizon.at) : null,
                daysLeft, amountPaid: s.amount_paid === null || s.amount_paid === undefined ? null : round2(s.amount_paid),
                currency: s.currency ? String(s.currency).toUpperCase() : null },
        rows: [
          `Plan: ${oneLine(s.plan, 30)} (${oneLine(s.billing_cycle, 20)})`,
          `Status: ${status}`,
          `Trial ends: ${day(s.trial_ends_at)}`,
          `Paid until: ${day(s.paid_until)}`,
          `Grace until: ${day(s.grace_until)}`,
        ],
      };
    }),
  },

  {
    name: 'billing_history',
    description: 'The payments and invoices recorded on this account over a period — how much was charged, whether ' +
                 'each payment succeeded, and which invoices were issued. Use for "what have we paid", "show our ' +
                 'invoices", "did our last payment go through", "billing history", "how much have we spent on ' +
                 'this platform", "were there any failed payments".',
    parameters: { type: 'object', properties: { days: DAYS_PARAM, limit: LIMIT_PARAM }, required: [] },
    requiredRoles: STAFF,
    kind: 'read',
    executor: safe('the payments table', async (args, ctx) => {
      const owner = ownerIdOf(ctx);
      const { days, limit } = args;
      const since = sinceDays(days);

      const pay = await dbOf(ctx).query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE status = 'success')::int AS succeeded,
                COUNT(*) FILTER (WHERE status <> 'success')::int AS not_succeeded,
                COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0) AS paid,
                MAX(currency) AS currency
           FROM payments WHERE user_id = $1 AND created_at >= $2`,
        [owner, since]
      );
      const p = pay.rows[0] || {};
      const n = int(p.n);
      if (!n) {
        return noneFound(`payments were recorded on this account in the last ${days} days`,
          'A payment row is written by the iPay88 return and webhook handlers. An account still inside its ' +
          'free trial has none, which is normal.', { days });
      }

      const inv = await dbOf(ctx).query(
        `SELECT invoice_number, total_amount, status, created_at
           FROM invoices WHERE user_id = $1 AND created_at >= $2
          ORDER BY created_at DESC LIMIT $3`,
        [owner, since, limit]
      );

      const currency = p.currency ? String(p.currency).toUpperCase() : 'MYR';
      return {
        display: `${n} payment(s) recorded in the last ${days} days: ${int(p.succeeded)} succeeded and ` +
                 `${int(p.not_succeeded)} did not. The successful ones total ${money(p.paid, currency)}. ` +
                 `${inv.rows.length} invoice(s) were issued in the same window.`,
        data: { days, payments: n, succeeded: int(p.succeeded), notSucceeded: int(p.not_succeeded),
                totalPaid: round2(p.paid), currency, invoices: inv.rows.length },
        rows: inv.rows.map(x => `${day(x.created_at)} — invoice ${oneLine(x.invoice_number, 40)}: ` +
                                `${money(x.total_amount, currency)} [${oneLine(x.status, 20)}]`),
      };
    }),
  },
];

module.exports = { TOOLS };

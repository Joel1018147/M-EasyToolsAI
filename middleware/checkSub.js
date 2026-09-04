'use strict';

const path = require('path');
const { pool } = require('../db');
const { wantsJson } = require('../helpers/wantsJson');

/* ═══════════════════════════════════════════════════════════════════════════
   THE RENEWAL SURFACE
   ───────────────────────────────────────────────────────────────────────────
   The hard-locked branch below used to redirect EVERY non-JSON request to
   /billing?expired=true — including a request for /billing itself, which
   server.js mounts behind this very middleware. So the one page a lapsed user
   needs was the one page they could not open: Chrome followed 20 redirects and
   gave up with ERR_TOO_MANY_REDIRECTS. Sixty such 302s are in the production
   access log for 2026-09-04, two bursts of twenty from one browser. Four of
   this platform's five subscription rows were `expired` at the time, so the
   lock-out was effectively everybody.

   THIS IS NOT AN EXEMPTION LIST (recurring-bugs-checklist #13). It is the
   definition of one thing: **the renewal surface** — the routes a locked-out
   user must reach in order to SEE and FIX their own billing state, and nothing
   else. A route belongs here if and only if /billing cannot function without
   it. Three of the four are exactly what public/billing.html fetches; the
   fourth is the form post that ends the lock. Adding an entry that is not part
   of paying is how this becomes the exemption list it must never be, and
   test/billing-reachable-test.js fails any route in this set that the page
   does not actually need, in both directions.

   /api/auth/me is deliberately absent: billing.html calls it, but it is
   mounted with requireAuth ONLY, so this middleware never sees it.

   Matched on the request's OWN full path, never on where a router happens to
   be mounted (#15) — req.originalUrl carries the prefix that req.path has
   stripped. Normalised the way Express routes: case-insensitively, with the
   query string and any trailing slash removed, so /Billing/ cannot walk past
   the check that /billing passes.
   ═══════════════════════════════════════════════════════════════════════════ */
const RENEWAL_SURFACE = Object.freeze([
  Object.freeze({ method: 'GET',  path: '/billing' }),
  Object.freeze({ method: 'POST', path: '/billing/checkout' }),
  Object.freeze({ method: 'GET',  path: '/api/subscription/status' }),
  Object.freeze({ method: 'GET',  path: '/api/subscription/invoices' }),
]);

/** The request's own path, normalised the way Express matches routes. */
function requestPath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '/').split(/[?#]/)[0];
  let p = path.posix.normalize(raw).toLowerCase();
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** Is this request the user trying to see or fix their own billing state? */
function isRenewalSurface(req) {
  const p = requestPath(req);
  // Express answers HEAD out of the GET handler, so the guard must agree.
  const raw = String(req.method || 'GET').toUpperCase();
  const method = raw === 'HEAD' ? 'GET' : raw;
  return RENEWAL_SURFACE.some((r) => r.method === method && r.path === p);
}

async function checkSub(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1',
      [req.user.id]
    );

    let sub = rows[0];

    // Auto-provision a trial row if none exists
    if (!sub) {
      const inserted = await pool.query(
        `INSERT INTO subscriptions (user_id, plan, billing_cycle, status, trial_starts_at, trial_ends_at)
         VALUES ($1, 'trial', 'yearly', 'trial', NOW(), NOW() + INTERVAL '30 days')
         ON CONFLICT (user_id) DO NOTHING
         RETURNING *`,
        [req.user.id]
      );
      sub = inserted.rows[0];
      if (!sub) {
        // Concurrent insert won — fetch the committed row
        const refetch = await pool.query(
          'SELECT * FROM subscriptions WHERE user_id = $1',
          [req.user.id]
        );
        sub = refetch.rows[0];
      }
    }

    // Fail open — should never happen but don't block the user
    if (!sub) return next();

    const now = Date.now();

    // ── ACTIVE ──────────────────────────────────────────────────────────────────
    if (sub.status === 'active' && new Date(sub.paid_until) > now) {
      req.subscription = { status: 'active', paid_until: sub.paid_until, showBanner: false };
      return next();
    }

    // ── TRIAL ACTIVE ─────────────────────────────────────────────────────────────
    if (sub.status === 'trial' && new Date(sub.trial_ends_at) > now) {
      const daysLeft = Math.ceil((new Date(sub.trial_ends_at) - now) / 86400000);
      req.subscription = { status: 'trial', daysLeft, showBanner: daysLeft <= 7 };
      if (req.subscription.showBanner) {
        req.subscription.bannerType    = 'warning';
        req.subscription.bannerMessage = `Your free trial ends in ${daysLeft} day(s). Upgrade now to keep access.`;
      }
      return next();
    }

    // ── GRACE ────────────────────────────────────────────────────────────────────
    if (sub.status === 'grace' && new Date(sub.grace_until) > now) {
      const daysLeft = Math.ceil((new Date(sub.grace_until) - now) / 86400000);
      req.subscription = {
        status:        'grace',
        daysLeft,
        showBanner:    true,
        bannerType:    'error',
        bannerMessage: `Your subscription has expired. Renew within ${daysLeft} day(s) or your account will be locked.`,
      };
      return next();
    }

    // ── HARD LOCKED (expired or grace elapsed) ───────────────────────────────────
    // Populated for every hard-locked request, including the ones let through
    // below: billing.html renders its banner from GET /api/subscription/status,
    // which reads these fields off req.subscription. Without this the one page
    // a locked user can open would be the one page that does not say why.
    req.subscription = {
      status:        'expired',
      locked:        true,
      showBanner:    true,
      bannerType:    'error',
      bannerMessage: 'Your subscription has expired. Renew to restore access.',
    };

    // The renewal surface is reachable while locked — that is the whole point
    // of a lock the user is expected to be able to lift. Everything else keeps
    // today's behaviour exactly.
    if (isRenewalSurface(req)) return next();

    // §4.3e. This asked `req.accepts('json') || req.xhr`, and the wildcard in a
    // browser's Accept header makes the first half true for an ordinary page
    // navigation — so a lapsed user clicking a link to /seo got a raw JSON 402
    // rendered as text instead of the billing page that would let them fix it.
    // Same root cause as the guard in server.js, which was fixed on its own in
    // 7732d91; this copy was missed. Both now call one function.
    if (wantsJson(req)) {
      return res.status(402).json({
        error:    'subscription_expired',
        message:  'Your subscription has expired. Please renew at /billing.',
        redirect: '/billing',
      });
    }
    return res.redirect('/billing?expired=true');

  } catch (err) {
    console.error('checkSub error:', err.message);
    next(); // Never block the user due to a subscription lookup failure
  }
}

async function updateExpiredSubscriptions(pool) {
  // trial → grace
  await pool.query(`
    UPDATE subscriptions
       SET status      = 'grace',
           grace_until = trial_ends_at + INTERVAL '3 days',
           updated_at  = NOW()
     WHERE status = 'trial'
       AND trial_ends_at < NOW()
  `);

  // active → grace
  await pool.query(`
    UPDATE subscriptions
       SET status      = 'grace',
           grace_until = paid_until + INTERVAL '3 days',
           updated_at  = NOW()
     WHERE status = 'active'
       AND paid_until < NOW()
  `);

  // grace → expired
  await pool.query(`
    UPDATE subscriptions
       SET status     = 'expired',
           updated_at = NOW()
     WHERE status = 'grace'
       AND grace_until < NOW()
  `);
}

async function sendTrialReminders(pool) {
  const { sendTrialReminder } = require('../routes/subscription');

  const thresholds = [
    { days: 7, key: 'day7' },
    { days: 3, key: 'day3' },
    { days: 1, key: 'day1' },
  ];

  for (const { days, key } of thresholds) {
    try {
      const result = await pool.query(`
        SELECT s.user_id, s.reminder_sent, u.name, u.email
        FROM subscriptions s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'trial'
          AND s.trial_ends_at > NOW() + INTERVAL '${days - 1} days'
          AND s.trial_ends_at <= NOW() + INTERVAL '${days} days'
          AND (s.reminder_sent->>'${key}') IS NULL
      `);

      for (const row of result.rows) {
        await sendTrialReminder({ name: row.name, email: row.email }, days);
        await pool.query(`
          UPDATE subscriptions
             SET reminder_sent = reminder_sent || $1::jsonb,
                 updated_at    = NOW()
           WHERE user_id = $2
        `, [JSON.stringify({ [key]: true }), row.user_id]);
      }

      if (result.rows.length > 0) {
        console.log(`Sent ${result.rows.length} day-${days} trial reminders`);
      }
    } catch (err) {
      console.error(`Trial reminder error (day ${days}):`, err.message);
    }
  }
}

module.exports = {
  checkSub,
  updateExpiredSubscriptions,
  sendTrialReminders,
  // Exported so the suite can enumerate the surface out of the artefact rather
  // than restating it (#24 — a check that enumerates its own subjects passes
  // forever on exactly the list it was given).
  RENEWAL_SURFACE,
  isRenewalSurface,
};

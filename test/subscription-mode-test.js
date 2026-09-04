'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION ENFORCEMENT IS OFF — and BOTH gates opened, not one
   ───────────────────────────────────────────────────────────────────────────
   Joel, 2026-09-04: "remove the subscription for now, let everyone have access
   to all the features — especially image generation."

   THERE ARE TWO GATES IN FRONT OF IMAGE GENERATION AND THEY ARE IN DIFFERENT
   FILES. Opening one of them looks exactly like opening both, right up until
   somebody tries to generate a fourth image in a day:

     1. `middleware/checkSub.js`  — reaches the route at all
     2. `lib/image/caps.js`       — how many, derived from the PLAN TIER

   Gate 2 maps an unrecognised subscription status to the FLOOR tier, on
   purpose (fail closed). `users.plan` is `'free'` for every account in this
   database including paying ones — caps.js documents that defect — so with
   only gate 1 opened, everybody would land on free: **3 a day, 15 a month**,
   and the fourth generation would be refused by a limit nobody chose. That
   failure would arrive days later, in ones and twos, reading like a quota
   working as intended.

   So §3 drives the REAL `caps.check` and asserts the numbers, not the flag.

   THE OTHER HALF IS HONESTY. Removing enforcement without removing what the
   product SAYS about it leaves `/billing` announcing "Subscription Expired" to
   somebody with full access, an expiry banner on every page, and trial emails
   promising to take away access that nobody is taking away. §4 asserts each of
   those went quiet, at the surface that renders it.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const BILLING_HTML = fs.readFileSync(path.join(ROOT, 'public', 'billing.html'), 'utf8');

let failures = 0;
let checks = 0;
function ok(msg) { checks += 1; console.log('  ✓ ' + msg); }
function fail(msg) { failures += 1; checks += 1; console.error('  ✗ ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }
async function section(name, fn) {
  console.log('\n' + name);
  try { await fn(); } catch (err) { fail(`${name} threw: ${err && err.stack ? err.stack : err}`); }
}

/* ═════════════════════════════════════════════════════════════════════════
   HARNESS
   ═════════════════════════════════════════════════════════════════════════ */

const DB_PATH = require.resolve('../db');
const REAL_DB_EXPORTS = Object.keys(require('../db'));
const REAL_POOL = require('../db').pool;

const DAY = 86400000;
/* The real production row as of 2026-09-04: hard-locked, grace long gone.
   Four of the five rows in that table look like this. */
const EXPIRED_ROW = {
  status: 'expired',
  trial_ends_at: new Date(Date.now() - 49 * DAY),
  grace_until: new Date(Date.now() - 46 * DAY),
  paid_until: null,
  plan: 'trial',
  billing_cycle: 'yearly',
};

const dbCalls = [];
const stubPool = {
  query: async (text) => {
    dbCalls.push(String(text).replace(/\s+/g, ' ').trim().slice(0, 60));
    return { rows: [EXPIRED_ROW] };
  },
};

require.cache[DB_PATH] = {
  id: DB_PATH, filename: DB_PATH, loaded: true, exports: { pool: stubPool },
};

const mode = require('../helpers/subscriptionMode');
const { checkSub, sendTrialReminders } = require('../middleware/checkSub');
const caps = require('../lib/image/caps');
const subscriptionRoutes = require('../routes/subscription');

/** Run `fn` with the switch in a named state, then put the environment back. */
async function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, mode.ENV_NAME);
  const before = process.env[mode.ENV_NAME];
  if (value === undefined) delete process.env[mode.ENV_NAME];
  else process.env[mode.ENV_NAME] = value;
  try { return await fn(); } finally {
    if (had) process.env[mode.ENV_NAME] = before;
    else delete process.env[mode.ENV_NAME];
  }
}

/* The subject list, derived from server.js — see billing-reachable-test.js for
   why this is read at run time rather than written down (#24). */
function deriveCheckSubRoutes(src) {
  const out = [];
  const re = /app\.(get|post|put|delete|patch|use)\(\s*(['"])([^'"]+)\2\s*,([^)]*?)\bcheckSub\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] === 'use') out.push({ method: 'GET', mount: m[3], kind: 'mount' });
    else out.push({ method: m[1].toUpperCase(), mount: m[3], kind: 'route' });
  }
  return out;
}
const DERIVED = deriveCheckSubRoutes(SERVER_SRC);
const urlFor = (r) => {
  const filled = r.mount.replace(/:[A-Za-z0-9_]+/g, '00000000-0000-4000-8000-000000000000');
  return r.kind === 'mount' ? filled.replace(/\/$/, '') + '/probe' : filled;
};

async function makeServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.user = { id: 'u-fixture', plan: 'free' }; next(); });
  const reached = (req, res) => res.status(200).json({ reached: true, subscription: req.subscription || null });
  for (const r of DERIVED) {
    if (r.kind === 'mount') app.use(r.mount, checkSub, reached);
    else app[r.method.toLowerCase()](r.mount, checkSub, reached);
  }
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(base, method, url, body) {
  const init = { method, redirect: 'manual' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* redirects carry no JSON */ }
  return { status: res.status, location: res.headers.get('location'), json };
}

/** A pool that answers caps.countUsage with a chosen number of images used. */
const usagePool = (day, month) => ({
  query: async () => ({ rows: [{ day_count: String(day), month_count: String(month) }] }),
});

/* ═════════════════════════════════════════════════════════════════════════
   RUN
   ═════════════════════════════════════════════════════════════════════════ */

(async () => {
  console.log('\n══ SUBSCRIPTION ENFORCEMENT — OFF, AND BOTH GATES WITH IT ══');

  await section('§0 · the switch, and which way it fails', async () => {
    const stubNames = Object.keys(require.cache[DB_PATH].exports);
    check(stubNames.every((n) => REAL_DB_EXPORTS.includes(n)), 'the ../db stub invents no export (#18)');

    await withEnv(undefined, () => {
      check(mode.isEnforced() === false,
        'UNSET means NOT enforced — losing the variable cannot silently re-lock the product');
    });
    await withEnv('on', () => check(mode.isEnforced() === true, "'on' enforces"));
    await withEnv('ON', () => check(mode.isEnforced() === true, "'ON' enforces — case does not matter"));
    await withEnv(' true ', () => check(mode.isEnforced() === true, "' true ' enforces — whitespace does not matter"));
    await withEnv('off', () => check(mode.isEnforced() === false, "'off' does not enforce"));
    await withEnv('no', () => check(mode.isEnforced() === false, "'no' does not enforce"));
    await withEnv('onn', () => check(mode.isEnforced() === false,
      "a typo of 'on' leaves the product OPEN rather than locking everyone out of a checkout that cannot take payment"));

    const open = mode.openSubscription();
    check(open.status === mode.OPEN_STATUS && open.enforced === false && open.showBanner === false,
      'the open subscription is its own status, not a forged "active", and raises no banner');
  });

  const srv = await makeServer();
  try {
    await section('§1 · GATE 1 — every gated route is reachable, expired row and all', async () => {
      await withEnv(undefined, async () => {
        dbCalls.length = 0;
        const wrong = [];
        for (const r of DERIVED) {
          const res = await request(srv.base, r.method, urlFor(r), r.method === 'POST' ? {} : undefined);
          if (res.status !== 200) wrong.push(`${r.method} ${urlFor(r)} → ${res.status}`);
        }
        check(DERIVED.length >= 20, `derived ${DERIVED.length} checkSub-gated routes (floor 20)`);
        check(wrong.length === 0,
          `all ${DERIVED.length} answer 200 for an EXPIRED account` + (wrong.length ? ` — ${wrong.slice(0, 5).join('; ')}` : ''));

        check(dbCalls.length === 0,
          'and not one database query was issued — an open deployment does not depend on `subscriptions` being readable');

        const r = await request(srv.base, 'GET', '/api/images/probe');
        check(r.json && r.json.subscription && r.json.subscription.status === 'open',
          "req.subscription.status is 'open' — a fact about the deployment, not a claim about the customer");
        check(r.json.subscription.enforced === false && r.json.subscription.showBanner === false,
          '…enforced:false, and no banner is requested');
      });
    });

    await section('§2 · the paywall is intact — `on` restores every previous answer', async () => {
      await withEnv('on', async () => {
        const surface = ['/billing', '/billing/checkout', '/api/subscription/status', '/api/subscription/invoices'];
        const blocked = [];
        const opened = [];
        for (const r of DERIVED) {
          const url = urlFor(r);
          const res = await request(srv.base, r.method, url, r.method === 'POST' ? {} : undefined);
          if (res.status === 200) opened.push(url);
          else if (url.startsWith('/api/') ? res.status === 402 : res.status === 302) blocked.push(url);
        }
        check(opened.length === surface.length && opened.every((u) => surface.includes(u)),
          `only the renewal surface is open when enforced — got [${opened.join(', ')}]`);
        check(blocked.length === DERIVED.length - surface.length,
          `the other ${blocked.length} routes refuse a locked account exactly as before`);
      });
    });
  } finally {
    await srv.close();
  }

  await section('§3 · GATE 2 — the image cap, in numbers rather than in a flag', async () => {
    const user = { id: 'u-fixture', plan: 'free' };   // what every row in this DB holds

    const locked = await caps.check(usagePool(0, 0), user, { status: 'expired' });
    check(locked.tier.key === 'free' && locked.limits.day === 3 && locked.limits.month === 15,
      `an expired account lands on the FLOOR tier: ${locked.limits.day}/day, ${locked.limits.month}/30 days`);

    const open = await caps.check(usagePool(0, 0), user, mode.openSubscription());
    check(open.tier.key === 'agency' && open.limits.day === 60 && open.limits.month === 600,
      `status 'open' lands on the top tier: ${open.limits.day}/day, ${open.limits.month}/30 days`);
    check(open.from === 'subscription',
      "…and it beat users.plan='free', which is what every account in this database actually carries");

    /* The assertion that would have caught "gate 1 only". Four images in a day
       is the smallest number that separates the two answers. */
    const fourth = await caps.check(usagePool(3, 3), user, mode.openSubscription());
    const fourthLocked = await caps.check(usagePool(3, 3), user, { status: 'expired' });
    check(fourth.allowed === true, 'a fourth image in one day is ALLOWED with the subscription removed');
    check(fourthLocked.allowed === false && fourthLocked.exceeded.window === 'day',
      '…and would have been refused on the free tier, which is what opening only gate 1 would have left');

    const atCeiling = await caps.check(usagePool(60, 100), user, mode.openSubscription());
    check(atCeiling.allowed === false && atCeiling.exceeded.limit === 60,
      'the ceiling still exists at 60/day — removing a price is not removing a spend limit');
  });

  await section('§4 · nothing on screen still claims a restriction', async () => {
    /* The real statusHandler, driven the way server.js mounts it. */
    const payloadFor = async (subscription) => {
      let body = null;
      await subscriptionRoutes.statusHandler(
        { user: { id: 'u-fixture' }, subscription },
        { json: (b) => { body = b; }, status() { return this; } }
      );
      return body;
    };

    const openPayload = await payloadFor(mode.openSubscription());
    check(openPayload.enforced === false, 'GET /api/subscription/status reports enforced:false');
    check(typeof openPayload.notice === 'string' && openPayload.notice.length > 20,
      '…and carries the sentence the page prints, rather than leaving it to be re-invented');
    check(openPayload.showBanner === false,
      '…and showBanner:false, which is the field public/app.html renders the expiry banner from');

    const lockedPayload = await payloadFor({ status: 'expired', showBanner: true, bannerMessage: 'x' });
    check(lockedPayload.enforced === true && lockedPayload.notice === null,
      'and when something IS enforced the payload says so — the flag is not hardcoded');

    /* billing.html must branch on `enforced` BEFORE the status branches, or the
       row's 'expired' still paints "Subscription Expired" over full access. */
    const openBranch = BILLING_HTML.indexOf('data.enforced === false');
    const trialBranch = BILLING_HTML.indexOf("data.status === 'trial'");
    check(openBranch > -1, 'public/billing.html branches on data.enforced');
    check(openBranch > -1 && trialBranch > -1 && openBranch < trialBranch,
      '…before it branches on the row status, so the row cannot paint over it');
    check(/getElementById\('pricing'\)[\s\S]{0,80}display\s*=\s*'none'/.test(BILLING_HTML),
      '…and hides the pricing section, whose button posts to a checkout that answers 500 unconfigured');

    /* The trial email promises to remove access. Nothing is removing access. */
    let queried = false;
    const throwingPool = { query: async () => { queried = true; return { rows: [] }; } };
    await withEnv(undefined, () => sendTrialReminders(throwingPool));
    check(queried === false,
      'sendTrialReminders sends nothing and reads nothing while enforcement is off');
    await withEnv('on', () => sendTrialReminders(throwingPool));
    check(queried === true, '…and resumes the moment it is re-armed — the code is switched off, not deleted');
  });

  console.log(`\n${checks} checks, ${failures} failure(s)`);
  if (failures) {
    console.error('✗ THE SUBSCRIPTION IS NOT ACTUALLY REMOVED, OR SOMETHING STILL CLAIMS IT IS\n');
    process.exit(1);
  }
  console.log('✓ no subscription is enforced, both gates are open, and nothing on screen says otherwise\n');
})();

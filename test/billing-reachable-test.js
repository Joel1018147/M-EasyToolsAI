'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   /billing IS REACHABLE WHILE LOCKED OUT — and nothing else is
   ───────────────────────────────────────────────────────────────────────────
   THIS SUITE EXECUTES middleware/checkSub.js. Until it existed, every suite
   in this repo that mentioned that file read it as TEXT — auth-guard-test
   greps it for `req.accepts('json')`, negative-control-ui plants a string in
   it, mai-boundary-test asserts the word `checkSub` appears at a mount. Not
   one of them ever called the function. That is this repo's own entry in
   recurring-bugs-checklist #21, and it is why the hard-locked branch could
   redirect /billing to itself for as long as it did.

   THE DEFECT, observed 2026-09-04. The HARD-LOCKED branch redirected every
   non-JSON request to /billing?expired=true, and server.js mounts /billing
   behind that same middleware. Sixty `GET /billing 302` lines are in the
   production HTTP access log for that day — two bursts of twenty from one
   browser, which is Chrome giving up with ERR_TOO_MANY_REDIRECTS twice. Four
   of the platform's five subscription rows were `expired` at the time.

   NO DATABASE IS NEEDED. `../db` is replaced by an in-memory pool, and the
   stub's export names are asserted to be a SUBSET of the real module's
   (#18 — a stub that invents an export tests a program that does not exist).

   THE SUBJECT LIST IS DERIVED, NOT WRITTEN DOWN (#24). Every route this suite
   drives is read out of server.js at run time, so a checkSub-gated route added
   tomorrow is covered without anyone remembering to add it here. A floor on
   the count means the day the finder breaks, it says so instead of going
   quiet.
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
   HARNESS — the real middleware, an unreal database
   ═════════════════════════════════════════════════════════════════════════ */

/* Read the real module's export names BEFORE replacing it. Requiring db.js
   constructs a pg Pool but opens no connection, so this is free. */
const DB_PATH = require.resolve('../db');
const REAL_DB_EXPORTS = Object.keys(require('../db'));
/* `in`, not Object.keys: a pg Pool carries query() on its PROTOTYPE, so an
   own-keys comparison reports the real pool as lacking the method it is most
   famous for — a broken guard reads exactly like a dishonest stub. */
const REAL_POOL = require('../db').pool;

/** Every row checkSub can ever see, keyed by the state under test. */
const DAY = 86400000;
const FIXTURES = {
  expired: {
    status: 'expired',
    trial_ends_at: new Date(Date.now() - 49 * DAY),
    grace_until: new Date(Date.now() - 46 * DAY),
    paid_until: null,
  },
  grace: {
    status: 'grace',
    trial_ends_at: new Date(Date.now() - 4 * DAY),
    grace_until: new Date(Date.now() + 2 * DAY),
    paid_until: null,
  },
  trial: {
    status: 'trial',
    trial_ends_at: new Date(Date.now() + 12 * DAY),
    grace_until: null,
    paid_until: null,
  },
};

let CURRENT_ROW = FIXTURES.expired;
const stubPool = {
  query: async (text) => {
    if (/INSERT\s+INTO\s+subscriptions/i.test(text)) return { rows: [CURRENT_ROW] };
    return { rows: [CURRENT_ROW] };
  },
};

require.cache[DB_PATH] = {
  id: DB_PATH,
  filename: DB_PATH,
  loaded: true,
  exports: { pool: stubPool },
};

const { checkSub, RENEWAL_SURFACE, isRenewalSurface } = require('../middleware/checkSub');

/* ═════════════════════════════════════════════════════════════════════════
   THE SUBJECT LIST — read out of server.js, never written down here
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Every route server.js puts behind checkSub, as {method, mount, kind}.
 * `kind` is 'route' for app.get/post/... and 'mount' for app.use(prefix, …),
 * because a mounted router strips its prefix from req.path and that is the
 * exact wiring #15 says a guard-level test cannot see.
 */
function deriveCheckSubRoutes(src) {
  const out = [];
  const re = /app\.(get|post|put|delete|patch|use)\(\s*(['"])([^'"]+)\2\s*,([^)]*?)\bcheckSub\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const verb = m[1];
    const mount = m[3];
    if (verb === 'use') out.push({ method: 'GET', mount, kind: 'mount' });
    else out.push({ method: verb.toUpperCase(), mount, kind: 'route' });
  }
  return out;
}

const DERIVED = deriveCheckSubRoutes(SERVER_SRC);

/** A concrete URL for a route pattern: :params filled, mounts given a child. */
function urlFor(r) {
  const filled = r.mount.replace(/:[A-Za-z0-9_]+/g, '00000000-0000-4000-8000-000000000000');
  return r.kind === 'mount' ? filled.replace(/\/$/, '') + '/probe' : filled;
}

/** Does the renewal surface claim this derived route? */
function surfaceClaims(r) {
  const url = urlFor(r);
  return RENEWAL_SURFACE.some((s) => s.method === r.method && s.path === url);
}

/* ═════════════════════════════════════════════════════════════════════════
   A REAL SERVER — real express, real checkSub, real helpers/wantsJson
   ═════════════════════════════════════════════════════════════════════════ */

async function makeServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  // Stands in for requireAuth, which server.js mounts in front of checkSub.
  app.use((req, _res, next) => { req.user = { id: 'u-fixture', email: 'fixture@example.com' }; next(); });

  const reached = (req, res) => res.status(200).json({ reached: true, subscription: req.subscription || null });

  for (const r of DERIVED) {
    if (r.kind === 'mount') {
      app.use(r.mount, checkSub, reached);
    } else {
      app[r.method.toLowerCase()](r.mount, checkSub, reached);
    }
  }

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
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
  try { json = JSON.parse(text); } catch (_) { /* a redirect body is not JSON */ }
  return { status: res.status, location: res.headers.get('location'), text, json };
}

/* ═════════════════════════════════════════════════════════════════════════
   RUN
   ═════════════════════════════════════════════════════════════════════════ */

(async () => {
  console.log('\n══ /billing REACHABLE WHILE LOCKED ══');

  await section('§0 · the harness is honest about what it replaced', async () => {
    const stubNames = Object.keys(require.cache[DB_PATH].exports);
    const invents = stubNames.filter((n) => !REAL_DB_EXPORTS.includes(n));
    check(invents.length === 0, `the ../db stub invents no export (real: ${REAL_DB_EXPORTS.join(', ')})`);
    const poolInvents = Object.keys(stubPool).filter((k) => !(k in REAL_POOL));
    check(poolInvents.length === 0, 'the stub pool invents no method the real pool lacks');
    check(typeof REAL_POOL.query === 'function',
      '…and the comparison can actually see pool.query, so that check is not vacuous');
  });

  await section('§1 · the subject list comes from server.js', async () => {
    check(DERIVED.length >= 20,
      `derived ${DERIVED.length} checkSub-gated routes from server.js (floor 20 — below it, the finder broke)`);
    const mounts = DERIVED.filter((r) => r.kind === 'mount');
    check(mounts.length >= 3,
      `${mounts.length} of them are app.use() mounts, where req.path loses the prefix (#15)`);
    const claimed = DERIVED.filter(surfaceClaims);
    check(claimed.length === RENEWAL_SURFACE.length,
      `all ${RENEWAL_SURFACE.length} renewal-surface entries are real checkSub-gated routes in server.js`);
  });

  const srv = await makeServer();
  try {
    /* ── HARD LOCKED ──────────────────────────────────────────────────────── */
    await section('§2 · status=expired — the renewal surface answers', async () => {
      CURRENT_ROW = FIXTURES.expired;

      const billing = await request(srv.base, 'GET', '/billing');
      check(billing.status === 200,
        `GET /billing answers 200 while hard-locked (got ${billing.status}${billing.location ? ' → ' + billing.location : ''})`);
      check(billing.location !== '/billing?expired=true',
        'GET /billing does not redirect to itself — the loop is gone');
      check(billing.json && billing.json.subscription && billing.json.subscription.status === 'expired',
        'req.subscription carries the hard-locked state, so billing.html can say why');
      check(billing.json && billing.json.subscription && billing.json.subscription.locked === true,
        '…and marks it locked, distinct from grace');

      const checkout = await request(srv.base, 'POST', '/billing/checkout', { billing_cycle: 'yearly' });
      check(checkout.status === 200, `POST /billing/checkout reaches its handler (got ${checkout.status})`);

      for (const p of ['/api/subscription/status', '/api/subscription/invoices']) {
        const r = await request(srv.base, 'GET', p);
        check(r.status === 200, `GET ${p} reaches its handler (got ${r.status})`);
      }
    });

    await section('§3 · status=expired — everything else is still locked', async () => {
      CURRENT_ROW = FIXTURES.expired;
      const blocked = DERIVED.filter((r) => !surfaceClaims(r));
      let wrong = [];
      for (const r of blocked) {
        const url = urlFor(r);
        const res = await request(srv.base, r.method, url, r.method === 'POST' ? {} : undefined);
        const isApi = url.startsWith('/api/');
        const good = isApi
          ? res.status === 402 && res.json && res.json.error === 'subscription_expired'
          : res.status === 302 && res.location === '/billing?expired=true';
        if (!good) wrong.push(`${r.method} ${url} → ${res.status} ${res.location || ''}`);
      }
      check(wrong.length === 0,
        `all ${blocked.length} non-renewal routes still refuse a locked user` +
        (wrong.length ? ` — ${wrong.slice(0, 6).join('; ')}` : ''));

      /* Named, so a widening cannot pass by being merely consistent. A
         permission widening makes existing tests pass HARDER; only a by-name
         assertion of the whole set catches one. */
      for (const p of ['/api/images/probe', '/api/mai/probe', '/api/docintel/probe']) {
        const r = await request(srv.base, 'GET', p);
        check(r.status === 402, `GET ${p} is 402, not reachable (got ${r.status})`);
      }
      const pr = await request(srv.base, 'GET', '/api/pr/releases');
      check(pr.status === 402, `GET /api/pr/releases is 402 (got ${pr.status})`);
      const mai = await request(srv.base, 'GET', '/mai');
      check(mai.status === 302 && mai.location === '/billing?expired=true',
        `GET /mai still redirects a locked user to billing (got ${mai.status} ${mai.location || ''})`);
    });

    /* ── STILL-ENTITLED STATES — unchanged behaviour, confirmed not assumed ── */
    for (const state of ['grace', 'trial']) {
      await section(`§4 · status=${state} — every gated route still passes through`, async () => {
        CURRENT_ROW = FIXTURES[state];
        const wrong = [];
        for (const r of DERIVED) {
          const url = urlFor(r);
          const res = await request(srv.base, r.method, url, r.method === 'POST' ? {} : undefined);
          if (res.status !== 200) wrong.push(`${r.method} ${url} → ${res.status}`);
        }
        check(wrong.length === 0,
          `all ${DERIVED.length} routes answer 200 for a ${state} user` +
          (wrong.length ? ` — ${wrong.slice(0, 6).join('; ')}` : ''));

        const r = await request(srv.base, 'GET', '/api/subscription/status');
        const sub = r.json && r.json.subscription;
        check(sub && sub.status === state, `req.subscription.status is '${state}'`);
        if (state === 'grace') {
          check(sub && typeof sub.daysLeft === 'number' && /Renew within/.test(sub.bannerMessage || ''),
            'the grace banner still counts down in its own words, not the locked one');
        } else {
          check(sub && typeof sub.daysLeft === 'number',
            'the trial banner still carries daysLeft');
        }
      });
    }

    /* ── THE PAIRING — the page's reads and the guard's exemption together ── */
    await section('§5 · the surface is exactly what billing.html needs (#31)', async () => {
      const fetched = [...BILLING_HTML.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
      const unique = [...new Set(fetched)].filter((u) => u.startsWith('/'));
      check(unique.length >= 3, `billing.html fetches ${unique.length} of its own endpoints (floor 3)`);

      const gated = (url) => DERIVED.some((r) => r.kind === 'route' ? r.mount === url : url.startsWith(r.mount + '/'));

      const needed = unique.filter(gated);
      const missing = needed.filter((u) => !RENEWAL_SURFACE.some((s) => s.path === u));
      check(missing.length === 0,
        `every checkSub-gated endpoint billing.html reads is on the surface` +
        (missing.length ? ` — missing ${missing.join(', ')}` : ''));

      const ungated = unique.filter((u) => !gated(u));
      check(ungated.includes('/api/auth/me'),
        '/api/auth/me is reachable because it is not gated at all, not because it was exempted');

      /* The other direction: nothing sits on the surface that the renewal
         journey does not use. This is what stops it becoming an exemption
         list (#13) one convenient entry at a time. */
      const unused = RENEWAL_SURFACE.filter((s) => {
        if (unique.includes(s.path)) return false;
        if (s.path === '/billing') return false;                                   // the page itself
        if (new RegExp(`action\\s*=\\s*'${s.path}'`).test(BILLING_HTML)) return false; // its form post
        return true;
      });
      check(unused.length === 0,
        'nothing is on the surface that the billing page does not use' +
        (unused.length ? ` — ${unused.map((s) => s.method + ' ' + s.path).join(', ')}` : ''));
    });

    /* ── THE MATCHER ITSELF ───────────────────────────────────────────────── */
    await section('§6 · the surface is matched on the request, not on the wiring', async () => {
      const asReq = (method, originalUrl) => ({ method, originalUrl, url: originalUrl, path: '/stripped' });
      check(isRenewalSurface(asReq('GET', '/billing?expired=true')),
        'the query string is not part of the path');
      check(isRenewalSurface(asReq('GET', '/Billing/')),
        'trailing slash and case are normalised the way Express routes');
      check(isRenewalSurface(asReq('HEAD', '/billing')),
        'HEAD is matched, because Express answers it out of the GET handler');
      check(!isRenewalSurface(asReq('POST', '/billing')),
        'the method is part of the match — POST /billing is not the page');
      check(!isRenewalSurface(asReq('GET', '/billing/../api/images/generate')),
        'a traversal that normalises to a gated path is not on the surface');
      check(!isRenewalSurface(asReq('GET', '/api/images/generate')),
        'a generation route is never on the surface');
    });
  } finally {
    await srv.close();
  }

  console.log(`\n${checks} checks, ${failures} failure(s)`);
  if (failures) {
    console.error('✗ A LOCKED USER CANNOT REACH BILLING, OR AN UNLOCKED ROUTE LEAKED\n');
    process.exit(1);
  }
  console.log('✓ /billing is reachable while locked, and nothing else is\n');
})();

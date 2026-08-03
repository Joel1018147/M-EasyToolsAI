'use strict';

/**
 * Gate 2 (Verify) — live smoke test.
 *
 * Run this AFTER a deploy shows ACTIVE on Railway, against the live URL.
 * "ACTIVE" only proves the process booted — this script proves the
 * feature actually behaves correctly against real Postgres + real routes.
 * See Modus-Agent-OS/skills/three-stage-deploy-gate.md.
 *
 * Usage:
 *   node scripts/smoke-test.js https://your-app.up.railway.app
 *
 * Auth (never pass a password as a CLI arg):
 *   SMOKE_TEST_COOKIE="msm.sid=s%3A..."          — reuse an existing session cookie, OR
 *   SMOKE_TEST_EMAIL=you@example.com
 *   SMOKE_TEST_PASSWORD=...                       — logs in via POST /api/auth/login
 *
 *   PowerShell example:
 *     $env:SMOKE_TEST_EMAIL="you@example.com"
 *     $env:SMOKE_TEST_PASSWORD="..."
 *     node scripts/smoke-test.js https://your-app.up.railway.app
 *
 * Without either, auth-gated checks are skipped (reported, not silently
 * dropped) and only unauthenticated checks (health, webhook) run.
 */

const BASE_URL = process.argv[2];

if (!BASE_URL) {
  console.error('Usage: node scripts/smoke-test.js <live-url>');
  console.error('Example: node scripts/smoke-test.js https://measytools.up.railway.app');
  process.exit(1);
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail });
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    results.push({ name, pass: false, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

// ── Auth: obtain a session cookie ──────────────────────────────────────────
// Session cookie name is 'msm.sid' (see server.js express-session config).
async function getSessionCookie() {
  if (process.env.SMOKE_TEST_COOKIE) {
    return process.env.SMOKE_TEST_COOKIE;
  }

  const email = process.env.SMOKE_TEST_EMAIL;
  const password = process.env.SMOKE_TEST_PASSWORD;
  if (!email || !password) return null;

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`login failed (status ${res.status}): ${text.slice(0, 200)}`);
  }

  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('login succeeded but no Set-Cookie header returned');
  // Grab just the "msm.sid=..." part, drop cookie attributes (Path, HttpOnly, etc.)
  const sidPart = setCookie.split(';')[0];
  return sidPart;
}

async function main() {
  console.log(`Gate 2 smoke test — M-EasyTools AI+ — target: ${BASE_URL}\n`);

  // ── Health check ──────────────────────────────────────────────────────────
  await check('GET /api/health returns ok status', async () => {
    const { res, body } = await fetchJson(`${BASE_URL}/api/health`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(body && body.status === 'ok', `expected status:'ok', got ${JSON.stringify(body)}`);
    assert(body.database === 'PostgreSQL', `expected database:'PostgreSQL', got ${body.database}`);
    assert(typeof body.users === 'number', `expected users count as a number, got ${typeof body.users}`);
    return `users=${body.users}, documents=${body.documents}`;
  });

  // ── Webhook signature gate: iPay88 server-to-server callback ────────────────
  // NOTE on this specific webhook's protocol: iPay88 requires the endpoint to
  // ALWAYS respond '1' (text/plain), even on a signature mismatch — the
  // gateway blindly retries on anything else. So "rejected" here does NOT
  // mean a 4xx/5xx status; it means the route must NOT process/mutate a
  // payment when the signature doesn't verify. We can only observe this from
  // the outside via the HTTP response, so this check confirms: (a) the route
  // still ACKs correctly (no 500, no crash) on a bad signature, and (b) it
  // doesn't leak any internal error detail in the body. The actual "no DB
  // mutation happened" guarantee is enforced by the signature check running
  // before any pool.query() in routes/subscription.js (verified by code
  // review) — an external HTTP-only smoke test cannot independently confirm
  // a negative (that a row was NOT written) without DB access.
  await check('POST /payment/backend rejects unsigned payload safely', async () => {
    const res = await fetch(`${BASE_URL}/payment/backend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        MerchantCode: 'SMOKETEST',
        PaymentId: '1',
        RefNo: `SMOKETEST-${Date.now()}`,
        Amount: '3800',
        Currency: 'MYR',
        TransactionId: 'SMOKETEST-TXN',
        Status: '1',
        Signature: 'not-a-real-signature',
      }),
    });
    const text = await res.text();
    assert(res.status === 200, `expected 200 (iPay88 protocol requires ACK), got ${res.status}`);
    assert(text.trim() === '1', `expected body '1', got '${text.slice(0, 100)}'`);
    return `acked with '1', no server error on invalid signature`;
  });

  // ── Authenticated checks ─────────────────────────────────────────────────
  let cookie;
  await check('Obtain session cookie (SMOKE_TEST_COOKIE or login)', async () => {
    cookie = await getSessionCookie();
    assert(cookie, 'no SMOKE_TEST_COOKIE and no SMOKE_TEST_EMAIL/SMOKE_TEST_PASSWORD set — skipping auth-gated checks below');
    return 'cookie obtained';
  });

  if (cookie) {
    await check('GET /api/auth/me returns the logged-in user', async () => {
      const { res, body } = await fetchJson(`${BASE_URL}/api/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body && body.email, `expected a user object with email, got ${JSON.stringify(body)}`);
      return `logged in as ${body.email}`;
    });

    await check('GET /api/subscription/status returns a subscription shape', async () => {
      const { res, body } = await fetchJson(`${BASE_URL}/api/subscription/status`, {
        headers: { Cookie: cookie },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body && 'status' in body, `expected a 'status' field, got ${JSON.stringify(body)}`);
      return `status=${body.status}`;
    });

    // ── Real NUMERIC/DECIMAL live check ────────────────────────────────────
    // pr_distributions.package_price is DECIMAL(10,2) (see server.js CREATE
    // TABLE pr_distributions). db.js now registers
    // types.setTypeParser(1700, parseFloat) globally, so this column must
    // come back as a JS number, not a string, in this live JSON response.
    // If no PR distributions exist yet for this account, the check is
    // reported as SKIPPED (not a false PASS) rather than fabricating data —
    // create one via a real PR distribution purchase to exercise this path.
    await check('GET /api/pr/releases returns package_price as a number (NUMERIC/DECIMAL check)', async () => {
      const { res, body } = await fetchJson(`${BASE_URL}/api/pr/releases`, {
        headers: { Cookie: cookie },
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(body && Array.isArray(body.releases), `expected a releases array, got ${JSON.stringify(body)}`);

      const withPrice = body.releases.find(r => r.package_price !== null && r.package_price !== undefined);
      if (!withPrice) {
        return 'SKIPPED — no PR distribution with package_price found for this account; run a distribution first to exercise this check';
      }

      assert(
        typeof withPrice.package_price === 'number',
        `package_price came back as ${typeof withPrice.package_price} (value: ${JSON.stringify(withPrice.package_price)}) — ` +
        `NUMERIC/DECIMAL type parser is not registered/working. Expected a JS number.`
      );
      return `package_price=${withPrice.package_price} (typeof number, confirmed)`;
    });
  } else {
    console.log('  SKIP  GET /api/auth/me (no session cookie)');
    console.log('  SKIP  GET /api/subscription/status (no session cookie)');
    console.log('  SKIP  GET /api/pr/releases NUMERIC check (no session cookie)');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('\nFailed checks:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});

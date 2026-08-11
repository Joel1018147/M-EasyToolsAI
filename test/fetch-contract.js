'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   fetch() does not reject, so nothing was checked.                (Run 29)
   ───────────────────────────────────────────────────────────────────────────
   `fetch` rejects only on a NETWORK failure. A 401, a 403, a 500 and a
   rate-limit all resolve, and `.json()` on them usually succeeds too — so a
   `try/catch` around a fetch is not error handling. It catches the one case
   where the request never left the machine, and renders every other failure as
   data.

   In seller.html that meant an operator saw "0 users", "RM0.00" revenue and
   "No modules configured." on a 401, and — worse — saw
   "✅ Subscription activated for 365 days" for a write that never landed,
   because the catch holding the correct failure toast could not be reached.

   Runs 27 and 28 both found the buggy file untested. This repo made it three
   for three: all six existing suites read these files as TEXT (fs.readFileSync)
   and none executes them. So this suite EXECUTES the real shipped source —
   `apiFetch` and the three subscription mutations are extracted from
   public/seller.html by anchor and run in a vm sandbox with a stubbed `fetch`.
   Nothing here is a copy of the code under test; if the anchors stop matching,
   the suite fails rather than silently testing nothing (#14).
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { scanFiles, targets, total, stripComments } = require('./lib/unchecked-fetch');

const APP = path.join(__dirname, '..');
const SELLER = path.join(APP, 'public/seller.html');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, e ?? '')); };

/* ── Pull real functions out of the shipped page ──────────────────────────── */
const html = fs.readFileSync(SELLER, 'utf8');

/** Source of `[async] function <name>(...) { ... }`, brace-matched.
 *
 * The `async ` prefix must come with it. Slicing from `function` alone produced
 * a body full of `await` inside a non-async function — a syntax error, which at
 * least failed loudly rather than testing a subtly different program. */
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const before = src.slice(Math.max(0, start - 6), start);
  if (before.endsWith('async ')) start -= 6;

  // Skip the PARAMETER LIST before looking for the body's opening brace.
  // `apiFetch(url, opts = {})` has a default-value `{}` in its signature, and
  // taking the first `{` after the name matched it — returning a 38-character
  // "function" whose braces balanced immediately. It failed loudly on a syntax
  // error rather than testing a truncated program, which is the only reason
  // this was cheap to find.
  const lparen = src.indexOf('(', start);
  let pd = 0, afterParams = -1;
  for (let i = lparen; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
  }
  if (afterParams < 0) return null;

  const open = src.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const SOURCES = {};
for (const name of ['errorDetail', 'apiFetch', 'loadStats', 'loadSubStats',
                    'extendTrial', 'activateSub', 'resetSub']) {
  SOURCES[name] = extractFn(html, name);
}
ok('the suite found every function it claims to test (an anchor miss must FAIL, not pass — #14)',
   Object.entries(SOURCES).every(([, s]) => s && s.length > 40),
   Object.entries(SOURCES).filter(([, s]) => !s).map(([n]) => n).join(',') || 'lengths too short');

/* ── A sandbox that is the page, minus the browser ────────────────────────── */
function sandbox({ status, body, throwNetwork = false }) {
  const toasts = [];
  const calls = [];
  const dom = {};
  const el = (id) => (dom[id] = dom[id] || { textContent: '', innerHTML: '', style: {}, value: '' });
  const ctx = {
    sellerKey: 'k',
    showToast: (m) => toasts.push(m),
    document: { getElementById: el },
    // Every loader the mutations call on success. If one of these fires after a
    // failed write, that is itself the bug — so they are recorded, not ignored.
    loadSubStats: () => toasts.push('[reload:stats]'),
    loadSubUsers: () => toasts.push('[reload:users]'),
    confirm: () => true,
    console,
    // Every request the page makes. The real loadSubStats is injected into this
    // context (it is one of the functions under test), so it SHADOWS the stub
    // above — which is more faithful, and means "did the success-path reload
    // run?" has to be answered by counting requests rather than by a marker the
    // real function never pushes.
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      if (throwNetwork) throw new TypeError('Failed to fetch');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(Object.values(SOURCES).join('\n'), ctx);
  return { ctx, toasts, dom, calls };
}

(async () => {
  /* ── 1. THE CENTRAL INVARIANT: a 401 read is an error, not an empty dash ── */
  {
    const { ctx } = sandbox({ status: 401, body: { error: 'Invalid or missing seller key' } });
    let threw = null, resolved;
    try { resolved = await ctx.apiFetch('/api/seller/stats'); } catch (e) { threw = e; }
    ok('THE INVARIANT — a 401 read REJECTS instead of resolving with the error body',
       threw !== null, `resolved with ${JSON.stringify(resolved)}`);
    ok('…and the thrown message carries the status', threw && /401/.test(threw.message), threw && threw.message);
    ok('…and the server\'s own explanation, so the operator can act on it',
       threw && /seller key/i.test(threw.message), threw && threw.message);
    ok('NEGATIVE CONTROL — the error body never reaches the caller as data',
       resolved === undefined, JSON.stringify(resolved));
  }

  /* ── 2. A 500 with a non-JSON body still fails loudly ────────────────────── */
  {
    const { ctx } = sandbox({ status: 500, body: '<html>Internal Server Error</html>' });
    let threw = null;
    try { await ctx.apiFetch('/api/seller/stats'); } catch (e) { threw = e; }
    ok('a 500 whose body is not JSON still rejects, using the raw body',
       threw !== null && /500/.test(threw.message), threw && threw.message);
  }

  /* ── 3. A success still succeeds — the fix is not "break the page" ───────── */
  {
    const { ctx } = sandbox({ status: 200, body: { totalUsers: 7, revenue: '12.30' } });
    const data = await ctx.apiFetch('/api/seller/stats');
    ok('a 200 still returns the parsed body', data && data.totalUsers === 7, JSON.stringify(data));
  }

  /* ── 4. A network failure still rejects (it always did) ──────────────────── */
  {
    const { ctx } = sandbox({ status: 200, body: {}, throwNetwork: true });
    let threw = null;
    try { await ctx.apiFetch('/x'); } catch (e) { threw = e; }
    ok('a genuine network failure still rejects', threw !== null);
  }

  /* ── 4b. THE DASHBOARD ITSELF: a 401 must not leave numbers on screen ─────
     Testing apiFetch alone was not enough. The first pass of this suite proved
     apiFetch throws and stopped there — and a mutation that put "RM0.00" back
     into loadSubStats' catch SURVIVED it. The read sites are where the operator
     actually reads a lie, so they are asserted directly. */
  {
    const { ctx, dom, toasts } = sandbox({ status: 200, body: { active: 3, trial: 1, revenue: '480.00', total: 4 } });
    await ctx.loadSubStats();
    ok('a healthy load shows the real revenue figure',
       dom['sub-stat-revenue'].textContent === 'RM480.00', dom['sub-stat-revenue'].textContent);

    // Same page, now failing — and crucially AFTER a success, so a stale value
    // is on screen. Leaving it there is the same lie in slower motion.
    ctx.fetch = async () => ({
      ok: false, status: 401,
      json: async () => ({ error: 'Invalid or missing seller key' }),
      text: async () => '{"error":"Invalid or missing seller key"}',
    });
    await ctx.loadSubStats();
    ok('THE CENTRAL INVARIANT — a 401 never leaves a currency figure on the revenue tile',
       !/RM/.test(dom['sub-stat-revenue'].textContent), dom['sub-stat-revenue'].textContent);
    ok('…and it does not leave the previous successful numbers looking current',
       dom['sub-stat-revenue'].textContent === '—' &&
       dom['sub-stat-active'].textContent === '—' &&
       dom['sub-stat-trial'].textContent === '—',
       JSON.stringify([dom['sub-stat-active'].textContent, dom['sub-stat-trial'].textContent, dom['sub-stat-revenue'].textContent]));
    ok('…and the operator is told, rather than left to read dashes',
       toasts.some((t) => t.includes('❌') && /subscription stats/i.test(t)), JSON.stringify(toasts));
  }
  {
    const { ctx, dom, toasts } = sandbox({ status: 200, body: { totalUsers: 12, activeUsers: 9, totalDocs: 40, activeModules: 3, totalModules: 5 } });
    await ctx.loadStats();
    ok('a healthy platform-stats load shows the real user count',
       dom['stat-total-users'].textContent === 12, String(dom['stat-total-users'].textContent));
    ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'db down' }), text: async () => '{"error":"db down"}' });
    await ctx.loadStats();
    ok('a 500 never leaves "0 users" or a stale count in the platform tiles',
       dom['stat-total-users'].textContent === '—' && dom['topbar-count'].textContent === '—',
       JSON.stringify([dom['stat-total-users'].textContent, dom['topbar-count'].textContent]));
    ok('…and says so', toasts.some((t) => t.includes('❌') && /platform stats/i.test(t)), JSON.stringify(toasts));
  }

  /* ── 5. NO MUTATION TOASTS SUCCESS ON A FAILED WRITE ─────────────────────── */
  for (const [fn, successText] of [
    ['extendTrial',  'Trial extended'],
    ['activateSub',  'Subscription activated'],
    ['resetSub',     'Subscription reset'],
  ]) {
    const { ctx, toasts, calls } = sandbox({ status: 500, body: { error: 'db is down' } });
    await ctx[fn]('user-1');
    ok(`THE WORST OUTCOME — ${fn}: a 500 does NOT toast success`,
       !toasts.some((t) => t.includes(successText) && t.includes('✅')), JSON.stringify(toasts));
    ok(`${fn}: the operator is told it failed, and why`,
       toasts.some((t) => t.includes('❌')) && toasts.some((t) => /db is down/.test(t)),
       JSON.stringify(toasts));
    ok(`${fn}: a failed write does not trigger the success-path reloads`,
       calls.length === 1, `${calls.length} requests: ${JSON.stringify(calls)}`);
  }

  /* ── 6. …and a genuine success still toasts and reloads ──────────────────── */
  {
    const { ctx, toasts, calls } = sandbox({ status: 200, body: { ok: true } });
    await ctx.activateSub('user-1');
    ok('a genuinely successful activation still toasts success',
       toasts.some((t) => t.includes('✅') && t.includes('Subscription activated')), JSON.stringify(toasts));
    ok('…and still refreshes the table', calls.length > 1, `${calls.length} requests: ${JSON.stringify(calls)}`);
  }

  /* ── 7. server.js — a revoked Shopify token is not an empty catalogue ────── */
  {
    // Comments stripped first: this route now carries an explanatory comment
    // that NAMES response.ok, and an assertion satisfied by its own
    // documentation proves nothing. (The same mistake, in the same run, as the
    // scanner's window — worth the second guard.)
    const src = stripComments(fs.readFileSync(path.join(APP, 'server.js'), 'utf8'));
    const i = src.indexOf("app.get('/api/integrations/shopify/products'");
    ok('the Shopify products route was found (an empty scan passes vacuously — #14)', i > 0);
    const end = src.indexOf('app.', i + 10);
    const block = src.slice(i, end > i ? end : i + 2000);
    const okAt = block.search(/if\s*\(\s*!\s*response\.ok\s*\)/);
    ok('a revoked Shopify token is distinguished from an empty catalogue',
       okAt >= 0 && okAt < block.indexOf('data.products'),
       `response.ok check at ${okAt}, data.products at ${block.indexOf('data.products')}`);
  }

  /* ── 8. THE RATCHET: unchecked fetch sites may only ever decrease ─────────
     A shape, not a file list (#13). No file is exempt and none can be added to
     an exemption — a new unchecked fetch ANYWHERE fails this. The number is the
     honest remaining debt, and the next run starts from it rather than from a
     re-audit. It must never be raised. */
  const MAX_UNCHECKED = 36;
  /* Per-file ceilings as well as a total.
   *
   * A single number is not a ratchet: raising it is one character, and a
   * mutation that did exactly that survived the first version of this suite.
   * The realistic bad-faith move is "add an unchecked fetch, then bump the
   * number to match" — which the total alone cannot see and this map does.
   * Still a shape, not an exemption list: no file is excused from the rule,
   * each is only held to what it already owed, and every entry may only go
   * down. */
  const BASELINE = {
    'public/app.html': 15,
    'public/gao.html': 8,
    'public/audit.html': 4,
    'public/index.html': 2,
    // server.js's single entry is a FALSE POSITIVE and is left counted rather
    // than exempted: it is a `fetch(...)` inside the API-docs example STRING at
    // :1359, not a call. Recorded here so the next run does not chase it. The
    // ratchet only requires the number not to rise, so a known-inert entry
    // costs nothing and an exemption would cost the rule (#13).
    'server.js': 1,
    'public/ads.html': 1,
    'public/commerce.html': 1,
    'public/mail.html': 1,
    'public/sales.html': 1,
    'public/seo.html': 1,
    'public/social.html': 1,
  };
  {
    const report = scanFiles(APP, targets(APP));
    const n = total(report);
    console.log('\n  unchecked fetch sites still outstanding, by file:');
    for (const [f, hits] of Object.entries(report).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${String(hits.length).padStart(3)}  ${f}  (lines ${hits.map((h) => h.line).join(', ')})`);
    }
    ok(`the scan covered the repo (${Object.keys(report).length} files with hits — an empty scan passes vacuously, #14)`,
       n > 0);
    ok(`THE RATCHET — no more than ${MAX_UNCHECKED} unchecked fetch sites repo-wide (found ${n})`,
       n <= MAX_UNCHECKED, `${n} > ${MAX_UNCHECKED} — a new unchecked fetch was added`);
    const regressed = Object.entries(report)
      .filter(([f, hits]) => hits.length > (BASELINE[f] ?? 0))
      .map(([f, hits]) => `${f}: ${hits.length} > ${BASELINE[f] ?? 0}`);
    ok('THE RATCHET, per file — no file gained an unchecked fetch, whatever the total says',
       regressed.length === 0, regressed.join('; '));
    ok('the three files this run owns are clean',
       !report['public/seller.html'] && !report['public/content.html'] &&
       (!report['server.js'] || !report['server.js'].some((h) => h.line > 1200 && h.line < 1230)),
       Object.keys(report).join(','));
  }

  console.log(`\nfetch-contract: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  // A suite that dies mid-way must still REPORT — Run 27's harness scored three
  // genuine kills as survivors because they aborted before a score was printed.
  fail += 1;
  console.log('  ❌ suite aborted before completing —', e.message);
  console.log(`\nfetch-contract: ${pass} passed, ${fail} failed`);
  process.exit(1);
});

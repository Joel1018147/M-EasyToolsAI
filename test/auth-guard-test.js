// ═══════════════════════════════════════════════════════════════
// M-EasyTools AI+ — auth guard content negotiation (UI CONTRACT §4.3e)
//
// THE DEFECT THIS LOCKS — the inverse of the one the rollout was hunting:
//
//     if (req.accepts('json')) return res.status(401).json(...)
//
// A browser sends  Accept: text/html,application/xhtml+xml,…,*/*;q=0.8.
// The wildcard makes req.accepts('json') return 'json', so EVERY PAGE
// NAVIGATION by a logged-out visitor was answered with a raw JSON 401 body
// instead of a redirect to the login screen. Nobody got sent to /login.
//
// req.accepts(['html','json']) asks the right question — which does the
// client PREFER — and the /api/ path prefix is the primary signal, because
// fetch() sends Accept: */* by default and content negotiation alone
// misclassifies most API calls.
//
// The guard lives in server.js, which starts a listener on require. It is
// read and evaluated in isolation here rather than imported, so the test
// never boots the app. wantsJson has moved to helpers/wantsJson.js, which has
// no side effects, so THAT one is required for real — the thing under test is
// then the actual shipped function rather than a copy of its text.
//
// This file also asserts the two things §4.3e says a guard-level test cannot:
//   - CALL-SITE ASSIGNMENT. This repo now has two guards (requireAuth, which
//     negotiates, and requireAuthJSON, which never redirects). "Correct" is a
//     property of which one each route picks, and a test of the functions
//     alone passes while the wiring is wrong.
//   - THE SECOND COPY. middleware/checkSub.js makes the same page-vs-fetch
//     decision for a lapsed subscription and had its own wrong answer. A test
//     that only ever looks at server.js cannot see that.
//
//   node test/auth-guard-test.js
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
const CHECKSUB = path.join(__dirname, '..', 'middleware', 'checkSub.js');
const checkSubSrc = fs.readFileSync(CHECKSUB, 'utf8');

let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.error('  ✗ ' + m); };

// Brace-match the whole declaration. Reading to the first closing brace is
// the error that put a false premise into this rollout — it truncated a
// guard before its API branch and reported a correct one as broken.
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0, inS = null, inC = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inC === 'line') { if (c === '\n') inC = null; continue; }
    if (inC === 'block') { if (c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { if (c === '\\') { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inC = 'line'; i++; continue; }
    if (c === '/' && n === '*') { inC = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

// requireAuth delegates to wantsJson, which is now a real importable module.
const guard = extract('requireAuth');
const guardJson = extract('requireAuthJSON');
if (!guard) {
  console.error('\n  ✗ requireAuth not found in server.js — has it moved? (§7b rule 4: this is a\n'
    + '    parse failure, not evidence the guard is absent)\n');
  process.exit(1);
}
if (!guardJson) {
  console.error('\n  ✗ requireAuthJSON not found in server.js — GET /auth/me has no JSON-only\n'
    + '    guard, or it has been renamed. (§7b rule 4: parse failure, not absence.)\n');
  process.exit(1);
}
const { wantsJson } = require('../helpers/wantsJson');

console.log('\n=== §4.3e auth guard: JSON for /api, redirect for pages ===\n');
console.log('  parsed server.js: requireAuth (' + guard.split('\n').length + ' lines), '
  + 'requireAuthJSON (' + guardJson.split('\n').length + ' lines)');
console.log('  required for real: helpers/wantsJson.js\n');

// eslint-disable-next-line no-new-func
// requireAuth now closes over previewLock (private-preview layer 3), so the
// harness has to supply it. The REAL module, not a stub: an unauthenticated
// request never reaches guardSession, so every assertion below still measures
// what it always did.
const previewLock = require('../lib/previewLock');
const requireAuth = new Function('wantsJson', 'previewLock', guard + '; return requireAuth;')(wantsJson, previewLock);
// eslint-disable-next-line no-new-func
const requireAuthJSON = new Function(guardJson + '; return requireAuthJSON;')();

// express's req.accepts, faithfully enough for the two shapes that matter.
function makeReq({ url = '/', accept = '', xhr = false, authed = false } = {}) {
  const a = accept || '*/*';
  return {
    originalUrl: url, path: url, xhr,
    headers: { accept: a },
    isAuthenticated: () => authed,
    // Layer 3 of the private-preview lock reads req.user, so an authenticated
    // request here carries an ALLOWLISTED address: these assertions are about
    // html-vs-json negotiation, not about the lock, which has its own suite.
    user: authed ? { email: previewLock.CODE_ALLOWLIST[0] } : undefined,
    accepts(types) {
      const list = Array.isArray(types) ? types : [types];
      const html = a.includes('text/html');
      const json = a.includes('application/json');
      const wild = a.includes('*/*');
      if (!Array.isArray(types)) {
        // single-argument form returns the type (truthy) if acceptable at all
        const t = list[0];
        if (t === 'json') return (json || wild) ? 'json' : false;
        if (t === 'html') return (html || wild) ? 'html' : false;
        return false;
      }
      for (const t of list) {
        if (t === 'html' && html) return 'html';
        if (t === 'json' && json && !html) return 'json';
      }
      if (html) return 'html';
      if (json) return 'json';
      return list[0];
    },
  };
}

function run(reqOpts, guardFn = requireAuth) {
  const out = { status: null, body: null, redirect: null, nexted: false };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    redirect(to) { out.redirect = to; return res; },
  };
  guardFn(makeReq(reqOpts), res, () => { out.nexted = true; });
  return out;
}

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

// ── pages must redirect ──────────────────────────────────────────
for (const url of ['/', '/dashboard', '/tools', '/settings']) {
  const r = run({ url, accept: BROWSER });
  if (r.redirect) pass(`page ${url} -> 302 ${r.redirect}`);
  else fail(`page ${url} -> status=${r.status} body=${JSON.stringify(r.body)} — a logged-out visitor got JSON instead of the login screen`);
}

// ── /api must get JSON ───────────────────────────────────────────
console.log('');
for (const url of ['/api/tools', '/api/settings', '/api/me']) {
  const r = run({ url });                       // fetch() default: Accept: */*
  if (r.status === 401 && r.body) pass(`${url} -> 401 ${JSON.stringify(r.body)}`);
  else fail(`${url} -> expected 401 JSON, got status=${r.status} redirect=${r.redirect}`);
}

// ── secondary signals ────────────────────────────────────────────
console.log('');
const x = run({ url: '/dashboard', xhr: true });
if (x.status === 401) pass('req.xhr on a page path -> 401'); else fail('req.xhr should force JSON');
const j = run({ url: '/dashboard', accept: 'application/json' });
if (j.status === 401) pass('Accept: application/json -> 401'); else fail('explicit json should force JSON');
const both = run({ url: '/dashboard', accept: 'text/html,application/json' });
if (both.redirect) pass('advertising BOTH -> redirect (html wins)'); else fail('html must win when both are advertised');

// ── authenticated pass-through ───────────────────────────────────
console.log('');
for (const url of ['/api/tools', '/dashboard']) {
  const r = run({ url, authed: true });
  if (r.nexted && r.status === null && r.redirect === null) pass(`authenticated ${url} -> next()`);
  else fail(`authenticated ${url} must call next() and write nothing`);
}

// ── requireAuthJSON: never redirects, still passes authenticated through ──
console.log('');
const mj = run({ url: '/auth/me', accept: BROWSER }, requireAuthJSON);
if (mj.status === 401 && mj.body && !mj.redirect) pass('requireAuthJSON -> 401 even for a browser Accept');
else fail(`requireAuthJSON must never redirect; got status=${mj.status} redirect=${mj.redirect}`);
const mjOk = run({ url: '/auth/me', authed: true }, requireAuthJSON);
if (mjOk.nexted && mjOk.status === null) pass('requireAuthJSON authenticated -> next()');
else fail('requireAuthJSON must let an authenticated request through untouched');

// ── §4.3e CALL-SITE ASSIGNMENT ───────────────────────────────────
// "A test of the guards alone passes while the wiring is wrong." Two guards
// exist, so this enumerates the actual app.<verb>('<path>', <guard>, …)
// registrations and checks that each path is on a guard that can answer it.
//
// requireAuthJSON always 401s, so it is only correct where no browser
// navigates: /api/* and the /auth/* JSON endpoints from §4.1. requireAuth
// negotiates, so it is correct anywhere — EXCEPT that a /api/ route on a guard
// that could redirect would be the original defect, and wantsJson's prefix
// rule already makes requireAuth answer JSON there. The failure this catches
// is the reverse: a PAGE route handed the JSON-only guard, which would answer
// a logged-out visitor with a bare 401 body and no way to sign in.
console.log('');
const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)/g;
const registrations = [];
for (let m; (m = ROUTE_RE.exec(src)) !== null; ) {
  registrations.push({ verb: m[1], path: m[2], guard: m[3] });
}
if (!registrations.length) {
  fail('parsed ZERO route registrations out of server.js — this is a parse failure, '
     + 'not proof the wiring is right (§7b rule 4)');
} else {
  pass(`parsed ${registrations.length} guarded route registrations from server.js`);
  const isJsonOnlyPath = (p) => p.startsWith('/api/') || p === '/auth/me';
  const misassigned = registrations.filter(r => r.guard === 'requireAuthJSON' && !isJsonOnlyPath(r.path));
  if (misassigned.length === 0) pass('no page route is on requireAuthJSON');
  else misassigned.forEach(r => fail(
    `${r.verb.toUpperCase()} ${r.path} is on requireAuthJSON — a logged-out visitor `
    + 'navigating there gets a bare 401 body and no login screen'));

  const meRoute = registrations.find(r => r.path === '/auth/me');
  if (!meRoute) fail('GET /auth/me is not registered — §4.1 requires it');
  else if (meRoute.guard === 'requireAuthJSON') pass('GET /auth/me is on requireAuthJSON');
  else fail(`GET /auth/me is on ${meRoute.guard}; it sits outside /api/, so a fetch() with the `
          + 'default Accept: */* would be answered with a 302 and the login HTML');
}

// ── §4.3e THE SECOND COPY: middleware/checkSub.js ────────────────
// The same page-vs-fetch decision, made for a lapsed subscription. It asked
// req.accepts('json'), which a browser's wildcard satisfies, so a signed-in
// user with an expired plan was shown a raw JSON 402 instead of /billing.
//
// Scanned against CODE ONLY. The first version of this check read the raw file
// and went red on the comment that explains the fix — the sentence naming the
// old call is not the old call. A scanner that cannot tell those apart reports
// every properly-documented fix as unfixed.
function stripComments(text) {
  let out = '', inS = null, inC = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inC === 'line')  { if (c === '\n') { inC = null; out += c; } continue; }
    if (inC === 'block') { if (c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { out += c; if (c === '\\') { out += text[++i] || ''; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inC = 'line'; i++; continue; }
    if (c === '/' && n === '*') { inC = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; }
    out += c;
  }
  return out;
}
const checkSubCode = stripComments(checkSubSrc);

console.log('');
if (/req\.accepts\(\s*['"]json['"]\s*\)/.test(checkSubCode)) {
  fail("middleware/checkSub.js still calls req.accepts('json') — a browser's */* "
     + 'makes that true for a page navigation');
} else {
  pass("middleware/checkSub.js does not call req.accepts('json')");
}
if (/wantsJson\s*\(\s*req\s*\)/.test(checkSubCode) && /require\(['"]\.\.\/helpers\/wantsJson['"]\)/.test(checkSubCode)) {
  pass('middleware/checkSub.js uses the shared helpers/wantsJson');
} else {
  fail('middleware/checkSub.js must use helpers/wantsJson — one definition, or it drifts again');
}
if (/require\(['"]\.\/helpers\/wantsJson['"]\)/.test(stripComments(src))) {
  pass('server.js uses the shared helpers/wantsJson');
} else {
  fail('server.js must use helpers/wantsJson, not a private copy');
}

console.log('');
if (failures) { console.error('✗ ' + failures + ' failure(s)\n'); process.exit(1); }
console.log('✓ auth guard negotiates correctly in both directions, and the wiring matches\n');

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
// never boots the app.
//
//   node test/auth-guard-test.js
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

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

// requireAuth delegates to wantsJson, so both have to come across. Pulling
// only the guard gave a ReferenceError at call time rather than a wrong
// answer — which is the good failure mode, but it still has to be handled.
const guard = extract('requireAuth');
const helper = extract('wantsJson');
if (!guard) {
  console.error('\n  ✗ requireAuth not found in server.js — has it moved? (§7b rule 4: this is a\n'
    + '    parse failure, not evidence the guard is absent)\n');
  process.exit(1);
}
console.log('\n=== §4.3e auth guard: JSON for /api, redirect for pages ===\n');
console.log('  parsed server.js: requireAuth (' + guard.split('\n').length + ' lines)'
  + (helper ? ', wantsJson (' + helper.split('\n').length + ' lines)' : ', no wantsJson helper') + '\n');

// eslint-disable-next-line no-new-func
const requireAuth = new Function((helper ? helper + '\n' : '') + guard + '; return requireAuth;')();

// express's req.accepts, faithfully enough for the two shapes that matter.
function makeReq({ url = '/', accept = '', xhr = false, authed = false } = {}) {
  const a = accept || '*/*';
  return {
    originalUrl: url, path: url, xhr,
    headers: { accept: a },
    isAuthenticated: () => authed,
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

function run(reqOpts) {
  const out = { status: null, body: null, redirect: null, nexted: false };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    redirect(to) { out.redirect = to; return res; },
  };
  requireAuth(makeReq(reqOpts), res, () => { out.nexted = true; });
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

console.log('');
if (failures) { console.error('✗ ' + failures + ' failure(s)\n'); process.exit(1); }
console.log('✓ auth guard negotiates correctly in both directions\n');

// ═══════════════════════════════════════════════════════════════
// M-EasyTools AI+ — §4.1 auth contract
//
//   node test/auth-contract.js
//
// SCOPE, STATED HONESTLY (§7b rule 5). server.js calls process.exit(1) on a
// missing env var and starts a listener on require, and this repo has no
// in-memory Postgres. So these are STRUCTURAL assertions over the source plus
// behavioural tests of the pure functions that can be lifted out. They prove
// the wiring and the invariants; they do not prove a live round-trip. The
// live check is scripts/smoke-test.js against a running deployment.
//
// WHAT THIS EXISTS TO CATCH — the failure mode from Run 11, one platform over:
// the canonical portal posts to /auth/register, and a repo that already had
// /api/auth/register grew a SECOND account-creating handler to serve it. Two
// paths into one endpoint must never become two implementations, because the
// day they disagree, one of them is the one attackers use.
// ═══════════════════════════════════════════════════════════════

'use strict';
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const raw = fs.readFileSync(SERVER, 'utf8');

let failures = 0, checks = 0;
const pass = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { checks++; failures++; console.error('  ✗ ' + m); };
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 56 - m.length)));

// Comments name things they do not do. Strip them, keep strings.
function stripComments(text) {
  let out = '', inS = null, inC = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inC === 'line') { if (c === '\n') { inC = null; out += c; } continue; }
    if (inC === 'block') { if (c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { out += c; if (c === '\\') { out += text[++i] || ''; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inC = 'line'; i++; continue; }
    if (c === '/' && n === '*') { inC = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') inS = c;
    out += c;
  }
  return out;
}
const src = stripComments(raw);

// Brace-match a whole declaration. Reading to the first closing brace is the
// error that put a false premise into this rollout (§7b).
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0, inS = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inS) { if (c === '\\') { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

console.log('\n=== §4.1 auth contract ===');

// ═══ 1. TWO PATHS, ONE HANDLER ══════════════════════════════════════════
head('two paths, one handler');
{
  // previewLock.guardCredentials sits between the limiter and the handler on
  // the credentialed routes (private preview, layer 2). It is middleware, not a
  // second handler — what this contract is about, one handler shared by the
  // canonical and the legacy path, is unchanged. So the pattern admits it
  // rather than reporting both routes as unregistered, which is what a
  // structural test should do when structure it does not name is added.
  const REG = /app\.(post|get)\('([^']+)',\s*(?:authLimiter,\s*)?(?:previewLock\.guardCredentials,\s*)?(?:requireAuth(?:JSON)?,\s*)?([A-Za-z_$][\w$]*)\)/g;
  const mounts = {};
  for (let m; (m = REG.exec(src)) !== null; ) mounts[m[2]] = m[3];
  const seen = Object.keys(mounts).filter((p) => p.includes('auth'));
  console.log('    auth route registrations parsed: ' + seen.length);
  if (!seen.length) fail('parsed ZERO auth routes — a parse failure, not an empty file');

  const PAIRS = [
    ['/auth/login',    '/api/auth/login'],
    ['/auth/register', '/api/auth/register'],
    ['/auth/forgot',   '/api/auth/forgot'],
  ];
  for (const [canonical, legacy] of PAIRS) {
    const a = mounts[canonical], b = mounts[legacy];
    if (!a) { fail(`${canonical} is not registered — §4.1 requires it and the canonical portal posts there`); continue; }
    if (!b) { fail(`${legacy} is not registered — existing callers in this repo post there`); continue; }
    if (a === b) pass(`${canonical} and ${legacy} share one handler (${a})`);
    else fail(`${canonical} → ${a} but ${legacy} → ${b}: TWO account paths that can drift`);
  }
  // /auth/me is deliberately on a different GUARD but the same handler.
  if (mounts['/auth/me'] && mounts['/auth/me'] === mounts['/api/auth/me']) {
    pass('/auth/me and /api/auth/me share one handler (' + mounts['/auth/me'] + ')');
  } else {
    fail('/auth/me and /api/auth/me do not share a handler');
  }
}

// ═══ 2. NO CLIENT-SUPPLIED PRIVILEGE AT REGISTRATION (§4.1b) ════════════
head('§4.1b  roles are never self-asserted');
{
  const body = extract('handleRegister');
  if (!body) { fail('handleRegister not found — parse failure'); }
  else {
    console.log('    handleRegister parsed: ' + body.split('\n').length + ' lines');
    const destructured = (body.match(/const\s*\{([^}]*)\}\s*=\s*req\.body/) || [])[1] || '';
    console.log('    reads from req.body: ' + destructured.trim().replace(/\s+/g, ' '));
    for (const forbidden of ['role', 'plan', 'is_active', 'api_key', 'team_id']) {
      if (new RegExp('\\b' + forbidden + '\\b').test(destructured)) {
        fail(`handleRegister reads '${forbidden}' from the request body — §4.1b`);
      } else {
        pass(`'${forbidden}' is not taken from the request body`);
      }
    }
    // The role must come from the server's own test, not from the request.
    if (/isFirst\s*\?\s*'admin'\s*:\s*'user'/.test(body)) pass("role is server-derived (isFirst ? 'admin' : 'user')");
    else fail('role is not the server-derived first-user expression any more — check what replaced it');
    if (/'free'/.test(body)) pass("plan is written as the server-chosen literal 'free'");
    else fail('plan is no longer a server-chosen literal');
  }
}

// ═══ 3. /auth/forgot — INVARIANCE, not the number ═══════════════════════
head('§4.1  forgot-password does not vary with the address');
{
  const body = extract('handleForgot');
  if (!body) { fail('handleForgot not found — parse failure'); }
  else {
    console.log('    handleForgot parsed: ' + body.split('\n').length + ' lines');
    // The strongest form of "the response does not depend on the address" is
    // that the address is never looked up at all.
    const touchesDb = /\b(db\.|pool\.|client\.query|SELECT|INSERT|UPDATE)\b/.test(body);
    if (!touchesDb) pass('never queries the database — the response cannot depend on whether the address exists');
    else fail('handleForgot touches the database; any query on the submitted address is an enumeration risk');

    const statuses = [...body.matchAll(/res\.status\((\d{3})\)/g)].map((m) => m[1]);
    const unique = [...new Set(statuses)];
    console.log('    response statuses in the function: ' + (unique.join(', ') || '(none — implicit 200)'));
    if (unique.length <= 1) pass('exactly one response status for every input (' + (unique[0] || '200') + ')');
    else fail('more than one status (' + unique.join(', ') + ') — the response varies, which is the defect');

    if (/\bif\s*\(/.test(body)) fail('handleForgot branches — every branch is a way for the response to vary');
    else pass('no branching at all');

    if (unique[0] === '503') {
      pass('503 is the honest answer: there is no reset flow, so nothing is ever sent');
    } else if (!unique.length) {
      fail('a bare 200 promises a delivery — only correct if a reset email is genuinely sent');
    }
  }
}

// ═══ 4. VALIDATION SHAPE — { error, fields } ════════════════════════════
head('§4.1  validation errors come back per field');
{
  for (const name of ['handleRegister', 'handleLogin']) {
    const body = extract(name);
    if (!body) { fail(name + ' not found'); continue; }
    if (/res\.status\(422\)\.json\(\{[^}]*fields/.test(body.replace(/\s+/g, ' '))) {
      pass(name + ' returns 422 { error, fields }');
    } else {
      fail(name + ' does not return the { error, fields } shape — the portal cannot render per-field errors');
    }
    if (/res\.status\(400\)/.test(body)) fail(name + ' still returns 400 for validation; §4.1 says 422');
    else pass(name + ' does not use 400 for validation');
  }
  const reg = extract('handleRegister') || '';
  if (/res\.status\(409\)/.test(reg)) pass('handleRegister returns 409 for a duplicate email');
  else fail('handleRegister has no 409 path — §4.1 requires it');
}

// ═══ 5. LOGIN DOES NOT ENUMERATE ════════════════════════════════════════
head('login gives one answer for two different failures');
{
  const body = extract('handleLogin') || '';
  const msgs = [...body.matchAll(/res\.status\(401\)\.json\(\{\s*error:\s*'([^']+)'/g)].map((m) => m[1]);
  console.log('    distinct 401 messages: ' + JSON.stringify([...new Set(msgs)]));
  if (new Set(msgs).size <= 1) pass('one 401 message covers unknown-account and wrong-password');
  else fail('more than one 401 message — the pair is an account-enumeration oracle');
}

// ═══ 6. safeRedirect — behavioural, the function is pure ════════════════
head('the post-sign-in return path cannot leave the site');
{
  const body = extract('safeRedirect');
  if (!body) { fail('safeRedirect not found — parse failure'); }
  else {
    // eslint-disable-next-line no-new-func
    const safeRedirect = new Function(body + '; return safeRedirect;')();
    const cases = [
      ['/seo', '/seo', 'a same-site path is kept'],
      ['/app?goto=pr', '/app?goto=pr', 'a path with a query is kept'],
      [undefined, '/app', 'absent falls back'],
      ['', '/app', 'empty falls back'],
      ['https://evil.example/x', '/app', 'an absolute URL is refused'],
      ['//evil.example/x', '/app', 'a protocol-relative URL is refused'],
      ['javascript:alert(1)', '/app', 'a javascript: URL is refused'],
      [{ toString: () => '/x' }, '/app', 'a non-string is refused'],
      ['app', '/app', 'a bare relative path is refused'],
    ];
    for (const [input, want, label] of cases) {
      const got = safeRedirect(input);
      if (got === want) pass(label + '  (' + JSON.stringify(input) + ' → ' + got + ')');
      else fail(label + ': safeRedirect(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ', want ' + want);
    }
  }
}

console.log('');
console.log(`${checks} checks, ${failures} failure(s)`);
if (failures) { console.error('\n✗ auth contract FAILED\n'); process.exit(1); }
console.log('✓ auth contract\n');

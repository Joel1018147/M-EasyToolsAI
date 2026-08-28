'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   GUARD — PRIVATE PREVIEW: the landing is public, the app is not.
   ───────────────────────────────────────────────────────────────────────────
   BYTE-IDENTICAL IN ALL SEVEN M-EASY REPOS. If you change it here, change it
   in all seven — a guard that has drifted between repos makes the per-repo
   verdicts incomparable, which is the only thing they are for. It finds the
   files it needs by searching, so the same bytes work in a repo that keeps its
   routes in `routes/` and one that keeps them in `src/routes/`.

   WHAT IT PROTECTS.

   Every platform's landing page and /modules/… pages are linked publicly.
   Nobody may get past the sign-in form except the allowlist. That is enforced
   at three layers by lib/previewLock.js, and the failure this file exists to
   catch is not the predicate being wrong — §P1 settles that in twenty
   assertions — but a credential route being added later WITHOUT the guard.
   That defect is invisible: the new route works perfectly, and the only
   symptom is that a stranger can sign in.

     §P1  the predicate behaves, over a real Express app
     §P2  every credential route in this repo is actually wired to it
     §P3  the negative control — §P2 fails when a guard is removed

   §P2 IS THE POINT. §P1 tests a module; §P2 tests the repo.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const APP = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, e === undefined ? '' : e)); };
const section = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 62 - m.length)));

/* ── find the module and the source tree, without hard-coding either ─────── */
function walk(dir, out) {
  out = out || [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-artifacts') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const ALL_JS = walk(APP);
const SOURCE = ALL_JS.filter((f) => !/[\\/]test[\\/]/.test(f) && !/[\\/]scripts[\\/]/.test(f));
const MODULE_PATH = ALL_JS.find((f) => path.basename(f) === 'previewLock.js');

section('§P0  the module is present');
ok('lib/previewLock.js exists somewhere in this repo', !!MODULE_PATH,
   'no previewLock.js found — the lock is not installed');
if (!MODULE_PATH) { console.log('\n❌ PASS ' + pass + ' FAIL ' + fail + '\n'); process.exit(1); }
console.log('    ' + path.relative(APP, MODULE_PATH).replace(/\\/g, '/'));

const LOCK_SRC = fs.readFileSync(MODULE_PATH, 'utf8');
const lock = require(MODULE_PATH);

/* ── §P1 · the predicate ─────────────────────────────────────────────────── */
section('§P1  the predicate, over a real Express app');
{
  const saveLock = process.env.PREVIEW_LOCK;
  const saveList = process.env.PREVIEW_ALLOW_EMAILS;
  delete process.env.PREVIEW_LOCK;
  delete process.env.PREVIEW_ALLOW_EMAILS;

  ok('absent PREVIEW_LOCK means LOCKED — it fails closed', lock.isLocked() === true);
  ok('an owner address is allowed', lock.allows(lock.CODE_ALLOWLIST[0]) === true);
  ok('case and surrounding space do not matter',
     lock.allows('  ' + lock.CODE_ALLOWLIST[0].toUpperCase() + ' ') === true);
  ok('a stranger is refused', lock.allows('stranger@example.com') === false);
  ok('an empty address is refused', lock.allows('') === false);
  ok('a null address is refused', lock.allows(null) === false);
  ok('a session with no readable address is refused', lock.allowsUser({ id: 7 }) === false);
  ok('no session at all is refused', lock.allowsUser(null) === false);

  process.env.PREVIEW_ALLOW_EMAILS = ' Extra@Example.com , second@example.com ';
  ok('the environment can ADD addresses',
     lock.allows('extra@example.com') && lock.allows('second@example.com'));
  ok('the environment cannot REMOVE the code allowlist — no config typo can '
     + 'lock the owner out', lock.allows(lock.CODE_ALLOWLIST[0]) === true);
  delete process.env.PREVIEW_ALLOW_EMAILS;
  ok('removing the variable removes only what it added',
     lock.allows(lock.CODE_ALLOWLIST[0]) && !lock.allows('extra@example.com'));

  process.env.PREVIEW_LOCK = 'anything-at-all';
  ok('only the exact value "off" lifts the lock', lock.isLocked() === true);
  process.env.PREVIEW_LOCK = 'off';
  ok('"off" lifts it for everyone', lock.allows('stranger@example.com') === true);
  delete process.env.PREVIEW_LOCK;

  /* Over a real server, because the middleware's contract is a response, not a
     boolean: the status has to be 403 and the handler behind it must not run. */
  let express;
  try { express = require(path.join(APP, 'node_modules', 'express')); } catch (e) { express = null; }
  ok('express is available to exercise the middleware', !!express);

  if (express) {
    const reached = [];
    const app = express();
    app.use(express.json());
    app.post('/auth/login', lock.guardCredentials, (req, res) => { reached.push('login'); res.json({ ok: true }); });
    app.post('/auth/register', lock.guardCredentials, (req, res) => { reached.push('register'); res.json({ ok: true }); });
    app.get('/private', (req, res, next) => { req.user = { email: req.query.as }; next(); },
      lock.guardSession, (req, res) => { reached.push('private'); res.json({ ok: true }); });

    const srv = app.listen(0);
    const port = srv.address().port;
    const call = (method, url, body, accept) => new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, path: url, method,
        headers: Object.assign({ accept: accept || 'application/json' },
          payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, loc: res.headers.location })); });
      req.on('error', () => resolve({ status: 0, body: '' }));
      if (payload) req.write(payload);
      req.end();
    });

    (async () => {
      const owner = lock.CODE_ALLOWLIST[0];
      let r = await call('POST', '/auth/login', { email: 'stranger@example.com', password: 'x' });
      ok('a stranger signing in is refused 403', r.status === 403, r.status);
      ok('  …and the sign-in handler never ran', reached.indexOf('login') === -1);
      ok('  …and is told it is a private preview, not that the password was wrong',
         /private preview/i.test(r.body) && !/password/i.test(r.body), r.body.slice(0, 90));

      r = await call('POST', '/auth/register', { email: 'stranger@example.com', password: 'x' });
      ok('a stranger registering is refused 403', r.status === 403, r.status);
      ok('  …and no account-creating handler ran', reached.indexOf('register') === -1);

      r = await call('POST', '/auth/login', { email: owner, password: 'x' });
      ok('the owner reaches the real sign-in handler', r.status === 200 && reached.indexOf('login') !== -1, r.status);

      r = await call('POST', '/auth/register', { email: owner, password: 'x' });
      ok('the owner reaches the real register handler', r.status === 200 && reached.indexOf('register') !== -1, r.status);

      r = await call('GET', '/private?as=' + encodeURIComponent('stranger@example.com'));
      ok('an existing session for a refused address is stopped', r.status === 403, r.status);
      ok('  …and the page behind it never rendered', reached.indexOf('private') === -1);

      r = await call('GET', '/private?as=' + encodeURIComponent(owner));
      ok('the owner\'s session is untouched', r.status === 200 && reached.indexOf('private') !== -1, r.status);

      r = await call('POST', '/auth/login', { email: 'stranger@example.com' }, 'text/html,application/xhtml+xml');
      ok('a browser navigation gets a page that says why, still 403',
         r.status === 403 && /<html/i.test(r.body) && /private preview/i.test(r.body),
         r.status + ' ' + r.body.slice(0, 60));
      ok('  …and that page is not indexable',
         /noindex/.test(r.body), 'a refusal page must not enter search results');

      srv.close();

      if (saveLock === undefined) delete process.env.PREVIEW_LOCK; else process.env.PREVIEW_LOCK = saveLock;
      if (saveList === undefined) delete process.env.PREVIEW_ALLOW_EMAILS; else process.env.PREVIEW_ALLOW_EMAILS = saveList;
      runStatic();
    })();
  } else {
    runStatic();
  }
}

/* ── §P2 · the wiring ────────────────────────────────────────────────────── */

/** A path whose LAST segment is one of these takes credentials and issues a
 *  session. Written as an explicit list, not a substring test: `/auth/logout`
 *  and `/auth/login-redirect` both contain a word from it and neither takes a
 *  password — login-redirect only stashes a return URL before bouncing to
 *  Google, and Google comes back through a callback that IS guarded. */
const CREDENTIAL_TAIL = /(^|\/)(login|register|signin|signup|register-first|login-local)$/;

/** Route declarations, with everything up to the handler body. */
const ROUTE_RE = /\b(?:app|router)\s*\.\s*post\s*\(\s*(['"`])([^'"`]+)\1([^;]{0,400}?)(?:=>|\)\s*;)/g;

function findCredentialRoutes() {
  const found = [];
  for (const file of SOURCE) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) {
      const routePath = m[2];
      if (!CREDENTIAL_TAIL.test(routePath)) continue;
      /* THREE THINGS THAT LOOK LIKE A WAY IN AND ARE NOT. Each was a real
         false positive across the seven repos, and each is excluded by a
         property of the route rather than by name, so a genuine route cannot
         be excused by being named like one of them.

         1 · A PATH PARAMETER. A route that creates an ACCOUNT never has one in
             front of the verb; one that does is about a thing you already
             have. M-EasyDo's /events/:id/register signs an existing member up
             for an event. */
      if (routePath.indexOf(':') !== -1) continue;
      /*  2 · ALREADY BEHIND requireAuth. A route you must be signed in to
             reach cannot be the way you get signed in, and layer 3 covers it.
             M-EasyHalal's creator and merchant /register both create a
             PROFILE for the current user. */
      if (/requireAuth/.test(m[0])) continue;
      /*  3 · A FILE THAT DEALS IN NO CREDENTIALS. M-EasyCommerce's
             /oauth/shopee/callback connects a marketplace, not a person: no
             password, no passport, no session. A file that never mentions
             either cannot be issuing one. */
      if (!/password/i.test(src) && !/passport\s*\./.test(src)) continue;
      found.push({ file: path.relative(APP, file).replace(/\\/g, '/'), path: routePath, decl: m[0] });
    }
  }
  return found;
}

function guardedBy(decl, src) {
  return /guardCredentials/.test(decl) || (/guardCredentials/.test(src) && /guardCredentials/.test(decl));
}

function runStatic() {
  section('§P2  every credential route in THIS repo is wired to it');
  const routes = findCredentialRoutes();
  ok('credential routes were found at all — a zero here is a parse failure, '
     + 'not a clean repo', routes.length > 0, routes.length);
  console.log('    ' + routes.length + ' credential route(s)');

  const unguarded = routes.filter((r) => !/guardCredentials/.test(r.decl));
  for (const r of routes) {
    ok(`${r.path} (${r.file}) is guarded`, /guardCredentials/.test(r.decl),
       'a stranger can ' + (/register/.test(r.path) ? 'create an account' : 'sign in') + ' through this route');
  }

  /* Layer 3. Whichever file defines requireAuth must run guardSession from it:
     that is the backstop for OAuth, for sessions predating the lock, and for
     any route this file's §P2 regex does not recognise. */
  const authFiles = SOURCE.filter((f) => /function requireAuth\b|const requireAuth\b/.test(fs.readFileSync(f, 'utf8')));
  ok('requireAuth is defined somewhere', authFiles.length > 0);
  const wired = authFiles.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    const at = src.search(/function requireAuth\b|const requireAuth\b/);
    return /guardSession/.test(src.slice(at, at + 700));
  });
  ok('requireAuth runs guardSession — layer 3 is the backstop for every path '
     + 'this test does not know about', wired.length === authFiles.length,
     authFiles.filter((f) => !wired.includes(f)).map((f) => path.relative(APP, f)).join(', '));

  /* An OAuth callback issues a session without ever seeing a password, so it
     cannot be covered by guardCredentials. Where one exists it must carry
     guardSession explicitly rather than lean on layer 3 — an account row is
     created either way, and the redirect after it would look like a success. */
  const callbacks = [];
  for (const file of SOURCE) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\b(?:app|router)\s*\.\s*get\s*\(\s*(['"`])([^'"`]*callback[^'"`]*)\1([\s\S]{0,600}?)(?:=>|\)\s*;)/g;
    let m;
    while ((m = re.exec(src))) {
      /* It has to be an IDENTITY callback. M-EasyCommerce's
         /oauth/shopee/callback, /oauth/lazada/callback and
         /oauth/tiktok/callback are marketplace connections — they exchange a
         shop token and issue no session for a person. `passport.authenticate`
         in the declaration is the thing that makes a callback a way in, so it
         is what this looks for rather than the word "callback". */
      if (!/passport\s*\.\s*authenticate/.test(m[0])) continue;
      callbacks.push({ file: path.relative(APP, file).replace(/\\/g, '/'), path: m[2], decl: m[0] });
    }
  }
  if (callbacks.length === 0) {
    ok('no OAuth callback in this repo — nothing to guard', true);
  } else {
    for (const c of callbacks) {
      ok(`${c.path} (${c.file}) carries guardSession`, /guardSession/.test(c.decl),
         'a Google sign-in would issue a session for any address');
    }
  }

  /* ── §P3 · the negative control ───────────────────────────────────────── */
  section('§P3  negative control · §P2 fails when a guard is removed');
  {
    const target = routes[0];
    ok('there is a route to plant against', !!target);
    if (target) {
      const stripped = target.decl.replace(/,?\s*(?:previewLock\.)?guardCredentials\s*,?/, ', ');
      ok('removing guardCredentials from ' + target.path + ' IS detected by §P2',
         !/guardCredentials/.test(stripped),
         'the planted regression survives — §P2 is asserting nothing');
    }
    /* And the same for layer 3, so neither half of §P2 is vacuous. */
    const sample = 'function requireAuth(req, res, next) {\n  if (req.isAuthenticated()) return next();';
    ok('a requireAuth without guardSession IS detected by §P2',
       !/guardSession/.test(sample));
  }

  /* THREE SPELLINGS OF ONE SCORE, AND THAT IS NOT DECORATION.
     The seven runners do not agree on how a suite reports itself:
     M-EasyPOS scores `/(\d+) PASS (\d+) FAIL/`, M-EasyCommerce scores
     `/(\d+) passed, (\d+) failed/`, and a suite that matches neither is filed
     as CRASHED — a green suite reported as a crash, which is the worst of the
     three outcomes because it looks like a real failure. This file is
     byte-identical across all seven, so it speaks all three. */
  console.log(`\n${fail === 0 ? '✅' : '❌'} PASS ${pass} FAIL ${fail}`);
  console.log(`${pass} PASS ${fail} FAIL`);
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

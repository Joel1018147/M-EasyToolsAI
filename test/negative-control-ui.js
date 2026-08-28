// ═══════════════════════════════════════════════════════════════
// M-EasyTools AI+ — negative control for the three new guards
//
//   node test/negative-control-ui.js
//
// §7b RULE 3: a test that has never gone red has not been tested. Every
// verifier written across this rollout — eight — was wrong on its first run,
// and each was caught only because a fail-first demo forced it.
//
// §7b RULE 6: verify the write ACTUALLY APPLIED. A plant that matches nothing
// changes nothing and says nothing; you then get a green run and read it as
// evidence the guard is sound. It has happened twice in this rollout — a CRLF
// anchor against an LF file, and a backtick template that mangled a
// replacement string. So every plant below is read back off disk and asserted
// PRESENT before the harness is allowed to run, and asserted GONE after the
// restore.
//
// THE DIRTY-BASELINE CHECK comes first. With a real bug already in the tree
// every harness run fails, so every plant reports CAUGHT and the control
// scores 100% having measured nothing. That is the fail-open case and it is
// the only one that produces a confident lie.
// ═══════════════════════════════════════════════════════════════

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.join(ROOT, p);

const PLANTS = [
  // ── test/auth-guard-test.js ──────────────────────────────────────────
  {
    harness: 'test/auth-guard-test.js',
    file: 'helpers/wantsJson.js',
    what: 'the guard negotiates on Accept instead of the /api/ path prefix',
    fromExact: "  if (req.originalUrl && req.originalUrl.startsWith('/api/')) return true;\n"
             + "  if (req.path && req.path.startsWith('/api/')) return true;\n"
             + '  if (req.xhr) return true;\n'
             + "  return req.accepts(['html', 'json']) === 'json';",
    to: "  return !!req.accepts('json');",
  },
  {
    harness: 'test/auth-guard-test.js',
    file: 'middleware/checkSub.js',
    what: 'the lapsed-subscription branch goes back to req.accepts(\'json\')',
    fromExact: '    if (wantsJson(req)) {\n      return res.status(402).json({',
    to: "    if (req.accepts('json') || req.xhr) {\n      return res.status(402).json({",
  },
  {
    harness: 'test/auth-guard-test.js',
    file: 'server.js',
    what: 'GET /auth/me is moved onto the redirecting guard',
    fromExact: "app.get('/auth/me',     requireAuthJSON, handleMe);",
    to: "app.get('/auth/me',     requireAuth, handleMe);",
  },

  // ── test/auth-contract.js ────────────────────────────────────────────
  {
    harness: 'test/auth-contract.js',
    file: 'server.js',
    what: 'the canonical /auth/register grows a SECOND handler (the Run 11 defect)',
    // The line grew previewLock.guardCredentials between the limiter and the
    // handler (private preview, layer 2). The PLANT is still the handler name —
    // that is the Run 11 defect this control reproduces — but the anchor has to
    // match the line as it is now, or the control reports ANCHOR ROTTED and
    // proves nothing.
    fromExact: "app.post('/auth/register',     authLimiter, previewLock.guardCredentials, handleRegister);",
    to: "app.post('/auth/register',     authLimiter, previewLock.guardCredentials, handleRegisterV2);",
  },
  {
    harness: 'test/auth-contract.js',
    file: 'server.js',
    what: 'registration takes `plan` from the request body again (§4.1b shape)',
    fromExact: '    const { name, email, password } = req.body || {};',
    to: "    const { name, email, password, plan = 'free' } = req.body || {};",
  },
  {
    harness: 'test/auth-contract.js',
    file: 'server.js',
    what: '/auth/forgot looks the address up, so the response can vary',
    fromExact: 'function handleForgot(req, res) {\n  res.status(503).json({',
    to: 'function handleForgot(req, res) {\n  db.getOne(\'SELECT id FROM users WHERE email = $1\', [req.body.email]);\n  res.status(503).json({',
  },
  {
    harness: 'test/auth-contract.js',
    file: 'server.js',
    what: 'the return path accepts an absolute URL (open redirect)',
    fromExact: "  if (!value.startsWith('/') || value.startsWith('//')) return fallback;",
    to: '  if (!value) return fallback;',
  },

  // ── test/ui-contract.js ──────────────────────────────────────────────
  {
    harness: 'test/ui-contract.js',
    file: 'public/privacy.html',
    what: 'a page loses its data-platform and silently renders in M-EasyDo blue',
    fromExact: '<html data-platform="tools"',
    to: '<html',
  },
  {
    harness: 'test/ui-contract.js',
    file: 'public/auth.html',
    what: 'the i18n adapter is removed, making the language switcher a dead control',
    fromExact: '  window.i18n = window.i18n || {',
    to: '  window.__i18n_disabled = window.i18n || {',
  },
  {
    harness: 'test/ui-contract.js',
    file: 'public/locales/ms.json',
    what: 'a Malay translation key goes missing, leaving that row English for ever',
    fromExact: '"submit": "Log Masuk"',
    to: '"submit_TYPO": "Log Masuk"',
  },
];

function runHarness(harness) {
  try {
    execFileSync(process.execPath, [path.join(ROOT, harness)], { cwd: ROOT, stdio: 'pipe' });
    return true;   // exited 0 = green
  } catch (_) {
    return false;  // non-zero = red
  }
}

const harnesses = [...new Set(PLANTS.map((p) => p.harness))];

console.log('\n=== negative control: prove each guard can go red ===\n');

// ── dirty baseline ───────────────────────────────────────────────────────
console.log('  baseline (nothing planted):');
let dirty = false;
for (const h of harnesses) {
  const green = runHarness(h);
  console.log(`    ${green ? '✓' : '✗'} ${h} ${green ? 'green' : 'ALREADY RED'}`);
  if (!green) dirty = true;
}
if (dirty) {
  console.error('\n  ✗ DIRTY BASELINE. A harness is red before anything was planted, so every\n'
    + '    plant below would report CAUGHT while measuring nothing. Fix the tree first.\n');
  process.exit(1);
}

// ── plants ───────────────────────────────────────────────────────────────
let caught = 0, notCaught = [];
console.log('');
for (const plant of PLANTS) {
  const file = rel(plant.file);
  const original = fs.readFileSync(file, 'utf8');
  const anchor = plant.fromExact;
  const hits = original.split(anchor).length - 1;

  if (hits === 0) { notCaught.push(`${plant.what}  [ANCHOR ROTTED — matched 0 times in ${plant.file}]`); continue; }
  if (hits > 1)   { notCaught.push(`${plant.what}  [ANCHOR AMBIGUOUS — matched ${hits}× in ${plant.file}]`); continue; }

  try {
    fs.writeFileSync(file, original.split(anchor).join(plant.to), 'utf8');

    // §7b rule 6. Read it back. A plant that did not land turns a green run
    // into false evidence that the guard is sound.
    const after = fs.readFileSync(file, 'utf8');
    if (after.includes(anchor) || !after.includes(plant.to)) {
      notCaught.push(`${plant.what}  [PLANT DID NOT LAND on disk]`);
      continue;
    }

    const green = runHarness(plant.harness);
    if (green) notCaught.push(`${plant.what}  [MISSED — ${plant.harness} stayed green]`);
    else { caught++; console.log(`  ✓ caught: ${plant.what}`); }
  } finally {
    fs.writeFileSync(file, original, 'utf8');
    const restored = fs.readFileSync(file, 'utf8');
    if (restored !== original) {
      console.error(`  ! FAILED TO RESTORE ${plant.file} — check git status before committing`);
      process.exit(1);
    }
  }
}

console.log('');
notCaught.forEach((n) => console.error('  ✗ NOT CAUGHT: ' + n));
// The denominator is EVERY plant in the list, not every plant that was
// attempted. A rotted anchor is a hole, not an abstention.
console.log(`\n  ${caught}/${PLANTS.length} planted defects caught`);
if (caught !== PLANTS.length) { console.error('\n✗ negative control FAILED\n'); process.exit(1); }
console.log('✓ every guard demonstrably goes red\n');

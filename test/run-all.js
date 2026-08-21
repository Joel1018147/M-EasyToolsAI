/* ═══════════════════════════════════════════════════════════════════════════
   THE SUITE RUNNER
   ───────────────────────────────────────────────────────────────────────────
   Foundation added this to solve a boring problem that would otherwise have
   produced a real one: package.json is a SHARED file, and four of the five
   Round 1 lanes each need to add a test script to it. Four lanes editing one
   file is four merge conflicts, and the tempting fix — one lane adding all
   four entries up front — means `npm test` fails for everybody until the last
   lane lands.

   So the named legacy suites keep their explicit order, and anything a lane
   drops in is DISCOVERED. A lane creates test files and touches nothing
   shared.

   ── WHY THIS IS NOT A TEST THAT CANNOT FAIL ───────────────────────────────
   Discovery has an obvious failure mode: find nothing, run nothing, print a
   green tick. Recurring-bugs #14, and #24's "a check that enumerates its
   subjects". Three things stop that here:

     1. Every legacy suite is named EXPLICITLY and its absence is a failure,
        never a skip. A deleted suite cannot vanish quietly.
     2. Discovery prints what it found AND what it expected to find. A lane
        with no tests is reported by name as MISSING, not omitted.
     3. EXPECTED_LANE_SUITES below is the manifest. A lane that lands without
        its suite is a visible red line in this output, not silence.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

/* Order matters — these run first and in exactly this sequence, because the
   negative controls assume the harnesses they mutate have already passed. */
const LEGACY = [
  'gate3-structure.js',
  'negative-control-gate3.js',
  'auth-guard-test.js',
  'auth-contract.js',
  'ui-contract.js',
  'negative-control-ui.js',
  'fetch-contract.js',
  'gao-contract.js',
  'no-new-fallbacks.js',
  'no-fallbacks-tree.js',
  'generation-extraction.js',
];

/* The manifest. Each lane's suite is expected once that lane has landed;
   until then it is reported MISSING, in orange, rather than passed over. */
const EXPECTED_LANE_SUITES = {
  'mai-boundary-test.js': 'Lane A · M-Ai — registry disjointness (Security Bar)',
  'mai-framework-test.js': 'Lane A · M-Ai — framework and guards',
  'docintel-confirm-test.js': 'Lane B · Document Intelligence (Human-Confirmation Bar)',
  'trilingual-test.js': 'Lane C · Trilingual generation (Localization Bar)',
  'image-contract.js': 'Lane D · Image generation',
  'r2-visual-contract.js': 'Lane E · Visual revamp (Visual Bar)',
};

let failed = 0;
const ran = [];

function run(file) {
  const full = path.join(TEST_DIR, file);
  if (!fs.existsSync(full)) return { file, status: 'absent' };
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  ran.push(file);
  if (r.status !== 0) { failed++; return { file, status: 'fail' }; }
  return { file, status: 'pass' };
}

console.log('\n══ LEGACY SUITES (explicit order, absence is a failure) ══');
const legacyResults = [];
for (const f of LEGACY) {
  const res = run(f);
  if (res.status === 'absent') {
    failed++;
    console.error('\n✗ REQUIRED SUITE MISSING: test/' + f +
      '\n  This file is named explicitly in test/run-all.js. It was not skipped —\n' +
      '  it is gone, and that is a failure, not a clean run.\n');
  }
  legacyResults.push(res);
}

console.log('\n══ ROUND 1 LANE SUITES (discovered) ══');
const laneResults = [];
for (const [f, label] of Object.entries(EXPECTED_LANE_SUITES)) {
  const full = path.join(TEST_DIR, f);
  if (!fs.existsSync(full)) {
    laneResults.push({ file: f, label, status: 'missing' });
    continue;
  }
  const res = run(f);
  laneResults.push({ ...res, label });
}

/* Anything else a lane dropped in that is not on the manifest. Run it — a test
   somebody wrote should not go unrun because a manifest was not updated — but
   NAME it, so the manifest and reality are visibly reconciled. */
const known = new Set([...LEGACY, ...Object.keys(EXPECTED_LANE_SUITES), 'run-all.js']);
const extra = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.js') && !known.has(f))
  .filter((f) => !f.startsWith('mutate-'))   // mutation harnesses are driven by their negative controls
  .filter((f) => fs.statSync(path.join(TEST_DIR, f)).isFile());

if (extra.length) {
  console.log('\n══ UNLISTED SUITES (run anyway, then reported) ══');
  for (const f of extra) run(f);
}

/* ── Summary ───────────────────────────────────────────────────────────────*/
console.log('\n══ SUMMARY ══');
console.log('  legacy suites : ' + legacyResults.filter((r) => r.status === 'pass').length +
            ' passed, ' + legacyResults.filter((r) => r.status === 'fail').length + ' failed, ' +
            legacyResults.filter((r) => r.status === 'absent').length + ' MISSING');

for (const r of laneResults) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '·';
  const note = r.status === 'missing' ? 'NOT WRITTEN YET' : r.status.toUpperCase();
  console.log('  ' + mark + ' ' + note.padEnd(16) + r.label);
}
if (extra.length) console.log('  unlisted suites run: ' + extra.join(', '));

const missing = laneResults.filter((r) => r.status === 'missing');
if (missing.length) {
  console.log('\n  ' + missing.length + ' lane suite(s) not written yet. This run therefore says');
  console.log('  NOTHING about those lanes — it is not evidence they are fine.');
}

console.log('');
if (failed) {
  console.error('✗ ' + failed + ' suite(s) failed\n');
  process.exit(1);
}
console.log('✓ ' + ran.length + ' suite(s) passed\n');

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
  'private-preview-test.js',
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
  'score-cjk-contract.js',

  /* ── WIRED IN AT INTEGRATION, after a check found them orphaned ──────────
     These two are mutation harnesses: they break a guard on purpose and
     assert the suite goes red. The first version of this runner SKIPPED them
     with the comment "mutation harnesses are driven by their negative
     controls".

     That comment was false, and I wrote it. Neither negative control
     references either file — grep returns nothing — and neither did the
     package.json chain they replaced, so both had been orphaned since before
     this round. CLAUDE.md meanwhile cites `test/mutate-fetch.js M7` as live
     evidence that the unchecked-fetch scan catches a deleted `.ok` check.
     That evidence was not running.

     An unrun mutation harness is the worst shape a test can have: it costs
     nothing, it looks like coverage in the file listing, and it is cited in
     documentation as proof of a property nobody is checking. UPGRADE-SPEC §3
     requires every mutation-tested negative control to still fail when its
     guard is broken — that is only true if they execute. */
  'mutate-fetch.js',
  'mutate-gao.js',
  'mutate-social-image.js',
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
  'social-image-contract.js': 'The image option on the Social Media Post tool',
};

let failed = 0;
const ran = [];

/* The mutation harnesses edit real source files and restore them afterwards,
   so they refuse to start on a dirty tree (exit 2) rather than risk restoring
   over somebody's uncommitted work. That refusal is correct and must not be
   turned into a pass — but it also must not fail a run during development,
   or the suite becomes unusable exactly when it is most needed.

   So: on a DIRTY tree the refusal is reported, loudly, as NOT RUN. On a CLEAN
   tree there is no excuse and a refusal is a failure. The merge gate requires
   a clean, fully-committed branch, so at the moment that matters these always
   execute. */
const MUTATION_HARNESSES = new Set(['mutate-fetch.js', 'mutate-gao.js', 'mutate-social-image.js']);
const TREE_BEFORE = (() => {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;   // null = git unreadable, treated as dirty
})();
const TREE_IS_DIRTY = TREE_BEFORE === null ? null : TREE_BEFORE.trim().length > 0;
const skippedMutation = [];

function run(file) {
  const full = path.join(TEST_DIR, file);
  if (!fs.existsSync(full)) return { file, status: 'absent' };
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' });
  ran.push(file);
  if (r.status !== 0) {
    if (MUTATION_HARNESSES.has(file) && r.status === 2 && TREE_IS_DIRTY !== false) {
      ran.pop();
      skippedMutation.push(file);
      return { file, status: 'not-run' };
    }
    failed++;
    return { file, status: 'fail' };
  }
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

/* ── DID A HARNESS LEAVE A MUTATION BEHIND? ───────────────────────────────
   Four suites here edit real source files on purpose and restore them
   afterwards. Two of them (mutate-fetch, mutate-gao) have no `finally` and no
   exit hook, so a crash mid-mutation leaves the mutated file on disk.

   This is not theoretical. During this round's review, two blind critics
   running mutation attacks concurrently left `lib/mai/roles.js` with 'user'
   added to the staff role set, and `lib/mai/registry.js` with an outright
   `if (role === 'user') return true;`. Either one, committed, is every
   customer holding staff access to the AI tool registry.

   The suite catches that mutation if it runs afterwards — proven, it goes red
   with 15 failures. What it could not do before this block is tell you the
   file was left that way by the tests themselves rather than written that way
   on purpose. So: snapshot the tree before, compare after, and NAME anything
   that changed underneath the run. Reported, never auto-reverted — silently
   undoing a developer's real edit would be a worse failure than the one this
   is guarding. */
function treeSnapshot() {
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
if (TREE_BEFORE !== null) {
  const after = treeSnapshot();
  if (after !== null && after !== TREE_BEFORE) {
    const before = new Set(TREE_BEFORE.split('\n').map((l) => l.slice(3)).filter(Boolean));
    const appeared = after.split('\n').map((l) => l.slice(3)).filter(Boolean).filter((f) => !before.has(f));
    if (appeared.length) {
      failed++;
      console.error('\n✗ A TEST LEFT THE WORKING TREE MODIFIED');
      appeared.forEach((f) => console.error('    ' + f));
      console.error('  A mutation harness did not restore. Check these files before doing');
      console.error('  ANYTHING else — a leaked mutant in lib/mai/ is a security hole, and');
      console.error('  a leaked mutant anywhere is a change nobody decided to make.');
      console.error('  Restore with: git checkout -- <file>   (after confirming it is not yours)\n');
    }
  }
}

if (skippedMutation.length) {
  console.log('');
  console.log('  ⚠ MUTATION HARNESSES DID NOT RUN: ' + skippedMutation.join(', '));
  console.log('    They refuse to start on a dirty working tree, because they edit real');
  console.log('    source and restore it afterwards. This run therefore proves NOTHING');
  console.log('    about whether those guards still go red — commit, then re-run.');
  console.log('    The merge gate requires a clean branch, so they cannot be skipped there.');
}

console.log('');
if (failed) {
  console.error('✗ ' + failed + ' suite(s) failed\n');
  process.exit(1);
}
console.log('✓ ' + ran.length + ' suite(s) passed'
  + (skippedMutation.length ? ' · ' + skippedMutation.length + ' mutation harness(es) NOT RUN' : '') + '\n');

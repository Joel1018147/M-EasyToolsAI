'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   GUARD A — RULE 6, the lines this branch added                     (Run 41)
   ───────────────────────────────────────────────────────────────────────────
   HARD FAIL, IN ALL TWELVE REPOS, TODAY.

   Scans only the lines added between the merge-base with `origin/main` and
   the working tree. A banned shape on one of those lines fails the build.
   Everything already in the tree is Guard B's problem, not this file's —
   which is exactly why this one can be armed everywhere on the day it lands
   without turning eleven builds red, and why it works even in a repo whose
   tree is still full of them.

   It describes a shape, names no file, and has no threshold, no baseline and
   no exemption list. There is nothing here to raise, waive or add a path to,
   so it cannot be dissolved one legitimate use at a time
   (recurring-bugs-checklist #13). The only way past it is to not add the
   shape.

   THIS FILE ALSO PROVES GUARD B IS WIRED. It spawns `no-fallbacks-tree.js`
   and asserts on that process's real output — that a report-only run says
   NOT A PASS, and that an armed run does not pretend to be one. An invariant
   about what a program prints has to be checked against what the program
   actually printed (§4).

   `test/lib/no-fallbacks-scan.js`'s header says what these four shapes do NOT
   cover. A green run here means no NEW instance of four mechanical shapes. It
   does not mean the diff respects RULE 6.
   ═══════════════════════════════════════════════════════════════════════════ */

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const scanner = require('./lib/no-fallbacks-scan.js');

const ROOT = path.join(__dirname, '..');
const UPSTREAM = 'origin/main';

let failures = 0;
function fail(msg) { failures += 1; console.error(`  ✗ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }

function git(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/* ── which lines are new ──────────────────────────────────────────────────
   `--unified=0` so there are no context lines to mistake for additions, and
   the diff runs against the WORKING TREE, not HEAD — a shape added and not
   yet committed is still a shape added.

   `git diff` sees TRACKED files only, so a brand-new file that has never been
   `git add`ed produces no diff at all and every line in it would read as
   pre-existing. That is the likeliest way a new violation actually arrives,
   and it is the direction that lets one through, so untracked files are
   folded in below with every line counted as added. Found by watching this
   guard report "0 added lines" while three new files sat in the tree. */
function addedLines(base) {
  const added = new Map();
  const mark = (file, line) => {
    if (!added.has(file)) added.set(file, new Set());
    added.get(file).add(line);
  };

  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=d', base, '--']);
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (!file || !raw.startsWith('+') || raw.startsWith('+++')) continue;
    mark(file, line);
    line += 1;
  }

  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').map((s) => s.trim()).filter(Boolean);
  for (const f of untracked) {
    let count;
    try { count = require('fs').readFileSync(path.join(ROOT, f), 'utf8').split('\n').length; } catch { continue; }
    for (let l = 1; l <= count; l++) mark(f, l);
  }

  return added;
}

console.log('no-new-fallbacks');

/* The scanner must be able to see a violation before its silence means
   anything. This throws rather than returning a count, so a broken scanner
   fails the build here instead of quietly passing every diff forever (#14). */
try {
  ok(`scanner self-test: ${scanner.selfTest()} shape checks`);
} catch (e) {
  console.error(`  ✗ ${e.message}`);
  process.exit(1);
}

const { files, hits } = scanner.scan(ROOT);

/* An empty walk passes vacuously. If the walker is broken every diff is
   clean and this guard is decorative. */
if (files.length < 5) {
  console.error(`  ✗ the walk covered ${files.length} files — a broken walker, not a clean repo`);
  process.exit(1);
}
ok(`walked ${files.length} product files`);

/* ── the merge-base. No merge-base, no verdict, and no verdict is a FAIL ──
   Silently skipping when git is unavailable is the fail-open shape this
   project has independently found three times. */
let base = null;
try {
  git(['rev-parse', '--verify', '--quiet', UPSTREAM]);
  base = git(['merge-base', 'HEAD', UPSTREAM]).trim();
} catch {
  base = null;
}
if (!base) {
  console.error(`\n  FAILED: could not resolve a merge-base with ${UPSTREAM}, so "which lines are`);
  console.error('  new" has no answer and this guard cannot report anything. It fails rather');
  console.error('  than skipping — a check that no-ops when its input is missing is a check');
  console.error('  that has never once said no.\n');
  process.exit(1);
}
ok(`merge-base with ${UPSTREAM}: ${base.slice(0, 8)}`);

const added = addedLines(base);
const addedCount = [...added.values()].reduce((n, s) => n + s.size, 0);
ok(`${addedCount} added line(s) across ${added.size} file(s) since that merge-base`);

/* A hit counts as new when ANY line of it was added — a two-line
   `catch (e) {` / `}` pair is added by whichever half moved. */
const offences = hits.filter((h) => {
  const lines = added.get(h.file);
  if (!lines) return false;
  for (let l = h.line; l <= h.endLine; l++) if (lines.has(l)) return true;
  return false;
});

if (offences.length) {
  console.error(`\n  ✗ ${offences.length} banned shape(s) on lines this branch added:\n`);
  for (const h of offences) console.error(`      ${scanner.format(h)}`);
  console.error('\n  RULE 6: if something does not work, let it not work. Throw, or return a');
  console.error('  value the caller cannot mistake for a real answer. A substitute that looks');
  console.error('  like success is found weeks later by a customer instead of minutes later');
  console.error('  by us. If the logic was never written, throw Error("unimplemented: …") —');
  console.error('  that is a debt with an address (RULE 6a).\n');
  failures += 1;
} else {
  ok('no banned shape on any added line');
}

/* ── Guard B is wired, and says what it is supposed to say ────────────────
   Asserted against the real process output, not against the exit code (§4).
   This is also the check that Guard B exists and runs at all in this repo. */
const b = spawnSync(process.execPath, [path.join(__dirname, 'no-fallbacks-tree.js')], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const bOut = `${b.stdout || ''}${b.stderr || ''}`;
if (b.status === null) {
  fail(`no-fallbacks-tree.js did not run: ${b.error && b.error.message}`);
} else if (/NOT A PASS/.test(bOut)) {
  if (b.status !== 0) fail('the whole-tree guard printed NOT A PASS but also exited non-zero — report-only must not fail the build');
  else if (!/REPORT-ONLY/.test(bOut)) fail('the whole-tree guard printed NOT A PASS without saying it is report-only');
  else ok('the whole-tree guard runs, is in report-only mode, and says NOT A PASS');
} else if (b.status === 0) {
  ok('the whole-tree guard runs and reports this tree clean');
} else {
  ok('the whole-tree guard runs and is ARMED — it failed on a regression');
}

console.log(failures ? `\nno-new-fallbacks: ${failures} failure(s)\n` : '\nno-new-fallbacks: clean\n');
process.exit(failures ? 1 : 0);

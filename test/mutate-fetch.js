'use strict';
/* Mutation harness for fetch-contract.js                          (Run 29)
 *
 * Breaks the thing each invariant protects, watches the suite go red, restores
 * from a byte backup, verifies the md5, watches it go green again. NEVER
 * `git checkout` (Run 22). Not registered in `npm test` — it rewrites source.
 *
 * RED is judged on a non-zero EXIT, not a parsed fail count: Run 27's harness
 * scored three genuine kills as survivors because they abort the suite before
 * it prints a score. Anchors are matched \r?\n-agnostically: Run 28 lost a
 * mutation to a CRLF file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const SELLER = path.join(APP, 'public/seller.html');
const CONTENT = path.join(APP, 'public/content.html');
const SERVER = path.join(APP, 'server.js');
const SUITE = path.join(__dirname, 'fetch-contract.js');

const TARGETS = [SELLER, CONTENT, SERVER];
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backup = (f) => `${f}.run29.bak`;

{
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...TARGETS],
    { encoding: 'utf8', cwd: APP }).stdout.trim();
  if (dirty) {
    console.error('Refusing to run: these files have uncommitted changes.\n' + dirty);
    process.exit(2);
  }
}

const ORIGINAL = {};
for (const f of TARGETS) { fs.copyFileSync(f, backup(f)); ORIGINAL[f] = md5(f); }

function restore() {
  for (const f of TARGETS) {
    fs.copyFileSync(backup(f), f);
    if (md5(f) !== ORIGINAL[f]) throw new Error(`RESTORE FAILED for ${path.basename(f)} — md5 drift`);
  }
}
function run() {
  const r = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', cwd: APP });
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || '');
  return {
    exit: r.status,
    pass: m ? +m[1] : NaN,
    fail: m ? +m[2] : NaN,
    named: (r.stdout || '').split('\n').filter((l) => l.startsWith('  ❌'))
      .map((l) => l.replace(/^ {2}❌ /, '').slice(0, 74)),
  };
}
function mutate(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  if (s.includes(find)) { fs.writeFileSync(file, s.replace(find, replace)); return; }
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
  if (!re.test(s)) throw new Error(`ANCHOR MISS in ${path.basename(file)}: ${find.slice(0, 60)}`);
  fs.writeFileSync(file, s.replace(re, replace.replace(/\$/g, '$$$$')));
}

const MUTATIONS = [
  ['M1  apiFetch stops checking res.ok (the original bug, restored)', () =>
    mutate(SELLER, '  if (!res.ok) {', '  if (false) {')],

  ['M2  apiFetch throws without the status, so the operator cannot act', () =>
    mutate(SELLER,
      "    throw new Error(`Request failed (${res.status})` + (detail ? ` — ${String(detail).slice(0, 200)}` : ''));",
      "    throw new Error('Something went wrong');")],

  ['M3  the success toast moves outside the try, firing on failure too', () =>
    mutate(SELLER,
      "    showToast('✅ Subscription activated for 365 days');\n    loadSubStats();",
      "    loadSubStats();")],

  ['M4  loadSubStats swallows again — the RM0.00 tile comes back', () =>
    mutate(SELLER,
      "    document.getElementById('sub-stat-revenue').textContent = '—';",
      "    document.getElementById('sub-stat-revenue').textContent = 'RM0.00';")],

  ['M5  a failed write triggers the success-path reloads anyway', () =>
    mutate(SELLER,
      "} catch(e) { showToast('❌ Failed to activate subscription — ' + e.message); }",
      "} catch(e) { loadSubStats(); showToast('❌ Failed to activate subscription — ' + e.message); }")],

  ['M6  server.js stops distinguishing a revoked token from an empty catalogue', () =>
    mutate(SERVER, '    if (!response.ok) {\n      const raw = await response.text();', '    if (false) {\n      const raw = await response.text();')],

  ['M7  content.html toasts "Saved ✓" on a rejected save again', () =>
    mutate(CONTENT, "    if(!r.ok){", "    if(false){")],

  // The realistic bad-faith move, not the naive one. Raising the ceiling on its
  // own is harmless — the harm is raising it TO ACCOMMODATE a new violation, so
  // the mutation does both. The first version of this harness only bumped the
  // number, and it survived, correctly: nothing had regressed.
  ['M8  a new unchecked fetch is added AND the ratchet raised to cover it', () => {
    mutate(SELLER, '  const res = await fetch(url + sep', "  await fetch('/api/seller/ping');\n  const res = await fetch(url + sep");
    mutate(path.join(__dirname, 'fetch-contract.js'), 'const MAX_UNCHECKED = 36;', 'const MAX_UNCHECKED = 999;');
  }],
];

// M8 edits the suite itself, so it needs its own backup slot.
const SUITE_BAK = `${SUITE}.run29.bak`;
fs.copyFileSync(SUITE, SUITE_BAK);
const SUITE_MD5 = md5(SUITE);
const restoreAll = () => {
  restore();
  fs.copyFileSync(SUITE_BAK, SUITE);
  if (md5(SUITE) !== SUITE_MD5) throw new Error('RESTORE FAILED for fetch-contract.js');
};

console.log('Baseline (unmutated):');
const base = run();
console.log(`  ${base.pass} passed, ${base.fail} failed, exit ${base.exit}\n`);
if (base.exit !== 0) { console.error('Baseline is not green — aborting.'); restoreAll(); process.exit(1); }

const survived = [];
for (const [name, apply] of MUTATIONS) {
  restoreAll();
  try { apply(); } catch (e) { console.log(`  ${name}\n    ANCHOR ERROR: ${e.message}`); survived.push(name); continue; }
  const red = run();
  restoreAll();
  const green = run();
  const verdict = red.exit !== 0
    ? `RED ${Number.isNaN(red.pass) ? 'aborted' : `${red.pass}/${red.fail}`}, exit ${red.exit}`
    : '*** SURVIVED ***';
  if (red.exit === 0) survived.push(name);
  console.log(`  ${name}`);
  console.log(`    ${verdict}`);
  if (red.named.length) console.log(`    named: ${red.named.slice(0, 3).join(' | ')}`);
  console.log(`    restored: ${green.pass} passed, ${green.fail} failed`);
}

restoreAll();
for (const f of TARGETS) fs.unlinkSync(backup(f));
fs.unlinkSync(SUITE_BAK);
console.log('\nBackups removed; all four files verified byte-identical to the originals.');
console.log(survived.length ? `\n${survived.length} MUTATION(S) NOT CAUGHT:\n  ${survived.join('\n  ')}` : '\nAll mutations caught.');
process.exit(survived.length ? 1 : 0);

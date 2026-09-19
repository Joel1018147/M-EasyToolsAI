/* ═══════════════════════════════════════════════════════════════════════════
   MUTATION HARNESS — the device-frame contract, broken one way at a time
   ───────────────────────────────────────────────────────────────────────────
   test/device-frame-contract.js was written alongside the thing it guards, so
   all twenty-six of its checks were green from the moment it existed. A guard
   that has only ever seen the passing case has no evidence it can report a
   failure. This breaks each protected thing, on the real files, and requires
   the suite to go red.

   THE MUTATIONS ARE NOT HYPOTHETICAL. Three of them are defects that were
   actually in this tree during the work that produced it:

     M3  the harness writes an inset from the wrong edge — the transposition
         that `rotateSafe` exists to prevent, and the one that produces a real
         layout that no device has ever rendered
     M5  the bar keeps the master's fixed 60px height, so the padding is
         absorbed instead of growing it — shipped exactly this way for an hour
     M9  visibility read off the element instead of through its ancestors —
         the live defect that reported four undersized controls inside a chat
         panel that was closed

   Each is aimed at ONE check so a kill names which check did the killing. A
   mutation that reddens the suite for some other reason has proved nothing
   about the check it was aimed at.

   ── IT REFUSES TO RUN ON A DIRTY TREE ─────────────────────────────────────
   Same arrangement as the other five harnesses here: it edits real source
   files and restores them from a byte-for-byte backup, checked by md5, and
   exits 2 on a dirty tree so run-all reports NOT RUN rather than a pass.

   `MUTATE_ALLOW_DIRTY=1` waives the tree check and nothing else — the md5
   restore still runs and still throws on drift, which is what actually
   protects the files. It exists so this harness can be exercised BEFORE the
   change it guards is committed, which is the one moment its verdict is worth
   most and the one moment the tree cannot be clean. run-all never sets it.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const CSS = path.join(APP, 'public/css/tools-mobile.css');
const FRAME = path.join(APP, 'public/preview.html');
const SERVER = path.join(APP, 'server.js');
const SETTINGS = path.join(APP, 'public/settings.html');
const BILLING = path.join(APP, 'public/billing.html');
const AUTH = path.join(APP, 'public/auth.html');

const SUITE = path.join(__dirname, 'device-frame-contract.js');

const TARGETS = [CSS, FRAME, SERVER, SETTINGS, BILLING, AUTH];
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backup = (f) => `${f}.mutframe.bak`;

if (process.env.MUTATE_ALLOW_DIRTY !== '1') {
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...TARGETS],
    { encoding: 'utf8', cwd: APP }).stdout.trim();
  if (dirty) {
    console.error('Refusing to run: these files have uncommitted changes.\n' + dirty);
    console.error('\nSet MUTATE_ALLOW_DIRTY=1 to waive the tree check. The md5-verified');
    console.error('restore still runs and still throws on drift.');
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
function cleanup() {
  restore();
  for (const f of TARGETS) { try { fs.unlinkSync(backup(f)); } catch (e) { /* already gone */ } }
}

function run() {
  const r = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', cwd: APP });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /device-frame-contract: (\d+) passed, (\d+) failed/.exec(out);
  const named = out.split('\n').filter((l) => l.includes('❌')).map((l) => l.trim());
  return { exit: r.status, passed: m ? +m[1] : NaN, failed: m ? +m[2] : NaN, named };
}

/* An anchor miss THROWS. A mutation that quietly fails to apply is a mutation
   the harness then reports as caught by a suite that never saw it. */
function mutate(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  const n = s.split(find).length - 1;
  if (n !== 1) {
    throw new Error(`ANCHOR ${n === 0 ? 'MISS' : 'AMBIGUOUS (' + n + 'x)'} in `
      + `${path.basename(file)}: ${find.slice(0, 70)}`);
  }
  fs.writeFileSync(file, s.replace(find, () => replace));
}

function mutateAll(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  if (!s.includes(find)) throw new Error(`ANCHOR MISS in ${path.basename(file)}: ${find.slice(0, 70)}`);
  fs.writeFileSync(file, s.split(find).join(replace));
}

const MUTATIONS = [
  ['M1  transpose the stylesheet mapping — bottom reads the TOP inset', () =>
    mutate(CSS, '--tmob-sab: env(safe-area-inset-bottom, 0px);',
                '--tmob-sab: env(safe-area-inset-top, 0px);')],

  ['M2  rename a property in the stylesheet, so the frame writes into nothing', () =>
    mutateAll(CSS, '--tmob-sab', '--tmob-sabottom')],

  ['M3  transpose the frame mapping — the bottom property gets the top number', () =>
    mutate(FRAME, "put('--tmob-sab', safe.b);", "put('--tmob-sab', safe.t);")],

  ['M4  drop the bottom inset off the fixed bar', () =>
    mutate(CSS, '    padding-bottom: var(--tmob-sab);\n    padding-left: var(--tmob-sal);',
                '    padding-left: var(--tmob-sal);')],

  ['M5  keep the master’s fixed height, so the padding is absorbed not added', () =>
    mutate(CSS, '    height: auto;\n    min-height: 60px;', '    height: 60px;')],

  ['M6  scope the inset block to a phone width, losing landscape side insets', () =>
    mutate(CSS, '@supports (padding: env(safe-area-inset-top)) {',
                '@media (max-width: 768px) {\n@supports (padding: env(safe-area-inset-top)) {')],

  ['M7  unmount the device frame', () =>
    mutate(SERVER, "app.get('/preview',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'preview.html')));",
                   '')],

  ['M8  stop opting into the hardware area, making the whole layer dead code', () => {
    mutate(SETTINGS, 'width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1');
    mutate(BILLING, 'width=device-width, initial-scale=1.0, viewport-fit=cover', 'width=device-width, initial-scale=1.0');
    mutate(AUTH, 'width=device-width, initial-scale=1, viewport-fit=cover', 'width=device-width, initial-scale=1');
  }],

  ['M9  read visibility off the element instead of through its ancestors', () =>
    mutate(FRAME, "if (typeof n.checkVisibility === 'function') {",
                  "if (false) {")],

  ['M10 let the clearance behind the bar stop tracking the bar’s height', () =>
    mutate(CSS, '    padding-bottom: calc(72px + var(--tmob-sab, 0px));',
                '    padding-bottom: 72px;')],

  /* BOTH SPELLINGS. The first version replaced only `var(--tmob-sal)` and left
     every `var(--tmob-sal, 0px)` standing, so the property was still consumed,
     the check correctly stayed green, and the harness reported a SURVIVING
     mutation for a defect it had never actually created. A plant that does not
     plant anything is worse than no plant: it reads as a hole in the guard and
     sends you to weaken a check that was right. */
  ['M11 define an inset property that nothing reads', () => {
    mutateAll(CSS, 'var(--tmob-sal, 0px)', '0px');
    mutateAll(CSS, 'var(--tmob-sal)', '0px');
  }],

  ['M12 let the frame write insets into a page that never asked for them', () =>
    mutate(FRAME, '    if (cover && px) de.style.setProperty(prop, px + \'px\');',
                  '    if (px) de.style.setProperty(prop, px + \'px\');')],

  ['M13 let the device frame be indexed as if it were part of the product', () =>
    mutate(FRAME, '<meta name="robots" content="noindex, nofollow">', '')],

  ['M14 scale the screen box instead of sizing it in CSS pixels', () =>
    mutate(FRAME, "  el.screen.style.width  = state.w + 'px';",
                  "  el.screen.style.width  = '390px';")],
];

console.log('\n══ MUTATION HARNESS · the device-frame contract ══\n');

const base = run();
if (base.exit !== 0) {
  console.error('BASELINE IS NOT GREEN — every kill below would be meaningless.');
  console.error(base.named.join('\n'));
  cleanup();
  process.exit(1);
}
console.log(`baseline: device-frame-contract.js green, ${base.passed} checks\n`);

let caught = 0, survived = 0;
for (const [label, apply] of MUTATIONS) {
  restore();
  try {
    apply();
  } catch (err) {
    console.log(`  ⚠ ${label}\n      ${err.message}`);
    survived++;
    continue;
  }
  const r = run();
  if (r.exit !== 0 && r.failed > 0) {
    caught++;
    console.log(`  ✓ ${label}\n      killed by: ${r.named[0] || '(unnamed)'}`);
  } else {
    survived++;
    console.log(`  ❌ ${label}\n      SURVIVED — the suite stayed green with this broken`);
  }
}

cleanup();

console.log(`\nmutate-device-frame: ${caught} caught, ${survived} survived`);
if (survived) {
  console.log('A surviving mutation is a check that does not exist. Either add it,');
  console.log('or delete the rule it was supposed to be protecting.');
}
process.exit(survived ? 1 : 0);

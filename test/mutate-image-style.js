/* ═══════════════════════════════════════════════════════════════════════════
   MUTATION HARNESS — the style picker's guards, broken one at a time
   ───────────────────────────────────────────────────────────────────────────
   test/image-contract.js §7b grew 70 checks the day the style picker landed.
   Seventy green ticks is not evidence of anything on its own: a check that
   iterates a catalogue can go quiet by the catalogue going empty, a check on
   `hasOwnProperty('phrase')` passes on a payload whose every phrase is null,
   and a substring scan over a source file passes on a file it failed to read.
   Each of those is a check that CANNOT FAIL, and each is what §7b would look
   like if it had been written carelessly.

   So every guard §7b adds is broken here, on the real files, and the suite
   must go red for it. A mutation that SURVIVES is a guard that was decoration.

   ── WHAT THE MUTATIONS ARE AIMED AT ───────────────────────────────────────
   Not "does the code still work" — the suite covers that. These are aimed at
   the four properties the feature is only allowed to exist under:

     the prompt is UNCHANGED unless a kind was named   (M3, M4)
     what is appended is EXACTLY what was published    (M1, M5, M8)
     an unknown kind is refused, not ignored           (M2)
     what was sent is what is stored                   (M6, M7)

   ── IT REFUSES TO RUN ON A DIRTY TREE ─────────────────────────────────────
   It edits real source files and restores them from a byte-for-byte backup,
   checked by md5. Exit 2 on a dirty tree, which test/run-all.js reports as
   NOT RUN rather than as a pass — the same arrangement mutate-social-image.js
   has, for the same reason.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const STYLES = path.join(APP, 'lib/image/styles.js');
const INDEX = path.join(APP, 'lib/image/index.js');
const DASH = path.join(APP, 'lib/image/providers/dashscope.js');
const IGEN = path.join(APP, 'public/js/imagegen.js');
const SUITE = path.join(__dirname, 'image-contract.js');

const TARGETS = [STYLES, INDEX, DASH, IGEN];
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backup = (f) => `${f}.mutstyle.bak`;

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
function cleanup() {
  restore();
  for (const f of TARGETS) { try { fs.unlinkSync(backup(f)); } catch (e) { /* already gone */ } }
}

function run() {
  const r = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', cwd: APP });
  const m = /(\d+) checks passed/.exec(r.stdout || '');
  const named = (r.stdout || '').split('\n').filter((l) => l.includes('✗')).map((l) => l.trim());
  return { exit: r.status, checks: m ? +m[1] : NaN, named };
}

/* An anchor miss THROWS. A mutation that quietly fails to apply is a mutation
   the harness then reports as caught by a suite that never saw it. */
function mutate(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  const n = s.split(find).length - 1;
  if (n !== 1) {
    throw new Error(`ANCHOR ${n === 0 ? 'MISS' : 'AMBIGUOUS (' + n + 'x)'} in `
      + `${path.basename(file)}: ${find.slice(0, 64)}`);
  }
  fs.writeFileSync(file, s.replace(find, () => replace));
}

const MUTATIONS = [
  ['M1  swallow the chosen kind — accept the pick, append nothing', () =>
    mutate(STYLES, '  if (!r.phrase) {', '  if (true) {')],

  ['M2  accept a style ref this platform does not have', () =>
    mutate(STYLES, 'if (!Object.prototype.hasOwnProperty.call(STYLES, ref)) {', 'if (false) {')],

  ['M3  give the add-nothing default a phrase of its own', () =>
    mutate(STYLES, "    summary: 'Nothing is added. The model gets only what you typed.',\n    phrase: null,",
                   "    summary: 'Nothing is added. The model gets only what you typed.',\n    phrase: 'Style: a photograph.',")],

  ['M4  append the house style to every request, named or not', () =>
    mutate(INDEX, 'const styled = styles.compose({ prompt: rawPrompt, styleRef: body.style });',
                  "const styled = styles.compose({ prompt: rawPrompt, styleRef: body.style || 'photo' });")],

  ['M5  stop publishing the phrases, keep publishing the labels', () =>
    mutate(STYLES, 'return { ref: s.ref, label: s.label, summary: s.summary, phrase: s.phrase };',
                   'return { ref: s.ref, label: s.label, summary: s.summary, phrase: null };')],

  ['M6  store the raw prompt while sending the composed one', () =>
    mutate(INDEX, '        prompt: composed.prompt,\n', '        prompt: rawPrompt,\n')],

  ['M7  stop recording WHICH kind shaped the image', () =>
    mutate(INDEX, '        style: styled.styleRef,', '        style: null,')],

  ['M8  hard-code a catalogue label into the client', () =>
    mutate(IGEN, "el('option', null, 'Default — nothing added')", "el('option', null, 'Watercolour')")],

  ['M9  drop the visible negative prompt on the way to the provider', () =>
    mutate(DASH, "if (typeof negativePrompt === 'string' && negativePrompt.trim() !== '') {",
                 'if (false) {')],
];

console.log('── baseline ' + '─'.repeat(52));
const base = run();
console.log(`    ${base.checks} checks, exit ${base.exit}`);
if (base.exit !== 0) { console.error('Baseline is not green — aborting.'); cleanup(); process.exit(1); }

console.log('\n── mutations ' + '─'.repeat(51));
let survived = 0;
for (const [label, apply] of MUTATIONS) {
  try {
    apply();
  } catch (e) {
    restore();
    console.error(`  ✗ ${label}\n      ${e.message}`);
    survived++;
    continue;
  }
  const r = run();
  restore();
  if (r.exit === 0) { survived++; console.log(`  ✗ SURVIVED  ${label}`); }
  else {
    console.log(`  ✓ caught    ${label}`);
    console.log(`                ${r.named.length ? r.named.slice(0, 2).join(' · ') : 'suite aborted (a kill, not a survivor)'}`);
  }
}

console.log('\n── restored ' + '─'.repeat(52));
const green = run();
console.log(`    ${green.checks} checks, exit ${green.exit}`);
cleanup();

if (survived || green.exit !== 0) {
  console.error(`\n✗ ${survived} mutation(s) survived`
    + (green.exit !== 0 ? ' and the tree did not come back green' : ''));
  process.exit(1);
}
console.log(`\n✓ all ${MUTATIONS.length} mutations caught, and the restored tree is green`);

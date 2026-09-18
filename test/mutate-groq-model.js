/* ═══════════════════════════════════════════════════════════════════════════
   MUTATION HARNESS — the Groq model contract, broken one way at a time
   ───────────────────────────────────────────────────────────────────────────
   test/groq-model-contract.js was written the day the model constant rolled,
   so every one of its checks was green from the moment it existed. A guard
   that has only ever seen the passing case has no evidence it can report a
   failure — test-harness-integrity-audit.md's one MUST. This breaks each thing
   it protects, on the real files, and requires the suite to go red.

   The eight mutations are not "does Groq still answer". They are the eight
   ways this contract has rotted or could rot, and they are aimed one at a
   time so a kill names which check did the killing:

     the default rolls onto a name that is dead        (M1)
     the reasoning gate re-pins to one minor version   (M2)  ← the live defect
     the reasoning gate widens to everything           (M3)
     a dead name leaves DEPRECATED_MODELS              (M4)
     dead names stop being remapped at all             (M5)
     the env template offers a dead model              (M6)
     the API docs publish a dead model                 (M7)
     a dead model gets hardcoded back into code        (M8)

   M2 is the reason this file exists. Between rolling the constant to 3.8 and
   widening `supportsReasoningEffortNone`, this repo really was in that state:
   the params silently stopped being sent, nothing errored, and the only thing
   that would ever have noticed is the check M2 attacks.

   ── IT REFUSES TO RUN ON A DIRTY TREE ─────────────────────────────────────
   It edits real source files and restores them from a byte-for-byte backup,
   checked by md5. Exit 2 on a dirty tree, which test/run-all.js reports as
   NOT RUN rather than as a pass — the same arrangement the other four
   harnesses here have, for the same reason.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const GROQ = path.join(APP, 'helpers/groq.js');
const ENV_EXAMPLE = path.join(APP, '.env.example');
const API_DOCS = path.join(APP, 'public/api-docs.html');
const DOCINTEL = path.join(APP, 'routes/docIntel.js');

const SUITE = path.join(__dirname, 'groq-model-contract.js');

const TARGETS = [GROQ, ENV_EXAMPLE, API_DOCS, DOCINTEL];
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backup = (f) => `${f}.mutgroq.bak`;

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
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /(\d+) checks, (\d+) failure/.exec(out);
  const named = out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim());
  return { exit: r.status, checks: m ? +m[1] : NaN, failures: m ? +m[2] : NaN, named };
}

/* An anchor miss THROWS. A mutation that quietly fails to apply is a mutation
   the harness then reports as caught by a suite that never saw it
   (recurring-bugs #30). */
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
  ['M1  roll the default onto a model that is already dead', () =>
    mutate(GROQ, "const DEFAULT_GROQ_MODEL = 'qwen/qwen3.8-27b';",
                 "const DEFAULT_GROQ_MODEL = 'qwen/qwen3.6-27b';")],

  ['M2  re-pin the reasoning gate to ONE minor version (the live defect)', () =>
    mutate(GROQ, 'return /^qwen\\/qwen3\\./.test(model);',
                 'return /^qwen\\/qwen3\\.8/.test(model);')],

  ['M3  widen the reasoning gate to every model', () =>
    mutate(GROQ, 'return /^qwen\\/qwen3\\./.test(model);',
                 'return true;')],

  ['M4  quietly drop a dead name out of DEPRECATED_MODELS', () =>
    mutate(GROQ, "  'qwen/qwen3.6-27b',\n]);", ']);')],

  ['M5  forward dead model names to Groq instead of remapping them', () =>
    mutate(GROQ, 'if (!requested || DEPRECATED_MODELS.has(requested)) return GROQ_MODEL;',
                 'if (!requested) return GROQ_MODEL;')],

  ['M6  point the env template at the dead model', () =>
    mutate(ENV_EXAMPLE, 'GROQ_MODEL=qwen/qwen3.8-27b', 'GROQ_MODEL=qwen/qwen3.6-27b')],

  ['M7  publish the dead model to external integrators', () =>
    mutate(API_DOCS, 'Groq model ID. Default: qwen/qwen3.8-27b',
                     'Groq model ID. Default: qwen/qwen3.6-27b')],

  ['M8  hardcode a dead model back into executable code', () =>
    mutate(DOCINTEL, '      model: GROQ_MODEL,', "      model: 'qwen/qwen3.6-27b',")],
];

/* ── Baseline ──────────────────────────────────────────────────────────────*/
console.log('\n══ MUTATION HARNESS · the Groq model contract ══\n');

const base = run();
if (base.exit !== 0) {
  console.error('BASELINE IS NOT GREEN — every kill below would be meaningless.');
  console.error(base.named.join('\n'));
  cleanup();
  process.exit(1);
}
console.log(`baseline: groq-model-contract.js green, ${base.checks} checks\n`);

/* ── The mutations ─────────────────────────────────────────────────────────*/
let caught = 0;
let survived = 0;

for (const [label, apply] of MUTATIONS) {
  restore();
  try {
    apply();
  } catch (err) {
    console.error(`  ✗ ${label}\n      ${err.message}`);
    survived += 1;   // an unapplied plant counts as NOT CAUGHT, never as a skip
    continue;
  }
  const res = run();
  if (res.exit !== 0) {
    caught += 1;
    const why = res.named[0] ? res.named[0].replace(/^✗\s*/, '').slice(0, 96) : '(unnamed)';
    console.log(`  ✓ CAUGHT   ${label}\n             └─ ${why}`);
  } else {
    survived += 1;
    console.error(`  ✗ SURVIVED ${label}\n             └─ the suite stayed green; that check is decoration`);
  }
}

cleanup();

console.log(`\n${caught} caught, ${survived} survived, ${MUTATIONS.length} planted`);
if (survived) {
  console.error('✗ AT LEAST ONE GUARD IN groq-model-contract.js CANNOT REPORT A FAILURE\n');
  process.exit(1);
}
console.log('✓ every guard in groq-model-contract.js has now been seen to fail and recover\n');

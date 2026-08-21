'use strict';
/* Mutation harness for social-image-contract.js
 *
 * A suite that cannot fail is not coverage. This breaks each thing that suite
 * claims to protect, watches it go red, restores from a byte backup, verifies
 * the md5, and watches it go green again. NEVER `git checkout` — a harness
 * that restores by reaching for git will one day restore over somebody's
 * uncommitted work.
 *
 * RED is judged on a NON-ZERO EXIT, not on a parsed fail count: a mutation
 * that makes the suite throw before it prints a score is a kill, and reading
 * the score would record it as a survivor.
 *
 * Two of these mutations were survivors on the first run and both were the
 * harness's fault rather than the product's, which is the whole argument for
 * this file existing:
 *
 *   M5 — the fake DOM kept the children an innerHTML assignment should have
 *        destroyed, so a stale image painted OVER a newer one was still
 *        findable underneath it and the guard looked alive with the guard
 *        deleted.
 *   M8 — the suite asserted the option was INERT on other tools rather than
 *        ABSENT from them, so building it everywhere changed nothing it read.
 *
 * A third, an attempt to bolt a hidden negative prompt onto the page's request
 * object, is genuinely inert: ImageGen.generate() builds its body from an
 * allowlist of three fields, so an extra key on the page never reaches the
 * wire. M2 is therefore aimed at the wire itself, which is where the invariant
 * actually lives.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const PAGE = path.join(APP, 'public/social.html');
const IGEN = path.join(APP, 'public/js/imagegen.js');
const SUITE = path.join(__dirname, 'social-image-contract.js');

const TARGETS = [PAGE, IGEN];
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const backup = (f) => `${f}.mutimg.bak`;

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
  const m = /(\d+) checks, (\d+) failure/.exec(r.stdout || '');
  return {
    exit: r.status,
    checks: m ? +m[1] : NaN,
    fail: m ? +m[2] : NaN,
    named: (r.stdout || '').split('\n').filter((l) => l.startsWith('  ❌'))
      .map((l) => l.replace(/^ {2}❌ /, '').slice(0, 74)),
  };
}

/* An anchor miss THROWS. A mutation that quietly fails to apply is a mutation
   the harness then reports as caught by a suite that never saw it. */
function mutate(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`ANCHOR ${n === 0 ? 'MISS' : 'AMBIGUOUS (' + n + 'x)'} in ${path.basename(file)}: ${find.slice(0, 64)}`);
  fs.writeFileSync(file, s.replace(find, () => replace));
}

const MUTATIONS = [
  ['M1  send the derived description instead of the one on screen', () =>
    mutate(PAGE, "prompt:(document.getElementById('ff-image-prompt')?.value||'').trim(),",
                 'prompt:derivedImagePrompt(),')],

  ['M2  bolt a negative prompt onto the wire, behind the user', () =>
    mutate(IGEN, 'if (r.size) body.size = r.size;',
                 "if (r.size) body.size = r.size; body.negative_prompt = 'text, watermark';")],

  ['M3  replace the API\'s own reason with a generic apology', () =>
    mutate(IGEN, 'if (d.message) return d.message;',
                 "if (d.message) return 'Something went wrong.';")],

  ['M4  restore the empty state over an image that is on its way', () =>
    mutate(PAGE, "if(!img)document.getElementById('out-empty').style.display='flex';",
                 "document.getElementById('out-empty').style.display='flex';")],

  ['M5  drop the stale-response token guard', () =>
    mutate(PAGE, 'if(token!==imgRun)return;\n    if(res.ok)paintImage',
                 'if(false)return;\n    if(res.ok)paintImage')],

  ['M6  offer an aspect lib/image/sizes.js rejects', () =>
    mutate(PAGE, "'Instagram':'1328*1328',", "'Instagram':'1024*1024',")],

  ['M7  spend a generation on an empty description', () =>
    mutate(PAGE, 'if(!req.prompt){paintImageError(', 'if(false){paintImageError(')],

  ['M8  offer the image option on every tool on the page', () =>
    mutate(PAGE, 'if(id===IMAGE_TOOL)buildImageSection(c);', 'buildImageSection(c);')],

  ['M9  render a row that holds no bytes as an image', () =>
    mutate(IGEN, "if (img.status !== 'stored' || !img.url) {", 'if (false) {')],

  ['M10 ignore the aspect the chosen platform implies', () =>
    mutate(PAGE, 'if(want&&[...sel.options].some(o=>o.value===want))sel.value=want;', '')],

  ['M11 offer the drop-in panel alongside the in-form option', () =>
    mutate(PAGE, 'if(igHost)igHost.hidden=(id===IMAGE_TOOL);', 'if(igHost)igHost.hidden=false;')],

  ['M12 stop asking whether the deployment is configured', () =>
    mutate(IGEN, 'if (r.data.configured === false) {', 'if (false) {')],

  ['M13 flatten a billing refusal into "unavailable right now"', () =>
    mutate(IGEN, ': (r.data && r.data.message) ? r.data.message',
                 ': (false) ? r.data.message')],
];

console.log('── baseline ' + '─'.repeat(52));
const base = run();
console.log(`    ${base.checks} checks, ${base.fail} failure(s), exit ${base.exit}`);
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
  if (r.exit === 0) {
    survived++;
    console.log(`  ✗ SURVIVED  ${label}`);
  } else {
    console.log(`  ✓ caught    ${label}`);
    console.log(`                ${r.named.length ? r.named.slice(0, 2).join(' · ') : 'suite aborted (a kill, not a survivor)'}`);
  }
}

console.log('\n── restored ' + '─'.repeat(52));
const green = run();
console.log(`    ${green.checks} checks, ${green.fail} failure(s), exit ${green.exit}`);
cleanup();

if (survived || green.exit !== 0) {
  console.error(`\n✗ ${survived} mutation(s) survived` + (green.exit !== 0 ? ' and the tree did not come back green' : ''));
  process.exit(1);
}
console.log(`\n✓ all ${MUTATIONS.length} mutations caught, and the restored tree is green`);

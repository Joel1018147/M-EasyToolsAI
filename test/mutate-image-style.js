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
const NANOBANANA = path.join(APP, 'lib/image/providers/nanobanana.js');
const IGEN = path.join(APP, 'public/js/imagegen.js');
const POST = path.join(APP, 'public/js/postimage.js');
/* THREE suites, because the feature has three surfaces and each can be broken
   without the others noticing. The server can append exactly the right
   sentence while the panel prints a different one; the panel can be perfect
   while the Social Post tool writes art direction nobody chose into an
   editable box. Every mutation below names which suite is supposed to catch
   it, and all three must be green at baseline. */
const SERVER_SUITE = path.join(__dirname, 'image-contract.js');
const PANEL_SUITE = path.join(__dirname, 'imagegen-panel-contract.js');
const SOCIAL_SUITE = path.join(__dirname, 'social-image-contract.js');

const TARGETS = [STYLES, INDEX, DASH, NANOBANANA, IGEN, POST];
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

function run(suite) {
  const r = spawnSync(process.execPath, [suite || SERVER_SUITE], { encoding: 'utf8', cwd: APP });
  /* BOTH streams. image-contract.js prints its passes to stdout and its
     FAILURES to stderr, so a harness reading stdout alone sees a kill it
     cannot name and reports every one as "suite aborted" — which reads
     exactly like the harness having crashed the suite by accident rather
     than the guard having fired on purpose. */
  const out = (r.stdout || '') + (r.stderr || '');
  /* Two spellings, because social-image-contract.js reports "N checks, 0
     failure(s)" while the other two say "N checks passed". A regex that knew
     only one would print NaN for the other's baseline — a harness that cannot
     say how big the suite it is protecting is. */
  const m = /(\d+) checks passed/.exec(out) || /(\d+) checks, \d+ failure/.exec(out);
  /* Both failure marks, too: social-image-contract.js prints ❌ and the other
     two print ✗. Reading one only made every kill on that suite report as
     "suite aborted", which is the harness describing its own blind spot as
     the product's behaviour. */
  const named = out.split('\n')
    .filter((l) => l.includes('✗') || l.includes('❌'))
    .map((l) => l.trim());
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
    /* `prompt: composed.prompt,` appears TWICE — once in the row that gets
       written and once in the call that gets made — and mutating the wrong
       one tests the opposite property, so the anchor has to pin down WHICH.

       RE-ANCHORED 2026-09-18. It used to carry the COMMENT LINE above the
       first site ("…describes something that did not happen."), and commit
       80c50d5 rewrote that comment — correctly, it had gone stale about the
       new provider — which silently killed this plant. The harness reported
       ANCHOR MISS and counted it NOT CAUGHT, exactly as it should, but the
       full suite was never re-run to completion after that commit so the red
       shipped. Recurring-bugs #34: a correct product fix rots an older guard
       and its plant.

       The anchor is now three consecutive STATEMENTS rather than prose. Both
       sites share the first two lines; only the row-building one is followed
       by `lang,`, and the two sites are indented differently anyway. Prose
       above a line is the most editable text in a file and the worst possible
       thing to anchor on — a comment is supposed to be rewritten when it stops
       being true. */
    mutate(INDEX, '        prompt: composed.prompt,\n'
                + '        negativePrompt: rawNegative || null,\n'
                + '        lang,',
                  '        prompt: rawPrompt,\n'
                + '        negativePrompt: rawNegative || null,\n'
                + '        lang,')],

  ['M7  stop recording WHICH kind shaped the image', () =>
    mutate(INDEX, '        style: styled.styleRef,', '        style: null,')],

  ['M8  hard-code a catalogue label into the client', () =>
    mutate(IGEN, "el('option', null, 'Default — nothing added')", "el('option', null, 'Watercolour')")],

  ['M9  drop the visible negative prompt on the way to the provider', () =>
    // Targets nanobanana.js — the DEFAULT provider as of 2026-09-18 — rather
    // than dashscope.js, which this suite's default pipeline no longer
    // exercises. dashscope.js's OWN equivalent guard is covered directly by
    // test/image-contract.js §12 (extractImageUrl et al.), not by mutation
    // here, matching the "registered but not default" status of that file.
    mutate(NANOBANANA, "return prompt + '\\n\\nAvoid: ' + negativePrompt.trim();",
                       'return prompt;')],

  /* ── the panel half ────────────────────────────────────────────────────
     These four leave the server perfect. Each one is a panel that appends,
     hides or misreports the art direction while every server-side check
     stays green — which is why they are checked against the other suite. */
  ['P1  stop printing the appended sentence in the preview', PANEL_SUITE, () =>
    mutate(IGEN, "prevBody.appendChild(part('Added by “' + st.label + '”', st.phrase));",
                 'void st;')],

  ['P2  fold the style text into the prompt on the client', PANEL_SUITE, () =>
    mutate(IGEN, '      generate({\n        prompt: prompt,',
                 '      generate({\n        prompt: prompt + (chosenStyle() && chosenStyle().phrase '
                 + "? ' ' + chosenStyle().phrase : ''),")],

  ['P3  ignore the default the server named', PANEL_SUITE, () =>
    mutate(IGEN, 'if (want && s.ref === want) opt.selected = true;', 'void want;')],

  ['P4  prefill a negative prompt the user never typed', PANEL_SUITE, () =>
    mutate(IGEN, 'if (r.negative_prompt) body.negative_prompt = r.negative_prompt;',
                 "body.negative_prompt = r.negative_prompt || 'text, watermark';")],

  /* ── the Social Post half ──────────────────────────────────────────────
     This surface applies a kind the OTHER way round — the sentence goes into
     the visible, editable description and no ref goes on the wire — so its
     failure modes are different ones, and none of them are visible to the
     two suites above. */
  ['S1  pick a look, write none of it into the description', SOCIAL_SUITE, () =>
    mutate(POST, "+ (st && st.phrase ? ' ' + st.phrase : '')", "+ ''")],

  ['S2  send a ref as well, re-appending direction the user may have deleted', SOCIAL_SUITE, () =>
    mutate(POST, "      prompt: String(ui.prompt.value || '').trim(),",
                 "      prompt: String(ui.prompt.value || '').trim(),\n"
               + "      style: ui.style ? ui.style.value : '',")],

  ['S3  prefer a look lib/image/styles.js does not offer', SOCIAL_SUITE, () =>
    mutate(POST, "var PREFERRED_STYLE = 'photo';", "var PREFERRED_STYLE = 'photorealistic';")],

  ['S4  let the look overwrite a description the user has edited', SOCIAL_SUITE, () =>
    mutate(POST, "style.addEventListener('change', refresh);",
                 "style.addEventListener('change', function () { promptEdited = false; refresh(); });")],
];

/* Each entry is [label, apply] or [label, suite, apply]. */
const parse = (m) => (m.length === 3 ? { label: m[0], suite: m[1], apply: m[2] }
                                     : { label: m[0], suite: SERVER_SUITE, apply: m[1] });

console.log('── baseline ' + '─'.repeat(52));
let baseFailed = false;
for (const suite of [SERVER_SUITE, PANEL_SUITE, SOCIAL_SUITE]) {
  const b = run(suite);
  console.log(`    ${path.basename(suite)}: ${b.checks} checks, exit ${b.exit}`);
  if (b.exit !== 0) baseFailed = true;
}
if (baseFailed) { console.error('Baseline is not green — aborting.'); cleanup(); process.exit(1); }

console.log('\n── mutations ' + '─'.repeat(51));
let survived = 0;
for (const m of MUTATIONS) {
  const { label, suite, apply } = parse(m);
  try {
    apply();
  } catch (e) {
    restore();
    console.error(`  ✗ ${label}\n      ${e.message}`);
    survived++;
    continue;
  }
  const r = run(suite);
  restore();
  if (r.exit === 0) { survived++; console.log(`  ✗ SURVIVED  ${label}`); }
  else {
    console.log(`  ✓ caught    ${label}`);
    console.log(`                ${r.named.length ? r.named.slice(0, 2).join(' · ') : 'suite aborted (a kill, not a survivor)'}`);
  }
}

console.log('\n── restored ' + '─'.repeat(52));
let notGreen = false;
for (const suite of [SERVER_SUITE, PANEL_SUITE, SOCIAL_SUITE]) {
  const g = run(suite);
  console.log(`    ${path.basename(suite)}: ${g.checks} checks, exit ${g.exit}`);
  if (g.exit !== 0) notGreen = true;
}
cleanup();

if (survived || notGreen) {
  console.error(`\n✗ ${survived} mutation(s) survived`
    + (notGreen ? ' and the tree did not come back green' : ''));
  process.exit(1);
}
console.log(`\n✓ all ${MUTATIONS.length} mutations caught, and the restored tree is green`);

'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   THE GROQ MODEL CONSTANT, AND THE THINGS THAT ROT AROUND IT
   ───────────────────────────────────────────────────────────────────────────
   Written 2026-09-18, after `qwen/qwen3.6-27b` was withdrawn by Groq and every
   inference call in production began failing with

       The model `qwen/qwen3.6-27b` does not exist or you do not have access to it.

   which users met as an error popup on the content tools — including the screen
   the image control sits on, which is how it was reported ("remove the qwen
   error pop up when i generate the image").

   The model name itself is not the interesting part. A dead vendor model is the
   vendor's decision and nothing here can prevent it. What this suite exists for
   is the THREE THINGS THAT GO STALE AROUND THE ROLL, each of which fails
   quietly, and two of which were live in this repo at the moment of the roll:

     1. The gate that decides whether to send `reasoning_effort` /
        `reasoning_format` was pinned to `/^qwen\/qwen3\.6/` — ONE MINOR
        VERSION. Roll the constant to 3.8 and the gate simply stops matching.
        Nothing errors. The params are dropped from every call, which is the
        legitimate behaviour for a non-qwen model, so the silence is
        indistinguishable from correctness. This is recurring-bugs #26 — a guard
        matching a spelling rather than the class — and it very nearly shipped
        inside the fix for the outage it would have caused next.
     2. `DEPRECATED_MODELS` is the only repair available for an external
        `/api/chat` caller that hardcodes a model name in its own request body.
        `GROQ_MODEL` cannot reach those callers; CLAUDE.md has said so since the
        endpoint was written. A roll that does not add the dead name leaves
        every such integration on a hard model_not_found.
     3. The name is PUBLISHED — in `public/api-docs.html` (to external
        integrators), in `.env.example` and `README.md` (to whoever deploys
        this), and in `CLAUDE.md` (to the next session). A roll that updates the
        constant and leaves those behind is how a dead model keeps being
        recommended to new callers long after it stopped answering.

   §4's scan is deliberately written against DEPRECATED_MODELS rather than
   against a hardcoded list of dead strings, so retiring the NEXT model needs no
   edit here: add it to the set in helpers/groq.js and this suite starts
   enforcing it everywhere at once.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const groq = require(path.join(ROOT, 'helpers', 'groq.js'));

let failures = 0;
let checks = 0;
function ok(msg) { checks += 1; console.log('  ✓ ' + msg); }
function fail(msg) { failures += 1; checks += 1; console.error('  ✗ ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }

console.log('\n══ GROQ MODEL CONTRACT ══');

/* ── §1 · The default is not itself a dead name ───────────────────────────── */
console.log('\n§1 · the default model');

check(typeof groq.DEFAULT_GROQ_MODEL === 'string' && groq.DEFAULT_GROQ_MODEL.trim() !== '',
  'DEFAULT_GROQ_MODEL is a non-empty string');

check(!groq.DEPRECATED_MODELS.has(groq.DEFAULT_GROQ_MODEL),
  'DEFAULT_GROQ_MODEL is not itself in DEPRECATED_MODELS — a roll onto a dead ' +
  'name would otherwise map the default onto itself forever');

/* GROQ_MODEL is the env override; with nothing set it must BE the default.
   Asserted because the whole fallback procedure in CLAUDE.md rests on it. */
check(groq.GROQ_MODEL === (process.env.GROQ_MODEL || groq.DEFAULT_GROQ_MODEL),
  'GROQ_MODEL resolves to the env override when set, and the default otherwise');

/* ── §2 · Every dead name is remapped, not forwarded ──────────────────────── */
console.log('\n§2 · dead names are remapped for callers that hardcode them');

/* A FLOOR UNDER THE LIST, so §2 cannot go quiet by shrinking.
   Every check below iterates DEPRECATED_MODELS, so deleting a name removes its
   own assertion and the suite stays green while an external integration starts
   getting model_not_found again — recurring-bugs #24, a check that enumerates
   its subjects. These four are known-decommissioned, and a model a vendor has
   withdrawn does not come back, so this list may only ever GROW. Pinning it is
   monotonic, not enumeration: no future roll needs to edit these four lines,
   it only adds a fifth name to helpers/groq.js. */
const KNOWN_DEAD = [
  'llama-3.3-70b-versatile',   // Groq, 2026-08-16
  'llama-3.1-8b-instant',      // Groq, 2026-08-16
  'llama3-70b-8192',           // Groq, 2026-08-16
  'qwen/qwen3.6-27b',          // Groq, withdrawn by 2026-09-18 — caused the outage
];
for (const dead of KNOWN_DEAD) {
  check(groq.DEPRECATED_MODELS.has(dead),
    `DEPRECATED_MODELS still carries '${dead}' — the list may only grow, and ` +
    'a name leaving it silently deletes its own remap assertion');
}

for (const dead of groq.DEPRECATED_MODELS) {
  check(groq.normaliseModel(dead) === groq.GROQ_MODEL,
    `normaliseModel('${dead}') -> the live model, so an external integration ` +
    'pinning it keeps working');
}

check(groq.normaliseModel('some/model-nobody-here-chose') === 'some/model-nobody-here-chose',
  'an unrecognised model is passed through untouched — this is a compatibility ' +
  'shim, not a whitelist');

check(groq.normaliseModel(undefined) === groq.GROQ_MODEL,
  'no model named falls back to the live model');

/* ── §3 · The reasoning gate tracks the FAMILY, not one minor version ─────── */
console.log('\n§3 · the reasoning-param gate is not pinned to a minor version');

const withReasoning = groq.withReasoning;
const sends = (model) => withReasoning({ model }, 'none').reasoning_effort !== undefined;

check(sends(groq.DEFAULT_GROQ_MODEL),
  `the gate matches the CURRENT default (${groq.DEFAULT_GROQ_MODEL}) — if it ` +
  'does not, both reasoning params are being silently dropped from every call');

/* The heart of it. Derive a SIBLING minor version from the real default and
   require the gate to match that too. A predicate pinned to one minor passes
   the check above and fails this one — which is exactly the state this repo was
   in between rolling the constant and widening the regex. */
const familySibling = groq.DEFAULT_GROQ_MODEL.replace(
  /^([a-z0-9-]+\/[a-z]+)(\d+)\.(\d+)/i,
  (_m, head, major, minor) => `${head}${major}.${Number(minor) + 1}`
);
check(familySibling !== groq.DEFAULT_GROQ_MODEL,
  `a sibling minor version could be derived from the default (${familySibling})`);
check(sends(familySibling),
  `the gate ALSO matches a sibling minor (${familySibling}) — a gate pinned to ` +
  'one minor version re-breaks on every roll, silently, by construction');

/* …and the widening must not have become "always true". */
check(!sends('openai/gpt-oss-120b'),
  'the gate does NOT match the documented fallback (openai/gpt-oss-120b) — ' +
  'sending it the reasoning params risks a 400');
check(!sends('qwen-image-plus'),
  'the gate does NOT match an image model that merely starts with "qwen"');
check(!sends('qwen/qwen2.5-32b'),
  'the gate does NOT match a different qwen MAJOR family');

/* ── §4 · No dead model is OFFERED as the one to use ──────────────────────── */
console.log('\n§4 · no dead model is offered as the one to use');

/* THE PROPERTY IS "OFFERED AS LIVE", NOT "MENTIONED".

   The first version of this section forbade the dead STRING anywhere on a live
   surface, and it was wrong in a way worth recording: it fired on
   `public/api-docs.html`'s own deprecation notice, on `.env.example`'s "this is
   what it used to be" comment, and on CLAUDE.md's account of the outage. Each
   of those names a dead model precisely in order to say that it is dead, which
   is the behaviour the documentation SHOULD have. A guard that cannot tell
   "use this" from "this stopped working" pushes whoever hits it into deleting
   the warning — it would make the docs worse while going green.

   So the check is against the SHAPE OF AN OFFER: the assigned value in the env
   template, the published default in the API docs, the model field of a
   response example, and any model string surviving in EXECUTABLE code. Prose
   about a dead model is left alone, deliberately. */

/* ── §4a · executable code ─────────────────────────────────────────────────
   Comments stripped, so a `// 3.6 was withdrawn` note survives and a live
   `model: '<dead>'` does not.

   Three files are outside the scan, and all three are DEFINITIONAL rather than
   an exemption list (recurring-bugs #13) — each one's job is to name dead
   models, so forbidding it from naming them forbids it from existing:

     helpers/groq.js            OWNS DEPRECATED_MODELS. A registry of dead
                                names cannot be barred from containing them.
     this suite                 ASSERTS against them, by name, above.
     mutate-groq-model.js       PLANTS them, to prove these checks can fail.

   Nothing else can join that list without also becoming a file whose purpose
   is to enumerate dead models, which is the whole boundary. */
const OWNS_THE_LIST = path.join('helpers', 'groq.js');
const THIS_SUITE = path.join('test', 'groq-model-contract.js');
const ITS_HARNESS = path.join('test', 'mutate-groq-model.js');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'docs') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const jsSurfaces = walk(ROOT)
  .filter((f) => path.extname(f) === '.js')
  .filter((f) => {
    const rel = path.relative(ROOT, f);
    return rel !== OWNS_THE_LIST && rel !== THIS_SUITE && rel !== ITS_HARNESS;
  });

check(jsSurfaces.length > 20,
  `the scan found ${jsSurfaces.length} executable files — a scan that found ` +
  'almost nothing would pass while checking nothing (recurring-bugs #14)');

const inCode = [];
for (const file of jsSurfaces) {
  let src;
  try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch { continue; }
  for (const dead of groq.DEPRECATED_MODELS) {
    if (src.includes(dead)) {
      inCode.push(`${path.relative(ROOT, file).replace(/\\/g, '/')} uses '${dead}'`);
    }
  }
}

check(inCode.length === 0,
  inCode.length === 0
    ? 'no executable file names a model DEPRECATED_MODELS says is dead'
    : 'executable code still names a dead model:\n      ' + inCode.join('\n      '));

/* ── §4b · the published values ────────────────────────────────────────────
   Three places state "this is the model", and each is read by somebody who
   will then use it: whoever deploys this, and whoever writes an integration
   against /api/chat. Each is checked as a VALUE, so the prose around it stays
   free to explain what died. */
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const envAssign = /^GROQ_MODEL=(.*)$/m.exec(envExample);
check(envAssign !== null, '.env.example still assigns GROQ_MODEL');
if (envAssign) {
  const value = envAssign[1].trim();
  check(!groq.DEPRECATED_MODELS.has(value),
    `.env.example's GROQ_MODEL= value ('${value}') is not a dead model`);
  check(value === groq.DEFAULT_GROQ_MODEL,
    `.env.example's GROQ_MODEL= value matches the code default ` +
    `('${groq.DEFAULT_GROQ_MODEL}') — an operator copying it gets what the ` +
    'code would have used anyway');
}

const apiDocs = fs.readFileSync(path.join(ROOT, 'public', 'api-docs.html'), 'utf8');

const published = /Groq model ID\.\s*Default:\s*([^<\s]+)/.exec(apiDocs);
check(published !== null, 'public/api-docs.html still publishes a default model');
if (published) {
  check(published[1] === groq.DEFAULT_GROQ_MODEL,
    `the default published to external integrators ('${published[1]}') is the ` +
    'live model');
}

const exampleModel = /"model":\s*"([^"]+)"/.exec(apiDocs);
check(exampleModel !== null, 'public/api-docs.html still shows a response example');
if (exampleModel) {
  check(!groq.DEPRECATED_MODELS.has(exampleModel[1]),
    `the response example's model ('${exampleModel[1]}') is not a dead model`);
}

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures) {
  console.error('✗ THE GROQ MODEL CONTRACT IS BROKEN — a dead model name, a gate that ' +
                'stopped matching it, or a doc still recommending one\n');
  process.exit(1);
}
console.log('✓ the model constant, the reasoning gate, the remap and every live surface agree\n');

/* ═══════════════════════════════════════════════════════════════════════════
   POST /api/score — the CJK fix, guarded
   ───────────────────────────────────────────────────────────────────────────
   WHY THIS FILE EXISTS: a blind critic reverted /api/score's word counter to
   `split(/\s+/)` and the whole suite stayed GREEN. trilingual-test.js covers
   helpers/, generation-extraction.js covers helpers/generation.js, and nothing
   at all loaded this route. The fix was real and completely unguarded, which
   means it would have survived exactly as long as nobody edited that line.

   Recurring-bugs #21: a suite that reads source as text and never executes it.
   So this does not grep for `countWords` — a call that is present but wired to
   the wrong variable would pass a grep. It CUTS THE REAL HANDLER OUT OF
   server.js AND RUNS IT, with a fake req/res, and asserts the numbers.

   Recurring-bugs #14 / #24: the extraction must fail loudly. If the handler
   cannot be located, or the reconstruction does not vary with its input, this
   file exits non-zero rather than reporting a clean run over nothing.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.log('  ✗ ' + m); };

console.log('\nscore-cjk-contract — /api/score counts a Chinese article as more than one word\n');

/* ── 1. Cut the real handler out of the shipped file ───────────────────────*/
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const OPEN = "app.post('/api/score'";
const iOpen = src.indexOf(OPEN);
if (iOpen === -1) {
  console.error('\n  ✗ could not find ' + OPEN + ' in server.js.');
  console.error('    This test asserts against the REAL route. It will not invent one.\n');
  process.exit(1);
}
// Walk braces from the handler's opening `{` to its matching close, ignoring
// braces inside strings and template literals.
const bodyStart = src.indexOf('{', src.indexOf('async (req, res)', iOpen));
let depth = 0, i = bodyStart, inStr = null, bodyEnd = -1;
for (; i < src.length; i++) {
  const c = src[i], prev = src[i - 1];
  if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
}
if (bodyEnd === -1) {
  console.error('\n  ✗ could not balance the handler body — refusing to test a partial slice.\n');
  process.exit(1);
}
const body = src.slice(bodyStart + 1, bodyEnd);
pass('extracted the live /api/score handler (' + body.split('\n').length + ' lines) from server.js');

if (!/langHelper|countWords|textMetrics/.test(body)) {
  fail('the handler does not reference the language helper at all — the CJK fix is gone');
}

/* ── 2. Run it for real ────────────────────────────────────────────────────*/
const langHelper = require('../helpers/lang');

function score(content, keyword) {
  let captured = null;
  const req = { body: { content, keyword } };
  const res = {
    json: (o) => { captured = o; return res; },
    status: () => ({ json: (o) => { captured = { _status: true, ...o }; return res; } }),
  };
  const ctx = vm.createContext({ req, res, langHelper, console, JSON, Math, Number, String, Object, parseFloat, parseInt });
  vm.runInContext('(async () => {' + body + '})()', ctx, { timeout: 5000 });
  return captured;
}

/* Non-vacuity: the reconstruction must actually compute. */
{
  const a = score('one two three');
  const b = score('one two three four five six seven eight nine ten eleven twelve');
  if (a && b && a.wordCount !== b.wordCount) pass('the extracted handler is live (output varies with input)');
  else { fail('the extracted handler returns a constant — every assertion below would be vacuous'); process.exit(1); }
}

/* ── 3. THE ACTUAL PROPERTY ────────────────────────────────────────────────*/
const ZH_ONE = '人工智能正在改变马来西亚中小企业的营销方式。';
const CASES = [
  ['zh ×1', ZH_ONE.repeat(1)],
  ['zh ×5', ZH_ONE.repeat(5)],
  ['zh ×20', ZH_ONE.repeat(20)],
  ['zh ×60', ZH_ONE.repeat(60)],
];

let prev = 0;
for (const [label, text] of CASES) {
  const r = score(text);
  if (!r) { fail(label + ': handler returned nothing'); continue; }
  if (r.wordCount <= 1) {
    fail(label + ': wordCount=' + r.wordCount + ' — a ' + text.length +
         '-character Chinese article counted as one word. UPGRADE-SPEC §0.7 has regressed.');
  } else if (r.wordCount <= prev) {
    fail(label + ': wordCount=' + r.wordCount + ' did not grow with length (previous ' + prev + ')');
  } else {
    pass(label.padEnd(7) + ' chars=' + String(text.length).padEnd(5) +
         'words=' + String(r.wordCount).padEnd(5) + 'readability=' + String(r.readabilityScore).padEnd(5) +
         'basis=' + r.readabilityBasis);
  }
  prev = r.wordCount;
}

/* Readability must not be the flattering 100 the old formula gave Chinese. */
{
  const r = score(ZH_ONE.repeat(60));
  if (r && r.readabilityScore === 100 && r.readabilityBasis === 'flesch-en') {
    fail('Chinese is being scored on the English Flesch scale again');
  } else pass('Chinese readability is computed on a Chinese basis (' + (r && r.readabilityBasis) + ')');
}

/* Keyword density: the old code divided by a wordCount of 1, and by ZERO on
   empty content, handing NaN to the UI. */
{
  const r = score(ZH_ONE.repeat(20), '营销');
  if (!r) fail('keyword case returned nothing');
  else if (!Number.isFinite(r.keywordDensity)) fail('keywordDensity is not a finite number: ' + r.keywordDensity);
  else if (r.keywordCount < 2) fail('keywordCount=' + r.keywordCount + ' — a Chinese keyword is not being counted by occurrence');
  else if (r.keywordDensity > 50) fail('keywordDensity=' + r.keywordDensity + '% — dividing by a word count of 1 again');
  else pass('Chinese keyword counted by occurrence: count=' + r.keywordCount + ' density=' + r.keywordDensity + '%');

  /* The divide-by-zero case is NOT `''` — the route answers 400 for that
     before any arithmetic runs, which is correct and is asserted separately
     below. It is content that is TRUTHY but contains no words: the old code
     computed keywordCount/wordCount = 0/0 and handed NaN to the UI. */
  const wordless = score('   \n\n ... !!! ??? ', 'anything');
  if (!wordless) fail('word-less content returned nothing');
  else if (!Number.isFinite(wordless.keywordDensity)) {
    fail('word-less content produced a non-finite keywordDensity (' +
         wordless.keywordDensity + ') — the 0/0 NaN is back');
  } else pass('word-less content does not divide by zero (density=' + wordless.keywordDensity + ')');

  const empty = score('', 'anything');
  if (empty && empty._status) pass('empty content is refused with a status, not scored');
  else fail('empty content was scored instead of refused: ' + JSON.stringify(empty));
}

/* English and Malay must not have regressed while Chinese was fixed. */
{
  const en = score('AI is transforming how Malaysian SMEs approach marketing today and tomorrow.');
  if (en && en.wordCount === 11 && en.readabilityBasis === 'flesch-en') pass('English still counted by words and scored by Flesch');
  else fail('English regressed: ' + JSON.stringify(en && { w: en.wordCount, b: en.readabilityBasis }));

  const ms = score('Platform kami menyediakan penjanaan kandungan dan pengurusan media sosial untuk perniagaan anda.');
  if (ms && ms.wordCount >= 10 && ms.readabilityBasis === 'ms-words-per-sentence') pass('Malay scored on its own basis, not Flesch');
  else fail('Malay regressed: ' + JSON.stringify(ms && { w: ms.wordCount, b: ms.readabilityBasis }));
}

console.log('');
if (failures) {
  console.error('✗ /api/score CJK contract FAILED (' + failures + ')\n');
  process.exit(1);
}
console.log('✓ /api/score handles all three languages\n');

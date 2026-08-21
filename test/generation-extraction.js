/* ═══════════════════════════════════════════════════════════════════════════
   FOUNDATION — generateWithGroq() was MOVED, not changed
   ───────────────────────────────────────────────────────────────────────────
   Round 1 extracted the generation core out of server.js into
   helpers/generation.js so the trilingual lane could own it without owning
   server.js. The claim attached to that commit is "pure refactor: the
   behaviour is byte-for-byte what was there, defects included".

   A claim like that is worth exactly as much as the test behind it, so this
   file does not take it on trust. It lifts the ORIGINAL scoring code out of
   the git blob at the merge-base — not a copy typed out here, which could
   drift or be quietly corrected while typing — and runs both implementations
   over the same corpus, asserting every field matches.

   THIS TEST IS EXPECTED TO BE DELETED OR REWRITTEN BY THE TRILINGUAL LANE.
   That lane's whole job includes fixing the CJK defect this test currently
   pins in place. When it does, equivalence with the old scorer stops being
   the property we want and this file must fail — loudly, so somebody decides
   — rather than being silently satisfiable. See §3 below.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { execFileSync } = require('child_process');
const assert = require('assert');
const { scoreContent } = require('../helpers/generation');

let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.log('  ✗ ' + m); };

console.log('\ngeneration-extraction — the move did not change the behaviour\n');

/* ── 1. Recover the ORIGINAL implementation from git ───────────────────────
   Read the pre-extraction server.js and cut the scoring block out of it. If
   the cut fails we must stop: a test that silently compares the new code
   against nothing is the "test that cannot fail" of recurring-bugs #14. */

const MERGE_BASE = (() => {
  try {
    return execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    console.error('  cannot resolve merge-base: ' + err.message);
    process.exit(1);
  }
})();

const originalSource = execFileSync('git', ['show', MERGE_BASE + ':server.js'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});
pass('read server.js at merge-base ' + MERGE_BASE.slice(0, 8) + ' (' + originalSource.split('\n').length + ' lines)');

/* The original block, verbatim, between these two landmarks. Both are asserted
   present so a rename turns into a stop rather than an empty slice. */
/* Starts at the wordCount line, NOT at the "Deterministic content score"
   comment below it — wordCount is declared above that comment and every line
   after it reads the variable, so slicing from the comment produces a block
   that throws ReferenceError rather than one that computes a wrong answer.
   (Found by running it.) */
const START = '  const wordCount = text.split(/\\s+/).filter(Boolean).length;';
const END = '  // Auto-save document';
const iStart = originalSource.indexOf(START);
const iEnd = originalSource.indexOf(END, iStart);

if (iStart === -1 || iEnd === -1) {
  console.error('\n  ✗ could not locate the original scoring block in the merge-base server.js.');
  console.error('    This test compares against real history; it will not fabricate a baseline.');
  process.exit(1);
}
const originalBlock = originalSource.slice(iStart, iEnd);
pass('extracted the original scoring block (' + originalBlock.split('\n').length + ' lines) from that blob');

// Rebuild the original as a callable function, in its own scope, with `text`
// as its only input — exactly the variables it read inside generateWithGroq.
const originalScore = new Function('text', `
  ${originalBlock}
  return { wordCount, sentences, seoScore, readability };
`);

/* Non-vacuity: the reconstructed original must actually compute something.
   If it returned a constant, every comparison below would pass for free. */
{
  const a = originalScore('one two three');
  const b = originalScore('a much longer sample with a good many more words in it than the first');
  if (a.wordCount !== b.wordCount) pass('the reconstructed original is live (it varies with input)');
  else fail('the reconstructed original returns a constant — the comparison would be vacuous');
}

/* ── 2. The corpus ─────────────────────────────────────────────────────────
   Deliberately includes the inputs the CURRENT scorer gets wrong, because the
   point is equivalence with the old behaviour, not correctness. */

const CORPUS = {
  'empty string': '',
  'single word': 'Hello',
  'one english sentence': 'AI is transforming how Malaysian SMEs approach marketing.',
  'english with headings': '## Why SEO matters\n\nSearch drives traffic. It compounds.\n\n### The plan\n\n- Audit\n- Fix\n- Measure',
  'english long': ('The platform generates marketing content for small businesses. ').repeat(40),
  'bahasa malaysia': 'Platform kami menyediakan penjanaan kandungan dan pengurusan media sosial untuk perniagaan anda di Malaysia.',
  'chinese (the known defect)': '人工智能正在改变马来西亚中小企业的营销方式。我们的平台提供内容生成、社交媒体管理和搜索引擎优化服务。立即开始免费试用。',
  'chinese long (the known defect)': ('人工智能正在改变马来西亚中小企业的营销方式。').repeat(40),
  'mixed script': 'Our platform 我们的平台 supports EN, BM dan 中文 for every tool.',
  'punctuation only': '... !!! ???',
  'markdown bullets': '- one\n- two\n- three',
  'newlines only': '\n\n\n',
  'very long single sentence': 'word '.repeat(500),
};

/* ── 3. Equivalence ────────────────────────────────────────────────────────*/

let compared = 0;
for (const [label, text] of Object.entries(CORPUS)) {
  const before = originalScore(text);
  const after = scoreContent(text);
  compared++;
  try {
    assert.strictEqual(after.wordCount, before.wordCount, 'wordCount');
    assert.strictEqual(after.sentences, before.sentences, 'sentences');
    assert.strictEqual(after.seoScore, before.seoScore, 'seoScore');
    assert.strictEqual(after.readability, before.readability, 'readability');
    pass(label.padEnd(30) + ' words=' + String(before.wordCount).padEnd(5) +
         'seo=' + String(before.seoScore).padEnd(4) + 'read=' + before.readability);
  } catch (err) {
    fail(label + ' — ' + err.message +
         '\n      before: ' + JSON.stringify(before) +
         '\n      after:  ' + JSON.stringify(after));
  }
}

if (compared < Object.keys(CORPUS).length) {
  fail('only ' + compared + ' of ' + Object.keys(CORPUS).length + ' corpus entries were compared');
} else {
  pass('all ' + compared + ' corpus entries compared, field by field');
}

/* ── 4. Pin the defect, so removing it is a DECISION ───────────────────────
   The whole reason this round touches generation is that this number is
   wrong. Asserting it here means the trilingual lane cannot fix it by
   accident and cannot leave it fixed silently — this file will fail, and
   whoever is holding it has to come here and say so. */
{
  const zh = CORPUS['chinese long (the known defect)'];
  const s = scoreContent(zh);
  if (s.wordCount === 1) {
    pass('DEFECT STILL PRESENT AND PINNED: a ' + zh.length +
         '-character Chinese article scores wordCount=1, seoScore=' + s.seoScore +
         ', readability=' + s.readability);
    console.log('        ^ this is not an endorsement. UPGRADE-SPEC §0.7 and GAUNTLET.md §L');
    console.log('          put it in scope for the trilingual lane, which owns this file.');
    console.log('          When that lane fixes it, THIS ASSERTION MUST FAIL and be replaced');
    console.log('          with one asserting the corrected count — not deleted quietly.');
  } else {
    fail('the CJK defect is no longer reproducing (wordCount=' + s.wordCount + ').\n' +
         '      If the trilingual lane fixed it deliberately: good — now replace this\n' +
         '      block and the equivalence corpus above with assertions on the NEW\n' +
         '      behaviour, and update helpers/generation.js\'s header comment.\n' +
         '      If nobody meant to change it, something else did, and that is the bug.');
  }
}

console.log('');
if (failures) {
  console.error('✗ generation extraction is NOT behaviour-preserving (' + failures + ' failure(s))\n');
  process.exit(1);
}
console.log('✓ the extraction preserved behaviour exactly\n');

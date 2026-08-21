/* ═══════════════════════════════════════════════════════════════════════════
   generation-extraction — WHAT THE SCORER USED TO DO, AND WHAT IT DOES NOW
   ───────────────────────────────────────────────────────────────────────────
   HISTORY OF THIS FILE, BECAUSE IT CHANGED PURPOSE ONCE AND MUST NOT DO SO
   QUIETLY AGAIN.

   Round 1 Foundation moved generateWithGroq() out of server.js into
   helpers/generation.js and claimed "pure refactor — the behaviour is
   byte-for-byte what was there, defects included". This file existed to hold
   that claim to account: it lifts the ORIGINAL scoring code out of the git
   blob at the merge-base, runs both implementations over one corpus, and
   asserted every field matched. Its §4 PINNED the CJK defect, so that fixing
   it could not happen silently, and its failure message said in as many words:

       "If the trilingual lane fixed it deliberately: good — now replace this
        block and the equivalence corpus above with assertions on the NEW
        behaviour."

   LANE C DID FIX IT (UPGRADE-SPEC §0.7, GAUNTLET.md §L), so that is what this
   file now is. Equivalence is no longer the property we want, and asserting it
   would mean asserting the defect. What has NOT changed is the mechanism: the
   "before" is still recovered from real git history rather than typed out
   here, because a before/after comparison whose "before" is a hand-written
   constant is a comparison against whatever the author remembered.

   ── WHAT IT ASSERTS NOW ───────────────────────────────────────────────────
   1. The original implementation is recovered from the merge-base and is live
      (it varies with input), so the comparison is not vacuous.
   2. Every corpus entry's NEW output is pinned field by field. This is the
      lock: a future change to the scorer has to come here and say so.
   3. Every entry where the NEW output DIFFERS from the old must appear in
      CHANGED with a written reason. An unexplained difference is a failure —
      that is what stops the next fix riding along unnoticed.
   4. The CJK defect specifically is asserted GONE, in the direction that
      matters: a long Chinese article counts hundreds of words, scores above
      the floor on SEO, and no longer returns a flattering readability of 100.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const { execFileSync } = require('child_process');
const assert = require('assert');
const { scoreContent } = require('../helpers/generation');

let failures = 0;
const pass = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.log('  ✗ ' + m); };

console.log('\ngeneration-extraction — the CJK defect is gone, and every other change is accounted for\n');

/* ── 1. Recover the ORIGINAL implementation from git ───────────────────────
   Unchanged from the Foundation version of this file. If the cut fails we
   stop: a test that silently compares the new code against nothing is the
   "test that cannot fail" of recurring-bugs #14. */

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
   present so a rename turns into a stop rather than an empty slice.
   Starts at the wordCount line, NOT at the "Deterministic content score"
   comment below it — wordCount is declared above that comment and every line
   after it reads the variable, so slicing from the comment produces a block
   that throws ReferenceError rather than one that computes a wrong answer. */
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

const originalScore = new Function('text', `
  ${originalBlock}
  return { wordCount, sentences, seoScore, readability };
`);

{
  const a = originalScore('one two three');
  const b = originalScore('a much longer sample with a good many more words in it than the first');
  if (a.wordCount !== b.wordCount) pass('the reconstructed original is live (it varies with input)');
  else fail('the reconstructed original returns a constant — the comparison would be vacuous');
}

/* ── 2. The corpus ─────────────────────────────────────────────────────────
   Same entries as before, plus a long Malay sample, because BM is now a
   first-class output language and a corpus that only tests it on one sentence
   cannot see a sentence-length effect. The two Chinese entries keep their
   labels' meaning but not their old parenthetical: they are no longer "the
   known defect", they are the fix. */

const CORPUS = {
  'empty string': '',
  'single word': 'Hello',
  'one english sentence': 'AI is transforming how Malaysian SMEs approach marketing.',
  'english with headings': '## Why SEO matters\n\nSearch drives traffic. It compounds.\n\n### The plan\n\n- Audit\n- Fix\n- Measure',
  'english long': ('The platform generates marketing content for small businesses. ').repeat(40),
  'bahasa malaysia': 'Platform kami menyediakan penjanaan kandungan dan pengurusan media sosial untuk perniagaan anda di Malaysia.',
  'malay long': ('Platform kami membantu perniagaan anda menjana kandungan pemasaran dengan pantas dan tepat. ').repeat(20),
  'chinese short': '人工智能正在改变马来西亚中小企业的营销方式。我们的平台提供内容生成、社交媒体管理和搜索引擎优化服务。立即开始免费试用。',
  'chinese long': ('人工智能正在改变马来西亚中小企业的营销方式。').repeat(40),
  'mixed script': 'Our platform 我们的平台 supports EN, BM dan 中文 for every tool.',
  'punctuation only': '... !!! ???',
  'markdown bullets': '- one\n- two\n- three',
  'newlines only': '\n\n\n',
  'very long single sentence': 'word '.repeat(500),
};

/* ── 3. The pin. Exact expected output of the CURRENT scorer. ──────────────
   Produced by running it, then read line by line and checked against what the
   text actually is. This is the lock: change the scorer and this table has to
   change with it, deliberately, in a diff somebody reviews. */

const EXPECTED = {
  'empty string':             { wordCount: 0,   sentences: 1,  seoScore: 40, readability: null },
  'single word':              { wordCount: 1,   sentences: 1,  seoScore: 40, readability: 37 },
  'one english sentence':     { wordCount: 8,   sentences: 1,  seoScore: 40, readability: 40 },
  'english with headings':    { wordCount: 13,  sentences: 7,  seoScore: 51, readability: 88 },
  'english long':             { wordCount: 320, sentences: 40, seoScore: 65, readability: 30 },
  'bahasa malaysia':          { wordCount: 14,  sentences: 1,  seoScore: 41, readability: 73 },
  'malay long':               { wordCount: 240, sentences: 20, seoScore: 60, readability: 82 },
  'chinese short':            { wordCount: 30,  sentences: 3,  seoScore: 42, readability: 92 },
  'chinese long':             { wordCount: 440, sentences: 40, seoScore: 65, readability: 85 },
  'mixed script':             { wordCount: 13,  sentences: 1,  seoScore: 41, readability: 100 },
  'punctuation only':         { wordCount: 0,   sentences: 1,  seoScore: 40, readability: null },
  'markdown bullets':         { wordCount: 3,   sentences: 3,  seoScore: 50, readability: 100 },
  'newlines only':            { wordCount: 0,   sentences: 1,  seoScore: 40, readability: null },
  'very long single sentence':{ wordCount: 500, sentences: 1,  seoScore: 55, readability: 0 },
};

/* Every entry whose numbers MOVED, and why. An entry that differs from the old
   scorer and is not named here fails — which is the whole point of keeping the
   old implementation around after equivalence stopped being the goal. */
const CHANGED = {
  'english with headings':
    'sentences 3→7 (Intl.Segmenter treats each markdown line as a sentence, which for a ' +
    'bulleted plan is closer to true than a full-stop split); words 18→13 (bare "##", "###" ' +
    'and "-" are not words); readability 60→88 (the syllable count and the word count now ' +
    'count the SAME words — see helpers/lang.js syllablesEn)',
  'one english sentence':
    'readability 30→40. The old 30 was the FLOOR (Math.max(30, …)); 40 is the real Flesch ' +
    'score. Nothing about the sentence changed — the scale stopped lying about its bottom end.',
  'bahasa malaysia':
    'readability 30→73. Flesch is defined over English syllables and was being applied to ' +
    'Malay; the floor of 30 was doing the talking. Now words-per-sentence on a Malay scale, ' +
    'labelled ms-words-per-sentence.',
  'malay long':
    'new corpus entry — no old value to differ from, listed so the count reconciles.',
  'chinese short':
    'THE DEFECT: words 1→30, seo 40→42, readability 100→92. See §4.',
  'chinese long':
    'THE DEFECT: words 1→440, seo 40→65, readability 100→85. See §4.',
  'mixed script':
    'words 11→13 and readability 65→100. The string is 12% Han so it is scored as Chinese, ' +
    'and one short mixed sentence is genuinely easy to read. A deliberately pathological ' +
    'entry: it exists to show the language decision, not to be realistic copy.',
  'punctuation only':
    'readability 100→null. "... !!! ???" has no words; every readability formula divides by ' +
    'a word count. null is the honest answer, and the old 100 was the flattering-wrong ' +
    'direction §0.7 is about.',
  'markdown bullets':
    'words 6→3 ("-" is not a word); sentences 1→3; readability 88→100. A three-item list is ' +
    'as readable as text gets.',
  'empty string':
    'readability 100→null. Same reason as "punctuation only": there is nothing to read, and ' +
    'the old floor-and-formula produced a confident number about it.',
  'newlines only':
    'readability 38→null. Same reason.',
  'very long single sentence':
    'readability 30→0. The old 30 was the floor; five hundred words in one sentence really is ' +
    'unreadable, and a scale that cannot say so is not a scale.',
};

let compared = 0;
const unexplained = [];

for (const [label, text] of Object.entries(CORPUS)) {
  const after = scoreContent(text);
  compared++;

  // 3a — the pin
  const want = EXPECTED[label];
  if (!want) {
    fail(label + ' — corpus entry has no entry in EXPECTED; the pin does not cover it');
    continue;
  }
  try {
    assert.strictEqual(after.wordCount, want.wordCount, 'wordCount');
    assert.strictEqual(after.sentences, want.sentences, 'sentences');
    assert.strictEqual(after.seoScore, want.seoScore, 'seoScore');
    assert.strictEqual(after.readability, want.readability, 'readability');
    pass(label.padEnd(26) + ' words=' + String(after.wordCount).padEnd(5) +
         'seo=' + String(after.seoScore).padEnd(4) +
         'read=' + String(after.readability).padEnd(5) +
         '[' + after.wordBasis + ' / ' + after.readabilityBasis + ']');
  } catch (err) {
    fail(label + ' — ' + err.message + '\n      expected: ' + JSON.stringify(want) +
         '\n      actual:   ' + JSON.stringify({
           wordCount: after.wordCount, sentences: after.sentences,
           seoScore: after.seoScore, readability: after.readability,
         }));
  }

  // 3b — anything that moved must be explained
  let before = null;
  try {
    before = originalScore(text);
  } catch (err) {
    fail(label + ' — the ORIGINAL scorer threw (' + err.message + '); no before/after possible');
    continue;
  }
  const moved = before.wordCount !== after.wordCount ||
    before.sentences !== after.sentences ||
    before.seoScore !== after.seoScore ||
    before.readability !== after.readability;
  if (moved && !CHANGED[label]) {
    unexplained.push(label + '  before=' + JSON.stringify(before) +
      '  after=' + JSON.stringify({
        wordCount: after.wordCount, sentences: after.sentences,
        seoScore: after.seoScore, readability: after.readability,
      }));
  }
}

if (compared !== Object.keys(CORPUS).length) {
  fail('only ' + compared + ' of ' + Object.keys(CORPUS).length + ' corpus entries were compared');
} else {
  pass('all ' + compared + ' corpus entries pinned field by field');
}

if (unexplained.length) {
  fail('these entries changed from the pre-Lane-C scorer and are NOT in CHANGED:\n      ' +
       unexplained.join('\n      ') +
       '\n      Every difference must carry a written reason. If the change is wanted, add it\n' +
       '      to CHANGED with why. If it is not, it is the bug this section exists to catch.');
} else {
  pass('every difference from the pre-Lane-C scorer is named in CHANGED with a reason');
}

/* One entry deserves saying out loud because it is invisible in a diff of
   numbers: 'english long' scored 30 before and scores 30 now, and those are
   not the same 30. The old one was the FLOOR — Math.max(30, …) over a true
   value of 8, produced by a syllable counter that read "generates" as four
   syllables. The new one is the real Flesch score. A number that did not move
   because two errors cancelled is exactly the kind of thing an equivalence
   test reports as "fine". */
{
  const before = originalScore(CORPUS['english long']);
  const after = scoreContent(CORPUS['english long']);
  if (before.readability === after.readability) {
    console.log('  · note: "english long" reads ' + after.readability + ' before AND after — the old ' +
                'value was the floor over a true 8, the new one is the real score. Same number, ' +
                'different provenance.');
  } else {
    fail('the "english long" provenance note is stale: readability moved ' +
         before.readability + '→' + after.readability + ', so it now belongs in CHANGED');
  }
}

/* Non-vacuity for §3b: CHANGED must not be a list of entries that did not
   actually change, because then it would be explaining nothing and a real
   unexplained change could hide behind a stale entry. */
{
  const stale = Object.keys(CHANGED).filter((label) => {
    if (!(label in CORPUS)) return true;
    if (label === 'malay long') return false;   // declared new, no `before`
    const before = originalScore(CORPUS[label]);
    const after = scoreContent(CORPUS[label]);
    return before.wordCount === after.wordCount && before.sentences === after.sentences &&
      before.seoScore === after.seoScore && before.readability === after.readability;
  });
  if (stale.length) {
    fail('CHANGED explains entries that did not change: ' + stale.join(', ') +
         ' — a stale explanation is somewhere a real change can hide');
  } else {
    pass('every CHANGED entry corresponds to a difference that is really there');
  }
}

/* ── 4. THE DEFECT IS GONE. This block replaces the one that pinned it. ────
   UPGRADE-SPEC §0.7's measured symptom was:

       ZH  chars=59   wordCount=1   sentences=1   readability=100

   and the consequence was that `wordCount >= 300 ? 25 : Math.floor(wordCount/12)`
   awarded 0 to every Chinese document however long it was. These assertions
   are on the DIRECTION and the MAGNITUDE, not only on the pinned numbers
   above, so they keep meaning if the segmenter's dictionary shifts by a word
   or two between ICU versions. */
{
  const zh = CORPUS['chinese long'];
  const before = originalScore(zh);
  const after = scoreContent(zh);

  console.log('\n  the §0.7 defect, before and after, on a ' + zh.length + '-character Chinese article:');
  console.log('    before : ' + JSON.stringify(before));
  console.log('    after  : ' + JSON.stringify({
    wordCount: after.wordCount, sentences: after.sentences,
    seoScore: after.seoScore, readability: after.readability,
  }) + '  [' + after.wordBasis + ']');

  if (before.wordCount === 1) pass('confirmed: the ORIGINAL scorer really did count this article as 1 word');
  else fail('the original scorer did not reproduce the defect (wordCount=' + before.wordCount +
            ') — then this whole comparison is measuring something else');

  if (after.wordCount > 100) pass('FIXED: it now counts ' + after.wordCount + ' words');
  else fail('the Chinese article still counts ' + after.wordCount + ' words — §0.7 is not closed');

  if (after.wordBasis && after.wordBasis.indexOf('segmenter') !== -1) {
    pass('counted by real segmentation (' + after.wordBasis + '), not by a character guess');
  } else {
    // Not a failure: helpers/lang.js is explicit that a small-icu runtime gets
    // a labelled estimate. It IS reported, because the number's provenance is
    // part of the number.
    console.log('  · counted by ' + after.wordBasis + ' — this runtime has no CJK word data; ' +
                'the count is a labelled estimate, which is still not 1');
  }

  if (after.seoScore > before.seoScore) {
    pass('FIXED: SEO score ' + before.seoScore + ' → ' + after.seoScore +
         ' — a long Chinese article now clears the length gate it always should have');
  } else {
    fail('SEO score did not improve (' + before.seoScore + ' → ' + after.seoScore +
         '); the length gate is still awarding a long Chinese article nothing');
  }

  if (before.readability === 100 && after.readability !== 100) {
    pass('FIXED: readability ' + before.readability + ' → ' + after.readability +
         ' (' + after.readabilityBasis + ') — no longer English Flesch applied to Chinese');
  } else {
    fail('readability is still ' + after.readability + ' via ' + after.readabilityBasis +
         '; a formula defined over English syllables must not be scoring Chinese');
  }

  if (after.lang === 'zh') pass('the score reports the language it measured (lang=zh)');
  else fail('the score reports lang=' + JSON.stringify(after.lang) + ' for a Chinese article');
}

/* ── 5. The ecosystem shape of scoreContent() is unchanged ────────────────
   Other repos copied this function. Fields may be ADDED; the four the old one
   returned may not move or vanish. */
{
  const s = scoreContent('A short English sentence for shape checking.');
  const required = ['wordCount', 'sentences', 'seoScore', 'readability'];
  const missing = required.filter((k) => !(k in s));
  if (!missing.length) pass('scoreContent() still returns ' + required.join(', '));
  else fail('scoreContent() no longer returns: ' + missing.join(', ') + ' — that is a breaking change');

  if (typeof s.wordCount === 'number' && typeof s.seoScore === 'number') {
    pass('wordCount and seoScore are still numbers');
  } else {
    fail('wordCount/seoScore changed type');
  }
}

console.log('');
if (failures) {
  console.error('✗ the scorer is not in the state this file pins (' + failures + ' failure(s))\n');
  process.exit(1);
}
console.log('✓ §0.7 is closed, and every other movement in the scorer is explained\n');

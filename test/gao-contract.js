'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   GAO reports what it measured, and nothing else.                 (Run 30)
   ───────────────────────────────────────────────────────────────────────────
   `gao.html` invented numbers and presented them as measurements:

     - an engine whose score the regex could not extract was given
       `Math.random()*30+10`, rendered with a trend label, averaged into the
       headline figure and written to history
     - the "Citations Found" tile was `Math.random()*15+5` — not a fallback,
       because nothing was attempted and nothing failed
     - the citation panel named G2.com, Capterra, TechCrunch, Forbes and Reddit
       with fixed percentages under "Frequently cited in AI answers"
     - the competitor panel ranked the user against "Competitor A" at `you+25`

   The ruling (Run 30 brief, under RULE 4a): never invent, and never
   hide the gap. An engine that did not answer is `null` — unscorable, leaves
   the denominator — never a low score, which is `scoringEngine.js`'s existing
   distinction in this ecosystem.

   Per checklist #21, added the day this run was written: EXECUTE the file.
   Runs 27–29 each found the buggy file loaded by no suite. This one extracts
   the real shipped functions from public/gao.html and runs them in a `vm`
   sandbox, reusing Run 29's harness shape.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripComments } = require('./lib/unchecked-fetch');

const APP = path.join(__dirname, '..');
const GAO = path.join(APP, 'public/gao.html');

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, e ?? '')); };

const html = fs.readFileSync(GAO, 'utf8');

/** Source of `[async] function <name>(...) { ... }`, brace-matched.
 *  Parameter list skipped first — a default value like `opts = {}` closes the
 *  brace count immediately (Run 29). */
function extractFn(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  if (src.slice(Math.max(0, start - 6), start).endsWith('async ')) start -= 6;
  const lp = src.indexOf('(', start);
  let pd = 0, ap = -1;
  for (let i = lp; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (!pd) { ap = i + 1; break; } }
  }
  if (ap < 0) return null;
  const open = src.indexOf('{', ap);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1); }
  }
  return null;
}

const NAMES = ['extractScores', 'responded', 'meanScore', 'updateHeadlineStats',
               'updateVisibilityScores', 'updateCitationMap', 'updateCompetitorList',
               'saveGAOResult', 'saveGAOAfterAnalysis'];
const SOURCES = {};
for (const n of NAMES) SOURCES[n] = extractFn(html, n);
ok('the suite found every function it claims to test (an anchor miss must FAIL, not pass — #14)',
   NAMES.every((n) => SOURCES[n] && SOURCES[n].length > 40),
   NAMES.filter((n) => !SOURCES[n]).join(',') || 'a body was too short');

/* ── THE SIMPLEST INVARIANT, AND THE HARDEST TO ARGUE WITH ────────────────── */
{
  // Comments stripped first. Both directions matter and Run 29 met both: a
  // comment mentioning the banned token would SATISFY nothing here but would
  // FALSELY FAIL this guard — this file's own comments quote `Math.random`
  // three times in order to explain what was removed. A guard that cannot
  // survive its own documentation gets deleted by the next person.
  const code = stripComments(html);
  const hits = (code.match(/Math\s*\.\s*random/g) || []);
  ok('NO Math.random survives anywhere in gao.html', hits.length === 0, `${hits.length} occurrence(s)`);
  // Non-vacuity: prove the scan is actually looking at the page's script.
  ok('…and the scan really did read the page body (an empty scan passes vacuously — #14)',
     /function extractScores/.test(code) && code.length > 20000, `${code.length} chars`);
}

/* ── A sandbox that is the page, minus the browser ────────────────────────── */
function sandbox() {
  const dom = {}, toasts = [], warns = [];
  const store = {};
  const el = (id) => (dom[id] = dom[id] || { textContent: '', innerHTML: '', style: {}, className: '', value: '' });
  const ctx = {
    document: { getElementById: el },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    toast: (m) => toasts.push(m),
    renderHistory: () => {},
    animateStat: (id, v) => { el(id).textContent = String(v); },
    console: { warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')), log: () => {} },
    setTimeout: (fn) => fn(),
    Math, JSON, Object, Date, Number, isNaN, parseInt, String, Array,
  };
  vm.createContext(ctx);
  vm.runInContext(Object.values(SOURCES).join('\n'), ctx);
  return { ctx, dom, toasts, warns, store };
}

// A model reply naming N engines with a percentage each. The rest go unmatched.
const reply = (pairs) => pairs.map(([name, pct]) => `${name} visibility is ${pct}%`).join('\n');
const ALL = [['ChatGPT', 70], ['Claude', 60], ['Gemini', 50], ['Perplexity', 40], ['DeepSeek', 30]];

(async () => {
  /* ── 1. AN UNMATCHED ENGINE YIELDS NO SCORE ──────────────────────────────── */
  {
    const { ctx } = sandbox();
    const scores = ctx.extractScores(reply(ALL.slice(0, 3)));
    ok('THE INVARIANT — an engine the regex cannot match gets null, not a number',
       scores.perplexity === null && scores.deepseek === null,
       JSON.stringify(scores));
    ok('…and a matched engine still scores exactly as before',
       scores.gpt === 70 && scores.claude === 60 && scores.gemini === 50, JSON.stringify(scores));
    ok('NEGATIVE CONTROL — no absent engine landed in the 10–40 band the invention used',
       ![scores.perplexity, scores.deepseek].some((v) => typeof v === 'number'), JSON.stringify(scores));
  }

  /* ── 2. THE AVERAGE IS OVER RESPONDERS, AND SO IS ITS DENOMINATOR ────────── */
  {
    const { ctx } = sandbox();
    const scores = ctx.extractScores(reply(ALL.slice(0, 3)));
    ok('the average is taken over responders only', ctx.meanScore(scores) === 60,
       String(ctx.meanScore(scores)));           // (70+60+50)/3, not /5
    ok('…and the denominator is the responder count', ctx.responded(scores).length === 3,
       String(ctx.responded(scores).length));
    ok('NEGATIVE CONTROL — absences do not drag the mean down as zeros would',
       ctx.meanScore(scores) !== 36, 'the mean was computed over all five');
  }

  /* ── 2b. THE DENOMINATOR IS DISPLAYED, AND CORRECT ───────────────────────
     The brief names this explicitly — "3 of 5 renders as 3 of 5" — and it was
     the one invariant nothing could reach, because the code lived inside
     runGAO behind a network call. A mutation that deleted the line entirely
     survived. It is now its own function, for exactly this reason. */
  {
    const { ctx, dom } = sandbox();
    ctx.updateHeadlineStats(ctx.extractScores(reply(ALL.slice(0, 3))), 4);
    ok('THE INVARIANT — the headline shows the responders-only mean',
       dom['stat-visibility'].textContent === 60, String(dom['stat-visibility'].textContent));
    ok('THE INVARIANT — and states its denominator, 3 of 5',
       dom['stat-visibility-denom'].textContent === 'from 3 of 5 engines',
       dom['stat-visibility-denom'].textContent);
    ok('the citations tile shows no number at all',
       dom['stat-citations'].textContent === '—', dom['stat-citations'].textContent);
  }
  {
    const { ctx, dom } = sandbox();
    ctx.updateHeadlineStats(ctx.extractScores(reply(ALL)), 4);
    ok('all five responding renders as 5 of 5, not as a bare number',
       dom['stat-visibility-denom'].textContent === 'from 5 of 5 engines',
       dom['stat-visibility-denom'].textContent);
  }
  {
    const { ctx, dom } = sandbox();
    ctx.updateHeadlineStats(ctx.extractScores('prose, no percentages'), 4);
    ok('no responders shows no headline number',
       dom['stat-visibility'].textContent === '--', String(dom['stat-visibility'].textContent));
    ok('…and says so in place of a denominator',
       /no engine responded/i.test(dom['stat-visibility-denom'].textContent),
       dom['stat-visibility-denom'].textContent);
  }

  /* ── 3. ALL FIVE UNMATCHED YIELDS NO HEADLINE, NOT ZERO ──────────────────── */
  {
    const { ctx } = sandbox();
    const scores = ctx.extractScores('The model replied with prose and no percentages at all.');
    ok('all five unmatched yields no headline score at all', ctx.meanScore(scores) === null,
       String(ctx.meanScore(scores)));
    ok('…and specifically NOT zero, which would claim every engine measured nothing',
       ctx.meanScore(scores) !== 0);
    ok('…and no engine responded', ctx.responded(scores).length === 0);
  }

  /* ── 4. AN ABSENCE RENDERS AS WORDS, NEVER AS A LOW BAR ──────────────────── */
  {
    const { ctx, dom } = sandbox();
    const scores = ctx.extractScores(reply(ALL.slice(0, 3)));
    ctx.updateVisibilityScores(scores);
    ok('a responder renders its measured number', dom['vis-gpt'].innerHTML.startsWith('70'),
       dom['vis-gpt'].innerHTML);
    ok('THE INVARIANT — a non-responder renders as words, not a number',
       /no response/i.test(dom['vis-perplexity'].textContent), dom['vis-perplexity'].textContent);
    ok('…its bar is empty rather than a short one that reads as poor performance',
       dom['vbar-perplexity'].style.width === '0%', dom['vbar-perplexity'].style.width);
    ok('…and it is NOT labelled with a trend',
       !/visibility|moderate/i.test(dom['vdelta-perplexity'].textContent),
       dom['vdelta-perplexity'].textContent);
    ok('…while a responder still gets its trend label',
       /good visibility/i.test(dom['vdelta-gpt'].textContent), dom['vdelta-gpt'].textContent);
  }

  /* ── 5. THE PANELS THAT MEASURED NOTHING SHOW NOTHING ────────────────────── */
  {
    const { ctx, dom } = sandbox();
    ctx.updateCitationMap('Acme', 'saas');
    const cite = dom['citation-list'];
    ok('the citation panel names no third party and shows no percentage',
       !/G2|Capterra|TechCrunch|Forbes|Reddit|%/.test(cite.textContent + cite.innerHTML),
       cite.textContent + cite.innerHTML);
    ok('…and says why it is empty', /not measured/i.test(cite.textContent), cite.textContent);

    ctx.updateCompetitorList('Acme', 'saas', ctx.extractScores(reply(ALL)));
    const comp = dom['competitor-list'];
    ok('the competitor panel invents no rivals',
       !/Competitor [ABC]|NaN|%/.test(comp.textContent + comp.innerHTML),
       comp.textContent + comp.innerHTML);
    ok('…and says why it is empty', /not measured/i.test(comp.textContent), comp.textContent);
  }

  /* ── 6. HISTORY CARRIES THE DENOMINATOR, AND REFUSES AN EMPTY RUN ────────── */
  {
    const { ctx, store } = sandbox();
    ctx.saveGAOResult('Acme', ctx.extractScores(reply(ALL.slice(0, 3))), 4);
    const h = JSON.parse(store.gao_history || '[]');
    ok('a recorded run stores the average over responders', h[0] && h[0].avg === 60, JSON.stringify(h[0]));
    ok('THE INVARIANT — and stores its denominator, so a later reader knows',
       h[0] && h[0].answered === 3 && h[0].engines === 5, JSON.stringify(h[0]));
    ok('…and names the best engine from among those that answered',
       h[0] && h[0].bestLLM === 'gpt' && h[0].bestScore === 70, JSON.stringify(h[0]));
  }
  {
    const { ctx, store, warns } = sandbox();
    ctx.saveGAOResult('Acme', ctx.extractScores('no percentages here'), 4);
    ok('a run where nothing responded is NOT written to history',
       !store.gao_history || JSON.parse(store.gao_history).length === 0, store.gao_history);
    ok('…and the reason is reported rather than swallowed',
       warns.some((w) => /no engine responded/i.test(w)), JSON.stringify(warns));
  }

  {
    /* The DOM re-read. saveGAOAfterAnalysis rebuilds `scores` from the rendered
       score cells, and dropping the non-responders there would make `engines`
       equal the number that answered — history reading "from 3 of 3", the
       denominator restored in one function and thrown away in the next. A
       mutation doing exactly that survived the first version of this suite. */
    const { ctx, dom, store } = sandbox();
    dom['brand-input'] = { value: 'Acme' };
    dom['prompts-input'] = { value: ['a','b','c'].join(String.fromCharCode(10)) };
    ctx.updateVisibilityScores(ctx.extractScores(reply(ALL.slice(0, 3))));
    ctx.saveGAOAfterAnalysis();
    const h = JSON.parse(store.gao_history || '[]');
    ok('THE INVARIANT — the DOM re-read keeps non-responders countable',
       h[0] && h[0].answered === 3 && h[0].engines === 5, JSON.stringify(h[0]));
  }

  /* ── 7. THE RATCHET FROM RUN 29 MUST NOT MOVE ────────────────────────────── */
  {
    const { scanFiles, targets, total } = require('./lib/unchecked-fetch');
    const n = total(scanFiles(APP, targets(APP)));
    ok('Run 29\'s unchecked-fetch ratchet is unchanged at 36', n === 36, String(n));
  }

  console.log(`\ngao-contract: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  fail += 1;
  console.log('  ❌ suite aborted before completing —', e.message);
  console.log(`\ngao-contract: ${pass} passed, ${fail} failed`);
  process.exit(1);
});

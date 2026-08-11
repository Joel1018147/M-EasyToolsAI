'use strict';
/* Mutation harness for gao-contract.js                            (Run 30)
 *
 * Break, watch it fail, restore from a byte backup, verify the md5, watch it
 * pass. NEVER `git checkout` (Run 22). Not in `npm test` — it rewrites source.
 * RED is judged on a non-zero EXIT (Run 27), anchors are \r?\n-agnostic
 * (Run 28), and an ANCHOR MISS counts as a survivor, never as a kill (Run 29).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const GAO = path.join(APP, 'public/gao.html');
const SUITE = path.join(__dirname, 'gao-contract.js');
const TARGETS = [GAO];

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const bak = (f) => `${f}.run30.bak`;

{
  const dirty = spawnSync('git', ['status', '--porcelain', '--', ...TARGETS],
    { encoding: 'utf8', cwd: APP }).stdout.trim();
  if (dirty) { console.error('Refusing to run: uncommitted changes.\n' + dirty); process.exit(2); }
}

const ORIGINAL = {};
for (const f of TARGETS) { fs.copyFileSync(f, bak(f)); ORIGINAL[f] = md5(f); }
const restore = () => {
  for (const f of TARGETS) {
    fs.copyFileSync(bak(f), f);
    if (md5(f) !== ORIGINAL[f]) throw new Error(`RESTORE FAILED for ${path.basename(f)}`);
  }
};
function run() {
  const r = spawnSync(process.execPath, [SUITE], { encoding: 'utf8', cwd: APP });
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || '');
  return {
    exit: r.status, pass: m ? +m[1] : NaN, fail: m ? +m[2] : NaN,
    named: (r.stdout || '').split('\n').filter((l) => l.startsWith('  ❌'))
      .map((l) => l.replace(/^ {2}❌ /, '').slice(0, 74)),
  };
}
function mutate(file, find, replace) {
  const s = fs.readFileSync(file, 'utf8');
  if (s.includes(find)) { fs.writeFileSync(file, s.replace(find, replace)); return; }
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
  if (!re.test(s)) throw new Error(`ANCHOR MISS: ${find.slice(0, 60)}`);
  fs.writeFileSync(file, s.replace(re, replace.replace(/\$/g, '$$$$')));
}

const MUTATIONS = [
  ['M1  the invented score returns (the original defect)', () =>
    mutate(GAO, 'scores[key] = match ? Math.min(parseInt(match[1]),100) : null;',
                'scores[key] = match ? Math.min(parseInt(match[1]),100) : Math.floor(Math.random()*30)+10;')],

  ['M2  an absent engine becomes 0 instead of null', () =>
    mutate(GAO, 'scores[key] = match ? Math.min(parseInt(match[1]),100) : null;',
                'scores[key] = match ? Math.min(parseInt(match[1]),100) : 0;')],

  ['M3  the average goes back over all five engines', () =>
    mutate(GAO, '  return Math.round(r.reduce((a,[,v]) => a+v, 0) / r.length);',
                '  return Math.round(r.reduce((a,[,v]) => a+v, 0) / Object.keys(scores).length);')],

  ['M4  no responders yields 0 instead of no headline', () =>
    mutate(GAO, '  if(!r.length) return null;', '  if(!r.length) return 0;')],

  // Anchor updated after the extraction: the line moved from inside runGAO into
  // updateHeadlineStats and its indent changed, so the old anchor MISSED. That
  // printed as ANCHOR ERROR and counted as a survivor, which is the only reason
  // it was visible — a harness that scored a miss as a kill would have reported
  // this invariant covered while testing nothing.
  ['M5  the denominator stops being displayed', () =>
    mutate(GAO, "    avgScore === null ? 'No engine responded' : `from ${answered} of ${total} engines`;",
                "    '';")],

  ['M6  an absent engine renders as a number with a trend again', () =>
    mutate(GAO, "    if(score === null){", "    if(false){")],

  ['M7  history stops recording its denominator', () =>
    mutate(GAO, '      answered: answered.length, engines: Object.keys(scores).length,', '')],

  ['M8  a run where nothing responded is recorded anyway', () =>
    mutate(GAO, "    if(avg === null){", "    if(false){")],

  ['M9  the fabricated citation sources come back', () =>
    mutate(GAO, "  document.getElementById('citation-list').textContent =\n    'Citation sources are not measured yet. This panel stays empty rather than showing figures nothing produced.';",
                "  document.getElementById('citation-list').innerHTML = '<div>G2.com 78%</div>';")],

  ['M10 the invented competitors come back', () =>
    mutate(GAO, "  document.getElementById('competitor-list').textContent =\n    'Competitor share of voice is not measured yet. This panel stays empty rather than ranking you against invented rivals.';",
                "  document.getElementById('competitor-list').innerHTML = '<div>Competitor A 95%</div>';")],

  ['M11 saveGAOAfterAnalysis drops non-responders, so history reads 3 of 3', () =>
    mutate(GAO, "      if(el){ const v = parseInt(el.textContent); scores[id] = isNaN(v) ? null : v; }",
                "      if(el){ const v = parseInt(el.textContent); if(!isNaN(v)) scores[id] = v; }")],
];

console.log('Baseline (unmutated):');
const base = run();
console.log(`  ${base.pass} passed, ${base.fail} failed, exit ${base.exit}\n`);
if (base.exit !== 0) { console.error('Baseline is not green — aborting.'); restore(); process.exit(1); }

const survived = [];
for (const [name, apply] of MUTATIONS) {
  restore();
  try { apply(); } catch (e) { console.log(`  ${name}\n    ANCHOR ERROR: ${e.message}`); survived.push(name); continue; }
  const red = run();
  restore();
  const green = run();
  const verdict = red.exit !== 0
    ? `RED ${Number.isNaN(red.pass) ? 'aborted' : `${red.pass}/${red.fail}`}, exit ${red.exit}`
    : '*** SURVIVED ***';
  if (red.exit === 0) survived.push(name);
  console.log(`  ${name}`);
  console.log(`    ${verdict}`);
  if (red.named.length) console.log(`    named: ${red.named.slice(0, 2).join(' | ')}`);
  console.log(`    restored: ${green.pass} passed, ${green.fail} failed`);
}

restore();
for (const f of TARGETS) fs.unlinkSync(bak(f));
console.log('\nBackup removed; gao.html verified byte-identical to the original.');
console.log(survived.length ? `\n${survived.length} MUTATION(S) NOT CAUGHT:\n  ${survived.join('\n  ')}` : '\nAll mutations caught.');
process.exit(survived.length ? 1 : 0);

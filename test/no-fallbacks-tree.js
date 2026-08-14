'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   GUARD B — RULE 6, the whole tree                                  (Run 41)
   ───────────────────────────────────────────────────────────────────────────
   Walks every product file in this repo and reports every banned shape in it.

   TWO MODES, AND ONLY ONE BIT DECIDES.

     ARMED = false  → REPORT-ONLY. Prints the real count and every
                      file:line:shape, prints that it is NOT A PASS, and
                      exits 0 so today's build does not go red.
     ARMED = true   → HARD FAIL. Any hit at all exits 1.

   `ARMED` is flipped to true for a repo when that repo's real count actually
   reaches zero — never at a baseline number, never with a list of allowed
   files. There is no threshold to raise and no path to exempt, which is the
   whole point: a decreasing ratchet is still a number someone raises at 5pm
   on a Friday, and a file-exemption list dissolves the rule one legitimate
   use at a time (recurring-bugs-checklist #13). One bit, whole repo, and it
   only ever moves in the direction of stricter.

   Arming a whole-tree hard guard across the ecosystem on the day it landed
   would have turned eleven builds red at once, which is not actionable — and
   the next person's fix for that is an exemption list. Guard A
   (`no-new-fallbacks.js`) is what stops the bleeding meanwhile: it is armed
   hard everywhere, today, because it only ever sees lines this branch added.

   READ `test/lib/no-fallbacks-scan.js`'s header before reading a zero here as
   a RULE 6 pass. Four mechanical shapes are not the rule.
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const scanner = require('./lib/no-fallbacks-scan.js');

/* ── the one bit ─────────────────────────────────────────────────────────
   Flip to true the moment this repo's count reaches zero, and never back. */
const ARMED = false;

const ROOT = path.join(__dirname, '..');

function main() {
  /* A scanner that has never been shown a violation has no evidence it can
     report one, and a broken one returns nothing — which looks exactly like a
     clean repo. Prove the shapes fire before trusting the count. */
  const checks = scanner.selfTest();

  const { files, hits } = scanner.scan(ROOT);

  /* An empty walk passes vacuously (#14). ESG's suite already guards this and
     the assertion is copied deliberately. */
  if (files.length < 5) {
    console.error(`\n  no-fallbacks-tree: the walk covered ${files.length} files. That is not a clean`);
    console.error('  repo, it is a broken walker. Nothing below can be trusted.\n');
    process.exit(1);
  }

  console.log('no-fallbacks-tree');
  console.log(`  ✓ scanner self-test: ${checks} shape checks`);
  console.log(`  ✓ walked ${files.length} product files (.js/.mjs/.cjs/.html, excluding node_modules test scripts migrations seed)`);

  const byShape = {};
  for (const h of hits) byShape[h.shape] = (byShape[h.shape] || 0) + 1;

  if (hits.length === 0) {
    if (ARMED) {
      console.log('\n  ARMED · 0 banned shapes. RULE 6 holds mechanically across this tree.\n');
      process.exit(0);
    }
    console.log('\n  0 banned shapes — this repo has reached zero.');
    console.log('  SET `ARMED = true` AT THE TOP OF THIS FILE so a regression fails the');
    console.log('  build instead of merely being printed.\n');
    process.exit(0);
  }

  for (const h of hits) console.log(`  ${scanner.format(h)}`);
  console.log(`\n  ${hits.length} banned shapes · ${Object.entries(byShape).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  if (ARMED) {
    console.error('\n  FAILED: this repo is ARMED and is no longer at zero.\n');
    process.exit(1);
  }

  console.error('\n  NOT A PASS: the whole-tree guard is in REPORT-ONLY mode. It printed the');
  console.error(`  ${hits.length} shapes above and did NOT fail the build, so nothing here has been`);
  console.error('  verified as clean and nothing has been enforced. This is not a pass.');
  console.error('  Guard A (no-new-fallbacks.js) is what is actually holding the line.\n');
  process.exit(0);
}

main();

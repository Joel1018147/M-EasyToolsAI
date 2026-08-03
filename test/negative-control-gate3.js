'use strict';

/**
 * Negative control for test/gate3-structure.js.
 *
 * Plants a genuine, un-allowlisted setTimeout into a real route file
 * (routes/subscription.js), runs gate3-structure.js as a subprocess, and
 * confirms it FAILS (exit code 1) and names the planted file/line. Restores
 * the original file in a `finally` block no matter what happens, so a
 * crash mid-test never leaves the repo modified.
 *
 * This proves the structural check actually catches a violation instead of
 * just always passing.
 *
 * Usage:
 *   node test/negative-control-gate3.js
 * Exit code 0 = the plant was correctly caught (negative control passed).
 * Exit code 1 = the plant was NOT caught — gate3-structure.js is broken.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_FILE = path.join(__dirname, '..', 'routes', 'subscription.js');
const GATE3_SCRIPT = path.join(__dirname, 'gate3-structure.js');

const PLANT_MARKER = '/* NEGATIVE-CONTROL-PLANT */';
const PLANT_LINE =
  `${PLANT_MARKER} setTimeout(() => { pool.query("UPDATE payments SET status='success' WHERE id=1"); }, 5000);\n`;

function main() {
  const original = fs.readFileSync(TARGET_FILE, 'utf8');
  let restored = false;

  function restore() {
    if (restored) return;
    fs.writeFileSync(TARGET_FILE, original, 'utf8');
    restored = true;
  }

  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });

  try {
    // Plant an un-allowlisted setTimeout that defers a business action
    // (mutating a payment row) — exactly the pattern the gate must catch.
    const planted = PLANT_LINE + original;
    fs.writeFileSync(TARGET_FILE, planted, 'utf8');

    let failedAsExpected = false;
    let output = '';
    try {
      output = execFileSync(process.execPath, [GATE3_SCRIPT], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // If execFileSync did NOT throw, gate3-structure.js exited 0 — that's
      // a failure of the negative control (the plant went undetected).
      failedAsExpected = false;
    } catch (err) {
      // execFileSync throws when the child process exits non-zero — this is
      // the EXPECTED path when the gate correctly fails on the plant.
      failedAsExpected = err.status === 1;
      output = (err.stdout || '') + (err.stderr || '');
    }

    const mentionsPlantedFile = output.includes('routes/subscription.js');

    if (failedAsExpected && mentionsPlantedFile) {
      console.log('Negative control PASS — gate3-structure.js correctly caught the planted setTimeout.');
      console.log(`  Detected in: routes/subscription.js:1 (planted line)`);
      restore();
      process.exit(0);
    }

    console.error('Negative control FAIL — gate3-structure.js did NOT catch the planted setTimeout.');
    console.error('--- gate3-structure.js output ---');
    console.error(output);
    restore();
    process.exit(1);
  } catch (err) {
    console.error('Negative control errored unexpectedly:', err.message);
    restore();
    process.exit(1);
  } finally {
    restore();
  }
}

main();

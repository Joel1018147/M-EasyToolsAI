'use strict';

/**
 * Gate 3 (Structure) — static check: no un-reviewed setTimeout/setInterval.
 *
 * Rule (Modus-Agent-OS/skills/three-stage-deploy-gate.md): any setTimeout/
 * setInterval used to DEFER OR SCHEDULE A BUSINESS ACTION (something that
 * needs to survive a Railway restart) is a bug — it must go through a
 * scheduled_jobs-backed job runner instead, because an in-process timer is
 * silently dropped on every deploy/restart.
 *
 * Network-I/O timeouts (fetch abort controllers) and graceful-shutdown
 * timers are NOT violations. Neither is a poll-loop setInterval that just
 * re-checks durable state in the database on a fixed cadence — if the
 * process restarts, the loop simply restarts too; no work is lost because
 * the loop itself isn't the source of truth, the DB is.
 *
 * This script recursively scans this platform's server-side route/helper/
 * middleware directories for setTimeout(/setInterval( calls, strips
 * comments first (a bug found on Dragon Ginseng: a doc-comment that merely
 * *mentions* setTimeout in prose triggered a false positive), and fails any
 * hit that isn't in the explicit ALLOWLIST below.
 *
 * No database needed — pure filesystem/regex scanning.
 *
 * Usage:
 *   node test/gate3-structure.js
 * Exit code 0 = pass, 1 = offenders found (listed on stderr/stdout).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Server-side directories that can contain business logic. Deliberately
// excludes public/ (client-side/browser JS — a setTimeout there runs in the
// user's tab, not on the server, so "survive a Railway restart" doesn't
// apply) and node_modules/.
const SCAN_TARGETS = [
  'server.js',
  'db.js',
  path.join('routes'),
  path.join('middleware'),
  path.join('helpers'), // doesn't exist yet on this platform; scanned if added later
];

// ── Explicit allowlist — every entry must carry a reason, never a blanket
// exemption for a whole file. Match is done against the RAW (pre-strip)
// source line text via `pattern` (a substring or regex-safe fragment).
const ALLOWLIST = [
  {
    file: 'server.js',
    pattern: 'setInterval(runScheduledTasks, 60 * 60 * 1000)',
    reason:
      "Hourly poll loop that re-checks durable subscription state in Postgres " +
      "(updateExpiredSubscriptions / sendTrialReminders in middleware/checkSub.js). " +
      "It is invoked once immediately on boot (runScheduledTasks()) and then re-armed " +
      "every hour; a Railway restart just re-starts the loop on the next boot — no " +
      "scheduled work is lost because the loop reads its state from the subscriptions " +
      "table, not from in-memory timer state. This is the job-runner poll-loop pattern, " +
      "not a deferred one-shot business action.",
  },
];

function isAllowlisted(relFile, rawLine) {
  return ALLOWLIST.some(
    (entry) => entry.file === relFile && rawLine.includes(entry.pattern)
  );
}

/**
 * Strip comments while preserving line numbers/positions, so matches are
 * still reported against the RAW source line. Handles /* block *\/ comments
 * (blanked out, newlines kept) and // line comments (blanked from // to EOL).
 * This is a pragmatic scanner, not a JS parser — it does not try to handle
 * // or /* appearing inside string/template literals or regex literals,
 * which is an acceptable trade-off for a lint-style structural gate.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inString = null; // ' " ` — tracks which quote we're inside
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      } else {
        out += ' ';
      }
      i++;
      continue;
    }

    if (inBlock) {
      if (c === '*' && c2 === '/') {
        out += '  ';
        i += 2;
        inBlock = false;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    if (inString) {
      out += c;
      if (c === '\\') {
        // preserve escaped char as-is (length-preserving, not comment-relevant)
        out += c2 === undefined ? '' : c2;
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i++;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i++;
      continue;
    }

    if (c === '/' && c2 === '/') {
      inLine = true;
      out += '  ';
      i += 2;
      continue;
    }

    if (c === '/' && c2 === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

function walk(target, files) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (abs.endsWith('.js')) files.push(abs);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(abs)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(path.join(target, entry), files);
    }
  }
}

function scan() {
  const files = [];
  for (const target of SCAN_TARGETS) walk(target, files);

  const offenders = [];

  for (const absFile of files) {
    const relFile = path.relative(ROOT, absFile).split(path.sep).join('/');
    const raw = fs.readFileSync(absFile, 'utf8');
    const stripped = stripComments(raw);

    const rawLines = raw.split('\n');
    const strippedLines = stripped.split('\n');

    for (let idx = 0; idx < strippedLines.length; idx++) {
      const line = strippedLines[idx];
      if (/\bsetTimeout\s*\(/.test(line) || /\bsetInterval\s*\(/.test(line)) {
        const lineNo = idx + 1;
        const rawLine = rawLines[idx] !== undefined ? rawLines[idx] : '';
        if (isAllowlisted(relFile, rawLine)) continue;
        offenders.push({ file: relFile, line: lineNo, text: rawLine.trim() });
      }
    }
  }

  return offenders;
}

function main() {
  const offenders = scan();
  if (offenders.length > 0) {
    console.error('Gate 3 FAIL — un-reviewed setTimeout/setInterval found:\n');
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.text}`);
    }
    console.error(
      '\nEach hit must either be added to the ALLOWLIST in test/gate3-structure.js ' +
      'with a written justification (network-I/O timeout, graceful shutdown, or an ' +
      'existing job-runner poll loop), or rewritten to use the scheduled_jobs table.'
    );
    process.exit(1);
  }

  console.log(
    `Gate 3 PASS — no un-reviewed setTimeout/setInterval ` +
    `(${ALLOWLIST.length} allowlisted exception${ALLOWLIST.length === 1 ? '' : 's'} reviewed).`
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { scan, stripComments, ALLOWLIST };

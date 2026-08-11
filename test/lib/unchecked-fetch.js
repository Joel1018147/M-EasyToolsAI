'use strict';
/* Find `fetch(` call sites whose Response is never checked.        (Run 29)
 *
 * `fetch` rejects only on a network failure. A 401, a 403, a 500 and a
 * rate-limit all RESOLVE, and `.json()` on them usually succeeds too — handing
 * the caller an error body that gets rendered as data. So a `try/catch` around
 * a fetch is not error handling; it only catches the case where the request
 * never left the machine.
 *
 * The rule this encodes: within a short window after a `fetch(`, the code must
 * look at `.ok` or at `.status`. It describes a SHAPE and names no file (#13) —
 * exported so both the guard and the run's reporting use one definition rather
 * than two that can drift.
 */

const fs = require('fs');
const path = require('path');

// How far after the `fetch(` to look. A checked call reads its response within
// a few lines; anything further away is a different statement.
const WINDOW = 12;

/** Sites in one source string. Returns [{line, snippet}] for the unchecked ones.
 *
 * The check must be on THE RESPONSE, not merely somewhere nearby. A first cut
 * looked for `.ok` or `.status` anywhere in the window and reported
 * server.js's Shopify products GET as checked — because the catch below it
 * calls `res.status(500)`. An express response object satisfying a guard about
 * a fetch response is exactly the kind of near-miss that makes a green scan
 * worthless, so the response variable is captured and the check is required to
 * name it.
 */
/* Blank out comments, keeping line numbers intact.
 *
 * Both directions matter. A comment that mentions `res.ok` would otherwise
 * SATISFY the guard over unchecked code — the worse failure — and a long
 * comment between the fetch and its check pushes the check outside the window,
 * which is how this guard first reported the very site it had just been used to
 * fix. Only whole-line `//` comments are removed, so `https://` inside a URL
 * survives.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');
}

function scanSource(rawSrc) {
  const src = stripComments(rawSrc);
  const lines = src.split(/\r?\n/);
  const out = [];
  lines.forEach((ln, i) => {
    if (!/\bfetch\s*\(/.test(ln)) return;
    const window = lines.slice(i, i + WINDOW).join('\n');

    // `const r = await fetch(…)` / `let res = fetch(…)` — the common form.
    const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fetch\s*\(/.exec(ln);
    if (assigned) {
      const v = assigned[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${v}\\s*\\.\\s*(ok|status)\\b`).test(window)) return;
      out.push({ line: i + 1, snippet: ln.trim().slice(0, 120) });
      return;
    }

    // `fetch(…).then(r => r.ok ? … : …)` — the response is named in the arrow.
    if (/\.\s*then\s*\(/.test(window) && /\.\s*(ok|status)\b/.test(window)) return;

    // Anything else — a bare `await fetch(…)` with no binding — cannot have
    // been checked, because nothing holds the response.
    out.push({ line: i + 1, snippet: ln.trim().slice(0, 120) });
  });
  return out;
}

/** Scan files, returning { file: [{line, snippet}] } for files with hits. */
function scanFiles(root, relPaths) {
  const report = {};
  for (const rel of relPaths) {
    const abs = path.join(root, rel);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const hits = scanSource(src);
    if (hits.length) report[rel] = hits;
  }
  return report;
}

/** Every tracked page plus the server, so the guard can never be scoped down. */
function targets(root) {
  const pages = fs.readdirSync(path.join(root, 'public'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => `public/${f}`);
  return ['server.js', ...pages];
}

function total(report) {
  return Object.values(report).reduce((n, hits) => n + hits.length, 0);
}

module.exports = { scanSource, scanFiles, targets, total, stripComments, WINDOW };

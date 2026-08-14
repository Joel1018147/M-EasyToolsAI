'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   RULE 6 — the shape scanner                                        (Run 41)
   ───────────────────────────────────────────────────────────────────────────
   BYTE-IDENTICAL IN ALL TWELVE REPOS. If you change it here, change it
   everywhere; `no-fallbacks-tree.js` asserts nothing about that, but a
   scanner that has drifted between repos makes the per-repo counts
   incomparable, which is the only thing they are for.

   This module is NOT a test. It returns hits. `test/no-new-fallbacks.js`
   (added lines only, hard fail) and `test/no-fallbacks-tree.js` (whole tree)
   are the two guards that consume it.

   ── WHAT IT MATCHES ────────────────────────────────────────────────────────
   Shapes, never files. A guard with a file-exemption list dissolves one
   legitimate use at a time (recurring-bugs-checklist #13), so no path is ever
   named here and none may be added.

     1. empty-catch           `catch (e) {}` · `catch {}`
     2. catch-arrow-empty     `.catch(() => {})`
     3. comment-only-catch    a catch whose body is nothing but comments —
                              "connection already gone" and the like
     4. catch-arrow-substitute
                              `.catch(() => ({}))` · `.catch(() => [])`
                              `.catch(() => null)` · `.catch(() => '')`

   1 and 2 are the three Run 24 already had. 3 and 4 are two of the three
   blind spots the Run 26 audit named (`context/rule6-audit.md` §0). The third
   — non-`.js` files — is closed by walking `.html` as well, because an inline
   `<script>` is product code.

   ── WHAT IT CANNOT MATCH, AND WILL NOT PRETEND TO ──────────────────────────
   Blind spot #4 of that audit is NOT mechanical. A catch that *does*
   something and still substitutes — ESG's `extractionService.js:189` writes an
   honest `ok=false` audit row and continues, so nothing surfaces the failure —
   is a CRITICAL that every regex in this file scores clean. So does a missing
   `res.ok` check, an `await fetch(...)` whose Response is never inspected, a
   record written before the operation it attests to, and a substitute that
   makes a *downstream* guard skip. Those are §5 of the audit, they are 24 of
   the ecosystem's 24 CRITICALs, and they need a reader, not a pattern.

   **A green scan from this file is not a RULE 6 pass. It is the absence of
   four mechanical shapes.** Do not let it imply coverage it does not have.

   ── WINDOWS / CRLF ─────────────────────────────────────────────────────────
   Every shape is matched with `\s`, which spans `\r\n`, and the body walker
   below consumes `\r` explicitly. Line numbers are counted off `\n`, so a
   CRLF file reports the same line a CR-stripped one would. Fix the regex,
   never the file (the `standardFontDataUrl` lesson).
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* Directories are excluded by NAME at any depth. `test/` and `scripts/` are
   out because a guard's own fixtures and a one-shot migration script are not
   product code; `migrations/` and `seed/` for the same reason. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'test', 'scripts', 'migrations', 'seed']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html']);

/* ── walk ────────────────────────────────────────────────────────────────── */
function walk(root) {
  const out = [];
  (function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name)) rec(full); }
      else if (e.isFile() && EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  })(root);
  return out.sort();
}

/* ── mask ─────────────────────────────────────────────────────────────────
   Blank out comments, string bodies and regex-literal bodies so that a shape
   found afterwards is certainly code and not prose. Delimiters are KEPT, so
   `''` survives as `''` (a real substitute) while `'anything'` becomes
   `'       '` (not one). Comments are blanked whole. Offsets and every `\n`
   are preserved, so an index into the mask is an index into the original.

   This matters: the sentence documenting a banned shape contains the shape.
   Scanning raw text reports every properly-commented fix as a violation —
   which is checklist #16's "strip comments first", learned the hard way. */
const REGEX_MAY_FOLLOW = /[({[,;:=!&|?+\-*/%~^<>]$|\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

function mask(src) {
  const out = src.split('');
  const blank = (from, to, keepEnds) => {
    for (let k = keepEnds ? from + 1 : from; k < (keepEnds ? to - 1 : to); k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  let lastCode = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      let j = i; while (j < src.length && src[j] !== '\n') j++;
      blank(i, j, false); i = j; continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e === -1 ? src.length : e + 2;
      blank(i, j, false); i = j; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (c !== '`' && src[j] === '\n') break;   // unterminated — bail, don't eat the file
        j++;
      }
      blank(i, j, true); lastCode = c; i = j; continue;
    }
    if (c === '/' && REGEX_MAY_FOLLOW.test(lastCode)) {
      let j = i + 1, cls = false, ok = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '\n') break;
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) { j++; ok = true; break; }
        j++;
      }
      if (ok) { blank(i, j, true); lastCode = '/'; i = j; continue; }
    }
    if (!/\s/.test(c)) lastCode = (lastCode + c).slice(-12);
    i++;
  }
  return out.join('');
}

/* ── line numbers ─────────────────────────────────────────────────────────
   Counted off `\n` only, so CRLF and LF agree. */
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

/* ── the catch body ───────────────────────────────────────────────────────
   Read forward from `{` over whitespace and comments ONLY. The first thing
   that is neither ends the question: if it is `}` the body was empty (or
   comment-only), and anything else means real code and no hit. Nothing here
   needs to balance braces, because a body with a `{` in it is real code by
   definition. `\r` is consumed like any other whitespace. */
function catchBody(src, braceIdx) {
  let i = braceIdx + 1;
  let sawComment = false;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { sawComment = true; while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      sawComment = true;
      const e = src.indexOf('*/', i + 2);
      if (e === -1) return null;
      i = e + 2; continue;
    }
    if (c === '}') return { shape: sawComment ? 'comment-only-catch' : 'empty-catch', end: i };
    return null;
  }
  return null;
}

/* ── the shapes ───────────────────────────────────────────────────────────
   A `catch` keyword that is not a property access (`.catch` is the callback
   form, matched separately below), optionally parameterised, opening a block. */
const CATCH_BLOCK = /(^|[^.\w$])catch\s*(?:\(\s*[^)]*\)\s*)?\{/g;

const ARROW = String.raw`(?:\(\s*(?:[A-Za-z_$][\w$]*)?\s*\)|[A-Za-z_$][\w$]*)`;
/* `{}` is the empty BLOCK — group 1's `.catch(() => {})`. The rest are the
   substitutes: an object, an array, a null or an empty string handed back as
   though the call had succeeded. */
const EMPTY_BLOCK = String.raw`\{\s*\}`;
const SUBSTITUTE = String.raw`(?:\(\s*\{\s*\}\s*\)|\[\s*\]|\(\s*\[\s*\]\s*\)|null|\(\s*null\s*\)|''|\(\s*''\s*\)|""|\(\s*""\s*\))`;
const CATCH_ARROW_EMPTY = new RegExp(String.raw`\.catch\s*\(\s*${ARROW}\s*=>\s*${EMPTY_BLOCK}\s*\)`, 'g');
const CATCH_ARROW_SUBSTITUTE = new RegExp(String.raw`\.catch\s*\(\s*${ARROW}\s*=>\s*${SUBSTITUTE}\s*\)`, 'g');

/* ── scan one source fragment ─────────────────────────────────────────────
   `lineOffset` is added so an inline <script> reports the line of the FILE,
   not of the fragment. */
function scanSource(src, lineOffset) {
  const off = lineOffset || 0;
  const masked = mask(src);
  const lineAt = lineIndex(src);
  const hits = [];

  CATCH_BLOCK.lastIndex = 0;
  let m;
  while ((m = CATCH_BLOCK.exec(masked)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const body = catchBody(src, braceIdx);        // the ORIGINAL: comments must be visible
    if (body) {
      hits.push({
        line: lineAt(m.index + m[1].length) + off,
        endLine: lineAt(body.end) + off,
        shape: body.shape,
      });
    }
  }
  // Matched against the MASK, so a comment inside the body has already been
  // blanked — which is how an arrow catch whose body is only a reassuring
  // comment gets caught at all. Re-read the original span to label it
  // honestly: comments rather than nothing is blind spot #1, not an empty
  // block.
  CATCH_ARROW_EMPTY.lastIndex = 0;
  while ((m = CATCH_ARROW_EMPTY.exec(masked)) !== null) {
    const raw = src.slice(m.index, m.index + m[0].length);
    hits.push({
      line: lineAt(m.index) + off,
      endLine: lineAt(m.index + m[0].length - 1) + off,
      shape: /\/\*|\/\//.test(raw) ? 'comment-only-catch' : 'catch-arrow-empty',
    });
  }
  CATCH_ARROW_SUBSTITUTE.lastIndex = 0;
  while ((m = CATCH_ARROW_SUBSTITUTE.exec(masked)) !== null) {
    hits.push({
      line: lineAt(m.index) + off,
      endLine: lineAt(m.index + m[0].length - 1) + off,
      shape: 'catch-arrow-substitute',
    });
  }
  return hits.sort((a, b) => a.line - b.line || a.shape.localeCompare(b.shape));
}

/* ── scan one file ────────────────────────────────────────────────────────
   For `.html` only the inline <script> bodies are product code. A <script
   src=...> has no body to read, and static markup is not JavaScript. */
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function scanText(text, ext) {
  if (ext !== '.html') return scanSource(text, 0);
  const hits = [];
  const lineAt = lineIndex(text);
  SCRIPT_TAG.lastIndex = 0;
  let m;
  while ((m = SCRIPT_TAG.exec(text)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const bodyStart = m.index + m[0].indexOf('>', 0) + 1;
    hits.push(...scanSource(m[2], lineAt(bodyStart) - 1));
  }
  return hits.sort((a, b) => a.line - b.line || a.shape.localeCompare(b.shape));
}

/* ── the public entry point ───────────────────────────────────────────────
   Returns { root, files, hits } where each hit is
   { file (repo-relative, forward slashes), line, shape }. */
function scan(root) {
  const base = root || path.join(__dirname, '..', '..');
  const files = walk(base);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(base, f).split(path.sep).join('/');
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (err) {
      throw new Error(`no-fallbacks-scan could not read ${rel}: ${err.message}`);
    }
    for (const h of scanText(text, path.extname(f).toLowerCase())) {
      hits.push({ file: rel, line: h.line, endLine: h.endLine, shape: h.shape });
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { root: base, files: files.map((f) => path.relative(base, f).split(path.sep).join('/')), hits };
}

function format(hit) { return `${hit.file}:${hit.line}:${hit.shape}`; }

/* ── selfTest ─────────────────────────────────────────────────────────────
   Both guards call this BEFORE they trust a count. A scanner that has never
   been shown a violation has no evidence it can report one, and a scanner
   silently returning nothing looks exactly like a clean repo
   (test-harness-integrity-audit.md, MUST). These fixtures are strings, not
   files, so nothing has to be planted in the tree to prove the shapes fire —
   and every one of them is a shape a real repo has shipped.

   Throws on the first disagreement. Returns the number of checks that ran. */
function selfTest() {
  const checks = [];
  const has = (label, text, shape, ext) => {
    const hits = scanText(text, ext || '.js');
    checks.push(label);
    if (!hits.some((h) => h.shape === shape)) {
      throw new Error(`no-fallbacks-scan selfTest: "${label}" should be a ${shape} hit and was not — the scanner is broken, the repo is not clean`);
    }
  };
  const hasNot = (label, text, ext) => {
    const hits = scanText(text, ext || '.js');
    checks.push(label);
    if (hits.length) {
      throw new Error(`no-fallbacks-scan selfTest: "${label}" is not a violation but produced ${hits.map((h) => h.shape).join(', ')}`);
    }
  };

  has('catch (e) {}', 'try { a(); } catch (e) {}', 'empty-catch');
  has('catch {}', 'try { a(); } catch {}', 'empty-catch');
  has('.catch(() => {})', 'p().catch(() => {});', 'catch-arrow-empty');

  // Blind spot #1 — a body that is nothing but a reassuring comment.
  has('comment-only block body', 'try { a(); } catch (e) { // connection already gone\n}', 'comment-only-catch');
  has('comment-only arrow body', 'p().catch(() => { /* the form still works */ });', 'comment-only-catch');

  // Blind spot #3 — the parenthesised substitutes, replicated across seven
  // auth portals.
  has('.catch(() => ({}))', 'const d = await p().catch(() => ({}));', 'catch-arrow-substitute');
  has('.catch(() => [])', 'const d = await p().catch(() => []);', 'catch-arrow-substitute');
  has('.catch(() => null)', 'const d = await p().catch(() => null);', 'catch-arrow-substitute');
  has(".catch(() => '')", "const d = await p().catch(() => '');", 'catch-arrow-substitute');

  // Blind spot #2 — an inline <script> is product code. This is the one that
  // let ESG's public/index.html:287 survive Run 24 while its three siblings
  // in src/utils/layout.js were fixed.
  has('inline <script> in .html',
    '<html><body>\n<div></div>\n<script>\ntry { a(); } catch (e) {}\n</script>\n</body></html>', 'empty-catch', '.html');

  // CRLF. Windows is where this runs. `\s` spans \r\n and the body walker
  // eats \r, so the same source with CRLF endings must give the same answer.
  has('CRLF block form', 'try {\r\n  a();\r\n} catch (e) {\r\n}\r\n', 'empty-catch');
  has('CRLF comment-only', 'try {\r\n  a();\r\n} catch (e) {\r\n  // gone\r\n}\r\n', 'comment-only-catch');

  // And the things that must NOT fire. A guard that reports the sentence
  // documenting a banned shape is the #16 trap, and it fired on the first
  // run of the guard written for that.
  hasNot('the shape named inside a line comment', '// never write catch (e) {} here\nconst x = 1;\n');
  hasNot('the shape named inside a block comment', '/* banned: catch {} and .catch(() => {}) */\nconst x = 1;\n');
  hasNot('the shape named inside a string', "const msg = 'catch (e) {} is banned';\n");
  hasNot('a catch that reports', "try { a(); } catch (e) { console.error('load failed:', e); throw e; }");
  hasNot('a non-empty string substitute', "p().catch(() => 'a real named failure state');");

  return checks.length;
}

module.exports = { scan, scanText, scanSource, walk, mask, format, selfTest, EXCLUDED_DIRS, EXTENSIONS };

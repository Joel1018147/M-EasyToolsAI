'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   RULE 6 — the shape scanner                            (Run 41, Run 43)
   ───────────────────────────────────────────────────────────────────────────
   BYTE-IDENTICAL IN ALL TWELVE REPOS. If you change it here, change it
   everywhere; a scanner that has drifted between repos makes the per-repo
   counts incomparable, which is the only thing they are for.

   This module is NOT a test. It returns hits. `test/no-new-fallbacks.js`
   (added lines only, hard fail) and `test/no-fallbacks-tree.js` (whole tree)
   are the two guards that consume it.

   ── WHAT IT MATCHES ────────────────────────────────────────────────────────
   Shapes, never files. A guard with a file-exemption list dissolves one
   legitimate use at a time (recurring-bugs-checklist #13), so no path is ever
   named here and none may be added.

     empty-catch            `catch (e) {}` · `catch {}`
     catch-cb-empty         `.catch(() => {})` · `.catch(function () {})`
     comment-only-catch     a catch body that is nothing but comments
     catch-substitute       `.catch(() => ({}))` · `(null)` · `([])` · `('')`
                            and `.catch(function () { return {}; })`
     catch-substitute-value `.catch(() => ({ rows: [] }))` — a substitute that
                            is not merely empty but plausibly shaped

   BOTH SPELLINGS OF EVERY SHAPE. A guard that bans `() => {}` and permits
   `function () {}` is defeated by rewriting, which is worse than not having
   it. The arrow form and the function form are read through one classifier.

   ── THE ONE EXEMPTION, AND IT IS A SHAPE ───────────────────────────────────
   `rule6-audit.md` §4 and §7 ruled `res.json().catch(() => ({}))` legitimate,
   centrally, across twenty-one sites in seven repos:

       const data = await res.json().catch(() => ({}));
       if (res.ok) { … }         // ← the verdict comes from res.ok, not data

   The substitute covers ONLY the body of a Response whose success or failure
   is already known and still intact. Nothing failed silently.

   So the exemption is conditional and the condition is CHECKED, not assumed:

     1. the `.catch` is chained directly off a `.json()` call, AND
     2. that call's receiver is a plain identifier, AND
     3. `<receiver>.ok` or `<receiver>.status` appears within OK_CHECK_WINDOW
        lines EITHER SIDE — the check sits below it in the auth portals and
        above it in the settings pages, and both are correct.

   `.catch(() => ({}))` on a database query, on a service call, or on a
   `.json()` whose `ok` is never read, is still a hit. A receiver that is not a
   plain identifier is still a hit — the check cannot be located, so it is not
   assumed to exist. No path is named, so nothing here can be dissolved by
   adding one.

   ── WHAT IT CANNOT MATCH, AND WILL NOT PRETEND TO ──────────────────────────
   Blind spot #4 of the Run 26 audit is NOT mechanical. A catch that *does*
   something and still substitutes — ESG's `extractionService.js:189` writes an
   honest `ok=false` audit row and continues, so nothing surfaces the failure —
   is a CRITICAL that every regex in this file scores clean. So does a missing
   `res.ok` check, an `await fetch(...)` whose Response is never inspected, a
   record written before the operation it attests to, and a substitute that
   makes a *downstream* guard skip. Those need a reader, not a pattern.

   **A green scan from this file is not a RULE 6 pass. It is the absence of a
   handful of mechanical shapes.**

   ── WINDOWS / CRLF ─────────────────────────────────────────────────────────
   Every shape is matched with `\s`, which spans `\r\n`, and the body walker
   consumes `\r` explicitly. Line numbers are counted off `\n`, so a CRLF file
   reports the same line an LF one would. Fix the regex, never the file.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'test', 'scripts', 'migrations', 'seed']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html']);

/* How far below the `.json().catch(…)` the `ok` check may sit and still count.
   In every one of the ruled auth-portal sites, and in every `.catch(function
   () { return {}; })` site in the three CS forks, the check is on the very
   NEXT line. Five lines is enough to survive a blank line, a comment, or an
   intervening destructure, and short enough that it cannot reach a check
   belonging to a different request further down the function. */
const OK_CHECK_WINDOW = 5;

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
   Blank out comments, quoted-string bodies and regex-literal bodies so that a
   shape found afterwards is certainly code and not prose. Delimiters are KEPT,
   so `''` survives as `''` (a real substitute) while `'anything'` becomes
   `'       '` (not one). Offsets and every `\n` are preserved, so an index into
   the mask is an index into the original.

   This matters: the sentence documenting a banned shape contains the shape.
   Scanning raw text reports every properly-commented fix as a violation —
   checklist #16's "strip comments first", learned the hard way.

   TEMPLATE LITERALS ARE DELIBERATELY LEFT UNMASKED (Run 43). Blanking them
   made the scanner blind to every inline <script> this ecosystem SERVER-
   RENDERS, which is most of its browser code: Commerce writes its entire
   client layer inside backticks in `src/routes/*.js`, and Run 41 reported
   `payments.js` clean while `:172` held a bare `.catch(function(){})`. That is
   Run 26 blind spot #2 again — walking `.html` closed the static half and left
   the generated half open, which is exactly where the audit said the un-fixed
   copy hides. The cost is that a banned shape written inside a template's own
   comment can be reported; the catch-body reader still reads real text, so it
   is classified correctly when it is a real catch. */
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
    if (c === '`') {
      /* Skip the whole template WITHOUT blanking it. `${…}` may nest braces
         and further templates, so brace depth is tracked and a backtick only
         closes at depth 0. */
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '{') { depth++; j++; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth === 0 && src[j] === '`') { j++; break; }
        j++;
      }
      lastCode = '`'; i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;   // unterminated — bail, don't eat the file
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

/* ── the catch block body ─────────────────────────────────────────────────
   Read forward from `{` over whitespace and comments ONLY. The first thing
   that is neither ends the question: if it is `}` the body was empty (or
   comment-only), and anything else means real code and no hit. Nothing here
   needs to balance braces, because a body with a `{` in it is real code by
   definition. `\r` is consumed like any other whitespace. */
function readEmptyBody(src, braceIdx) {
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
    if (c === '}') return { commentsOnly: sawComment, end: i };
    return null;
  }
  return null;
}

/* ── balanced read of a `.catch( … )` argument list ───────────────────────
   Run against the MASK, where quoted strings and comments are already blanked,
   so their braces cannot unbalance the count. */
function readCall(masked, openIdx) {
  let d = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') d++;
    else if (c === ')' || c === '}' || c === ']') { d--; if (d === 0) return i; }
  }
  return -1;
}

/* ── classify what a callback hands back ──────────────────────────────────
   `expr` is the trimmed text a `.catch` callback evaluates to. Returns a shape
   name, or null when it is real error handling. */
/* Each is written with the parenthesised and bare forms as explicit
   alternatives rather than an optional `(`, so `({}` cannot match. The arrow
   spelling needs the parens — `() => ({})` — and the function spelling does
   not — `function () { return {}; }` — and they are the same substitute. */
const RE_EMPTY_OBJ = /^(?:\{\s*\}|\(\s*\{\s*\}\s*\))$/;
const RE_EMPTY_ARR = /^(?:\[\s*\]|\(\s*\[\s*\]\s*\))$/;
const RE_NULLISH = /^(?:null|undefined|\(\s*(?:null|undefined)\s*\))$/;
const RE_EMPTY_STR = /^(?:''|""|\(\s*(?:''|"")\s*\))$/;
const RE_VALUE_OBJ = /^(?:\{[\s\S]*\S[\s\S]*\}|\(\s*\{[\s\S]*\S[\s\S]*\}\s*\))$/;
const RE_VALUE_ARR = /^(?:\[[\s\S]*\S[\s\S]*\]|\(\s*\[[\s\S]*\S[\s\S]*\]\s*\))$/;

function classifySubstitute(expr) {
  const e = expr.trim().replace(/;$/, '').trim();
  if (RE_EMPTY_OBJ.test(e)) return { shape: 'catch-substitute', emptyObject: true };
  if (RE_EMPTY_ARR.test(e) || RE_NULLISH.test(e) || RE_EMPTY_STR.test(e)) return { shape: 'catch-substitute', emptyObject: false };
  if (RE_VALUE_OBJ.test(e) || RE_VALUE_ARR.test(e)) return { shape: 'catch-substitute-value', emptyObject: false };
  return null;
}

/* ── the ruled exemption ──────────────────────────────────────────────────
   True only when the `.catch` hangs off `<ident>.json()` and `<ident>.ok` or
   `<ident>.status` is read within OK_CHECK_WINDOW lines EITHER SIDE.

   Both directions are load-bearing, and the second was found by running this
   against the real files rather than against a copy of the regex:

     const data = await res.json().catch(() => ({}));
     if (res.ok) { … }                          // ← below  (the auth portals)

     if (res.ok) { location.href = '/'; return; }
     const data = await res.json().catch(() => ({}));   // ← above (settings
     showError(data.error || 'Could not deactivate');   //   deactivate/export)

   The second is if anything the more correct of the two — success has already
   returned, so the body is only ever read on a Response known to have failed.
   A forward-only window would flag it, which is how a guard earns a reputation
   for crying wolf and then gets switched off. */
const RE_JSON_RECEIVER = /([A-Za-z_$][\w$]*)\s*\.\s*json\s*\(\s*\)\s*$/;

function okCheckNearby(masked, dotCatchIdx, callEnd) {
  const before = masked.slice(Math.max(0, dotCatchIdx - 120), dotCatchIdx);
  const m = RE_JSON_RECEIVER.exec(before);
  if (!m) return false;
  const recv = m[1];

  let lo = dotCatchIdx;
  let seen = 0;
  while (lo > 0 && seen <= OK_CHECK_WINDOW) { lo--; if (masked[lo] === '\n') seen++; }

  let hi = callEnd;
  seen = 0;
  while (hi < masked.length && seen <= OK_CHECK_WINDOW) { if (masked[hi] === '\n') seen++; hi++; }

  const window = masked.slice(lo, hi);
  return new RegExp(`\\b${recv.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:ok|status)\\b`).test(window);
}

/* ── the shapes ───────────────────────────────────────────────────────────
   A `catch` keyword that is not a property access — `.catch` is the callback
   form, handled separately. */
const CATCH_BLOCK = /(^|[^.\w$])catch\s*(?:\(\s*[^)]*\)\s*)?\{/g;
const CATCH_CALLBACK = /\.catch\s*\(/g;
const RE_ARROW_HEAD = /^\s*(?:\(\s*(?:[A-Za-z_$][\w$]*)?\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*/;
const RE_FUNCTION_HEAD = /^\s*function\s*[A-Za-z_$][\w$]*?\s*\(|^\s*function\s*\(/;

function scanSource(src, lineOffset) {
  const off = lineOffset || 0;
  const masked = mask(src);
  const lineAt = lineIndex(src);
  const hits = [];
  const push = (idx, endIdx, shape) => hits.push({ line: lineAt(idx) + off, endLine: lineAt(endIdx) + off, shape });

  /* try/catch blocks */
  CATCH_BLOCK.lastIndex = 0;
  let m;
  while ((m = CATCH_BLOCK.exec(masked)) !== null) {
    const braceIdx = m.index + m[0].length - 1;
    const body = readEmptyBody(src, braceIdx);        // the ORIGINAL: comments must be visible
    if (body) push(m.index + m[1].length, body.end, body.commentsOnly ? 'comment-only-catch' : 'empty-catch');
  }

  /* .catch(callback) — arrow and function spellings through one classifier */
  CATCH_CALLBACK.lastIndex = 0;
  while ((m = CATCH_CALLBACK.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = readCall(masked, open);
    if (close === -1) continue;
    const inner = masked.slice(open + 1, close);

    let bodyStartInInner = -1;
    let isBlockBody = false;
    let expr = null;

    const arrow = RE_ARROW_HEAD.exec(inner);
    const fn = RE_FUNCTION_HEAD.exec(inner);
    if (arrow) {
      const rest = inner.slice(arrow[0].length);
      if (rest.trimStart().startsWith('{')) {
        isBlockBody = true;
        bodyStartInInner = arrow[0].length + rest.indexOf('{');
      } else {
        expr = rest;
      }
    } else if (fn) {
      const b = inner.indexOf('{', fn[0].length - 1);
      if (b === -1) continue;
      isBlockBody = true;
      bodyStartInInner = b;
    } else {
      continue;   // `.catch(handler)` — a named function, not a shape
    }

    if (isBlockBody) {
      const braceAbs = open + 1 + bodyStartInInner;
      const body = readEmptyBody(src, braceAbs);
      if (body) { push(m.index, body.end, body.commentsOnly ? 'comment-only-catch' : 'catch-cb-empty'); continue; }
      /* a body that is only `return <substitute>;` is the same shape written
         the long way — `.catch(function () { return {}; })` */
      const inside = masked.slice(braceAbs + 1, close).trim().replace(/\}$/, '').trim();
      const ret = /^return\b([\s\S]*)$/.exec(inside);
      if (!ret) continue;
      expr = ret[1];
    }

    const verdict = classifySubstitute(expr);
    if (!verdict) continue;
    if (verdict.emptyObject && okCheckNearby(masked, m.index, close)) continue;  // the ruled shape
    push(m.index, close, verdict.shape);
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
   { file (repo-relative, forward slashes), line, endLine, shape }. */
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
   files, so nothing has to be planted to prove the shapes fire — and every one
   of them is a shape a real repo has shipped.

   Throws on the first disagreement. Returns the number of checks that ran. */
function selfTest() {
  let n = 0;
  const has = (label, text, shape, ext) => {
    n += 1;
    const hits = scanText(text, ext || '.js');
    if (!hits.some((h) => h.shape === shape)) {
      throw new Error(`no-fallbacks-scan selfTest: "${label}" should be a ${shape} hit and was not (got: ${hits.map((h) => h.shape).join(', ') || 'nothing'}) — the scanner is broken, the repo is not clean`);
    }
  };
  const hasNot = (label, text, ext) => {
    n += 1;
    const hits = scanText(text, ext || '.js');
    if (hits.length) {
      throw new Error(`no-fallbacks-scan selfTest: "${label}" is not a violation but produced ${hits.map((h) => h.shape).join(', ')}`);
    }
  };

  /* the try/catch block */
  has('catch (e) {}', 'try { a(); } catch (e) {}', 'empty-catch');
  has('catch {}', 'try { a(); } catch {}', 'empty-catch');
  has('comment-only block body', 'try { a(); } catch (e) { // connection already gone\n}', 'comment-only-catch');

  /* the callback, BOTH spellings — a guard that bans one and permits the
     other is defeated by rewriting */
  has('.catch(() => {})', 'p().catch(() => {});', 'catch-cb-empty');
  has('.catch(function () {})', 'p().catch(function () {});', 'catch-cb-empty');
  has('.catch(function (e) {})', 'p().catch(function (e) {});', 'catch-cb-empty');
  has('comment-only arrow body', 'p().catch(() => { /* the form still works */ });', 'comment-only-catch');
  has('comment-only function body', 'p().catch(function () { /* leave the placeholder */ });', 'comment-only-catch');

  /* the empty substitutes */
  has('.catch(() => ({}))', 'const d = await q().catch(() => ({}));', 'catch-substitute');
  has('.catch(() => [])', 'const d = await q().catch(() => []);', 'catch-substitute');
  has('.catch(() => null)', 'const d = await q().catch(() => null);', 'catch-substitute');
  has(".catch(() => '')", "const d = await q().catch(() => '');", 'catch-substitute');
  has('.catch(function () { return {}; })', 'const d = await q().catch(function () { return {}; });', 'catch-substitute');

  /* the non-empty substitute — the shape carrying most of the real damage */
  has('.catch(() => ({ rows: [] }))', 'const r = await pool.query(sql).catch(() => ({ rows: [] }));', 'catch-substitute-value');
  has('.catch(() => ({ count: 0 }))', 'const r = await q().catch(() => ({ count: 0 }));', 'catch-substitute-value');
  has('.catch(() => [{}])', 'const r = await q().catch(() => [{ id: 0 }]);', 'catch-substitute-value');
  has('.catch(function(){ return { rows: [] }; })', 'const r = await q().catch(function () { return { rows: [] }; });', 'catch-substitute-value');

  /* blind spot #2 — an inline <script> is product code */
  has('inline <script> in .html',
    '<html><body>\n<div></div>\n<script>\ntry { a(); } catch (e) {}\n</script>\n</body></html>', 'empty-catch', '.html');
  /* …and the SERVER-RENDERED half of it, which Run 41 could not see */
  has('inline <script> inside a template literal',
    'function page() {\n  return `<div></div>\n<script>\nfetch(u).then(r => r.json()).catch(function(){});\n</scr' + 'ipt>`;\n}', 'catch-cb-empty');

  /* CRLF. Windows is where this runs. */
  has('CRLF block form', 'try {\r\n  a();\r\n} catch (e) {\r\n}\r\n', 'empty-catch');
  has('CRLF comment-only', 'try {\r\n  a();\r\n} catch (e) {\r\n  // gone\r\n}\r\n', 'comment-only-catch');

  /* THE RULED EXEMPTION — built from the real auth.html pattern, not from a
     copy of the regex (rule6-audit.md §4/§7). */
  hasNot('res.json().catch(() => ({})) with res.ok on the next line',
    "const res = await fetch(url);\nconst data = await res.json().catch(() => ({}));\nif (res.ok) { onOk(data); return; }\nshowAlert('error', data.error);\n");
  hasNot('the same, function spelling, with !res.ok on the next line',
    "const res = await fetch(url);\nvar data = await res.json().catch(function () { return {}; });\nif (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));\n");
  hasNot('the ok check ABOVE, with an early return on success',
    "const res = await fetch(url);\nif (res.ok) { location.href = '/'; return; }\nconst data = await res.json().catch(() => ({}));\nshowError(data.error || 'Could not deactivate this account.');\n");
  /* …and the polarity that must still fire: no check anywhere. */
  has('res.json().catch(() => ({})) with NO ok check',
    'const res = await fetch(url);\nconst data = await res.json().catch(() => ({}));\nrender(data);\n', 'catch-substitute');
  has('.catch(() => ({})) on a database query is never exempt',
    'const r = await pool.query(sql).catch(() => ({}));\nif (r.ok) {}\n', 'catch-substitute');
  has('the ok check too far ABOVE does not exempt',
    'const res = await fetch(u);\nif (res.ok) {}\na();\nb();\nc();\nd();\ne();\nf();\nconst data = await res.json().catch(() => ({}));\n', 'catch-substitute');
  has('the ok check too far below does not exempt',
    'const res = await fetch(u);\nconst data = await res.json().catch(() => ({}));\na();\nb();\nc();\nd();\ne();\nf();\nif (res.ok) {}\n', 'catch-substitute');

  /* the things that must NOT fire */
  hasNot('the shape named inside a line comment', '// never write catch (e) {} here\nconst x = 1;\n');
  hasNot('the shape named inside a block comment', '/* banned: catch {} and .catch(() => {}) */\nconst x = 1;\n');
  hasNot('the shape named inside a string', "const msg = 'catch (e) {} is banned';\n");
  hasNot('a catch that reports', "try { a(); } catch (e) { console.error('load failed:', e); throw e; }");
  hasNot('a non-empty string substitute', "p().catch(() => 'a real named failure state');");
  hasNot('a catch callback that does something', 'p().catch(function (e) { console.error(e); });');
  hasNot('a named error handler', 'p().catch(reportFailure);');

  return n;
}

module.exports = { scan, scanText, scanSource, walk, mask, format, selfTest, OK_CHECK_WINDOW, EXCLUDED_DIRS, EXTENSIONS };

// ═══════════════════════════════════════════════════════════════════════════
// LANE E — VISUAL BAR conformance  (GAUNTLET.md §V)
//
//   node test/r2-visual-contract.js
//
// §V made executable. Everything below is a property that rots silently: a
// page that pastes #E8622A instead of var(--accent) looks identical the day it
// ships and drifts the moment the ecosystem master moves; a page that declares
// a looping @keyframes with no reduced-motion collapse is broken only for the
// users least likely to report it.
//
// THE ONE FACT THIS FILE EXISTS TO PROTECT. [data-platform="tools"] declares
// --accent:#E8622A inside public/css/modus-design-system.css, which is
// md5-pinned to a master shared by twelve platforms. The orange is therefore
// LOCKED ONCE, UPSTREAM. Lane E's job was never to pick it — only to make
// every page CONSUME it. A literal anywhere downstream is a second source of
// truth for that value, which is precisely what "locked once" exists to
// prevent, so a literal is a build failure and not a style preference.
//
// It follows the same three rules test/ui-contract.js does:
//
//   RULE 1  Comments are stripped before scanning. Prose that NAMES a value is
//           not a use of it — r2-tokens.css's own header explains at length
//           why no accent hex is written in it, and a scanner that counted
//           those sentences would fail the file on the rule it documents.
//   RULE 4  Every check prints WHAT IT ACTUALLY READ, so a silent zero shows
//           up as a parse failure rather than as a clean result.
//   §7b     Nothing here names a file to exempt it from a rule. The pages that
//           are out of scope are listed ONCE, at the top, with the reason, and
//           their numbers are PRINTED rather than skipped.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const DS = 'css/modus-design-system.css';
const TOKENS = 'css/r2-tokens.css';
const MASTER_CSS_MD5 = '8425f45613be387b1affe93e18b09a65';   // the same constant ui-contract.js pins

// ── THE SURFACES LANE E CONVERTED ──────────────────────────────────────────
// Split exactly as GAUNTLET.md §V splits them, because the two halves are held
// to different motion rules and §V.MOTION below checks the difference.
const MARKETING = ['index.html', 'pr-demo.html'];
const DAILY = [
  'app.html', 'aichat.html', 'audiobook.html', 'gao.html',
  'content.html', 'social.html', 'mail.html', 'ads.html',
  'seo.html', 'sales.html', 'commerce.html',
  'seller.html', 'billing.html', 'api-docs.html', 'audit.html',
  'terms.html', 'privacy.html', 'module-unavailable.html',
];
const LANE_SURFACES = [...MARKETING, ...DAILY];

// ── NOT CONVERTED, AND THE REASON IS NOT "WE RAN OUT OF TIME" ──────────────
// Their numbers are printed by §V.SCOPE so the exclusion stays visible and
// cannot quietly become "we fixed everything".
const OUT_OF_SCOPE = {
  'auth.html': 'canonical master synced from Modus-Agent-OS/design (CLAUDE.md). '
    + 'Editing it here is per-repo drift from a master — the same defect class as '
    + 'editing the pinned stylesheet. Its 8 literals belong to the master and are '
    + 'fixed there, in one commit across all twelve repos.',
  'settings.html': 'canonical master, same reason. Already at 0 literals.',
  'auth-success.html': 'a <meta refresh> stub with no <body> content and no CSS at '
    + 'all. There is nothing on it to style, and loading two stylesheets into a '
    + 'document that redirects on first paint is cost with no render.',
  'mai.html': 'Lane A owns it (GAUNTLET.md lane split). Lane E must not edit it.',
  'docintel.html': 'Lane B owns it. Same reason.',
};

// The platform accent, in every spelling it could be pasted in. These are the
// ORANGE ones — the six tokens [data-platform="tools"] declares, plus the rgba
// prefix that carries the same value with an alpha.
const ACCENT_LITERALS = [
  /#e8622a\b/i,           // --accent
  /#c44e1e\b/i,           // --accent-2
  /#b24213\b/i,           // --accent-text (light)
  /#fbe2d8\b/i,           // --accent-light (light)
  /rgba\(\s*232\s*,\s*98\s*,\s*42\b/i,   // --accent-bg / --accent-glow
];

let failures = 0, checks = 0;
const pass = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { checks++; failures++; console.error('  ✗ ' + m); };
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 62 - m.length)));
const read = (f) => fs.readFileSync(f, 'utf8');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const exists = (p) => fs.existsSync(path.join(PUBLIC, p));

// ── RULE 1 — strip prose before scanning ───────────────────────────────────
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
function stripJsComments(text) {
  let out = '', inS = null, inC = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inC === 'line') { if (c === '\n') { inC = null; out += c; } continue; }
    if (inC === 'block') { if (c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { out += c; if (c === '\\') { out += text[++i] || ''; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inC = 'line'; i++; continue; }
    if (c === '/' && n === '*') { inC = 'block'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') inS = c;
    out += c;
  }
  return out;
}
// An HTML page carries three comment syntaxes. Strip each in its own region:
// <style> is CSS, <script> is JS, everything else is markup. Strings are kept —
// a colour inside a JS string IS a use of it, and several of the worst offences
// this round were exactly that (`style="background:${t.color}18"`).
//
// THE OPEN TAG IS PUT BACK VERBATIM, and that is not cosmetic. Rewriting
// `<script src="/js/genlang.js" defer>` to a bare `<script>` throws away the
// src, so §V.CONTRACT's "does this page load the selector" check read false on
// all nine pages that do. Caught by the negative control: deleting a real
// script tag changed nothing, because they were all already reading as absent.
function declutterHtml(src) {
  let s = stripHtmlComments(src);
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, body, close) => open + stripCssComments(body) + close);
  s = s.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) => open + stripJsComments(body) + close);
  return s;
}
const styleBlocks = (src) => (src.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).join('\n');

// Every form a raw colour can take. `currentColor`, `transparent` and `inherit`
// are not colour CHOICES and are not matched. The mask sentinel below is
// geometry that happens to be expressed in a colour slot.
const COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d/gi;
const MASK_SENTINEL = /mask-image[^;]*/gi;

// ═══ §V.1 — one token layer, in css/ ═══════════════════════════════════════
head('§V.1  the locked token layer');
{
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'r2-tokens.css') found.push(p);
    }
  })(ROOT);
  console.log('    scanned the repo tree; found ' + found.length + ' copy/copies of r2-tokens.css');
  if (found.length !== 1) {
    fail('expected exactly ONE r2-tokens.css, found ' + found.length
      + ' — two copies is two token sets, which is the thing this round exists to prevent');
  } else {
    const rel = path.relative(ROOT, found[0]).replace(/\\/g, '/');
    if (rel === 'public/' + TOKENS) pass('exactly one copy, at ' + rel);
    else fail('the one copy is at ' + rel + ', not public/' + TOKENS);
  }
}

// ═══ §V.2 — the token layer names the accent, never restates it ════════════
head('§V.2  the orange has exactly one source of truth');
{
  const f = path.join(PUBLIC, TOKENS);
  if (!fs.existsSync(f)) {
    fail('public/' + TOKENS + ' does not exist — nothing else in this file can be true');
  } else {
    const src = stripCssComments(read(f));
    console.log('    token layer read: ' + src.length + ' bytes after comments stripped');
    if (src.length < 10000) fail('the token layer is ' + src.length + ' bytes after stripping — that is a parse '
      + 'failure, not a small file; every check below would pass vacuously');

    const hits = ACCENT_LITERALS.filter((re) => re.test(src));
    console.log('    accent-hex literals in the token layer: ' + hits.length);
    if (!hits.length) pass('the token layer restates no platform-accent value');
    else fail('the token layer hardcodes the accent (' + hits.length + ' spelling(s)) — that is a SECOND '
      + 'source of truth for the orange; use var(--accent)');

    // The stronger form: NO colour literal at all, not merely no orange one.
    // The whole point of the port is that these identical bytes resolve blue
    // under [data-platform="do"] and orange here. One hex of any hue breaks
    // that property for the platform it does not belong to.
    const anyColour = [...src.replace(MASK_SENTINEL, '').matchAll(COLOUR)].map((m) => m[0]);
    console.log('    raw colour literals of ANY hue in the token layer: ' + anyColour.length);
    if (!anyColour.length) pass('zero colour literals — the identical bytes resolve per-platform');
    else fail('the token layer declares ' + anyColour.length + ' raw colour(s): '
      + [...new Set(anyColour.map((c) => c.toLowerCase()))].slice(0, 8).join(' '));

    const refs = (src.match(/var\(--accent[a-z0-9-]*\)/g) || []).length;
    console.log('    var(--accent*) references in the token layer: ' + refs);
    if (refs > 0) pass('it consumes the design-system accent (' + refs + ' reference(s))');
    else fail('it never references var(--accent) — then it is not consuming the locked token at all');
  }
}

// ═══ §V.3 — load order, on every converted page ════════════════════════════
head('§V.3  design system first, token layer second');
{
  let linked = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) { fail(page + ' does not exist'); continue; }
    const src = stripHtmlComments(read(path.join(PUBLIC, page)));
    const iDs = src.indexOf('/' + DS);
    const iTok = src.indexOf('/' + TOKENS);
    if (iDs === -1) { fail(page + ' does not load ' + DS + ' — it cannot be consuming --accent'); continue; }
    if (iTok === -1) { fail(page + ' does not load ' + TOKENS + ' — it is not on the token foundation'); continue; }
    if (iTok < iDs) { fail(page + ' loads ' + TOKENS + ' BEFORE ' + DS + '. The token layer is expressed in '
      + 'terms of the design system and overrides nothing at that order'); continue; }
    linked++;
  }
  console.log('    surfaces loading both, in order: ' + linked + '/' + LANE_SURFACES.length);
  if (!linked) fail('ZERO surfaces parsed as linked — that is a parse failure, not a clean result');
  else if (linked === LANE_SURFACES.length) pass('all ' + linked + ' converted surfaces load the design system, then the token layer');

  // Every <html> must claim the platform, or --accent resolves to the :root
  // default, which is M-EasyDo's blue. ui-contract.js §2 asserts this across
  // the whole repo; it is re-asserted here because §V.4's "no literal" result
  // is meaningless on a page whose tokens resolve to another platform's.
  const unmarked = LANE_SURFACES.filter((p) => exists(p)
    && !/<html[^>]*data-platform="tools"/.test(stripHtmlComments(read(path.join(PUBLIC, p)))));
  if (!unmarked.length) pass('every converted surface declares data-platform="tools"');
  else unmarked.forEach((p) => fail(p + ' has no data-platform="tools" — its --accent resolves to the :root blue'));
}

// ═══ §V.4 — no converted surface restates the accent ═══════════════════════
head('§V.4  no converted surface hardcodes the orange');
{
  let scanned = 0, clean = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    scanned++;
    const src = declutterHtml(read(path.join(PUBLIC, page)));
    const spellings = ACCENT_LITERALS.filter((re) => re.test(src));
    if (!spellings.length) { clean++; continue; }
    const lines = [];
    src.split('\n').forEach((l, i) => { if (ACCENT_LITERALS.some((re) => re.test(l))) lines.push(i + 1); });
    fail(page + ' hardcodes the accent at line(s) ' + lines.slice(0, 8).join(', ')
      + (lines.length > 8 ? ' (+' + (lines.length - 8) + ' more)' : '') + ' — use var(--accent)');
  }
  console.log('    surfaces scanned: ' + scanned + '/' + LANE_SURFACES.length + ', free of an accent literal: ' + clean);
  if (!scanned) fail('ZERO surfaces scanned — parse failure');
  else if (clean === scanned) pass('all ' + scanned + ' consume the orange rather than restating it');
}

// ═══ §V.5 — no converted surface invents a colour ══════════════════════════
head('§V.5  every colour resolves through a token');
{
  // §V.4 catches the accent pasted as a literal. This catches the subtler and
  // far more common form: a page that never mentions #E8622A because it
  // invented its OWN palette. Seventeen of the twenty-three pages in this repo
  // did exactly that, aichat.html most memorably — it declared
  // data-platform="tools" and then set --mod:#7C3AED, which is M-EasyMember's
  // purple, so a Tools page rendered in another platform's brand colour while
  // claiming this one, and no accent-literal check could ever have seen it.
  //
  // The bar is zero, and zero is not aspirational: mai.html and docintel.html
  // are comparably complex pages already at zero. It is the proven standard in
  // this repo, not one invented for this round.
  let scanned = 0, clean = 0, total = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    scanned++;
    const src = declutterHtml(read(path.join(PUBLIC, page))).replace(MASK_SENTINEL, '');
    const hits = [...src.matchAll(COLOUR)].map((m) => m[0]);
    total += hits.length;
    if (!hits.length) { clean++; continue; }
    const counts = {};
    hits.forEach((h) => { counts[h.toLowerCase()] = (counts[h.toLowerCase()] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => c + '×' + n).join(' ');
    fail(page + ' declares ' + hits.length + ' raw colour(s), most common: ' + top
      + ' — one token set, consumed, not per-screen invention');
  }
  console.log('    surfaces at zero raw colour literals: ' + clean + '/' + scanned + '  (total literals found: ' + total + ')');
  if (!scanned) fail('ZERO surfaces scanned — parse failure');
  else if (clean === scanned) pass('all ' + scanned + ' converted surfaces are free of raw colour literals');

  // The positive half. Every check above passes on an empty file, so the
  // surfaces must be shown to actually SPEND the accent.
  //
  // There are TWO legitimate ways to spend it, and a check that knew only the
  // first would punish the better one. billing.html writes no colour at all:
  // it renders .btn-primary, .sidebar-item.active and .progress-bar, and the
  // accent reaches them from the md5-pinned stylesheet. That is the ideal
  // consumption pattern, not a gap.
  //
  // So the accent-bearing class list is DERIVED FROM THE MASTER rather than
  // hand-written here: any class whose rule in modus-design-system.css
  // references var(--accent*) counts. A hand-written list would be a fourth
  // place the accent is described, and would rot the first time the master
  // renamed a component.
  const dsSrc = stripCssComments(read(path.join(PUBLIC, DS)));
  const accentClasses = new Set();
  for (const [, sel, body] of dsSrc.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/var\(\s*--accent[a-z0-9-]*\s*\)/.test(body)) continue;
    for (const m of sel.matchAll(/\.([a-zA-Z][\w-]*)/g)) accentClasses.add(m[1]);
  }
  console.log('    accent-bearing classes derived from the master: ' + accentClasses.size);
  if (accentClasses.size < 10) fail('derived only ' + accentClasses.size + ' accent-bearing class(es) from '
    + DS + ' — that is a parse failure of the master, and every result below it would be wrong');

  const byToken = [], byComponent = [], neither = [];
  for (const p of LANE_SURFACES) {
    if (!exists(p)) continue;
    const src = declutterHtml(read(path.join(PUBLIC, p)));
    if (/var\(--accent(-[a-z0-9-]+)?\)/.test(src)) { byToken.push(p); continue; }
    const used = [...src.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/)).filter((c) => accentClasses.has(c));
    if (used.length) { byComponent.push(p + ' (' + [...new Set(used)].slice(0, 3).join(', ') + ')'); continue; }
    neither.push(p);
  }
  console.log('    spending it by naming var(--accent*): ' + byToken.length);
  console.log('    spending it through a design-system component: ' + byComponent.length
    + (byComponent.length ? ' — ' + byComponent.join(', ') : ''));
  if (!neither.length) pass('all ' + LANE_SURFACES.length + ' converted surfaces genuinely spend the accent, so §V.4 is not vacuous');
  else fail(neither.length + ' surface(s) reference the accent in neither form: ' + neither.join(', ')
    + ' — on those, "no accent literal" is true of a page that has no accent');
}

// ═══ §V.6 — no converted surface re-declares a token it should consume ═════
head('§V.6  tokens are declared once, in the layer that owns them');
{
  // A DECLARATION is `--r2-foo:`; a USE is `var(--r2-foo)`. Only the former is
  // a second source of truth, so the use form is removed before counting.
  // This is also why the pages stagger their reveals with :nth-child rather
  // than an inline `style="--r2-i:3"`: an inline custom property IS a
  // declaration and would fail here.
  const offenders = [];
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const src = declutterHtml(read(path.join(PUBLIC, page)))
      .replace(/var\(\s*--r2-[a-z0-9-]+\s*\)/g, '');
    const decls = src.match(/--r2-[a-z0-9-]+\s*:/g) || [];
    if (decls.length) offenders.push(page + ' declares ' + decls.length + ': ' + [...new Set(decls)].slice(0, 5).join(' '));
  }
  console.log('    surfaces declaring an --r2-* token of their own: ' + offenders.length);
  if (!offenders.length) pass('every --r2-* token is declared only in ' + TOKENS);
  else offenders.forEach((o) => fail(o + ' — both halves of the split consume the same token, not their own copy'));

  // The six accent tokens belong to the md5-pinned master and to nothing else.
  // A page that re-declares --accent shadows the platform registry on itself,
  // which is exactly what seller.html, index.html, gao.html and api-docs.html
  // each did before this round.
  const shadowers = [];
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const css = stripCssComments(styleBlocks(read(path.join(PUBLIC, page))))
      .replace(/var\(\s*--accent[a-z0-9-]*\s*\)/g, '');
    const decls = css.match(/--accent[a-z0-9-]*\s*:/g) || [];
    if (decls.length) shadowers.push(page + ' → ' + [...new Set(decls)].join(' '));
  }
  console.log('    surfaces re-declaring an --accent* token: ' + shadowers.length);
  if (!shadowers.length) pass('no surface shadows the platform accent registry');
  else shadowers.forEach((o) => fail(o + ' — the accent is declared in the md5-pinned master and nowhere else'));
}

// ═══ §V.6b — a token that resolves to nothing is worse than a literal ═════
head('§V.6b  every var() a surface uses actually resolves');
{
  // §V.5's "zero literals" has an obvious cheat and an easy accident: replace
  // #8892A4 with var(--text-3), a token no stylesheet declares, and the scan
  // goes green while the rule renders with NO COLOUR AT ALL. audiobook.html
  // was doing exactly that in three places before this round — not as a cheat,
  // as a typo for --text-2 that nothing could see.
  //
  // So the declared set is read out of the two stylesheets, and every var()
  // on every converted surface has to be in it, or declared by the page.
  const declared = new Set();
  for (const sheet of [DS, TOKENS]) {
    const src = stripCssComments(read(path.join(PUBLIC, sheet)));
    for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(m[1]);
  }
  console.log('    tokens declared by the two stylesheets: ' + declared.size);
  if (declared.size < 100) fail('parsed only ' + declared.size + ' token declarations — that is a parse failure '
    + 'of the stylesheets, and every page below would be reported as broken');

  let checked = 0, broken = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    checked++;
    const src = stripCssComments(stripHtmlComments(read(path.join(PUBLIC, page))));
    const local = new Set([...src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*[,)]/g)].map((m) => m[1]));
    const missing = [...used].filter((t) => !declared.has(t) && !local.has(t));
    if (!missing.length) continue;
    broken++;
    fail(page + ' uses ' + missing.length + ' token(s) nothing declares: ' + missing.join(' ')
      + ' — those rules render with no colour at all');
  }
  console.log('    surfaces whose every var() resolves: ' + (checked - broken) + '/' + checked);
  if (!checked) fail('ZERO surfaces checked — parse failure');
  else if (!broken) pass('every var() on all ' + checked + ' converted surfaces resolves to a declared token');
}

// ═══ §V.7 — the surface split, enforced rather than intended ═══════════════
head('§V.7  daily-use surfaces stay calm');
{
  // §V's table is the bar: marketing pages get entrance and scroll reveal;
  // daily-use pages get transitions only, on colour and width. The mechanical
  // reading of "transitions only" is that a daily-use page declares no
  // @keyframes of its own — a page-level animation on a screen someone opens
  // forty times a week is decoration with a recurring cost.
  //
  // app.html, gao.html and pr-demo.html are the deliberate exceptions and are
  // NOT exempted: they are held to §V.8's reduced-motion rule instead, and
  // their counts are printed here rather than suppressed.
  let calm = 0, noisy = [];
  for (const page of DAILY) {
    if (!exists(page)) continue;
    const kf = (styleBlocks(declutterHtml(read(path.join(PUBLIC, page)))).match(/@keyframes\b/g) || []).length;
    if (kf === 0) calm++;
    else noisy.push(page + ' (' + kf + ')');
  }
  console.log('    daily-use surfaces with no page-level @keyframes: ' + calm + '/' + DAILY.length);
  if (noisy.length) console.log('    still animating, and therefore held to §V.8: ' + noisy.join(', '));
  if (calm >= DAILY.length - 3) pass(calm + ' of ' + DAILY.length + ' daily-use surfaces declare no animation of their own');
  else fail('only ' + calm + ' of ' + DAILY.length + ' daily-use surfaces are transition-only; the split says '
    + 'bold belongs on marketing, not on a screen opened forty times a week');

  // Glass on floating chrome only. A blur behind body text is decoration
  // bought with legibility, so a content card never gets one. The token layer
  // exposes exactly one blur value, and the only selectors allowed to use it
  // are sticky/fixed chrome.
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const css = stripCssComments(styleBlocks(read(path.join(PUBLIC, page))));
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /backdrop-filter\s*:\s*blur/.test(body));
    const bad = rules.filter(([, , body]) => !/position\s*:\s*(sticky|fixed)/.test(body));
    if (!bad.length) continue;
    fail(page + ' blurs behind a surface that is not sticky or fixed chrome: '
      + bad.map(([, sel]) => sel.trim().split('\n')[0]).slice(0, 3).join(' | ')
      + ' — a blur behind body text costs legibility for decoration');
  }
  const glassPages = LANE_SURFACES.filter((p) => exists(p)
    && /backdrop-filter\s*:\s*blur/.test(stripCssComments(styleBlocks(read(path.join(PUBLIC, p))))));
  console.log('    surfaces using glass at all: ' + glassPages.length + ' (' + glassPages.join(', ') + ')');
  pass('every glass surface found is floating chrome');
}

// ═══ §V.8 — motion degrades honestly ═══════════════════════════════════════
head('§V.8  prefers-reduced-motion, and content that survives it');
{
  let animated = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const styles = styleBlocks(declutterHtml(read(path.join(PUBLIC, page))));
    const kf = (styles.match(/@keyframes\b/g) || []).length;
    const hasRm = /prefers-reduced-motion\s*:\s*reduce/.test(styles);
    if (kf === 0) continue;
    animated++;
    console.log('    ' + page.padEnd(16) + kf + ' @keyframes, reduced-motion block ' + (hasRm ? 'present' : 'ABSENT'));
    if (hasRm) pass(page + ' declares animation and handles reduced motion');
    else fail(page + ' declares ' + kf + ' @keyframes and has no prefers-reduced-motion block');
  }
  console.log('    surfaces declaring page-level animation: ' + animated);

  // A LOOP MUST BE SWITCHED OFF, NOT SPED UP. The design system's §41 collapses
  // every duration to 0.01ms globally, which is right for an entrance and wrong
  // for a loop: a 0.01ms loop freezes at an arbitrary frame, so a spinner stops
  // at 140° and reads as a hung request rather than as a calm one. Each page's
  // own block therefore has to say `animation:none` for its loops.
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const styles = styleBlocks(declutterHtml(read(path.join(PUBLIC, page))));
    if (!/@keyframes/.test(styles)) continue;
    const loops = (styles.match(/animation\s*:[^;{}]*\binfinite\b/g) || []).length;
    if (!loops) continue;
    const rm = (styles.match(/@media[^{]*prefers-reduced-motion[^{]*\{([\s\S]*?)\n\}/) || [])[1] || '';
    const offs = (rm.match(/animation\s*:\s*none/g) || []).length;
    console.log('    ' + page.padEnd(16) + loops + ' looping animation(s), ' + offs + ' switched off under reduced motion');
    if (offs > 0) pass(page + ' switches its loops OFF rather than collapsing them to a frozen frame');
    else fail(page + ' has ' + loops + ' looping animation(s) and switches none of them off — §41 collapses the '
      + 'duration to 0.01ms, which freezes the loop mid-cycle and reads as a rendering fault');
  }

  // THE FAILURE THAT MATTERS MOST, because it is invisible in review and total
  // in production. `.reveal{opacity:0}` unconditionally in CSS, turned back on
  // by JS, is not a slow animation — it is permanently invisible content, and
  // a blank page whenever the script does not run. The design system's §50.7
  // authors the resting state VISIBLE and hides it only under
  // [data-reveal="on"], which JS sets AFTER confirming it has an
  // IntersectionObserver. M-EasyDo shipped the other form and lost 7,000px of
  // its landing page. A surface that re-implements it is reintroducing that.
  let revealPages = 0;
  for (const page of LANE_SURFACES) {
    if (!exists(page)) continue;
    const src = declutterHtml(read(path.join(PUBLIC, page)));
    const styles = styleBlocks(src);
    const bad = [...styles.matchAll(/([^{}]*\breveal\b[^{}]*)\{([^}]*)\}/gi)]
      .filter(([, sel, body]) => /opacity\s*:\s*0\b/.test(body) && !/\[data-reveal/.test(sel) && !/\[data-motion/.test(sel));
    if (bad.length) {
      fail(page + ' hides .reveal at opacity:0 outside [data-reveal="on"] (' + bad.length + ' rule(s)) — '
        + 'if the script does not run, that content never appears');
      continue;
    }
    if (/class="[^"]*\breveal\b/.test(src)) revealPages++;
  }
  console.log('    surfaces using .reveal: ' + revealPages + ' (all resting VISIBLE)');
  pass('no surface hides content by default and depends on a script to show it');

  // And the engine has to actually gate on the observer, or the attribute is
  // set on a browser that can never clear it.
  const engine = path.join(PUBLIC, 'js', 'modus-components.js');
  if (!fs.existsSync(engine)) fail('public/js/modus-components.js is missing — the reveal engine has no home');
  else {
    const js = stripJsComments(read(engine));
    const sets = /setAttribute\(\s*['"]data-reveal['"]\s*,\s*['"]on['"]\s*\)/.test(js);
    const guards = /'IntersectionObserver'\s+in\s+window/.test(js);
    console.log('    reveal engine: sets [data-reveal="on"] = ' + sets + ', guards on IntersectionObserver = ' + guards);
    if (!sets) fail('the reveal engine never sets [data-reveal="on"] — then .reveal is inert and the class is decoration');
    else if (guards) pass('the engine sets [data-reveal="on"] only after confirming an IntersectionObserver exists');
    else fail('the engine sets [data-reveal="on"] without checking for an IntersectionObserver — on a browser '
      + 'without one, that hides every .reveal permanently');
  }
}

// ═══ §V.9 — the ecosystem master is byte-identical ═════════════════════════
head('§V.9  the shared stylesheet was consumed, not edited');
{
  const f = path.join(PUBLIC, DS);
  if (!fs.existsSync(f)) fail(DS + ' is missing');
  else {
    const hash = md5(fs.readFileSync(f));
    console.log('    md5 read from disk: ' + hash);
    if (hash === MASTER_CSS_MD5) pass('unchanged — the orange was consumed, not edited');
    else fail('md5 ' + hash.slice(0, 8) + ' ≠ master ' + MASTER_CSS_MD5.slice(0, 8)
      + ' — a per-repo edit to this file is a §1 defect; the change belongs in the master and is '
      + 're-copied to all twelve repos in the same commit');
  }

  // §1b: one copy of the design system in the tree, and nothing may inline a
  // second. pr-demo.html carried a 2,450-line INLINE COPY of it — §1 through
  // §47, frozen at --accent-2:#1557b0 — which is the same defect as editing
  // the file, with the drift already applied.
  // Comments stripped first (RULE 1). Several pages now carry a note EXPLAINING
  // that they used to declare `--accent: #E8622A`; a scanner that counted the
  // explanation would fail the page on the defect it documents.
  const inlined = LANE_SURFACES.filter((p) => {
    if (!exists(p)) return false;
    const css = stripCssComments(styleBlocks(read(path.join(PUBLIC, p))));
    return /--accent\s*:\s*#/.test(css) || /--bg\s*:\s*#f8f9fa/i.test(css);
  });
  console.log('    surfaces inlining a copy of the design system: ' + inlined.length);
  if (!inlined.length) pass('no surface carries its own copy of the shared stylesheet');
  else inlined.forEach((p) => fail(p + ' inlines the design system — a per-page copy is a per-repo edit that '
    + 'has already drifted'));
}

// ═══ §V.CONTRACT — the one cross-lane contract ═════════════════════════════
head('§V.CONTRACT  the language-selector mount points (GAUNTLET.md)');
{
  // Lane C ships one self-contained public/js/genlang.js; Lane E adds the
  // mount point and the script tag. One selector implementation, nine pages,
  // no shared file. This asserts Lane E's half, which is all Lane E can own —
  // and it asserts BOTH halves per page, because a mount with no script and a
  // script with no mount are each a control that renders nothing.
  const GEN = ['content.html', 'social.html', 'mail.html', 'ads.html', 'seo.html',
               'sales.html', 'commerce.html', 'audiobook.html', 'app.html'];
  let ok = 0;
  for (const page of GEN) {
    if (!exists(page)) { fail(page + ' does not exist'); continue; }
    // declutterHtml, not stripHtmlComments: every converted page carries a CSS
    // comment EXPLAINING that genlang.js finds its slot by
    // [data-genlang-mount], and a scan that read the sentence as the attribute
    // reported nine passes it had not actually verified. Caught by the
    // negative control, which deleted a real mount and watched this stay green.
    const src = declutterHtml(read(path.join(PUBLIC, page)));
    const hasMount = /data-genlang-mount/.test(src);
    const hasScript = /<script[^>]+src="\/js\/genlang\.js"/.test(src);
    if (hasMount && hasScript) { ok++; continue; }
    fail(page + ': mount=' + hasMount + ' script=' + hasScript
      + ' — a mount with no script never fills, and a script with no mount has nothing to fill');
  }
  console.log('    generation surfaces carrying both the mount and the script: ' + ok + '/' + GEN.length);
  if (ok === GEN.length) pass('all ' + GEN.length + ' content-generation surfaces honour the contract');

  const jsPath = path.join(PUBLIC, 'js', 'genlang.js');
  if (fs.existsSync(jsPath)) console.log('    public/js/genlang.js: present (Lane C has landed)');
  else console.log('    public/js/genlang.js: NOT YET PRESENT — Lane C owns it. Lane E\'s half is in place; '
    + 'until it lands the slot is empty and .genlang-slot:empty keeps it collapsed, so nothing renders '
    + 'as a dead control. This line is a status report, not an assertion — Lane C\'s own suite asserts the file.');
}

// ═══ §V.SCOPE — what was not converted, with its numbers ═══════════════════
head('§V.SCOPE  out of scope this round, printed rather than skipped');
{
  // Nothing here is asserted. §7b: naming a file to exempt it from a rule is
  // how a rule quietly stops applying. These pages are excluded for a reason
  // stated at the top of this file, and their numbers are printed so the
  // exclusion cannot become invisible.
  for (const [page, reason] of Object.entries(OUT_OF_SCOPE)) {
    if (!exists(page)) { console.log('    ' + page.padEnd(22) + '(not present)'); continue; }
    const raw = read(path.join(PUBLIC, page));
    const src = declutterHtml(raw).replace(MASK_SENTINEL, '');
    const lits = [...src.matchAll(COLOUR)].length;
    const accents = ACCENT_LITERALS.filter((re) => re.test(src)).length;
    const ds = /\/css\/modus-design-system\.css/.test(src);
    const tok = /\/css\/r2-tokens\.css/.test(src);
    console.log('    ' + page.padEnd(22) + String(lits).padStart(4) + ' raw colour(s), '
      + accents + ' accent spelling(s), design-system=' + (ds ? 'yes' : 'no ') + ' token-layer=' + (tok ? 'yes' : 'no'));
    console.log('      reason: ' + reason.replace(/\s+/g, ' '));
  }
  const covered = new Set([...LANE_SURFACES, ...Object.keys(OUT_OF_SCOPE)]);
  const all = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  const unaccounted = all.filter((f) => !covered.has(f));
  console.log('    pages in public/: ' + all.length + '  ·  converted: ' + LANE_SURFACES.length
    + '  ·  out of scope: ' + Object.keys(OUT_OF_SCOPE).filter(exists).length
    + '  ·  unaccounted: ' + unaccounted.length);
  // An unaccounted page is the real hazard: a page added later that no rule
  // covers and no reason excuses. It fails, rather than being counted.
  if (!unaccounted.length) pass('every page in public/ is either converted or excluded with a stated reason');
  else fail('page(s) neither converted nor excluded: ' + unaccounted.join(', ')
    + ' — add them to LANE_SURFACES or give them a reason in OUT_OF_SCOPE');
}

console.log('');
console.log(`${checks} checks, ${failures} failure(s)`);
if (!checks) { console.error('\n✗ ZERO checks ran — that is a harness failure, not a pass\n'); process.exit(1); }
if (failures) { console.error('\n✗ VISUAL BAR conformance FAILED\n'); process.exit(1); }
console.log('✓ VISUAL BAR conformance\n');

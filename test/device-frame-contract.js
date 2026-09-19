/* ═══════════════════════════════════════════════════════════════════════════
   DEVICE FRAME CONTRACT
   ───────────────────────────────────────────────────────────────────────────
   Guards public/preview.html — the interactive device frame — and the
   safe-area layer it exists to verify (css/tools-mobile.css §10).

   WHAT THE PAIR IS, AND WHY THE WIRING BETWEEN THEM NEEDS A GUARD OF ITS OWN.

   Nothing in a web page can set `env(safe-area-inset-*)`. The user agent
   supplies those values and a page — or an iframe framing that page — cannot
   fake them. So a rule written directly against `env()` is a rule nobody can
   test anywhere except on the hardware, which in practice means nobody tests
   it and it rots.

   §10 therefore routes all four insets through custom properties:

       --tmob-sat: env(safe-area-inset-top,    0px)
       --tmob-sar: env(safe-area-inset-right,  0px)
       --tmob-sab: env(safe-area-inset-bottom, 0px)
       --tmob-sal: env(safe-area-inset-left,   0px)

   and every declaration consumes `var(--tmob-sa*)` rather than `env()`.
   public/preview.html writes the selected device's real numbers onto those
   same four properties before it measures, so the framed page lays out exactly
   as the phone would.

   THAT MAKES THE PROPERTY NAMES A CONTRACT BETWEEN TWO FILES, and it is a
   contract that fails silently in the worst possible direction. Rename
   `--tmob-sab` in the stylesheet and the harness writes a property nothing
   reads: no error, no warning, every check goes green, and the green means
   "the layout did not move" rather than "the layout is correct". Transpose two
   of them — top written into the bottom property — and the harness measures a
   real layout that is not the one any device produces. Both mistakes look like
   a passing test suite.

   §1 asserts the names and the direction of the mapping on both sides.

   WHAT THIS FILE CANNOT DO. It is static, like test/mobile-contract.js and for
   the same reason: Playwright is not a dependency of this repo. It cannot tell
   you whether anything overflows, and it does not try. What it protects is the
   wiring that makes the browser-side measurement mean something — run the
   frame at /preview to get the measurement itself.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const CSS_PATH = path.join(PUB, 'css', 'tools-mobile.css');
const FRAME_PATH = path.join(PUB, 'preview.html');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '\n       ' + detail : '')); }
};
const section = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 60 - m.length)));

const css = fs.readFileSync(CSS_PATH, 'utf8');
const frame = fs.existsSync(FRAME_PATH) ? fs.readFileSync(FRAME_PATH, 'utf8') : '';
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* Comments stripped before anything is matched. The header above names every
   property this file asserts, and scanning the raw text would let the prose
   satisfy the checks it describes — a guard reading its own documentation as
   evidence. mobile-contract.js learned this the same way. */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
const frameCode = frame.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

const EDGES = [
  { prop: '--tmob-sat', env: 'top',    field: 't' },
  { prop: '--tmob-sar', env: 'right',  field: 'r' },
  { prop: '--tmob-sab', env: 'bottom', field: 'b' },
  { prop: '--tmob-sal', env: 'left',   field: 'l' },
];

/* ── §0 · BOTH HALVES ARE PRESENT ───────────────────────────────────────── */
section('§0  the frame and the layer exist');
ok('public/preview.html exists', frame.length > 0);
if (!frame) {
  console.log('\ndevice-frame-contract: ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
}
ok('server.js serves it at /preview',
   /app\.get\(\s*['"]\/preview['"]/.test(server) && /preview\.html/.test(server));
ok('the frame is not indexable (it is a build tool, not a page of the product)',
   /<meta[^>]+name=["']robots["'][^>]*noindex/i.test(frame));

/* ── §1 · THE CONTRACT BETWEEN THE TWO FILES ────────────────────────────── */
section('§1  the four inset properties, on both sides');

for (const e of EDGES) {
  /* a. the stylesheet defines it, FROM THE MATCHING EDGE. A transposition here
        (top's value in the bottom property) produces a layout that is wrong in
        a way no check can see, because everything still moves. */
  const def = new RegExp(
    e.prop.replace(/-/g, '\\-') + '\\s*:\\s*env\\(\\s*safe-area-inset-([a-z]+)', 'i');
  const m = cssCode.match(def);
  ok('§10 defines ' + e.prop + ' from env(safe-area-inset-' + e.env + ')',
     !!m && m[1] === e.env,
     m ? 'it is defined from safe-area-inset-' + m[1] : 'not defined at all');

  /* b. and something consumes it. A property that is defined and never read is
        inert: the fix looks present in the diff and does nothing at runtime. */
  const uses = (cssCode.match(new RegExp('var\\(\\s*' + e.prop.replace(/-/g, '\\-'), 'g')) || []).length;
  ok(e.prop + ' is consumed by at least one declaration', uses > 0,
     'defined but never read — an inert rule reads as a fix in the diff');

  /* c. the harness writes THAT name, from the matching field of the preset. */
  const put = new RegExp(
    "put\\(\\s*'" + e.prop.replace(/-/g, '\\-') + "'\\s*,\\s*safe\\.([a-z]+)\\s*\\)");
  const fm = frameCode.match(put);
  ok('the frame writes ' + e.prop + ' from the preset’s .' + e.field,
     !!fm && fm[1] === e.field,
     fm ? 'it writes it from safe.' + fm[1] : 'the frame never writes ' + e.prop);
}

/* ── §2 · THE LAYER APPLIES WHERE IT HAS TO ─────────────────────────────── */
section('§2  §10 is not scoped away from the cases that need it');
{
  /* A landscape phone is 852px wide — past the 768px breakpoint — and still
     has a notch on one side edge. Scoping the inset block to a max-width
     query switches the compensation off in exactly the orientation where the
     left/right insets exist. The block is `@supports`, deliberately, and this
     asserts it has not been wrapped. */
  const i = cssCode.indexOf('@supports (padding: env(safe-area-inset-top))');
  ok('the inset block is a bare @supports, reached at every width', i !== -1);
  if (i !== -1) {
    const before = cssCode.slice(0, i);
    const opens = (before.match(/@media[^{]*\{/g) || []).length;
    /* Count braces to see whether any @media is still open at that point. */
    let depth = 0, mediaDepth = -1;
    const re = /@media[^{]*\{|\{|\}/g;
    let mm;
    while ((mm = re.exec(before))) {
      if (mm[0].startsWith('@media')) { if (mediaDepth === -1) mediaDepth = depth; depth++; }
      else if (mm[0] === '{') depth++;
      else { depth--; if (depth === mediaDepth) mediaDepth = -1; }
    }
    ok('and it is not nested inside a media query', mediaDepth === -1,
       'it sits inside an open @media — landscape phones would lose the side insets'
       + ' (' + opens + ' media blocks before it)');
  }
}

/* ── §3 · THE LAYER IS NOT DEAD CODE ────────────────────────────────────── */
section('§3  something actually opts into the hardware area');
{
  /* §10 only ever fires on a page that sets viewport-fit=cover; without it the
     browser insets the viewport itself and every env() is 0. If the last such
     page loses the attribute, the whole section becomes unreachable and should
     be deleted rather than left to look like protection. */
  const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
  const cover = pages.filter((f) => {
    const m = fs.readFileSync(path.join(PUB, f), 'utf8')
      .match(/<meta[^>]+name=["']viewport["'][^>]*>|<meta[^>]+content=["'][^"']*viewport-fit[^"']*["'][^>]*name=["']viewport["'][^>]*>/i);
    return m && /viewport-fit\s*=\s*cover/i.test(m[0]);
  });
  ok('at least one page sets viewport-fit=cover, so §10 is reachable',
     cover.length > 0,
     'no page opts into the hardware area — §10 can never fire and should go');
  if (cover.length) console.log('       ' + cover.join(', '));
}

/* ── §4 · THE BOTTOM NAV, WHICH IS THE DEFECT THIS STARTED FROM ─────────── */
section('§4  the fixed bottom nav clears the home indicator');
{
  /* The master declares `.app-bottom-nav { position:fixed; bottom:0;
     height:60px }` with no bottom padding and no env() anywhere in the file,
     so on settings.html and billing.html — both viewport-fit=cover — its lower
     34px sat behind the home indicator, which also owns the swipe gesture in
     that strip. Measured at 393×852 with an iPhone 15's insets.

     `height:auto` matters as much as the padding: the master's fixed 60px
     height would simply absorb the padding instead of growing by it. */
  const block = cssCode.match(/\[data-platform="tools"\]\s*\.app-bottom-nav\s*\{([^}]*)\}/);
  ok('§10 re-declares .app-bottom-nav', !!block);
  if (block) {
    const body = block[1];
    ok('  it pads the bottom by the inset', /padding-bottom:\s*var\(\s*--tmob-sab/.test(body),
       body.trim());
    ok('  and drops the master’s fixed height so the padding grows the bar',
       /height:\s*auto/.test(body) && /min-height:/.test(body),
       'without height:auto the 60px height absorbs the padding and nothing moves');
  }

  /* The pane behind the bar has to reserve room for the bar's NEW height. The
     master reserves 72px for a 60px bar; once the bar grows by the inset, the
     clearance has to grow with it or the tail of the page goes underneath. */
  ok('.app-main reserves the bar’s height PLUS the inset',
     /\.app-main\s*\{[^}]*padding-bottom:\s*calc\([^)]*--tmob-sab/.test(cssCode),
     'the bar grows by the inset and the clearance behind it does not');
}

/* ── §5 · THE FRAME MEASURES WHAT IT CLAIMS TO ──────────────────────────── */
section('§5  the frame’s own honesty');
{
  /* Writing insets into a page that never asked for them invents a layout the
     product does not have. The gate is the viewport-fit test. */
  ok('the frame only writes insets into a viewport-fit=cover page',
     /viewport-fit\s*\\?s\*=|viewport-fit/.test(frameCode) &&
     /cover\s*&&\s*px/.test(frameCode),
     'applyInsets must gate on the cover opt-in');

  /* The iframe is the whole point: it gives the framed page a real viewport at
     the device's CSS-pixel width, so its media queries resolve for real. A
     transform on the screen box instead would be a scaled desktop render. */
  ok('the screen box is sized in CSS pixels, not scaled into shape',
     /el\.screen\.style\.width\s*=\s*state\.w\s*\+\s*'px'/.test(frameCode));

  /* checkVisibility, not a single getComputedStyle. The homepage chat widget
     is closed with opacity:0 on an ancestor while every control inside it
     keeps opacity:1 — reading the element's own style reported four visible,
     undersized controls on a panel nobody can see. */
  /* The FEATURE DETECT, not a mention of the name. `/checkVisibility\(/` was
     the first version and a mutation walked straight past it: wrapping the
     call in `if (false)` leaves the token in the file, so the check went on
     reading a disabled code path as evidence that visibility was resolved
     properly. Pinning the guard expression is the weakest thing a static scan
     can assert here that still has to be true for the call to run. */
  ok('visibility is resolved through ancestors, not read off the element',
     /if\s*\(\s*typeof\s+n\.checkVisibility\s*===\s*['"]function['"]\s*\)/.test(frameCode),
     'an ancestor’s opacity:0 or display:none must count, and the call must be reachable');

  /* The fallback for engines without it has to CLIMB. A fallback that reads
     one element is the same defect with a longer body. */
  ok('  and its fallback walks the ancestor chain',
     /for\s*\(\s*let\s+p\s*=\s*n;[^)]*p\s*=\s*p\.parentElement\s*\)/.test(frameCode));

  /* A route that redirected was not measured. Reporting its checks under the
     requested route's name is how /app came back clean while every number in
     it came from /login. */
  ok('the frame reports where a frame actually landed',
     /landed/.test(frameCode) && /redirect/i.test(frame));
}

console.log('\ndevice-frame-contract: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

/* ═══════════════════════════════════════════════════════════════════════════
   MOBILE CONTRACT
   ───────────────────────────────────────────────────────────────────────────
   Guards the mobile layer added for the phone pass on this repo. It is a
   STATIC guard on purpose: the behaviour it protects was verified in a real
   browser (off-canvas drawer opened, closed, focus-trapped, and every page
   measured at 390 and 360 px), but Playwright is not a dependency of this repo
   and adding one to make `npm test` runnable is a worse trade than a scan that
   catches the ways this actually regresses — a page added without the
   stylesheet, an inline grid pasted back in, a viewport copied from the wrong
   sibling.

   What this CANNOT see, stated so nobody reads it as more than it is:
     · whether the drawer still opens (needs a browser)
     · whether anything overflows at 390px (needs layout)
     · whether a touch target is 44px (needs computed style)
   Those were measured once, by hand, at the time the layer was written. This
   file only stops the wiring from rotting underneath them.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const CSS = path.join(PUB, 'css', 'tools-mobile.css');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '\n       ' + detail : '')); }
};

const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

/* ── 1. THE MASTER IS STILL THE MASTER ──────────────────────────────────────
   CLAUDE.md §1: a per-repo edit to the design system is a defect. The whole
   reason tools-mobile.css exists is so the mobile pass did not have to touch
   it. If this hash moves, somebody took the shortcut. */
{
  const md5 = crypto.createHash('md5')
    .update(fs.readFileSync(path.join(PUB, 'css/modus-design-system.css')))
    .digest('hex');
  ok('design system is byte-identical to the master (md5 8425f456…)',
     md5.startsWith('8425f456'), 'got ' + md5.slice(0, 16));
}

/* ── 2. EVERY PAGE THAT HAS THE DESIGN SYSTEM HAS THE MOBILE LAYER ──────────
   A new page copied from an old one is the normal way a page arrives here, and
   an old one is a page from before this layer existed. */
{
  const missing = pages.filter((f) => {
    const s = read(f);
    return s.includes('css/modus-design-system.css') && !s.includes('tools-mobile.css');
  });
  ok('every design-system page also links css/tools-mobile.css',
     missing.length === 0, 'missing on: ' + missing.join(', '));
}

/* ── 3. THE DRAWER PAGES CARRY THE SCRIPT THAT DRIVES THE DRAWER ────────────
   The CSS is gated on the `.mnav-ready` class this script sets, so a page with
   the stylesheet and without the script keeps its cramped desktop sidebar
   rather than breaking — but it also silently loses the mobile nav it was
   given. These are the two shells that own their own sidebar. */
{
  for (const f of ['app.html', 'gao.html']) {
    ok(f + ' links js/mobile-nav.js (its sidebar has no other opener)',
       read(f).includes('mobile-nav.js'));
  }
  ok('js/mobile-nav.js exists', fs.existsSync(path.join(PUB, 'js', 'mobile-nav.js')));
}

/* ── 4. NOBODY BLOCKS PINCH-ZOOM ────────────────────────────────────────────
   billing.html shipped `maximum-scale=1.0, user-scalable=no` — a WCAG 1.4.4
   failure on the one page carrying the prices. It came from a sibling repo's
   viewport tag, which is exactly how it would come back. */
{
  const offenders = pages.filter((f) => {
    const m = read(f).match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
    return m && /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?!\d)/i.test(m[0]);
  });
  ok('no page disables pinch-zoom in its viewport meta',
     offenders.length === 0, 'blocks zoom: ' + offenders.join(', '));
}

/* ── 5. NO INLINE HARDCODED MULTI-COLUMN GRID ───────────────────────────────
   An inline style attribute outranks every stylesheet, so a media query cannot
   collapse `style="grid-template-columns:360px 1fr"` at any specificity — this
   is the one defect class the mobile layer is structurally unable to fix, and
   pr-demo.html overflowed 84px because of it. The .tmob-* utilities exist so
   the desktop value can stay at the call site as a custom property. */
{
  const bad = [];
  for (const f of pages) {
    const re = /style="[^"]*grid-template-columns\s*:\s*([^";]+)/g;
    let m;
    while ((m = re.exec(read(f)))) {
      const cols = m[1].trim();
      if (/\d+\s*px/.test(cols)) { bad.push(f + ': ' + cols); continue; }        // fixed px track
      const tracks = cols.split(/\s+(?![^(]*\))/).length;
      if (/repeat\s*\(\s*[3-9]/.test(cols) || tracks >= 3) bad.push(f + ': ' + cols);
    }
  }
  ok('no inline grid-template-columns with a fixed px or 3+ track layout',
     bad.length === 0, bad.join('\n       '));
}

/* ── 6. THE LAYER DOES NOT REACH DESKTOP, AND DOES NOT SHOUT ────────────────
   Every layout rule is inside a max-width media query and anchored on
   [data-platform="tools"] so it beats a page's own single-class rule by
   specificity rather than by load order. !important would mean that anchoring
   had failed and would make the next override unfixable. */
{
  const css = fs.readFileSync(CSS, 'utf8');
  /* Comments stripped first. The file's own header explains why it contains no
     !important, and scanning the raw text made that sentence fail the check it
     was describing. A guard that reads prose as code reports the documentation
     as the defect. */
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('tools-mobile.css uses no !important', !/!\s*important/.test(code));
  ok('tools-mobile.css declares no min-width breakpoint (it is additive only)',
     !/@media[^{]*\(\s*min-width/.test(code));

  /* The pair that already broke once: `display:none` on .mnav-toggle and the
     media query that shows it are BOTH (0,2,0), so whichever is written last
     wins. Shipped the wrong way round, the hamburger never appeared and the
     drawer had no opener — the CSS was correct and the product had no nav. */
  const hide = css.indexOf('.mnav-toggle {\n  display: none;');
  const show = css.lastIndexOf('display: inline-flex;');
  ok('the .mnav-toggle show-rule is written after the hide-rule (equal specificity)',
     hide !== -1 && show > hide, 'hide@' + hide + ' show@' + show);
}

/* ── 7. THE BOTTOM NAV POINTS AT ROUTES THAT EXIST ──────────────────────────
   settings.html inherited `/app/inbox` from the canonical master. There is no
   such route in this repo, so a third of the only mobile nav in the product
   404'd. Anything copied from the master is a candidate for the same thing. */
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = new Set();
  const rr = /app\.(get|use)\(\s*['"](\/[^'"]*)['"]/g;
  let m;
  while ((m = rr.exec(server))) routes.add(m[2]);

  const dead = [];
  for (const f of pages) {
    const s = read(f);
    if (!s.includes('app-bottom-nav')) continue;
    const nav = s.slice(s.indexOf('<nav class="app-bottom-nav"'));
    const block = nav.slice(0, nav.indexOf('</nav>'));
    let a;
    const ar = /href="(\/[^"#?]*)"/g;
    while ((a = ar.exec(block))) if (!routes.has(a[1])) dead.push(f + ' -> ' + a[1]);
  }
  ok('every bottom-nav destination resolves to a route in server.js',
     dead.length === 0, dead.join(', '));
}

/* ── 8. THE CANONICAL SHELL PAGES ACTUALLY HAVE A MOBILE NAV ────────────────
   The design system's contract is a pair: hide .app-sidebar at <=768px AND
   show .app-bottom-nav. billing.html and audiobook.html shipped only the first
   half, so on a phone they had no navigation at all — a state that looks fine
   in every screenshot of the page itself. */
{
  /* Exact class TOKEN, not a substring. `includes('app-bottom-nav')` also
     matched `app-bottom-nav-DISABLED`, so renaming the element — the most
     likely way it gets switched off — left this green. `\b` does not help:
     a hyphen is already a word boundary, so `\bapp-bottom-nav\b` matches the
     renamed class too. The only reliable test is to read the class attribute
     and compare whole tokens. */
  const hasClass = (src, name) => {
    const re = /class="([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) if (m[1].trim().split(/\s+/).includes(name)) return true;
    return false;
  };
  const half = pages.filter((f) => {
    const s = read(f);
    return hasClass(s, 'app-layout') && !hasClass(s, 'app-bottom-nav');
  });
  ok('every .app-layout page ships the bottom nav that hiding its sidebar assumes',
     half.length === 0, 'sidebar hidden with no replacement on: ' + half.join(', '));
}

console.log(`\nmobile-contract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

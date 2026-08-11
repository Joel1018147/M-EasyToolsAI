// ═══════════════════════════════════════════════════════════════
// M-EasyTools AI+ — MODUS UI CONTRACT v2.0 conformance
//
//   node test/ui-contract.js
//
// §7's build checklist, made executable. Everything here is a property that
// silently rots: a page added without data-platform renders in M-EasyDo blue,
// a second login surface drifts from the first, a locale key that never
// resolves leaves the switcher looking like it works.
//
// §7b RULE 4 — a scanner that reports only "found"/"not found" cannot tell a
// real absence from a parse failure. Every check below prints WHAT IT
// ACTUALLY READ, so a silent zero is visible as one.
//
// §7b RULE 1 — HTML comments are stripped before scanning for tags. The first
// version of the data-platform check counted the sentence "1. data-platform on
// <html>" inside the master's own header comment as an unmarked surface, and a
// documentation example in pr-demo.html as a marked one. Both wrong, both
// confident.
// ═══════════════════════════════════════════════════════════════

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PLATFORM = 'tools';
const ACCENT = '#E8622A';                       // §2 platform registry
const MASTER_CSS_MD5 = 'a208320dcabe23aef105fefa64ccd8ff';
// Moves in the SAME commit as a master sync. This constant is the tripwire
// that fires when the shared stylesheet drifts, so it firing is correct — it
// only becomes noise when a sync updates the ten copies and leaves it behind,
// which is what happened on the a208320d rollout and turned three repos red.

let failures = 0, checks = 0;
const pass = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { checks++; failures++; console.error('  ✗ ' + m); };
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 58 - m.length)));

const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
// JS comments too. Prose that NAMES a thing is not a use of it, and a scanner
// that cannot tell those apart reports every documented fix as unfixed. This
// is the same trap as the HTML-comment one above; both were hit on the first
// run of this file. Strings are preserved — a path in a string IS a use.
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
// This file and the repo's prose talk ABOUT these filenames by design. Scanning
// them would make every check here fail on its own text.
const SELF = ['test' + path.sep + 'ui-contract.js', 'README.md'];
const isSelf = (p) => SELF.some((s) => p.endsWith(s));
const declutter = (p, src) => (p.endsWith('.js') ? stripJsComments(src) : stripHtmlComments(src));
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const read = (f) => fs.readFileSync(f, 'utf8');

// ═══ 1. ONE design system, at public/css/, md5 matching the master ═══════
head('§1  the design system file');
{
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'modus-design-system.css') found.push(p);
    }
  })(ROOT);

  console.log('    scanned the repo tree; found ' + found.length + ' copy/copies');
  if (found.length !== 1) {
    fail('expected exactly ONE modus-design-system.css, found ' + found.length + ':\n      '
      + found.map((f) => path.relative(ROOT, f)).join('\n      '));
  } else {
    const rel = path.relative(ROOT, found[0]).replace(/\\/g, '/');
    if (rel === 'public/css/modus-design-system.css') pass('exactly one copy, at ' + rel);
    else fail('the one copy is at ' + rel + ', not public/css/');
    const hash = md5(fs.readFileSync(found[0]));
    if (hash === MASTER_CSS_MD5) pass('md5 ' + hash.slice(0, 8) + ' matches the master');
    else fail('md5 ' + hash.slice(0, 8) + ' does NOT match the master ' + MASTER_CSS_MD5.slice(0, 8)
      + ' — a per-repo edit to this file is a defect (§1)');
  }
}

// §1a — grep the BARE FILENAME. A repath that matches only the URL form
// (quote-then-slash) silently skips every filesystem path, which have no
// leading slash. Counting both forms is the check; the repath cannot
// self-verify.
{
  const refs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|js|json)$/.test(e.name)) continue;
      if (isSelf(p)) continue;
      const src = declutter(p, read(p));
      if (!src.includes('modus-design-system.css')) continue;
      src.split('\n').forEach((line, i) => {
        if (line.includes('modus-design-system.css')) {
          refs.push({ file: path.relative(ROOT, p).replace(/\\/g, '/'), line: i + 1, text: line.trim() });
        }
      });
    }
  })(ROOT);
  console.log('    references to the bare filename: ' + refs.length);
  const wrong = refs.filter((r) => !/\/css\/modus-design-system\.css/.test(r.text)
                                && !/css[\\/]modus-design-system\.css/.test(r.text));
  if (!wrong.length) pass('every reference points at the css/ path');
  else wrong.forEach((r) => fail(`${r.file}:${r.line} does not point at css/ — ${r.text.slice(0, 90)}`));
}

// ═══ 2. data-platform on EVERY surface, static and runtime-rendered ══════
head('§2  data-platform on every surface');
{
  const surfaces = [];
  const collect = (file, src) => {
    const clean = stripHtmlComments(src);
    (clean.match(/<html\b[^>]*>/g) || []).forEach((tag) => {
      // pr-demo.html documents the attribute's own syntax in a code sample.
      if (/do\|tools\|commerce/.test(tag)) return;
      surfaces.push({ file, tag });
    });
  };
  fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))
    .forEach((f) => collect('public/' + f, read(path.join(PUBLIC, f))));
  // Server-rendered HTML. Enumerated explicitly: a page emitted from a route
  // file is invisible to a public/*.html scan, and that exact gap shipped 31
  // unmarked pages on another platform.
  ['routes/subscription.js', 'routes/subsystemPages.js', 'server.js', 'public/app.html']
    .forEach((f) => { if (fs.existsSync(path.join(ROOT, f))) collect(f + ' (runtime)', read(path.join(ROOT, f))); });

  const seen = new Set();
  const unique = surfaces.filter((s) => {
    const k = s.file + ' ' + s.tag;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  console.log('    surfaces found: ' + unique.length + ' (static pages + runtime-rendered documents)');
  if (!unique.length) fail('ZERO surfaces parsed — that is a parse failure, not a clean result');
  const bad = unique.filter((s) => !new RegExp('data-platform="' + PLATFORM + '"').test(s.tag));
  if (!bad.length) pass('all ' + unique.length + ' carry data-platform="' + PLATFORM + '"');
  else bad.forEach((s) => fail(`${s.file} — ${s.tag.slice(0, 80)}`));
}

// ═══ 3. exactly ONE login surface (§B2) ═════════════════════════════════
head('§B2  one login surface');
{
  const candidates = ['login.html', 'signup.html', 'register.html', 'signin.html']
    .filter((f) => fs.existsSync(path.join(PUBLIC, f)));
  if (!candidates.length) pass('no legacy login/signup page remains in public/');
  else fail('a second login surface still exists: ' + candidates.join(', '));

  if (fs.existsSync(path.join(PUBLIC, 'auth.html'))) pass('public/auth.html is present');
  else fail('public/auth.html is missing');

  // §C1 — nothing may still reference a deleted page. Comments do not count
  // as references, but a link in markup does.
  const dangling = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(html|js)$/.test(e.name)) continue;
      if (isSelf(p)) continue;
      const src = declutter(p, read(p));
      ['login.html', 'signup.html'].forEach((name) => {
        if (src.includes(name)) dangling.push(path.relative(ROOT, p).replace(/\\/g, '/') + ' → ' + name);
      });
    }
  })(ROOT);
  if (!dangling.length) pass('nothing references login.html or signup.html');
  else dangling.forEach((d) => fail('dangling reference: ' + d));
}

// ═══ 4. the auth portal matches the master ══════════════════════════════
head('§4.1  the auth portal');
{
  const src = read(path.join(PUBLIC, 'auth.html'));
  const need = ['login', 'register', 'forgot', 'otp'];
  const views = need.filter((v) => src.includes('data-view-panel="' + v + '"'));
  console.log('    views present: ' + views.join(', '));
  if (views.length === need.length) pass('all four required views render');
  else fail('missing view panel(s): ' + need.filter((v) => !views.includes(v)).join(', '));

  const required = {
    // Rendered as <button onclick="location.href='/auth/google'">, not an
    // anchor. Matching only the anchor form is how the platform extension's
    // return-path rewrite silently matched nothing.
    'Google OAuth button': /oauth-google[\s\S]{0,120}\/auth\/google/,
    'password show/hide': /data-pw-toggle/,
    'remember-me': /name="remember"/,
    'consent checkbox': /name="consent"/,
    'password strength meter': /pw-strength/,
    'language switcher': /lang-switch-btn/,
    'theme toggle': /id="themeToggle"/,
    'single alert region': /id="authAlert"/,
    'per-field errors': /field-error/,
    'support footer': /support@modusaiassociates\.com/,
    'skip link': /class="skip-link"/,
  };
  Object.entries(required).forEach(([label, re]) => {
    if (re.test(src)) pass(label); else fail('auth.html is missing: ' + label);
  });

  // §4.1c/§4.1e — the selector and the gate must not be postable when off.
  if (/selfServiceRoles:\s*\[\s*\]/.test(src)) pass('selfServiceRoles is empty (one public account type)');
  else fail('selfServiceRoles is non-empty — every listed role must be self-service (§4.1b)');
  if (/registration:\s*'open'/.test(src)) pass("registration is 'open' (§4.1e)");
  else fail('registration mode not recognised');
}

// ═══ 5. settings: ten sections, master order, master field names ════════
head('§4.2  the settings page');
{
  const src = read(path.join(PUBLIC, 'settings.html'));
  const EXPECTED = ['profile', 'security', 'appearance', 'language', 'notifications',
                    'ai', 'team', 'integrations', 'billing', 'danger'];
  const navOrder = [...src.matchAll(/class="settings-nav-item[^"]*"\s+data-section="([a-z]+)"/g)].map((m) => m[1]);
  console.log('    nav sections read from the markup: ' + (navOrder.join(', ') || '(none)'));
  if (!navOrder.length) fail('parsed ZERO nav sections — parse failure, not an empty page');
  else if (navOrder.join(',') === EXPECTED.join(',')) pass('all ten sections, in the contract order');
  else fail('section list/order differs from §4.2:\n      want ' + EXPECTED.join(', ') + '\n      got  ' + navOrder.join(', '));

  const panels = [...src.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
  const missingPanels = EXPECTED.filter((s) => !panels.includes(s));
  if (!missingPanels.length) pass('every section has a panel — none is hidden rather than empty (§4.2)');
  else fail('sections with no panel: ' + missingPanels.join(', '));

  // §4.2b — the field names ARE the API contract.
  const CANON = {
    profile: ['name', 'email', 'phone', 'timezone'],
    security: ['currentPassword', 'newPassword', 'twofa'],
    appearance: ['theme', 'sidebarCollapsed'],
    language: ['lang', 'currency', 'dateFormat', 'sstRate'],
    notifications: ['notifyEmail', 'notifyWhatsapp', 'notifyInApp', 'digest'],
    ai: ['ashaTone', 'escalationPhone', 'trilingualAutoDetect', 'humanEscalation'],
  };
  const names = new Set([...src.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]));
  const missingNames = Object.values(CANON).flat().filter((n) => !names.has(n));
  if (!missingNames.length) pass('all ' + Object.values(CANON).flat().length + ' canonical §4.2b field names present');
  else fail('missing canonical field name(s): ' + missingNames.join(', '));

  // §4.2d — it must READ, not only write.
  const fetches = (src.match(/fetch\(/g) || []).length;
  console.log('    fetch() calls in settings.html: ' + fetches);
  if (/fetch\('\/api\/settings'/.test(src)) pass('loads GET /api/settings on boot (§4.2d)');
  else fail('settings.html never reads /api/settings — every field would show a template default');
}

// ═══ 6. i18n: every hook resolves, in all three languages ═══════════════
head('§4.3b/§4.2c  translation hooks resolve');
{
  const getDeep = (o, k) => k.split('.').reduce((n, p) => (n && typeof n === 'object' ? n[p] : undefined), o);
  const dicts = {};
  for (const lang of ['en', 'ms', 'zh']) {
    const f = path.join(PUBLIC, 'locales', lang + '.json');
    if (!fs.existsSync(f)) { fail('missing locale file: locales/' + lang + '.json'); continue; }
    dicts[lang] = JSON.parse(read(f));
  }
  for (const page of ['auth.html', 'settings.html']) {
    const src = read(path.join(PUBLIC, page));
    const keys = [...new Set((src.match(/data-i18n(?:-html)?="([^"]+)"/g) || [])
      .map((s) => s.replace(/.*="|"/g, '')))];
    console.log('    ' + page + ': ' + keys.length + ' unique hooks');
    if (!keys.length) { fail(page + ': parsed ZERO hooks — parse failure'); continue; }
    for (const lang of Object.keys(dicts)) {
      const missing = keys.filter((k) => getDeep(dicts[lang], k) === undefined);
      if (!missing.length) pass(`${page} × ${lang}: ${keys.length}/${keys.length} resolve`);
      else fail(`${page} × ${lang}: ${missing.length} key(s) do not resolve — the switcher would `
        + `leave them in English. First few: ${missing.slice(0, 5).join(', ')}`);
    }
  }

  // §4.3c — a switcher with no engine reachable from the page is a dead control.
  for (const page of ['auth.html', 'settings.html']) {
    const src = read(path.join(PUBLIC, page));
    if (!/lang-switch-btn/.test(src)) continue;
    if (/<script src="\/js\/i18n\.js">/.test(src)) pass(page + ' loads the i18n engine');
    else fail(page + ' renders a language switcher and never loads /js/i18n.js — a dead control (§4.3c)');
    if (/window\.i18n\s*=\s*window\.i18n\s*\|\|/.test(src)) pass(page + ' adapts window.I18n to the contract interface (§4.2e)');
    else fail(page + ' has no adapter; this repo\'s engine is window.I18n.setLang and the page calls window.i18n.apply');
  }
}

// ═══ 7. the accent is read from the stylesheet, never from a document ═══
head('§2b  the registry, checked against the code');
{
  const css = read(path.join(PUBLIC, 'css', 'modus-design-system.css'));
  const block = css.match(new RegExp('\\[data-platform="' + PLATFORM + '"\\][^{]*\\{([^}]*)\\}'));
  if (!block) {
    fail('no [data-platform="' + PLATFORM + '"] block in the stylesheet — parse failure or a missing platform');
  } else {
    const m = block[1].match(/--accent\s*:\s*([^;]+);/);
    const resolved = m && m[1].trim();
    console.log('    --accent resolved from the stylesheet: ' + resolved);
    if (resolved && resolved.toLowerCase() === ACCENT.toLowerCase()) pass('accent matches the §2 registry (' + ACCENT + ')');
    else fail('accent is ' + resolved + ', registry says ' + ACCENT + ' — and the REPO WINS until proven otherwise (§2b)');

    const SIX = ['--accent', '--accent-2', '--accent-bg', '--accent-glow', '--accent-light', '--accent-contrast'];
    const missing = SIX.filter((t) => !new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(block[1]));
    if (!missing.length) pass('all six accent tokens declared');
    else fail('accent tokens missing from the ' + PLATFORM + ' block: ' + missing.join(', '));
  }
}

console.log('');
console.log(`${checks} checks, ${failures} failure(s)`);
if (failures) { console.error('\n✗ UI contract conformance FAILED\n'); process.exit(1); }
console.log('✓ UI contract conformance\n');

'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   THE IMAGE OPTION ON THE SOCIAL MEDIA POST TOOL — on BOTH pages that ship it
   ───────────────────────────────────────────────────────────────────────────
   `social-media` is defined TWICE in this repo: in public/app.html, behind the
   dashboard's "Social Post" tile, and in public/social.html, reached through
   /social's landing page and its "Open Tool →" button. Two FORMS tables, two
   openTool(), two generate().

   The first pass of this feature was built into social.html alone. It passed
   62 checks, deployed green, and was invisible to anyone using the dashboard —
   because the suite only ever knew about one of the two pages. So this file
   runs its WHOLE battery against BOTH, from one table, and check one reads the
   product to prove that table is complete. A page that ships the tool and is
   not covered here now fails the suite.

   It takes the real inline script out of each page, plus the whole of
   /js/imagegen.js and /js/postimage.js, and runs them in one vm sandbox over a
   fake DOM and a stubbed fetch. Nothing below is a copy of the code under
   test. If an anchor stops matching, the harness FAILS rather than quietly
   testing nothing (#14).

   ── HOW IT FINDS THE CONTROLS ─────────────────────────────────────────────
   By walking the form for a checkbox, a textarea and a select — not by id.
   postimage.js holds every node it creates by reference and never asks the
   document for one back, so there is no id to typo. The page's own fields ARE
   looked up by id, because the page built them, and that one boundary is
   checked on its own.

   ── THE INVARIANTS ────────────────────────────────────────────────────────
   1. READ = SENT — the description in the visible box is byte-for-byte the
      prompt that reaches the API, with no hidden negative prompt.
   2. THE SERVER'S SENTENCE SURVIVES — quota, billing and not-configured all
      arrive written for a person; none of them is replaced.
   3. THE TWO HALVES ARE INDEPENDENT — a caption failure must not delete an
      image already generated and billed, and vice versa.
   4. THE ASPECT MAP CANNOT DRIFT from lib/image/sizes.js.
   5. ONE IMPLEMENTATION — neither page may carry a copy of its own.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..');
const sizes = require('../lib/image/sizes');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const imagegenSrc = read('public/js/imagegen.js');
const postimageSrc = read('public/js/postimage.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra === undefined ? '' : '→ ' + extra); }
};
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 64 - m.length)));

/* ═══ THE TABLE — every page that ships the social-media tool ═══════════════ */
const PAGES = [
  {
    label: 'public/app.html — the dashboard hub, behind the "Social Post" tile',
    file: 'public/app.html',
    bootstrap: [/^\s*renderTools\(TOOLS\);\s*$/m, /^\s*initTheme\(\);\s*$/m,
                /^\s*initLang\(\);\s*$/m, /^\s*initApp\(\);\s*$/m],
    generate: 'generateContent',
    otherTool: 'blog-writer',
    dropInPanel: false,
  },
  {
    label: 'public/social.html — the module page, behind /social’s "Open Tool"',
    file: 'public/social.html',
    bootstrap: [/^init\(\);\s*$/m],
    generate: 'generate',
    otherTool: 'instagram-bio',
    dropInPanel: true,
  },
];

/* ═══ 1. HARNESS INTEGRITY ═══════════════════════════════════════════════════ */
head('1. harness integrity — is this every page, and the real program?');

const htmlFiles = fs.readdirSync(path.join(APP, 'public')).filter((f) => f.endsWith('.html'));
const definesTool = htmlFiles
  .filter((f) => /\{id:'social-media',name:/.test(read('public/' + f)))
  .map((f) => 'public/' + f).sort();
const covered = PAGES.map((p) => p.file).sort();
ok('THE CHECK THAT WAS MISSING — every page defining the social-media tool is covered here',
   JSON.stringify(definesTool) === JSON.stringify(covered),
   'product: ' + definesTool.join(', ') + '  |  covered: ' + covered.join(', '));

for (const page of PAGES) {
  const html = read(page.file);
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  ok(page.file + ': inline script found', blocks.length >= 1, blocks.length);
  page.js = blocks.length ? blocks[0][1] : '';
  let stripped = 0;
  for (const re of page.bootstrap) {
    if (re.test(page.js)) { stripped++; page.js = page.js.replace(re, '/* bootstrap removed by harness */'); }
  }
  ok(page.file + ': every bootstrap anchor matched and was stripped',
     stripped === page.bootstrap.length, stripped + '/' + page.bootstrap.length);
  ok(page.file + ': loads imagegen.js and postimage.js',
     /src="\/js\/imagegen\.js"/.test(html) && /src="\/js\/postimage\.js"/.test(html));
  ok(page.file + ': wires the shared module rather than carrying a copy',
     /PostImage\.attach\(/.test(page.js)
     && !/function derivedImagePrompt|function buildImageSection|function paintImage/.test(page.js),
     'a page-local implementation is present');
}

ok('postimage.js exposes the surface both pages call',
   /window\.PostImage\s*=/.test(postimageSrc) && /attach:/.test(postimageSrc));
ok('imagegen.js still owns the transport both go through',
   /window\.ImageGen\s*=/.test(imagegenSrc));

/* The one place a name still has to be agreed: the page builds ff-<field> and
   the page's own wiring names them. */
for (const page of PAGES) {
  const builds = /id="ff-\$\{f\.id\}"/.test(page.js);
  const wires = /fields:\{topic:'ff-topic',platform:'ff-platform',goal:'ff-goal'\}/.test(page.js);
  const form = /\{id:'topic',[\s\S]{0,400}?\{id:'platform',[\s\S]{0,400}?\{id:'goal',/.test(page.js);
  ok(page.file + ': the field ids it wires are the ids its social-media form builds',
     builds && wires && form, `builds=${builds} wires=${wires} form=${form}`);
}

/* ═══ 2. THE ASPECT MAP, AGAINST THE SERVER ═════════════════════════════════ */
head('2. the platform → aspect map, against lib/image/sizes.js');
const mapped = (() => {
  const m = /var PLATFORM_ASPECT = \{([\s\S]*?)\n  \};/.exec(postimageSrc);
  ok('PLATFORM_ASPECT lives in the module, once', Boolean(m));
  return m ? [...m[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((x) => ({ platform: x[1], size: x[2] })) : [];
})();
ok('it maps every platform to something', mapped.length >= 5, mapped.length);
{
  const illegal = mapped.filter((e) => !sizes.LEGAL_SIZES.includes(e.size));
  ok('every aspect it can send is one the server will accept',
     illegal.length === 0, illegal.map((e) => e.platform + '→' + e.size).join(', '));
}
for (const page of PAGES) {
  const opts = /\{id:'platform',label:'Platform',type:'select',opts:\[([^\]]*)\]\}/.exec(page.js);
  ok(page.file + ': the Platform field is where this suite thinks it is', Boolean(opts));
  const platforms = opts ? [...opts[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const unmapped = platforms.filter((p) => !mapped.some((e) => e.platform === p));
  ok(page.file + ': every platform a user can choose has an aspect chosen for it',
     platforms.length > 0 && unmapped.length === 0, unmapped.join(', '));
}

/* ═══ THE SANDBOX ═══════════════════════════════════════════════════════════ */

function makeSandbox(page, routes) {
  const dom = Object.create(null);
  const calls = [];

  function mk(tag) {
    const node = {
      tagName: String(tag || 'div').toLowerCase(),
      children: [], options: [], attrs: {}, listeners: {},
      style: {}, className: '', id: '', textContent: '', _html: '',
      value: '', hidden: false, disabled: false, checked: false, selected: false,
      href: '', src: '', alt: '', type: '', placeholder: '', rows: 0,
      maxLength: 0, download: '', target: '', rel: '',
      appendChild(c) {
        this.children.push(c);
        if (c && c.tagName === 'option') this.options.push(c);
        return c;
      },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() {}, blur() {}, click() { this.fire('click'); }, remove() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      fire(ev) { (this.listeners[ev] || []).forEach((f) => f({ target: this, preventDefault() {} })); },
      all() { const out = [this]; this.children.forEach((c) => { if (c.all) out.push(...c.all()); }); return out; },
      find(pred) { return this.all().find(pred) || null; },
      text() { return this.all().map((n) => (n.textContent || '') + ' ' + (n._html || '')).join(' '); },
    };
    /* innerHTML REPLACES a subtree. A fake that keeps the old children while
       storing the new string lets a block painted over another one still be
       found by a test, which is how the stale-response guard once passed a run
       with that guard deleted. */
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._html; },
      set(v) { node._html = String(v); node.children.length = 0; node.options.length = 0; },
    });
    return node;
  }

  const mount = mk('div');
  const document = {
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    readyState: 'complete',
    createElement: mk,
    createTextNode: (t) => { const n = mk('#text'); n.textContent = String(t); return n; },
    getElementById(id) { if (!dom[id]) { dom[id] = mk('div'); dom[id].id = id; } return dom[id]; },
    querySelector(sel) { return sel === '[data-imagegen-mount]' ? mount : null; },
    querySelectorAll(sel) { return sel === '[data-imagegen-mount]' ? [mount] : []; },
    addEventListener() {}, removeEventListener() {},
    cookie: '',
  };

  async function fetchStub(url, opts) {
    const u = String(url);
    const record = { url: u, method: (opts && opts.method) || 'GET',
                     body: opts && opts.body ? JSON.parse(opts.body) : null };
    calls.push(record);
    const route = Object.keys(routes).find((k) => u.indexOf(k) === 0);
    if (!route) throw new Error('sandbox: no route for ' + u);
    const answer = await routes[route](record, calls.length);
    if (answer.network) throw new TypeError('Failed to fetch');
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)),
      json: async () => (typeof answer.body === 'string' ? JSON.parse(answer.body) : answer.body),
    };
  }

  const ctx = {
    console, JSON, Promise, Math, Date, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    document, fetch: fetchStub,
    Image: function () { return mk('img'); },
    navigator: { clipboard: { writeText: () => Promise.resolve() }, language: 'en' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { href: 'https://example.test/app', pathname: '/app', search: '', hash: '',
                assign() {}, replace() {} },
    history: { pushState() {}, replaceState() {} },
    alert() {}, confirm: () => true,
    URLSearchParams,
    requestAnimationFrame: (f) => setTimeout(f, 0),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(imagegenSrc, ctx, { filename: 'public/js/imagegen.js' });
  vm.runInContext(postimageSrc, ctx, { filename: 'public/js/postimage.js' });
  vm.runInContext(page.js, ctx, { filename: page.file + '#inline' });

  const evaluate = (expr) => vm.runInContext(expr, ctx);

  /* Find the module's controls the way a person would — a checkbox, a
     textarea, a select — not by an id that could be typo'd on either side. */
  function controls() {
    const all = dom['form-fields'] ? dom['form-fields'].all() : [];
    const hints = all.filter((n) => n.className === 'pimg-hint');
    return {
      toggle: all.find((n) => n.tagName === 'input' && n.type === 'checkbox'),
      prompt: all.find((n) => n.tagName === 'textarea'),
      size: all.find((n) => n.tagName === 'select' && n.getAttribute('aria-label') === 'Image aspect'),
      note: hints[0],
    };
  }

  return { ctx, dom, calls, mount, evaluate, controls,
           imageHost: () => document.getElementById('out-image') };
}

const OPTIONS_OK = {
  status: 200,
  body: { ok: true, provider: 'dashscope', configured: true, missing: [], model: 'qwen-image',
          sizes: sizes.catalogue(), defaultSize: '1328*1328', brandAssets: [], maxPromptChars: 2000 },
};
const storedImage = (over) => Object.assign({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  status: 'stored', size: '1664*928',
  url: '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/file',
  usage: { remaining: { day: 4, month: 41 } },
}, over || {});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function openSocial(box, over) {
  box.evaluate("openTool('social-media')");
  const fields = Object.assign(
    { 'ff-topic': 'Summer sale launch', 'ff-platform': 'LinkedIn', 'ff-goal': 'Drive website traffic' },
    over || {});
  for (const [id, v] of Object.entries(fields)) box.dom[id].value = v;
  await box.ctx.window.ImageGen.ready();
  await tick();
  return box;
}
function switchOn(box) {
  const c = box.controls();
  c.toggle.checked = true;
  c.toggle.fire('change');
  return box.controls();
}

/* ═══ THE BATTERY — run in full against every page in the table ═════════════ */
async function battery(page) {
  head('▶ ' + page.label);

  /* 3. the option is built, and only for this tool */
  {
    const box = makeSandbox(page, { '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    const c = box.controls();
    ok('the Social Media Posts form carries the image toggle', Boolean(c.toggle));
    ok('…with an aspect select and a description box', Boolean(c.size) && Boolean(c.prompt));
    if (page.dropInPanel) {
      ok('the drop-in panel is hidden while this tool is open — one image control per screen',
         box.mount.hidden === true);
    }

    /* Tick it HERE, before leaving. A module that keeps hold of the form it
       was attached to would carry a ticked box — and its stale description —
       into the next tool, whose Generate calls start() too. Asserting the
       option is merely ABSENT from the other tool does not see that;
       asserting it cannot still FIRE does. */
    switchOn(box);
    box.evaluate(`openTool('${page.otherTool}')`);
    ok('another tool gets no image section at all', !box.controls().toggle);
    ok('…and a box ticked on the post tool does not follow the user to it',
       box.evaluate('PostImage.pending()') === null);
    ok('…so that tool\'s Generate fires no image request',
       box.evaluate('PostImage.start()') === false);
    if (page.dropInPanel) {
      ok('…and the drop-in panel comes back for it', box.mount.hidden === false);
    }
  }

  /* 4. a control that cannot work says so up front */
  {
    const unconfigured = { status: 200,
      body: Object.assign({}, OPTIONS_OK.body, { configured: false, missing: ['DASHSCOPE_API_KEY'] }) };
    const box = makeSandbox(page, { '/api/images/options': async () => unconfigured });
    await openSocial(box);
    const c = box.controls();
    ok('an unconfigured deployment disables the toggle rather than failing on click',
       c.toggle.disabled === true);
    ok('…and says so, naming text generation as unaffected',
       c.note.hidden === false && /not configured/i.test(c.note.textContent)
       && /text generation is unaffected/i.test(c.note.textContent), c.note.textContent);
    c.toggle.checked = true;
    ok('…and a disabled toggle produces no request even if something ticks it',
       box.evaluate('PostImage.pending()') === null);
  }
  {
    const box = makeSandbox(page, { '/api/images/options': async () =>
      ({ status: 402, body: { error: 'subscription_expired',
         message: 'Your subscription has expired. Please renew at /billing.' } }) });
    await openSocial(box);
    ok('a lapsed subscription is reported in the words that name the fix',
       /renew at .billing/.test(box.controls().note.textContent), box.controls().note.textContent);
  }

  /* 5. the description */
  {
    const box = makeSandbox(page, { '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    const c = switchOn(box);
    const p = c.prompt.value;
    ok('the description carries the topic verbatim', p.includes('Summer sale launch'), p);
    ok('…the platform', p.includes('LinkedIn'), p);
    ok('…the goal', /drive website traffic/i.test(p), p);
    ok('…the tone', /professional/i.test(p), p);
    ok('…and tells the model to leave the lettering to the caption',
       /no text/i.test(p) && /watermark/i.test(p), p);

    box.evaluate("activeTone='Witty'; PostImage.refresh();");
    ok('changing the tone rewrites an untouched description', /witty/i.test(c.prompt.value), c.prompt.value);

    c.prompt.value = 'A hand holding a paper boarding pass';
    c.prompt.fire('input');
    box.dom['ff-topic'].value = 'Something else entirely';
    box.dom['ff-topic'].fire('input');
    ok('once edited, the description is never rewritten under the user',
       c.prompt.value === 'A hand holding a paper boarding pass', c.prompt.value);
  }

  /* 6. the aspect */
  {
    const box = makeSandbox(page, { '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    const c = switchOn(box);
    ok('the size list came from the server catalogue, not a copy on the page',
       c.size.options.length === sizes.LEGAL_SIZES.length, c.size.options.length + ' options');
    ok('LinkedIn gets landscape', c.size.value === '1664*928', c.size.value);

    box.dom['ff-platform'].value = 'TikTok';
    box.dom['ff-platform'].fire('change');
    ok('TikTok gets full-screen portrait', c.size.value === '928*1664', c.size.value);

    c.size.value = '1328*1328';
    c.size.fire('change');
    box.dom['ff-platform'].value = 'Instagram';
    box.dom['ff-platform'].fire('change');
    ok('once chosen, the aspect is never changed under the user', c.size.value === '1328*1328', c.size.value);
  }

  /* 7. READ = SENT */
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    box.ctx.window.GenLang = { get: () => 'ms' };
    await openSocial(box);
    const c = switchOn(box);
    c.prompt.value = 'A durian on a marble counter, morning light';
    c.prompt.fire('input');
    box.evaluate('PostImage.start()');
    await tick();

    const sent = box.calls.find((x) => x.url === '/api/images/generate');
    ok('THE INVARIANT — the prompt sent is the string in the visible box, byte for byte',
       sent && sent.body.prompt === 'A durian on a marble counter, morning light', sent && sent.body.prompt);
    ok('no hidden negative prompt is bolted on behind the user',
       sent && !('negative_prompt' in sent.body), sent && JSON.stringify(sent.body));
    ok('no brand asset travels without a consent surface',
       sent && !sent.body.use_brand_asset && !sent.body.brand_asset_ref);
    ok('the selected aspect is sent', sent && sent.body.size === '1664*928', sent && sent.body.size);
    ok("the run's output language is recorded against the row", sent && sent.body.lang === 'ms');
  }

  /* 8. the result */
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    await openSocial(box);
    switchOn(box);
    box.evaluate('PostImage.start()');
    await tick();

    const host = box.imageHost();
    const img = host.find((n) => n.tagName === 'img');
    ok('an <img> is rendered', Boolean(img));
    ok("its src is this platform's own owner-scoped route, never the provider's",
       img && img.src === '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/file', img && img.src);
    ok('it has alt text taken from the description', img && img.alt.length > 0);
    ok('the page empty state is cleared', box.dom['out-empty'].style.display === 'none');
    ok('the remaining quota that came back with it is printed rather than re-fetched',
       /4 image generations left today/.test(host.text()) && /41 this month/.test(host.text()),
       host.text().slice(0, 140));
    ok('…and no second request was made to find that out',
       box.calls.filter((x) => x.url.indexOf('/api/images/usage') === 0).length === 0);
  }

  /* 9. the server's own sentence */
  {
    const capMessage = 'Your Free plan allows 3 image generations in a day, and 3 have been used. '
      + 'This limit is checked before the request is sent, so nothing was charged.';
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 429,
        body: { ok: false, error: 'image_cap_exceeded', message: capMessage } }),
    });
    await openSocial(box);
    switchOn(box);
    box.evaluate('PostImage.start()');
    await tick();
    const shown = box.imageHost().text();
    ok('a quota refusal is shown in the words the API chose', shown.includes(capMessage), shown.slice(0, 180));
    ok('…and is not replaced by a generic apology', !/something went wrong/i.test(shown));
    ok('nothing is rendered as an image', box.imageHost().find((n) => n.tagName === 'img') === null);
  }
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201,
        body: { ok: true, image: storedImage({ status: 'rehost_failed', url: null }) } }),
    });
    await openSocial(box);
    switchOn(box);
    box.evaluate('PostImage.start()');
    await tick();
    const shown = box.imageHost().text();
    ok('a row that holds no bytes is a failure, not a broken image tag',
       /could not be stored/i.test(shown) && box.imageHost().find((n) => n.tagName === 'img') === null,
       shown.slice(0, 140));
    ok('…and it says the quota was still spent', /counted against your quota/i.test(shown));
  }
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ network: true }),
    });
    await openSocial(box);
    switchOn(box);
    box.evaluate('PostImage.start()');
    await tick();
    ok('a request that never left the machine is worded as that, not as a refusal',
       /cannot reach the server/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 140));
  }

  /* 10. the two halves are independent — driven through the PAGE's own generate */
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
      '/api/generate': async () => ({ status: 500, body: { error: 'Groq is down' } }),
    });
    await openSocial(box);
    switchOn(box);
    await box.evaluate(`${page.generate}()`);
    await tick();
    ok('the posts failing does not delete an image that was generated and billed',
       Boolean(box.imageHost().find((n) => n.tagName === 'img')));
    ok('…and the "nothing here yet" empty state does not reappear over it',
       box.dom['out-empty'].style.display === 'none', box.dom['out-empty'].style.display);
  }
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 500,
        body: { ok: false, error: 'provider_failed', message: 'The provider refused.' } }),
      '/api/generate': async () => ({ status: 200, body: { text: 'POST 1 — Summer is here.' } }),
    });
    await openSocial(box);
    switchOn(box);
    await box.evaluate(`${page.generate}()`);
    await tick();
    ok('the image failing does not take the posts down with it',
       box.dom['out-results'].text().includes('Summer is here'),
       box.dom['out-results'].text().slice(0, 100));
    ok('…and the image failure is reported where the image would have been',
       /provider refused/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 140));
  }
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/generate': async () => ({ status: 500, body: { error: 'Groq is down' } }),
    });
    await openSocial(box);
    await box.evaluate(`${page.generate}()`);
    ok('NEGATIVE CONTROL — with no image requested, a text failure still restores the empty state',
       box.dom['out-empty'].style.display === 'flex', box.dom['out-empty'].style.display);
  }

  /* 11. a slow answer cannot paint over a newer one */
  {
    let release;
    const held = new Promise((r) => { release = r; });
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async (rec, n) => {
        if (n === 2) { await held; return { status: 201, body: { ok: true, image: storedImage({ id: 'first', url: '/api/images/first/file' }) } }; }
        return { status: 201, body: { ok: true, image: storedImage({ id: 'second', url: '/api/images/second/file' }) } };
      },
    });
    await openSocial(box);
    switchOn(box);
    box.evaluate('PostImage.start()');
    box.evaluate('PostImage.start()');
    await tick();
    ok('the newer answer is on screen',
       box.imageHost().find((n) => n.tagName === 'img').src === '/api/images/second/file');
    release();
    await tick();
    ok('the older answer, arriving late, does not paint over it',
       box.imageHost().find((n) => n.tagName === 'img').src === '/api/images/second/file',
       box.imageHost().find((n) => n.tagName === 'img').src);
  }

  /* 12. an empty description spends nothing */
  {
    const box = makeSandbox(page, {
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    await openSocial(box);
    const c = switchOn(box);
    c.prompt.value = '';
    c.prompt.fire('input');
    box.evaluate('PostImage.start()');
    await tick();
    ok('nothing is sent', box.calls.filter((x) => x.url === '/api/images/generate').length === 0);
    ok('…and the user is told, rather than left with a silent no-op',
       /describe the image/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 140));
    ok('…and it says nothing was charged', /nothing was charged/i.test(box.imageHost().text()));
  }
}

(async () => {
  for (const page of PAGES) await battery(page);

  console.log('\n' + (pass + fail) + ' checks, ' + fail + ' failure(s)');
  if (fail) { console.error('✗ THE IMAGE OPTION ON THE SOCIAL POST TOOL'); process.exit(1); }
  console.log('✓ THE IMAGE OPTION ON THE SOCIAL POST TOOL — on every page that ships it');
})().catch((e) => { console.error('harness crashed:', e); process.exit(1); });

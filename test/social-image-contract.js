'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   THE IMAGE OPTION ON THE SOCIAL MEDIA POST TOOL — executed, not scanned
   ───────────────────────────────────────────────────────────────────────────
   CLAUDE.md's own "Test coverage gap" section is about exactly this shape:
   public/content.html's save handling is covered only by a static scan that
   reads source as text, so an inverted `.ok` check would pass it. This suite
   does not repeat that mistake for the feature it covers.

   It takes the WHOLE inline script out of public/social.html and the WHOLE of
   public/js/imagegen.js, runs both in one vm sandbox over a fake DOM and a
   stubbed fetch, and drives the real functions. Nothing below is a copy of the
   code under test. If an anchor stops matching, the harness FAILS rather than
   quietly testing nothing (#14) — the first four checks exist only to prove
   the suite is looking at the real program.

   ── THE INVARIANTS IT DEFENDS ─────────────────────────────────────────────
   1. READ = SENT. The description in the visible box is byte-for-byte the
      prompt that reaches the API, with no hidden negative prompt bolted on.
      lib/image stores the prompt it sends; a UI that sends something the user
      never read makes that stored row describe something nobody asked for.
   2. THE SERVER'S SENTENCE SURVIVES. A quota refusal, a moderation refusal
      and an unconfigured deployment each arrive with a message written for a
      person. Replacing any of them with "something went wrong" throws away
      the only actionable part of the response.
   3. THE TWO HALVES ARE INDEPENDENT. A caption that fails must not delete an
      image that has already been generated and billed; an image that fails
      must not take the posts down with it.
   4. THE ASPECT MAP CANNOT DRIFT. public/social.html maps platform → aspect.
      lib/image/sizes.js owns the five legal values. A page offering a sixth
      would 400 on every click, so the map is checked against the real module.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..');
const PAGE = path.join(APP, 'public', 'social.html');
const IMAGEGEN = path.join(APP, 'public', 'js', 'imagegen.js');
const sizes = require('../lib/image/sizes');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra === undefined ? '' : '→ ' + extra); }
};
const head = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 62 - m.length)));

/* ═══ 1. HARNESS INTEGRITY ═══════════════════════════════════════════════════
   Prove the suite is running the shipped program before believing anything it
   says about it. */
head('1. harness integrity — is this the real program?');

const pageHtml = fs.readFileSync(PAGE, 'utf8');
const imagegenSrc = fs.readFileSync(IMAGEGEN, 'utf8');

const scriptBlocks = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
ok('exactly one inline <script> block in social.html', scriptBlocks.length === 1, scriptBlocks.length);

let pageJs = scriptBlocks.length === 1 ? scriptBlocks[0][1] : '';
const initCalls = (pageJs.match(/^init\(\);$/gm) || []).length;
ok('the page bootstraps with one top-level init(), stripped so the sandbox does not sign in',
   initCalls === 1, initCalls);
pageJs = pageJs.replace(/^init\(\);$/m, '/* init() removed by the test harness */');

const NEEDED = ['buildImageSection', 'derivedImagePrompt', 'refreshImageDefaults',
                'pendingImage', 'startImage', 'paintImage', 'paintImageError',
                'quotaLine', 'disableImage', 'generate', 'openTool'];
const absent = NEEDED.filter((n) => !new RegExp('function ' + n + '\\s*\\(').test(pageJs));
ok('every function this suite drives is defined in the shipped page', absent.length === 0, absent.join(','));

ok('imagegen.js exposes the shared surface both halves go through',
   /window\.ImageGen\s*=/.test(imagegenSrc), 'no window.ImageGen assignment');

/* The sandbox's getElementById invents an element for any id, which is what
   makes driving a page without an HTML parser possible — and is also exactly
   how a typo'd id would sail through. So the ids buildImageSection LOOKS UP
   are checked, statically, against the markup buildImageSection WRITES. */
const sectionSrc = (() => {
  const start = pageJs.indexOf('function buildImageSection(');
  if (start < 0) return '';
  let depth = 0;
  for (let i = pageJs.indexOf('{', start); i < pageJs.length; i++) {
    if (pageJs[i] === '{') depth++;
    else if (pageJs[i] === '}') { depth--; if (depth === 0) return pageJs.slice(start, i + 1); }
  }
  return '';
})();
const lookedUp = [...sectionSrc.matchAll(/getElementById\('(ff-image-[\w-]+|img-[\w-]+)'\)/g)].map((m) => m[1]);
const declared = [...sectionSrc.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
const orphans = [...new Set(lookedUp)].filter((id) => !declared.includes(id));
ok('every id buildImageSection reads is an id buildImageSection writes (no invented element)',
   lookedUp.length >= 4 && orphans.length === 0, orphans.join(',') || 'found ' + lookedUp.length + ' lookups');

/* ═══ 2. THE ASPECT MAP CANNOT DRIFT FROM THE SERVER ════════════════════════ */
head('2. the platform → aspect map, against lib/image/sizes.js');

const mapSrc = /const PLATFORM_ASPECT=\{([\s\S]*?)\n\};/.exec(pageJs);
ok('PLATFORM_ASPECT is present and parseable', Boolean(mapSrc));
const mapped = mapSrc
  ? [...mapSrc[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((m) => ({ platform: m[1], size: m[2] }))
  : [];
ok('it maps every platform to something', mapped.length >= 5, mapped.length);

const illegal = mapped.filter((e) => !sizes.LEGAL_SIZES.includes(e.size));
ok('every aspect the page can send is one the server will accept',
   illegal.length === 0, illegal.map((e) => e.platform + '→' + e.size).join(', '));

/* The Platform <select> is the list of things a user can pick. A platform with
   no entry silently falls back to the API default, which is not wrong — but it
   IS a decision, and it should be a decision somebody made rather than one
   nobody noticed. */
const platformOpts = /\{id:'platform',label:'Platform',type:'select',opts:\[([^\]]*)\]\}/.exec(pageJs);
ok('the Platform field is where this suite thinks it is', Boolean(platformOpts));
const platforms = platformOpts ? [...platformOpts[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const unmapped = platforms.filter((p) => !mapped.some((e) => e.platform === p));
ok('every platform a user can choose has an aspect chosen for it',
   platforms.length > 0 && unmapped.length === 0, unmapped.join(', '));

/* ═══ THE SANDBOX ═══════════════════════════════════════════════════════════ */

function makeSandbox(routes) {
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
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() {},
      fire(ev) { (this.listeners[ev] || []).forEach((f) => f({ target: this })); },
      // Depth-first search for the test's own assertions, not for the page.
      find(pred) {
        if (pred(this)) return this;
        for (const c of this.children) { const hit = c.find ? c.find(pred) : null; if (hit) return hit; }
        return null;
      },
      text() {
        return (this.textContent || '') + ' ' + (this._html || '') + ' '
          + this.children.map((c) => (c.text ? c.text() : '')).join(' ');
      },
    };
    /* innerHTML REPLACES a subtree. A fake that keeps the old children while
       storing the new string lets a block painted over another one still be
       found by a test, which is how the stale-response guard first passed a
       run with the guard deleted. */
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._html; },
      set(v) { node._html = String(v); node.children.length = 0; node.options.length = 0; },
    });
    return node;
  }

  const mount = mk('div');
  const document = {
    head: mk('head'),
    readyState: 'complete',
    createElement: mk,
    getElementById(id) {
      if (!dom[id]) { dom[id] = mk('div'); dom[id].id = id; }
      return dom[id];
    },
    querySelector(sel) { return sel === '[data-imagegen-mount]' ? mount : null; },
    querySelectorAll(sel) { return sel === '[data-imagegen-mount]' ? [mount] : []; },
    addEventListener() {},
  };

  async function fetchStub(url, opts) {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const record = { url: u, method: (opts && opts.method) || 'GET', body };
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
    document,
    fetch: fetchStub,
    Image: function () { return mk('img'); },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  ctx.window = ctx;                 // the page reads window.ImageGen / window.GenLang
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(imagegenSrc, ctx, { filename: 'public/js/imagegen.js' });
  vm.runInContext(pageJs, ctx, { filename: 'public/social.html#inline' });

  const evaluate = (expr) => vm.runInContext(expr, ctx);
  return { ctx, dom, calls, mount, evaluate, imageHost: () => document.getElementById('out-image') };
}

const OPTIONS_OK = {
  status: 200,
  body: {
    ok: true, provider: 'dashscope', configured: true, missing: [], model: 'qwen-image',
    sizes: sizes.catalogue(), defaultSize: '1328*1328', brandAssets: [], maxPromptChars: 2000,
  },
};
const storedImage = (over) => Object.assign({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  status: 'stored', size: '1664*928', url: '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/file',
  usage: { remaining: { day: 4, month: 41 } },
}, over || {});

/** Open the tool, fill the form, wait for the deferred options fetch. */
async function openSocial(box, over) {
  const fields = Object.assign({ 'ff-topic': 'Summer sale launch', 'ff-platform': 'LinkedIn', 'ff-goal': 'Drive website traffic' }, over || {});
  box.evaluate("openTool('social-media')");
  for (const [id, v] of Object.entries(fields)) box.dom[id].value = v;
  await box.ctx.window.ImageGen.ready();
  await new Promise((r) => setTimeout(r, 0));
  return box;
}
function switchImageOn(box) {
  box.dom['ff-image-on'].checked = true;
  box.dom['ff-image-on'].fire('change');
}

(async () => {
  /* ═══ 3. THE OPTION APPEARS WHERE IT BELONGS ═════════════════════════════ */
  head('3. where the option is offered, and where it is not');
  {
    const box = makeSandbox({ '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    ok('the Social Media Posts form carries the image toggle',
       box.dom['ff-image-on'].listeners.change && box.dom['ff-image-on'].listeners.change.length === 1);
    ok('the drop-in panel is hidden while this tool is open — one image control per screen',
       box.mount.hidden === true);

    box.evaluate("openTool('instagram-bio')");
    ok('a tool whose deliverable is not a post gets the drop-in panel back',
       box.mount.hidden === false);
    ok('…and no image section is built into its form at all',
       box.dom['form-fields'].children.every((n) => n.id !== 'img-sec'),
       box.dom['form-fields'].children.map((n) => n.id).join(','));
    switchImageOn(box);
    ok('…and even a stale toggle cannot make it send one — which tool offers this is a rule, not a side effect of the form being rebuilt',
       box.evaluate('pendingImage()') === null);
  }

  /* ═══ 4. AN UNCONFIGURED DEPLOYMENT SAYS SO BEFORE THE CLICK ═════════════ */
  head('4. a control that cannot work says so up front');
  {
    const unconfigured = {
      status: 200,
      body: Object.assign({}, OPTIONS_OK.body, { configured: false, missing: ['DASHSCOPE_API_KEY'] }),
    };
    const box = makeSandbox({ '/api/images/options': async () => unconfigured });
    await openSocial(box);
    ok('the toggle is disabled rather than left to fail on click', box.dom['ff-image-on'].disabled === true);
    ok('the reason is shown, not hidden', box.dom['img-note'].hidden === false);
    ok('…and it names the deployment, and says text generation is unaffected',
       /not configured/i.test(box.dom['img-note'].textContent)
       && /text generation is unaffected/i.test(box.dom['img-note'].textContent),
       box.dom['img-note'].textContent);
    ok('a disabled toggle produces no request even if something ticks it',
       (box.dom['ff-image-on'].checked = true, box.evaluate('pendingImage()')) === null);
  }
  {
    /* checkSub guards /api/images, so a lapsed account meets this route before
       the image service does. Its answer names the fix; flattening it into
       'unavailable right now' would leave a dead control and no clue why. */
    const box = makeSandbox({ '/api/images/options': async () => ({ status: 402, body: { error: 'subscription_expired', message: 'Your subscription has expired. Please renew at /billing.', redirect: '/billing' } }) });
    await openSocial(box);
    ok('a lapsed subscription is reported in the words that name the fix',
       box.dom['ff-image-on'].disabled === true && /renew at .billing/.test(box.dom['img-note'].textContent),
       box.dom['img-note'].textContent);
  }
  {
    const box = makeSandbox({ '/api/images/options': async () => ({ status: 401, body: { error: 'unauthorised' } }) });
    await openSocial(box);
    ok('a signed-out session is reported as sign-in, not as a fault',
       box.dom['ff-image-on'].disabled === true && /sign in/i.test(box.dom['img-note'].textContent),
       box.dom['img-note'].textContent);
  }

  /* ═══ 5. THE DESCRIPTION IS WRITTEN FROM THE FORM ═══════════════════════ */
  head('5. the description the user reads');
  {
    const box = makeSandbox({ '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    switchImageOn(box);
    const p = box.dom['ff-image-prompt'].value;
    ok('it carries the topic verbatim', p.includes('Summer sale launch'), p);
    ok('it carries the platform', p.includes('LinkedIn'), p);
    ok('it carries the goal', /drive website traffic/i.test(p), p);
    ok('it carries the tone', /professional/i.test(p), p);
    ok('it tells the model to leave the lettering to the caption',
       /no text/i.test(p) && /watermark/i.test(p), p);

    box.evaluate("activeTone='Witty'");
    box.evaluate('refreshImageDefaults()');
    ok('changing the tone rewrites an untouched description',
       /witty/i.test(box.dom['ff-image-prompt'].value), box.dom['ff-image-prompt'].value);

    // The user takes over. From here the page must stop rewriting it.
    box.dom['ff-image-prompt'].value = 'A hand holding a paper boarding pass';
    box.dom['ff-image-prompt'].fire('input');
    box.dom['ff-topic'].value = 'Something else entirely';
    box.dom['ff-topic'].fire('input');
    ok('once edited, the description is never rewritten under the user',
       box.dom['ff-image-prompt'].value === 'A hand holding a paper boarding pass',
       box.dom['ff-image-prompt'].value);

    ok('an empty topic yields no invented description',
       (box.dom['ff-topic'].value = '', box.evaluate('derivedImagePrompt()')) === '');
  }

  /* ═══ 6. THE ASPECT FOLLOWS THE PLATFORM, UNTIL THE USER PICKS ══════════ */
  head('6. the aspect');
  {
    const box = makeSandbox({ '/api/images/options': async () => OPTIONS_OK });
    await openSocial(box);
    switchImageOn(box);
    ok('the size list came from the server catalogue, not from a copy on the page',
       box.dom['ff-image-size'].options.length === sizes.LEGAL_SIZES.length,
       box.dom['ff-image-size'].options.length + ' options');
    ok('LinkedIn gets landscape', box.dom['ff-image-size'].value === '1664*928', box.dom['ff-image-size'].value);

    box.dom['ff-platform'].value = 'TikTok';
    box.dom['ff-platform'].fire('change');
    ok('TikTok gets full-screen portrait', box.dom['ff-image-size'].value === '928*1664', box.dom['ff-image-size'].value);

    box.dom['ff-image-size'].value = '1328*1328';
    box.dom['ff-image-size'].fire('change');
    box.dom['ff-platform'].value = 'Instagram';
    box.dom['ff-platform'].fire('change');
    ok('once chosen, the aspect is never changed under the user',
       box.dom['ff-image-size'].value === '1328*1328', box.dom['ff-image-size'].value);
  }

  /* ═══ 7. READ = SENT ════════════════════════════════════════════════════ */
  head('7. THE INVARIANT — what the box says is what the API gets');
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    box.ctx.window.GenLang = { get: () => 'ms' };
    await openSocial(box);
    switchImageOn(box);
    box.dom['ff-image-prompt'].value = 'A durian on a marble counter, morning light';
    box.dom['ff-image-prompt'].fire('input');
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));

    const sent = box.calls.find((c) => c.url === '/api/images/generate');
    ok('the request happened', Boolean(sent));
    ok('THE INVARIANT — the prompt sent is the string in the visible box, byte for byte',
       sent && sent.body.prompt === 'A durian on a marble counter, morning light', sent && sent.body.prompt);
    ok('no hidden negative prompt is bolted on behind the user',
       sent && !('negative_prompt' in sent.body), sent && JSON.stringify(sent.body));
    ok('no brand asset travels without a consent surface',
       sent && !sent.body.use_brand_asset && !sent.body.brand_asset_ref, sent && JSON.stringify(sent.body));
    ok('the selected aspect is sent', sent && sent.body.size === '1664*928', sent && sent.body.size);
    ok("the run's output language is recorded against the row", sent && sent.body.lang === 'ms', sent && sent.body.lang);
  }

  /* ═══ 8. A STORED IMAGE IS SHOWN FROM THIS PLATFORM'S OWN URL ═══════════ */
  head('8. the result');
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    await openSocial(box);
    switchImageOn(box);
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));

    const host = box.imageHost();
    const img = host.find((n) => n.tagName === 'img');
    ok('an <img> is rendered', Boolean(img));
    ok("its src is this platform's own owner-scoped route, never the provider's URL",
       img && img.src === '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/file', img && img.src);
    ok('it has alt text taken from the description', img && img.alt.length > 0, img && img.alt);
    ok('the empty state is gone', box.dom['out-empty'].style.display === 'none');
    ok('the remaining quota that came back with it is printed rather than re-fetched',
       /4 image generations left today/.test(host.text()) && /41 this month/.test(host.text()),
       host.text().slice(0, 160));
    ok('…and no second request was made to find that out',
       box.calls.filter((c) => c.url.indexOf('/api/images/usage') === 0).length === 0);
  }

  /* ═══ 9. THE SERVER'S OWN SENTENCE SURVIVES ═════════════════════════════ */
  head("9. THE INVARIANT — the API's reason reaches the person");
  {
    const capMessage = 'Your Free plan allows 3 image generations in a day, and 3 have been used. '
      + 'This limit is checked before the request is sent, so nothing was charged.';
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({
        status: 429,
        body: { ok: false, error: 'image_cap_exceeded', message: capMessage, tier: 'free' },
      }),
    });
    await openSocial(box);
    switchImageOn(box);
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));
    const shown = box.imageHost().text();
    ok('a quota refusal is shown in the words the API chose', shown.includes(capMessage), shown.slice(0, 200));
    ok('…and it is not replaced by a generic apology', !/something went wrong/i.test(shown));
    ok('nothing is rendered as an image', box.imageHost().find((n) => n.tagName === 'img') === null);
  }
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({
        status: 201, body: { ok: true, image: storedImage({ status: 'rehost_failed', url: null }) },
      }),
    });
    await openSocial(box);
    switchImageOn(box);
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));
    const shown = box.imageHost().text();
    ok('a row that holds no bytes is reported as a failure, not rendered as a broken image',
       /could not be stored/i.test(shown) && box.imageHost().find((n) => n.tagName === 'img') === null,
       shown.slice(0, 160));
    ok('…and it says the quota was still spent', /counted against your quota/i.test(shown));
  }
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ network: true }),
    });
    await openSocial(box);
    switchImageOn(box);
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));
    ok('a request that never left the machine is worded as that, not as a refusal',
       /cannot reach the server/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 160));
  }

  /* ═══ 10. THE TWO HALVES ARE INDEPENDENT ════════════════════════════════ */
  head('10. THE INVARIANT — a caption failure and an image failure are separate');
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
      '/api/generate': async () => ({ status: 500, body: { error: 'Groq is down' } }),
    });
    await openSocial(box);
    switchImageOn(box);
    await box.evaluate('generate()');
    await new Promise((r) => setTimeout(r, 0));

    const img = box.imageHost().find((n) => n.tagName === 'img');
    ok('the posts failing does not delete an image that was generated and billed', Boolean(img));
    ok('…and the "nothing here yet" empty state does not reappear over it',
       box.dom['out-empty'].style.display === 'none', box.dom['out-empty'].style.display);
    ok('…and the failure is still reported', /Groq is down/.test(box.dom['toast'].textContent),
       box.dom['toast'].textContent);
  }
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 500, body: { ok: false, error: 'provider_failed', message: 'The provider refused.' } }),
      '/api/generate': async () => ({ status: 200, body: { text: 'POST 1 — Summer is here.' } }),
    });
    await openSocial(box);
    switchImageOn(box);
    await box.evaluate('generate()');
    await new Promise((r) => setTimeout(r, 0));
    ok('the image failing does not take the posts down with it',
       box.dom['out-results'].innerHTML.includes('Summer is here'),
       box.dom['out-results'].innerHTML.slice(0, 120));
    ok('…and the image failure is reported where the image would have been',
       /provider refused/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 160));
  }
  {
    // The empty state IS still correct when there is genuinely nothing.
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/generate': async () => ({ status: 500, body: { error: 'Groq is down' } }),
    });
    await openSocial(box);
    await box.evaluate('generate()');
    ok('NEGATIVE CONTROL — with no image requested, a text failure still restores the empty state',
       box.dom['out-empty'].style.display === 'flex', box.dom['out-empty'].style.display);
  }

  /* ═══ 11. A SLOW ANSWER CANNOT PAINT OVER A NEWER ONE ═══════════════════ */
  head('11. two runs in flight');
  {
    let release;
    const held = new Promise((r) => { release = r; });
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async (rec, n) => {
        if (n === 2) { await held; return { status: 201, body: { ok: true, image: storedImage({ id: 'first', url: '/api/images/first/file' }) } }; }
        return { status: 201, body: { ok: true, image: storedImage({ id: 'second', url: '/api/images/second/file' }) } };
      },
    });
    await openSocial(box);
    switchImageOn(box);
    box.evaluate('startImage()');                 // request 1 — held
    box.evaluate('startImage()');                 // request 2 — answers now
    await new Promise((r) => setTimeout(r, 0));
    ok('the newer answer is on screen',
       box.imageHost().find((n) => n.tagName === 'img').src === '/api/images/second/file');
    release();
    await new Promise((r) => setTimeout(r, 0));
    ok('the older answer, arriving late, does not paint over it',
       box.imageHost().find((n) => n.tagName === 'img').src === '/api/images/second/file',
       box.imageHost().find((n) => n.tagName === 'img').src);
  }

  /* ═══ 12. AN EMPTY DESCRIPTION SPENDS NOTHING ═══════════════════════════ */
  head('12. an empty description');
  {
    const box = makeSandbox({
      '/api/images/options': async () => OPTIONS_OK,
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: storedImage() } }),
    });
    await openSocial(box);
    switchImageOn(box);
    box.dom['ff-image-prompt'].value = '';
    box.dom['ff-image-prompt'].fire('input');
    box.evaluate('startImage()');
    await new Promise((r) => setTimeout(r, 0));
    ok('nothing is sent', box.calls.filter((c) => c.url === '/api/images/generate').length === 0);
    ok('…and the user is told, rather than left with a silent no-op',
       /describe the image/i.test(box.imageHost().text()), box.imageHost().text().slice(0, 160));
    ok('…and it says nothing was charged', /nothing was charged/i.test(box.imageHost().text()));
  }

  /* ── result ────────────────────────────────────────────────────────────── */
  console.log('\n' + (pass + fail) + ' checks, ' + fail + ' failure(s)');
  if (fail) { console.error('✗ THE IMAGE OPTION ON THE SOCIAL POST TOOL'); process.exit(1); }
  console.log('✓ THE IMAGE OPTION ON THE SOCIAL POST TOOL');
})().catch((e) => { console.error('harness crashed:', e); process.exit(1); });

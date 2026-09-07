/* ═══════════════════════════════════════════════════════════════════════════
   THE DROP-IN IMAGE PANEL — Contract A, executed
   ───────────────────────────────────────────────────────────────────────────
   test/image-contract.js proves the SERVER half of the style picker: the
   default adds nothing, a named kind appends the sentence /options published,
   an unknown one is refused before any spend. All of that is true of a server
   nobody can reach.

   This is the other half, and it is the half the whole design rests on. The
   feature is only allowed to append text the user did not type BECAUSE THE
   PANEL PRINTS THAT TEXT FIRST. If the picker renders labels but the preview
   never shows the phrase, or shows a phrase it made up locally, then the
   server's guarantee is intact and the product is still lying to the user.
   So this drives the real public/js/imagegen.js — no re-implementation, no
   string matching — in a fake DOM, and reads what it built.

   ── WHY A HAND-ROLLED DOM AND NOT jsdom ───────────────────────────────────
   This repo has no jsdom and adding one for a 200-line panel is a dependency
   with a supply chain. test/social-image-contract.js already established the
   pattern for the same reason; this is the smaller sibling of that sandbox,
   carrying only what Contract A touches.

   The one behaviour worth stating: `innerHTML = ''` REALLY empties the
   children here. A fake that keeps them while storing the new string lets a
   preview that was never redrawn still be found by a test — which is exactly
   how social-image-contract once passed a run with its stale-response guard
   deleted.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const IGEN_SRC = fs.readFileSync(path.join(ROOT, 'public/js/imagegen.js'), 'utf8');
const styles = require('../lib/image/styles');
const sizes = require('../lib/image/sizes');

let checks = 0;
let failures = 0;
const ok = (m) => { checks += 1; console.log('  ✓ ' + m); };
const bad = (m, extra) => {
  failures += 1; checks += 1;
  console.error('  ✗ ' + m + (extra !== undefined ? '\n      ' + extra : ''));
};
const check = (cond, m, extra) => (cond ? ok(m) : bad(m, extra));
const head = (t) => console.log('\n' + t);

/* ── the sandbox ─────────────────────────────────────────────────────────── */

function makeSandbox(routes) {
  const calls = [];

  function mk(tag) {
    const node = {
      tagName: String(tag || 'div').toLowerCase(),
      children: [], options: [], attrs: {}, listeners: {},
      style: {}, className: '', id: '', textContent: '', _html: '',
      value: '', hidden: false, disabled: false, selected: false, open: false,
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
      removeAttribute(k) { delete this.attrs[k]; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() {}, blur() {}, click() { this.fire('click'); }, remove() {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      fire(ev) { (this.listeners[ev] || []).forEach((f) => f({ target: this, preventDefault() {} })); },
      all() { const out = [this]; this.children.forEach((c) => { if (c.all) out.push(...c.all()); }); return out; },
      find(pred) { return this.all().find(pred) || null; },
      filter(pred) { return this.all().filter(pred); },
      text() { return this.all().map((n) => n.textContent || '').join(' '); },
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._html; },
      set(v) { node._html = String(v); node.children.length = 0; node.options.length = 0; },
    });

    /* A <select>'s value is DERIVED from its selected option, and a plain
       `value: ''` property is not that. Without this, code that marks an
       option selected and then reads back `sel.value` gets the empty string —
       so a picker with a correct default looks, to a test, exactly like a
       picker that sends nothing. That is the shape of bug this whole suite
       exists to catch, and it must not be one the harness invents. */
    if (node.tagName === 'select') {
      Object.defineProperty(node, 'value', {
        get() {
          const chosen = node.options.find((o) => o.selected);
          return chosen ? chosen.value : (node.options[0] ? node.options[0].value : '');
        },
        set(v) {
          const want = String(v);
          const target = node.options.find((o) => o.value === want);
          if (!target) return;              // a browser ignores an unknown value
          node.options.forEach((o) => { o.selected = o === target; });
        },
      });
    }
    return node;
  }

  const mount = mk('div');
  const document = {
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    readyState: 'complete',
    createElement: mk,
    createTextNode: (t) => { const n = mk('#text'); n.textContent = String(t); return n; },
    getElementById: () => null,
    querySelector: (s) => (s === '[data-imagegen-mount]' ? mount : null),
    querySelectorAll: (s) => (s === '[data-imagegen-mount]' ? [mount] : []),
    addEventListener() {}, removeEventListener() {},
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
    };
  }

  const ctx = {
    console, JSON, Promise, Math, Date, setTimeout, clearTimeout, Set, Array, Object, String, Number,
    document, fetch: fetchStub,
    Image: function () { return mk('img'); },
    navigator: { language: 'en' },
    location: { href: 'https://example.test/app', pathname: '/app' },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(IGEN_SRC, ctx, { filename: 'public/js/imagegen.js' });

  /* Found the way a person finds them — a textarea, the select whose
     aria-label says what it is — never by an id this suite and the file
     would each have to spell the same way. */
  function panel() {
    const all = mount.all();
    const selects = all.filter((n) => n.tagName === 'select');
    return {
      prompt: all.find((n) => n.tagName === 'textarea'),
      style: selects.find((n) => n.className.indexOf('igen-sel-wide') >= 0),
      size: selects.find((n) => n.getAttribute('aria-label') === 'Image shape'),
      avoidBtn: all.find((n) => n.tagName === 'button' && n.className.indexOf('igen-link') >= 0),
      avoid: all.find((n) => n.tagName === 'input' && n.type === 'text'),
      go: all.find((n) => n.tagName === 'button' && n.className.indexOf('igen-btn') >= 0),
      preview: all.find((n) => n.tagName === 'details'),
      hint: all.find((n) => n.className === 'igen-hint'),
      count: all.find((n) => n.className === 'igen-count'),
      msg: all.find((n) => n.className === 'igen-msg'),
      out: all.find((n) => n.className === 'igen-out'),
    };
  }

  return { ctx, calls, mount, panel };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* The options payload the REAL server would send — built from the real
   modules, so a catalogue change cannot leave this suite testing a fixture
   that no deployment returns. */
const OPTIONS_BODY = {
  ok: true,
  provider: 'dashscope',
  configured: true,
  missing: [],
  model: 'qwen-image-plus',
  sizes: sizes.catalogue(),
  defaultSize: sizes.DEFAULT_SIZE,
  styles: styles.catalogue(),
  defaultStyle: styles.DEFAULT_STYLE,
  brandAssets: ['brand_name', 'brand_desc', 'brand_tone'],
  maxPromptChars: 2000,
  maxNegativePromptChars: 500,
};

const STORED_IMAGE = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  status: 'stored',
  url: '/api/images/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/file',
  size: '1328*1328',
  usage: { remaining: { day: 41, month: 512 } },
};

const OK_ROUTES = {
  '/api/images/options': async () => ({ status: 200, body: OPTIONS_BODY }),
  '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: STORED_IMAGE } }),
};

async function main() {
  /* ═══ 1. the controls exist at all ═════════════════════════════════════ */
  head('1. the panel builds every control it claims to offer');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();
    check(Boolean(p.prompt), 'a description box');
    check(Boolean(p.style), 'a picker for the KIND of image');
    check(Boolean(p.size), 'a picker for the shape');
    check(Boolean(p.avoidBtn) && Boolean(p.avoid), 'a way to say what to keep OUT');
    check(p.avoid && p.avoid.hidden !== true && p.avoid.tagName === 'input',
      'which starts collapsed rather than crowding the common case',
      p.avoidBtn && p.avoidBtn.getAttribute('aria-expanded'));
    check(p.avoidBtn && p.avoidBtn.getAttribute('aria-expanded') === 'false',
      'and says so to a screen reader');
    check(Boolean(p.preview), 'and a preview of exactly what will be sent');
    check(Boolean(p.go), 'plus the button that does it');
  }

  /* ═══ 2. the picker is the SERVER's catalogue ═══════════════════════════ */
  head('2. every kind offered came from /options, and all of them did');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();
    const offered = p.style.options.map((o) => ({ ref: o.value, label: o.textContent }));
    const expected = styles.catalogue().map((s) => ({ ref: s.ref, label: s.label }));
    check(offered.length === expected.length,
      `the picker offers all ${expected.length} kinds the server published`, offered.length);
    check(JSON.stringify(offered) === JSON.stringify(expected),
      'with the server\'s own refs and labels, in the server\'s own order');
    const selected = p.style.options.filter((o) => o.selected);
    check(selected.length === 1 && selected[0].value === styles.DEFAULT_STYLE,
      'and the one the server named as the default starts selected',
      selected.map((o) => o.value).join(','));
  }

  /* ═══ 3. THE INVARIANT — the preview shows the real phrase ═════════════ */
  head('3. the preview prints the exact sentence the server will append');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();

    p.prompt.value = 'A cold brew bottle on a wooden counter';
    p.prompt.fire('input');
    check(p.preview.text().includes('A cold brew bottle on a wooden counter'),
      "the user's own words are shown back");
    check(!styles.catalogue().some((s) => s.phrase && p.preview.text().includes(s.phrase)),
      'and with the default picked, no art direction is shown — because none will be sent');

    /* EVERY kind, not a sampled one. A preview that renders the first entry's
       phrase and silently nothing for the rest looks identical on one test. */
    let shown = 0;
    for (const s of styles.catalogue().filter((x) => x.phrase)) {
      p.style.value = s.ref;
      p.style.fire('change');
      const text = p.preview.text();
      if (text.includes(s.phrase) && text.includes('A cold brew bottle on a wooden counter')) shown += 1;
      else bad(`"${s.label}" — the preview does not show the phrase /options published for it`,
               text.slice(0, 200));
    }
    check(shown === styles.catalogue().filter((x) => x.phrase).length,
      `all ${shown} kinds print their own published sentence, verbatim, beside the user's words`);

    /* And the summary under the picker, which is what a person reads BEFORE
       expanding the preview. */
    const withPhrase = styles.catalogue().find((x) => x.phrase);
    p.style.value = withPhrase.ref;
    p.style.fire('change');
    check(p.hint.textContent === withPhrase.summary,
      'the line under the picker is the server\'s summary for the picked kind', p.hint.textContent);
  }

  /* ═══ 4. what actually goes on the wire ════════════════════════════════ */
  head('4. the request carries a REF, the user\'s words, and nothing else');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();
    const picked = styles.catalogue().find((x) => x.phrase);

    p.prompt.value = 'A cold brew bottle on a wooden counter';
    p.prompt.fire('input');
    p.style.value = picked.ref;
    p.style.fire('change');
    p.avoid.value = 'text, lettering, watermark';
    p.avoid.fire('input');
    p.go.fire('click');
    await tick(); await tick();

    const sent = box.calls.find((c) => c.url.indexOf('/api/images/generate') === 0);
    check(Boolean(sent), 'the request was made');
    check(sent && sent.body.prompt === 'A cold brew bottle on a wooden counter',
      'THE INVARIANT — the prompt field is the box, byte for byte, with no style text folded in',
      sent && sent.body.prompt);
    check(sent && sent.body.style === picked.ref,
      'the KIND travels as a ref, so the server appends its own sentence and not a copy',
      sent && sent.body.style);
    check(sent && !JSON.stringify(sent.body).includes(picked.phrase.slice(0, 30)),
      'the phrase itself is nowhere on the wire');
    check(sent && sent.body.negative_prompt === 'text, lettering, watermark',
      'the visible Avoid box is what fills negative_prompt', sent && sent.body.negative_prompt);
    check(sent && !sent.body.use_brand_asset && !sent.body.brand_asset_ref,
      'no brand asset travels without a consent surface');
  }

  /* ═══ 5. an empty Avoid box sends no field at all ══════════════════════ */
  head('5. nothing is invented for a control the user left alone');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();
    p.prompt.value = 'A durian on a marble counter';
    p.prompt.fire('input');
    p.go.fire('click');
    await tick(); await tick();

    const sent = box.calls.find((c) => c.url.indexOf('/api/images/generate') === 0);
    check(sent && !('negative_prompt' in sent.body),
      'an untouched Avoid box puts no negative_prompt on the wire',
      sent && JSON.stringify(sent.body));
    check(sent && sent.body.style === styles.DEFAULT_STYLE,
      'and the default kind is sent as itself — the one the server treats as "append nothing"',
      sent && sent.body.style);
  }

  /* ═══ 6. the result, and the number already in hand ════════════════════ */
  head('6. the result is painted, with the quota that came back with it');
  {
    const box = makeSandbox(OK_ROUTES);
    await tick(); await tick();
    const p = box.panel();
    p.prompt.value = 'A durian on a marble counter';
    p.prompt.fire('input');
    p.go.fire('click');
    await tick(); await tick();

    const img = p.out.find((n) => n.tagName === 'img');
    check(Boolean(img), 'an <img> is rendered');
    check(img && img.src === STORED_IMAGE.url,
      "its src is this platform's own owner-scoped route, never the provider's", img && img.src);
    check(img && img.alt.length > 0, 'it has alt text taken from the description');
    check(p.out.text().includes('41'),
      'the remaining quota the response already carried is printed rather than re-fetched',
      p.out.text());
    check(box.calls.filter((c) => c.url.indexOf('/api/images/usage') === 0).length === 0,
      'and no second round trip was made for it');
  }

  /* ═══ 7. a deployment with no key says so BEFORE the click ═════════════ */
  head('7. an unconfigured deployment is admitted up front');
  {
    const box = makeSandbox({
      '/api/images/options': async () => ({
        status: 200, body: { ...OPTIONS_BODY, configured: false, missing: ['DASHSCOPE_API_KEY'] },
      }),
      '/api/images/generate': async () => ({ status: 503, body: { ok: false, message: 'nope' } }),
    });
    await tick(); await tick();
    const p = box.panel();
    check(p.msg && p.msg.hidden === false && p.msg.textContent.length > 0,
      'the panel says why it cannot be used');
    check(p.go && p.go.disabled === true, 'and the button is disabled rather than failing on click');
  }

  /* ═══ 8. no catalogue → nothing on the wire ════════════════════════════ */
  head('8. a server that published no catalogue is not guessed at');
  {
    const body = { ...OPTIONS_BODY };
    delete body.styles;
    delete body.defaultStyle;
    const box = makeSandbox({
      '/api/images/options': async () => ({ status: 200, body }),
      '/api/images/generate': async () => ({ status: 201, body: { ok: true, image: STORED_IMAGE } }),
    });
    await tick(); await tick();
    const p = box.panel();
    check(p.style.options.length === 1 && p.style.options[0].value === '',
      'one inert option with an empty value — no ref this server might reject');

    p.prompt.value = 'A durian on a marble counter';
    p.prompt.fire('input');
    p.go.fire('click');
    await tick(); await tick();
    const sent = box.calls.find((c) => c.url.indexOf('/api/images/generate') === 0);
    check(sent && !('style' in sent.body),
      'and the request carries no style at all', sent && JSON.stringify(sent.body));
  }

  /* ═══ 9. the failure sentence is the server's own ══════════════════════ */
  head('9. a refusal is reported in the words the server chose');
  {
    const MSG = 'Your Full plan allows 60 image generations in a day, and 60 have been used. '
      + 'This limit is checked before the request is sent, so nothing was charged.';
    const box = makeSandbox({
      '/api/images/options': async () => ({ status: 200, body: OPTIONS_BODY }),
      '/api/images/generate': async () => ({
        status: 429, body: { ok: false, error: 'image_cap_exceeded', message: MSG },
      }),
    });
    await tick(); await tick();
    const p = box.panel();
    p.prompt.value = 'A durian on a marble counter';
    p.prompt.fire('input');
    p.go.fire('click');
    await tick(); await tick();
    check(p.msg.textContent === MSG,
      'the quota refusal is shown verbatim — the numbers in it are the useful part',
      p.msg.textContent);
    check(p.out.children.length === 0 && !p.out.innerHTML,
      'and nothing is painted where an image would have been');
  }

  console.log('');
  if (failures) {
    console.error(`✗ imagegen-panel-contract: ${failures} of ${checks} checks failed`);
    process.exit(1);
  }
  console.log(`✓ imagegen-panel-contract: ${checks} checks passed`);
}

main().catch((err) => {
  console.error('imagegen-panel-contract crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

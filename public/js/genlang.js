/* ═══════════════════════════════════════════════════════════════════════════
   GENLANG — the output-language selector for every generation page
   ───────────────────────────────────────────────────────────────────────────
   Lane C (trilingual). ONE file, nine pages, and Lane C never edits an HTML
   file — that is the cross-lane contract GAUNTLET.md fixes in Foundation.

   ╔═════════════════════════════════════════════════════════════════════════╗
   ║  CONTRACT FOR LANE E — this is the whole of it                          ║
   ╠═════════════════════════════════════════════════════════════════════════╣
   ║  1. Load it, anywhere in the page, deferred:                            ║
   ║                                                                         ║
   ║       <script src="/js/genlang.js" defer></script>                      ║
   ║                                                                         ║
   ║  2. Put ONE empty element where the selector should appear:             ║
   ║                                                                         ║
   ║       <div data-genlang-mount></div>                                    ║
   ║                                                                         ║
   ║     That is it. No init call, no options object, no CSS file, no        ║
   ║     ordering requirement against your own scripts, and nothing to       ║
   ║     remember to do on nine separate pages.                              ║
   ║                                                                         ║
   ║  OPTIONAL, if you want it:                                              ║
   ║   • data-genlang-mount="compact"  — buttons only, no "Output language"  ║
   ║     label. Use this inside a dense toolbar.                             ║
   ║   • Several mounts on one page are fine; they stay in sync.             ║
   ║   • A mount added later (a re-render, a modal) is picked up — a         ║
   ║     MutationObserver watches for new ones.                              ║
   ║                                                                         ║
   ║  WHERE TO PUT IT: near the Generate button. When the model answers in   ║
   ║  the wrong language the warning is inserted directly AFTER the mount,   ║
   ║  so the mount wants to sit somewhere a sentence of warning reads        ║
   ║  naturally — above the result, not in the page footer.                  ║
   ║                                                                         ║
   ║  STYLING: it consumes var(--accent), var(--border), var(--surface),     ║
   ║  var(--text-2) and friends from modus-design-system.css and declares    ║
   ║  no colour literal of its own (Visual Bar §V). On a page that has not   ║
   ║  been ported yet the var() lookups simply fail and it falls back to     ║
   ║  currentColor — plain, but never invisible and never broken.            ║
   ╚═════════════════════════════════════════════════════════════════════════╝

   ── WHY THIS FILE INTERCEPTS fetch(), WHICH DESERVES AN EXPLANATION ───────
   Every module page builds its prompt in its own inline <script> and posts it
   to /api/generate. Lane C may not edit those pages, so there is no seam to
   pass a language through — except the request itself. So window.fetch is
   wrapped, and for POST /api/generate ONLY, the selected language is added to
   the body two ways:

     body.lang              — the clean field. server.js does not read it yet
                              (see Lane C's report: one line). Sent anyway, so
                              the day that line lands nothing here changes.
     a [[GENLANG …]] block  — appended to body.prompt, which server.js DOES
                              already forward verbatim to generateWithGroq().
                              helpers/generation.js strips the block, reads the
                              code out of it, and applies the real per-language
                              system prompt. This is what makes the feature
                              work end-to-end today with no server change.

   The block's body is one line on purpose. It is NOT a second copy of the
   register guidance — that lives in helpers/generation.js and only there, so
   there is one place to improve the Malay and one place to improve the
   Chinese. The block is an envelope, not the letter.

   /api/pr/generate gets body.lang too, and nothing else: it has no `prompt`
   field to carry a block, so PR really is blocked on the server.js line.
   Sending the field now means that change is a one-liner and not a hunt.

   /api/chat is DELIBERATELY LEFT ALONE. gao.html posts prompts to it that
   demand strictly-shaped JSON back; wrapping those in "answer in Chinese"
   from the client is how you get a schema-mangling answer and a broken page.
   /api/chat needs its own server-side treatment — named in Lane C's report.

   Every other request in the app passes through untouched, byte for byte.

   ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
   It does not change the INTERFACE language. That is window.I18n / msm_lang
   and is a separate preference — a Malaysian user reading an English UI while
   writing Chinese ads is a normal Tuesday. The output language merely STARTS
   at the UI language and is remembered separately from then on.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var LANGS = ['en', 'ms', 'zh'];

  /* Language names are shown in their own language, always. "Bahasa Malaysia"
     does not become "Malay" because the UI happens to be English — the label
     is the language identifying itself. */
  var LANG_BUTTON = { en: 'EN', ms: 'BM', zh: '中文' };
  var LANG_FULL = { en: 'English', ms: 'Bahasa Malaysia', zh: '简体中文' };

  /* UI strings, in all three languages, built in.

     They are ALSO in public/locales/{en,ms,zh}.json under `genlang.*`, and
     every node this file creates carries the matching data-i18n attribute, so
     the shared engine keeps them in sync when the user switches the UI
     language. The built-in copy is what renders on the first paint and what
     renders if the locale fetch fails — a selector whose label is blank until
     a network round-trip lands is a worse selector. */
  var STRINGS = {
    en: {
      label: 'Output language',
      aria: 'Language the AI writes in',
      hint: 'The AI writes in this language. The interface language is separate.',
      warnTitle: 'Wrong language',
      dismiss: 'Dismiss',
    },
    ms: {
      label: 'Bahasa output',
      aria: 'Bahasa yang digunakan AI untuk menulis',
      hint: 'AI akan menulis dalam bahasa ini. Bahasa antara muka adalah berasingan.',
      warnTitle: 'Bahasa tidak tepat',
      dismiss: 'Tutup',
    },
    zh: {
      label: '输出语言',
      aria: 'AI 撰写内容所使用的语言',
      hint: 'AI 将以此语言撰写内容。界面语言另行设置。',
      warnTitle: '语言不符',
      dismiss: '关闭',
    },
  };

  var I18N_KEYS = {
    label: 'genlang.label',
    aria: 'genlang.aria',
    hint: 'genlang.hint',
    warnTitle: 'genlang.warn_title',
    dismiss: 'genlang.dismiss',
  };

  var LS_KEY = 'msm_genlang';
  /* The UI-language keys. CLAUDE.md: this repo's engine reads msm_lang and the
     canonical pages dual-write modus-lang. Read BOTH, write NEITHER — the
     output language is a separate preference and must not disturb the UI one. */
  var UI_LS_KEYS = ['msm_lang', 'modus-lang'];

  var STYLE_ID = 'genlang-style';
  var current = null;
  var mounts = [];

  /* ── storage, with the failure named ────────────────────────────────────
     localStorage throws in a locked-down browser or a sandboxed frame. That is
     survivable — the selector still works for the session — but it is not
     nothing, so it is reported once instead of being swallowed. */
  var warned = {};
  function warnOnce(key, message) {
    if (warned[key]) return;
    warned[key] = true;
    console.warn('genlang.js: ' + message);
  }

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      warnOnce('ls-read', 'cannot read localStorage (' + err.message +
        ') — the output language will not persist across pages');
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      warnOnce('ls-write', 'cannot write localStorage (' + err.message +
        ') — the output language will not persist across pages');
    }
  }

  function normalise(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim().toLowerCase();
    if (!v) return null;
    if (LANGS.indexOf(v) !== -1) return v;
    if (v.indexOf('zh') === 0) return 'zh';
    if (v.indexOf('ms') === 0) return 'ms';
    if (v.indexOf('en') === 0) return 'en';
    return null;
  }

  /* First run: start at the interface language, because someone reading the
     product in Chinese most likely wants to write in Chinese. From the first
     explicit choice onward the two are independent. */
  function initialLang() {
    var saved = normalise(readStore(LS_KEY));
    if (saved) return saved;
    for (var i = 0; i < UI_LS_KEYS.length; i++) {
      var ui = normalise(readStore(UI_LS_KEYS[i]));
      if (ui) return ui;
    }
    return 'en';
  }

  function uiLang() {
    if (window.I18n && typeof window.I18n.getLang === 'function') {
      var l = normalise(window.I18n.getLang());
      if (l) return l;
    }
    for (var i = 0; i < UI_LS_KEYS.length; i++) {
      var ui = normalise(readStore(UI_LS_KEYS[i]));
      if (ui) return ui;
    }
    return 'en';
  }

  function t(name) {
    var pack = STRINGS[uiLang()] || STRINGS.en;
    return pack[name] || STRINGS.en[name];
  }

  /* ── styles ─────────────────────────────────────────────────────────────
     Not one colour literal (Visual Bar §V). currentColor and transparent are
     the base so the control is legible on a page that has not been ported to
     the design system yet; the var() layers refine it where the tokens exist. */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.genlang{display:inline-flex;align-items:center;gap:8px;font-family:var(--font);font-size:13px;color:var(--text-2);}',
      '.genlang-label{font-weight:600;letter-spacing:.01em;white-space:nowrap;}',
      '.genlang-seg{display:inline-flex;border:1px solid currentColor;border-color:var(--border);border-radius:var(--r-sm);overflow:hidden;background:var(--surface);}',
      '.genlang-opt{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:inherit;',
      'font:inherit;font-weight:600;padding:5px 12px;cursor:pointer;line-height:1.3;',
      'transition:background var(--motion-fast,120ms) ease,color var(--motion-fast,120ms) ease;}',
      '.genlang-opt+.genlang-opt{border-left:1px solid currentColor;border-left-color:var(--border);}',
      '.genlang-opt:hover{background:var(--accent-bg);}',
      '.genlang-opt[aria-pressed="true"]{background:var(--accent);color:var(--surface);}',
      '.genlang-opt:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;}',
      '.genlang-warn{display:flex;align-items:flex-start;gap:10px;margin:10px 0;padding:10px 12px;',
      'border:1px solid currentColor;border-color:var(--amber);border-radius:var(--r-sm);',
      'background:var(--amber-bg);color:var(--amber-text);font-family:var(--font);font-size:13px;line-height:1.5;}',
      '.genlang-warn-body{flex:1;}',
      '.genlang-warn-title{font-weight:700;display:block;margin-bottom:2px;}',
      '.genlang-warn-x{appearance:none;-webkit-appearance:none;border:0;background:transparent;',
      'color:inherit;font:inherit;font-weight:700;cursor:pointer;padding:0 4px;}',
      '@media (max-width:520px){.genlang-label{display:none;}}',
    ].join('');
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ── the control ────────────────────────────────────────────────────────*/
  function buildInto(host) {
    host.textContent = '';
    host.classList.add('genlang');

    var compact = host.getAttribute('data-genlang-mount') === 'compact';

    if (!compact) {
      var label = document.createElement('span');
      label.className = 'genlang-label';
      label.setAttribute('data-i18n', I18N_KEYS.label);
      label.textContent = t('label');
      host.appendChild(label);
    }

    var seg = document.createElement('div');
    seg.className = 'genlang-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('data-i18n-aria', I18N_KEYS.aria);
    seg.setAttribute('aria-label', t('aria'));
    seg.title = t('hint');

    LANGS.forEach(function (code) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'genlang-opt';
      b.setAttribute('data-genlang', code);
      b.setAttribute('aria-pressed', String(code === current));
      b.setAttribute('aria-label', LANG_FULL[code]);
      b.textContent = LANG_BUTTON[code];
      b.addEventListener('click', function () { setLang(code); });
      seg.appendChild(b);
    });

    host.appendChild(seg);
    if (mounts.indexOf(host) === -1) mounts.push(host);
  }

  function paint() {
    for (var i = 0; i < mounts.length; i++) {
      var opts = mounts[i].querySelectorAll('.genlang-opt');
      for (var j = 0; j < opts.length; j++) {
        opts[j].setAttribute('aria-pressed',
          String(opts[j].getAttribute('data-genlang') === current));
      }
    }
  }

  function setLang(code) {
    var l = normalise(code);
    if (!l || l === current) return;
    current = l;
    writeStore(LS_KEY, l);
    paint();
    document.dispatchEvent(new CustomEvent('genlang:change', { detail: { lang: l } }));
  }

  function scan() {
    var found = document.querySelectorAll('[data-genlang-mount]');
    for (var i = 0; i < found.length; i++) {
      if (found[i].getAttribute('data-genlang-ready') === '1') continue;
      found[i].setAttribute('data-genlang-ready', '1');
      buildInto(found[i]);
    }
  }

  /* ── the wrong-language warning ─────────────────────────────────────────*/
  function showWarning(message) {
    var host = mounts[0];
    if (!host) {
      // Nowhere to draw it. Say so rather than dropping a real failure.
      console.warn('genlang.js: server reported wrong-language output and there is ' +
        'no [data-genlang-mount] on this page to show it in — ' + message);
      return;
    }
    var anchor = host.parentNode;
    if (!anchor) return;

    var existing = anchor.querySelector(':scope > .genlang-warn');
    if (existing) existing.parentNode.removeChild(existing);

    var box = document.createElement('div');
    box.className = 'genlang-warn';
    box.setAttribute('role', 'status');

    var body = document.createElement('div');
    body.className = 'genlang-warn-body';
    var title = document.createElement('strong');
    title.className = 'genlang-warn-title';
    title.setAttribute('data-i18n', I18N_KEYS.warnTitle);
    title.textContent = t('warnTitle');
    body.appendChild(title);
    body.appendChild(document.createTextNode(message));

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'genlang-warn-x';
    x.setAttribute('aria-label', t('dismiss'));
    x.setAttribute('data-i18n-aria', I18N_KEYS.dismiss);
    x.textContent = '×';
    x.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });

    box.appendChild(body);
    box.appendChild(x);
    anchor.insertBefore(box, host.nextSibling);
  }

  function clearWarning() {
    var boxes = document.querySelectorAll('.genlang-warn');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].parentNode) boxes[i].parentNode.removeChild(boxes[i]);
    }
  }

  /* ── request rewriting ──────────────────────────────────────────────────*/

  /* The envelope, not the letter. helpers/generation.js strips this and
     supplies the real register guidance; the one line here only has to be
     honest if something ever forwards the prompt unstripped. */
  function directiveBlock(lang) {
    return '\n\n[[GENLANG lang=' + lang + ']]\n' +
      'Write the entire response in ' + LANG_FULL[lang] + '.\n' +
      '[[/GENLANG]]';
  }

  function pathOf(input) {
    var url;
    if (typeof input === 'string') url = input;
    else if (input && typeof input.url === 'string') url = input.url;
    else return null;
    // Relative URLs are what the pages actually use; absolute ones are parsed
    // so a same-origin absolute call is treated identically.
    var idx = url.indexOf('://');
    if (idx !== -1) {
      var rest = url.slice(idx + 3);
      var slash = rest.indexOf('/');
      url = slash === -1 ? '/' : rest.slice(slash);
    }
    var q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  function methodOf(input, init) {
    if (init && init.method) return String(init.method).toUpperCase();
    if (input && typeof input !== 'string' && input.method) return String(input.method).toUpperCase();
    return 'GET';
  }

  /* Only these two, and only these two. Everything else is returned untouched
     by the caller below without this function being consulted. */
  var GENERATE_PATH = '/api/generate';
  var PR_PATH = '/api/pr/generate';

  function rewriteBody(path, raw) {
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Not JSON — not a body this file understands, so it is left exactly as
      // it was. Reported once because /api/generate is documented as JSON and
      // a non-JSON body here means something changed upstream.
      warnOnce('body-parse', 'POST ' + path + ' body is not JSON (' + err.message +
        ') — the output language was NOT attached to this request');
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    // A caller that set its own language wins. This file is a convenience for
    // the module pages, not an authority over an explicit request.
    if (!parsed.lang) parsed.lang = current;

    if (path === GENERATE_PATH && typeof parsed.prompt === 'string' &&
        parsed.prompt.indexOf('[[GENLANG') === -1) {
      parsed.prompt = parsed.prompt + directiveBlock(parsed.lang || current);
    }
    return JSON.stringify(parsed);
  }

  function inspectResponse(response) {
    // clone() so the page's own .json() still gets an unread body. Without it
    // every generation page would break on "body already read".
    var copy;
    try {
      copy = response.clone();
    } catch (err) {
      warnOnce('clone', 'cannot clone the response (' + err.message +
        ') — a wrong-language warning would not be shown for this request');
      return;
    }
    copy.json().then(function (data) {
      if (!data || typeof data !== 'object') return;
      if (data.langVerified === false && data.langWarning) showWarning(String(data.langWarning));
      else clearWarning();
    }).catch(function (err) {
      // A non-JSON or truncated body. The page's own handler reports the
      // failure to the user; this listener only loses its warning, and says so
      // rather than being an empty catch.
      warnOnce('resp-parse', 'could not read the generation response as JSON (' +
        err.message + ') — no language verdict for this request');
    });
  }

  function installFetchWrapper() {
    if (typeof window.fetch !== 'function') {
      console.warn('genlang.js: window.fetch is unavailable — the output language ' +
        'selector will render but will not reach the server');
      return;
    }
    if (window.fetch.__genlang) return;

    var original = window.fetch;
    var wrapped = function (input, init) {
      var path = pathOf(input);
      var isTarget = path === GENERATE_PATH || path === PR_PATH;
      if (!isTarget || methodOf(input, init) !== 'POST') {
        return original.apply(this, arguments);
      }

      var nextInit = init;
      // Only the plain (url, init) form is rewritten. A Request object carries
      // a stream body that cannot be re-read synchronously here, and guessing
      // would corrupt the request — so it is passed through and reported.
      if (init && typeof init.body === 'string') {
        var newBody = rewriteBody(path, init.body);
        if (newBody !== null) {
          nextInit = {};
          for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) nextInit[k] = init[k];
          nextInit.body = newBody;
        }
      } else if (typeof input !== 'string') {
        warnOnce('request-object', 'POST ' + path + ' was made with a Request object; ' +
          'the output language was NOT attached to it');
      } else {
        warnOnce('no-body', 'POST ' + path + ' had no string body — the output ' +
          'language was NOT attached to it');
      }

      var out = original.call(this, input, nextInit);
      if (path === GENERATE_PATH) {
        return out.then(function (response) {
          inspectResponse(response);
          return response;
        });
      }
      return out;
    };
    wrapped.__genlang = true;
    window.fetch = wrapped;
  }

  /* ── public surface ─────────────────────────────────────────────────────
     Small on purpose. Anything that needs the current output language reads
     it from here rather than from localStorage, so the key stays private. */
  window.GenLang = {
    get: function () { return current; },
    set: setLang,
    langs: LANGS.slice(),
    /** The directive block, for anything that builds a prompt itself. */
    directive: directiveBlock,
  };

  function init() {
    current = initialLang();
    injectStyle();
    scan();
    paint();

    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () { scan(); paint(); })
        .observe(document.documentElement, { childList: true, subtree: true });
    }

    // When the UI language changes, the built-in labels follow it. The shared
    // engine handles the data-i18n nodes; this covers title/aria-label, which
    // it does not, and covers pages with no locale file loaded at all.
    document.addEventListener('click', function (e) {
      var opt = e.target && e.target.closest && e.target.closest('.lang-option');
      // A microtask, not a timer: this listener is capture-phase, so i18n's own
      // bubble-phase handler has not run yet and window.I18n.getLang() would
      // still report the OLD language. Queuing relabel lets the whole dispatch
      // finish first. (Engineering Bar: no setTimeout, and none is needed.)
      if (opt) Promise.resolve().then(relabel);
    }, true);
  }

  function relabel() {
    for (var i = 0; i < mounts.length; i++) {
      var lbl = mounts[i].querySelector('.genlang-label');
      if (lbl) lbl.textContent = t('label');
      var seg = mounts[i].querySelector('.genlang-seg');
      if (seg) {
        seg.setAttribute('aria-label', t('aria'));
        seg.title = t('hint');
      }
    }
  }

  // The wrapper is installed IMMEDIATELY, not on DOMContentLoaded: a page that
  // fires a generation before DOM ready would otherwise send an unlabelled
  // request, and the failure would look like the selector being ignored.
  installFetchWrapper();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* ═══════════════════════════════════════════════════════════════════════════
   IMAGEGEN — image generation, inside the content tools
   ───────────────────────────────────────────────────────────────────────────
   Round 1 shipped a complete image-generation API and no way to reach it. The
   lane split that stopped five agents colliding also meant the lane that built
   /api/images owned no HTML, and the lane that owned every HTML file did not
   know the endpoint existed. The feature went to production without a front
   door. This is the front door.

   ╔═════════════════════════════════════════════════════════════════════════╗
   ║  CONTRACT — the same one genlang.js uses, deliberately                  ║
   ╠═════════════════════════════════════════════════════════════════════════╣
   ║  1. Load it, anywhere, deferred:                                        ║
   ║       <script src="/js/imagegen.js" defer></script>                     ║
   ║  2. Put one empty element where the panel should appear:                ║
   ║       <div data-imagegen-mount></div>                                   ║
   ║                                                                         ║
   ║  No init call, no options, no CSS file, no ordering requirement.        ║
   ║  Several mounts on one page are fine. A mount added later by a          ║
   ║  re-render is picked up by the MutationObserver.                        ║
   ╚═════════════════════════════════════════════════════════════════════════╝

   ── SCOPE: GENERATE ONLY, AND THAT IS A DECISION ──────────────────────────
   Prompt, size, generate, show the result. No gallery, no history browser.
   Past images remain reachable through GET /api/images, and the honest
   consequence — that this panel does not show them — is stated in the UI
   rather than left for someone to discover.

   ── WHAT IT DOES NOT DO, ON PURPOSE ───────────────────────────────────────
   It never sends brand assets. The API supports an explicit brand-asset
   opt-in, and the rule from the spec is that a user's uploaded material only
   travels when they initiated that specific action. A checkbox tucked under a
   prompt box is not that, so this panel does not offer one at all, and
   `used_brand_asset` stays false on everything it creates. Wiring that flow
   needs a real consent surface, and it is DEFERRED rather than faked.

   ── STYLING ───────────────────────────────────────────────────────────────
   Every colour resolves through a design-system token — var(--accent),
   var(--border), var(--surface), var(--text-2). There is not one hex literal
   or rgb() in this file, because test/r2-visual-contract.js fails the build
   on one and because a literal here would be a second source of truth for the
   orange. On an unported page the var() lookups fall back to currentColor:
   plain, never invisible.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STYLE_ID = 'imagegen-style';
  var mounted = [];          // every panel on the page
  var options = null;        // GET /api/images/options, fetched once
  var optionsError = null;

  /* ── styles ──────────────────────────────────────────────────────────────
     Injected once. Scoped under .igen- so nothing here can reach a page's own
     rules, and expressed only in design-system tokens. */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.igen{border:1px solid var(--border,currentColor);border-radius:var(--r,10px);',
      '  background:var(--surface,transparent);padding:14px;margin:10px 0;font-size:.875rem}',
      '.igen[hidden]{display:none}',
      '.igen-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.igen-t{font-weight:600;color:var(--text,currentColor)}',
      '.igen-sub{font-size:.75rem;color:var(--text-2,currentColor)}',
      '.igen-ta{width:100%;box-sizing:border-box;min-height:74px;resize:vertical;padding:9px 11px;',
      '  border:1px solid var(--border,currentColor);border-radius:var(--r-sm,6px);',
      '  background:var(--bg,transparent);color:var(--text,currentColor);font:inherit}',
      '.igen-ta:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:1px}',
      '.igen-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:9px}',
      '.igen-sel{padding:7px 9px;border:1px solid var(--border,currentColor);',
      '  border-radius:var(--r-sm,6px);background:var(--bg,transparent);color:var(--text,currentColor);font:inherit}',
      '.igen-btn{padding:8px 15px;border:1px solid var(--accent,currentColor);border-radius:var(--r-sm,6px);',
      '  background:var(--accent,transparent);color:var(--accent-contrast,inherit);',
      '  font:inherit;font-weight:600;cursor:pointer;transition:opacity var(--motion-fast,.15s)}',
      '.igen-btn:hover:not(:disabled){opacity:.88}',
      '.igen-btn:disabled{opacity:.5;cursor:default}',
      '.igen-note{margin-top:9px;font-size:.75rem;color:var(--text-2,currentColor)}',
      '.igen-msg{margin-top:9px;padding:8px 11px;border-radius:var(--r-sm,6px);',
      '  border:1px solid var(--border,currentColor);color:var(--text,currentColor);font-size:.8125rem}',
      '.igen-msg[data-kind="error"]{border-color:var(--red,currentColor);color:var(--red-text,currentColor)}',
      '.igen-out{margin-top:11px}',
      '.igen-out img{max-width:100%;height:auto;display:block;border-radius:var(--r-sm,6px);',
      '  border:1px solid var(--border,currentColor)}',
      '.igen-actions{display:flex;gap:10px;margin-top:8px;font-size:.75rem}',
      '.igen-actions a{color:var(--accent-text,currentColor)}'
    ].join('');
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML
    return n;
  }

  /* ── the API ─────────────────────────────────────────────────────────────*/

  /* Read the response as text and parse it here.
     `.json().catch(() => ({}))` would turn an HTML proxy error page into an
     empty object, and on this endpoint an empty object reads as "generated
     nothing successfully" — a false statement about the product built out of
     a transport failure. */
  function call(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        return { ok: res.ok, status: res.status, data: data, raw: txt };
      });
    });
  }

  function loadOptions() {
    return call('GET', '/api/images/options').then(function (r) {
      if (r.ok && r.data) { options = r.data; return options; }
      // 401 is not a fault — it means signed out. Say which.
      optionsError = r.status === 401
        ? 'Sign in to generate images.'
        : 'Image generation is unavailable right now.';
      return null;
    }).catch(function () {
      optionsError = 'Cannot reach the image service.';
      return null;
    });
  }

  /* ── one panel ───────────────────────────────────────────────────────────*/
  function build(host) {
    if (host.getAttribute('data-imagegen-ready') === '1') return;
    host.setAttribute('data-imagegen-ready', '1');

    var wrap = el('div', 'igen');
    var head = el('div', 'igen-h');
    head.appendChild(el('span', 'igen-t', 'Image'));
    head.appendChild(el('span', 'igen-sub', '— generated, then stored here'));
    wrap.appendChild(head);

    var ta = el('textarea', 'igen-ta');
    ta.placeholder = 'Describe the image — subject, setting, lighting, style. Be specific.';
    ta.setAttribute('aria-label', 'Image description');
    wrap.appendChild(ta);

    var row = el('div', 'igen-row');
    var sel = el('select', 'igen-sel');
    sel.setAttribute('aria-label', 'Image size');
    row.appendChild(sel);

    var btn = el('button', 'igen-btn', 'Generate image');
    btn.type = 'button';
    row.appendChild(btn);
    wrap.appendChild(row);

    var msg = el('div', 'igen-msg');
    msg.hidden = true;
    wrap.appendChild(msg);

    var out = el('div', 'igen-out');
    wrap.appendChild(out);

    /* Stated, not hidden: this panel generates and shows one image. The
       gallery is a follow-up, and pretending otherwise would have someone
       hunting for a history view that does not exist. */
    var note = el('div', 'igen-note',
      'Images are saved to your account. This panel shows the one you just made.');
    wrap.appendChild(note);

    host.appendChild(wrap);

    function say(kind, text) {
      msg.hidden = false;
      msg.setAttribute('data-kind', kind);
      msg.textContent = text;
    }
    function clearSay() { msg.hidden = true; msg.textContent = ''; }

    function fillSizes() {
      sel.innerHTML = '';
      var sizes = (options && (options.sizes || options.legalSizes)) || [];
      if (!sizes.length) {
        var o = el('option', null, 'Default size');
        o.value = '';
        sel.appendChild(o);
        return;
      }
      sizes.forEach(function (s) {
        // The API returns either plain strings or {size,label} objects.
        var value = typeof s === 'string' ? s : (s.size || s.value);
        var label = typeof s === 'string' ? s : (s.label || s.orientation || s.size);
        var o = el('option', null, label === value ? value : label + ' · ' + value);
        o.value = value;
        if (options && value === options.defaultSize) o.selected = true;
        sel.appendChild(o);
      });
    }

    function setBusy(on) {
      btn.disabled = on;
      ta.disabled = on;
      sel.disabled = on;
      btn.textContent = on ? 'Generating…' : 'Generate image';
    }

    btn.addEventListener('click', function () {
      var prompt = ta.value.trim();
      clearSay();
      out.innerHTML = '';
      if (!prompt) { say('error', 'Describe the image first.'); ta.focus(); return; }

      setBusy(true);
      call('POST', '/api/images/generate', { prompt: prompt, size: sel.value || undefined })
        .then(function (r) {
          setBusy(false);

          if (!r.ok || !r.data || !r.data.image) {
            /* Surface what the server actually said. The API answers with a
               named reason — prompt_refused, cap_exceeded, unsupported_size —
               and those sentences are written for a person to act on. A
               generic "something went wrong" would throw away the only useful
               part of the response. */
            var d = r.data || {};
            var text = d.message || d.error ||
              (r.status === 401 ? 'Your session expired. Sign in again.' :
               r.status === 429 ? 'You have reached your image limit for now.' :
               'Image generation failed (HTTP ' + r.status + ').');
            say('error', text);
            return;
          }

          var img = r.data.image;
          if (img.status !== 'stored' || !img.url) {
            /* A row that exists but holds no bytes is not a success. The API
               marks that 'rehost_failed': the provider billed for it and the
               download did not land. Say so rather than rendering a broken
               image element. */
            say('error', 'The image was generated but could not be stored, so there is '
              + 'nothing to show. It still counted against your quota.');
            return;
          }

          var image = new Image();
          image.alt = prompt.slice(0, 120);
          image.src = img.url;
          out.appendChild(image);

          var actions = el('div', 'igen-actions');
          var open = el('a', null, 'Open full size');
          open.href = img.url;
          open.target = '_blank';
          open.rel = 'noopener';
          actions.appendChild(open);
          if (img.size) actions.appendChild(el('span', 'igen-sub', img.size));
          out.appendChild(actions);
        })
        .catch(function () {
          setBusy(false);
          say('error', 'Cannot reach the server. Check your connection and try again.');
        });
    });

    // Reflect whatever the options call already told us.
    if (options) { fillSizes(); }
    else if (optionsError) { fillSizes(); say('error', optionsError); btn.disabled = true; }

    mounted.push({ fillSizes: fillSizes, say: say, btn: btn });
  }

  function scan() {
    var hosts = document.querySelectorAll('[data-imagegen-mount]');
    for (var i = 0; i < hosts.length; i++) build(hosts[i]);
  }

  function start() {
    injectStyle();
    scan();
    loadOptions().then(function () {
      mounted.forEach(function (m) {
        m.fillSizes();
        if (optionsError) { m.say('error', optionsError); m.btn.disabled = true; }
      });
    });
    // A mount that appears later — a re-render, a modal — is picked up.
    if (window.MutationObserver) {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

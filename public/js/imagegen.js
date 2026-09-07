/* ═══════════════════════════════════════════════════════════════════════════
   IMAGEGEN — image generation, inside the content tools
   ───────────────────────────────────────────────────────────────────────────
   Round 1 shipped a complete image-generation API and no way to reach it. The
   lane split that stopped five agents colliding also meant the lane that built
   /api/images owned no HTML, and the lane that owned every HTML file did not
   know the endpoint existed. The feature went to production without a front
   door. This is the front door.

   ╔═════════════════════════════════════════════════════════════════════════╗
   ║  CONTRACT A — the drop-in panel, the same one genlang.js uses           ║
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

   ╔═════════════════════════════════════════════════════════════════════════╗
   ║  CONTRACT B — window.ImageGen, for a page that owns its own controls    ║
   ╠═════════════════════════════════════════════════════════════════════════╣
   ║  ImageGen.ready()   → Promise, resolves to the options object or null   ║
   ║  ImageGen.options() → that object once ready() has resolved             ║
   ║  ImageGen.error()   → why it is not usable, in a sentence, or null      ║
   ║  ImageGen.sizes()   → [{value,label,isDefault}], normalised             ║
   ║  ImageGen.styles()  → [{ref,label,summary,phrase}] — the KINDS, with    ║
   ║          the exact sentence each one appends. Published so a            ║
   ║          page can SHOW it; never re-typed on the client.                ║
   ║  ImageGen.generate({prompt,size,style,negative_prompt,lang})            ║
   ║        → Promise<{ok:true, image} | {ok:false, message, status}>        ║
   ║          It REJECTS only when the request never reached the server.     ║
   ╚═════════════════════════════════════════════════════════════════════════╝

   ── WHY CONTRACT B EXISTS ─────────────────────────────────────────────────
   A blank prompt box under a form is the wrong control for a feature whose
   image is part of one specific deliverable. public/social.html's Social
   Media Posts tool derives the image prompt from the topic, platform and tone
   the user has already filled in, picks the aspect from the platform, and
   puts the result beside the posts. That is page-specific business policy and
   it belongs on the page.

   What must NOT be page-specific is the transport, the option catalogue and
   the sentences a failure is reported with — an image path that reports a
   quota refusal one way here and another way there is two things that drift.
   So those live once, here, and the page reaches them through window.ImageGen.
   Contract A's own panel goes through the same three functions; there is no
   second implementation to keep in step.

   ── SCOPE: GENERATE ONLY, AND THAT IS A DECISION ──────────────────────────
   Prompt, size, generate, show the result. No gallery, no history browser.
   Past images remain reachable through GET /api/images, and the honest
   consequence — that this panel does not show them — is stated in the UI
   rather than left for someone to discover.

   ── WHAT IT DOES NOT DO, ON PURPOSE ───────────────────────────────────────
   It never sends brand assets. The API supports an explicit brand-asset
   opt-in, and the rule from the spec is that a user's uploaded material only
   travels when they initiated that specific action. A checkbox tucked under a
   prompt box is not that, so neither contract offers one, and
   `used_brand_asset` stays false on everything either creates. Wiring that
   flow needs a real consent surface, and it is DEFERRED rather than faked.

   It also never sends a negative prompt the user cannot see. The API accepts
   one, and "no text, no watermark" is genuinely the right guidance for a
   social image — so social.html writes that guidance into the VISIBLE,
   editable prompt instead. The prompt stored against the image is then the
   prompt the user read, which is the same invariant lib/image keeps on the
   server side when it stores the composed prompt rather than the raw one.

   The panel now offers a negative prompt DIRECTLY, in a box, and that is the
   same rule rather than an exception to it: what was refused is a HIDDEN one.
   Nothing is prefilled, no style implies one, and an empty box puts no
   `negative_prompt` field on the wire at all.

   ── THE STYLE PICKER, AND WHY IT KEEPS THAT INVARIANT ─────────────────────
   A style DOES append a sentence the user did not type, which looks like the
   thing the paragraph above forbids. It is not, and the difference is where
   the sentence lives. lib/image/styles.js publishes every phrase through
   GET /api/images/options; the panel prints the selected one under "Exactly
   what will be sent" BEFORE anything is sent; the server stores the composed
   prompt. The text is on screen, in the response and in the audit row.

   Nothing on the client enumerates a style. Refs, labels, summaries and
   phrases all arrive from /options, and `style` goes on the wire as a REF —
   so this file cannot show one sentence while the server appends another.

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
  var mounted = [];          // every Contract-A panel on the page
  var options = null;        // GET /api/images/options, fetched once
  var optionsError = null;   // why it is not usable, in a sentence
  var optionsPromise = null; // the ONE in-flight fetch, shared by every caller

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
      '.igen-count{margin-top:4px;font-size:.6875rem;color:var(--text-2,currentColor);text-align:right}',
      '.igen-count[data-over="1"]{color:var(--red-text,currentColor);font-weight:600}',
      '.igen-lbl{display:block;margin-top:11px;font-size:.75rem;font-weight:600;',
      '  color:var(--text-2,currentColor)}',
      '.igen-lbl>select,.igen-lbl>input{display:block;margin-top:5px;font-weight:400;',
      '  color:var(--text,currentColor)}',
      '.igen-sel-wide{width:100%;box-sizing:border-box}',
      '.igen-in{width:100%;box-sizing:border-box;padding:7px 9px;',
      '  border:1px solid var(--border,currentColor);border-radius:var(--r-sm,6px);',
      '  background:var(--bg,transparent);color:var(--text,currentColor);font:inherit}',
      '.igen-in:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:1px}',
      '.igen-hint{margin-top:5px;font-size:.75rem;color:var(--text-2,currentColor);line-height:1.5}',
      '.igen-link{padding:7px 10px;border:1px solid var(--border,currentColor);',
      '  border-radius:var(--r-sm,6px);background:transparent;color:var(--text-2,currentColor);',
      '  font:inherit;font-size:.8125rem;cursor:pointer}',
      '.igen-link:hover{color:var(--text,currentColor)}',
      '.igen-link:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:1px}',
      '.igen-prev{margin-top:11px;font-size:.8125rem}',
      '.igen-prev>summary{cursor:pointer;font-size:.75rem;color:var(--text-2,currentColor)}',
      '.igen-prev>summary:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:2px}',
      '.igen-prev-body{margin-top:8px;padding:10px 12px;border:1px solid var(--border,currentColor);',
      '  border-radius:var(--r-sm,6px);background:var(--bg,transparent);',
      '  color:var(--text,currentColor);line-height:1.55}',
      '.igen-prev-part+.igen-prev-part{margin-top:9px;padding-top:9px;',
      '  border-top:1px solid var(--border,currentColor)}',
      '.igen-prev-lbl{font-size:.6875rem;font-weight:600;text-transform:uppercase;',
      '  letter-spacing:.04em;color:var(--text-2,currentColor);margin-bottom:3px}',
      '.igen-prev-muted{opacity:.7}',
      '.igen-prev-foot{margin-top:10px;font-size:.6875rem;color:var(--text-2,currentColor)}',
      '.igen-avoid[hidden]{display:none}',
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

  /* ══ THE SHARED SURFACE ═══════════════════════════════════════════════════
     Everything from here to CONTRACT A is what both contracts go through. */

  /* Read the response as text and parse it here.
     Handing an unparseable body back as an empty object would turn an HTML
     proxy error page into "generated nothing successfully" — a false
     statement about the product, built out of a transport failure. */
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

  /**
   * GET /api/images/options, once per page load, shared by every caller.
   * Resolves to the options object, or to null with `optionsError` set to a
   * sentence saying why. It never rejects — a page asking "may I offer this
   * control at all" needs an answer, not an exception.
   */
  function ensureOptions() {
    if (optionsPromise) return optionsPromise;
    optionsPromise = call('GET', '/api/images/options').then(function (r) {
      if (r.ok && r.data) {
        options = r.data;
        optionsError = null;
        /* `configured` is the server's own word for "this deployment holds a
           key". A control offered where nothing can generate is a control
           that fails on click, so the refusal is said up front instead — and
           in the API's own words, which name text generation as unaffected. */
        if (r.data.configured === false) {
          optionsError = 'Image generation is not configured on this deployment. '
            + 'Text generation is unaffected.';
        }
        return options;
      }
      /* 401 is not a fault — it means signed out. Say which, in words that
         name the fix, rather than in the API's word 'unauthorised'.

         Everything else defers to the server's own sentence when it sent one.
         checkSub answers this route 402 with 'Your subscription has expired.
         Please renew at /billing.' — an instruction the user can act on — and
         flattening that into 'unavailable right now' would leave someone
         staring at a dead control with no idea it is a billing problem. */
      optionsError = r.status === 401
        ? 'Sign in to generate images.'
        : (r.data && r.data.message) ? r.data.message
        : 'Image generation is unavailable right now.';
      return null;
    }).catch(function () {
      optionsError = 'Cannot reach the image service.';
      return null;
    });
    return optionsPromise;
  }

  /**
   * The legal size catalogue, normalised to {value,label,isDefault}.
   *
   * lib/image/sizes.js is the single source of truth for the five values and
   * derives its own labels from the strings, so nothing here enumerates them
   * a second time. This only reshapes what the API sent into the one form a
   * <select> wants — plain strings and {size,label,orientation} objects are
   * both handled, here, once, rather than at each call site.
   */
  function normalisedSizes() {
    var raw = (options && (options.sizes || options.legalSizes)) || [];
    return raw.map(function (s) {
      var value = typeof s === 'string' ? s : (s.size || s.value);
      var label = typeof s === 'string' ? s : (s.label || s.orientation || s.size);
      return {
        value: value,
        label: label === value ? value : label + ' · ' + value,
        isDefault: Boolean(options && value === options.defaultSize)
      };
    });
  }

  /**
   * The style catalogue, normalised to {ref,label,summary,phrase}.
   *
   * lib/image/styles.js owns the refs, the labels AND the sentences. This
   * enumerates none of them — a hard-coded "Watercolour" here would be a
   * second catalogue, and the day the server rewords a phrase the panel would
   * still be printing the old one under a box that sends the new one. That is
   * the exact failure this whole design is arranged to prevent: what the user
   * READS has to be what gets SENT.
   */
  function normalisedStyles() {
    var raw = (options && options.styles) || [];
    return raw.map(function (s) {
      return {
        ref: typeof s === 'string' ? s : s.ref,
        label: (typeof s === 'string' ? s : s.label) || s.ref,
        summary: (s && s.summary) || '',
        phrase: (s && s.phrase) || null
      };
    }).filter(function (s) { return Boolean(s.ref); });
  }

  /**
   * ONE mapping from a failed response to a sentence a person can act on.
   *
   * The API answers with a named reason — image_cap_exceeded,
   * moderation_refused, unsupported_size, image_generation_unavailable — and
   * a `message` written for a human, which says things like how much of the
   * quota is left and whether anything was charged. Those are shown verbatim
   * because they are the only useful part of the response; a generic
   * "something went wrong" throws them away. The status lines below are the
   * last resort, for a response that carried no body at all.
   */
  function failureMessage(r) {
    var d = r.data || {};
    if (d.message) return d.message;
    if (d.error) return d.error;
    if (r.status === 401) return 'Your session expired. Sign in again.';
    if (r.status === 429) return 'You have reached your image limit for now.';
    return 'Image generation failed (HTTP ' + r.status + ').';
  }

  /**
   * The remaining-quota sentence, from the usage block the server returns
   * WITH the image. Empty string when there is nothing to say, so a caller
   * can append it unconditionally. Worded once here, like the failure
   * sentences above, so the panel and public/js/postimage.js cannot report
   * the same number two different ways.
   */
  function quota(usage) {
    var day = usage && usage.remaining ? usage.remaining.day : undefined;
    var month = usage && usage.remaining ? usage.remaining.month : undefined;
    if (typeof day !== 'number') return '';
    return day + ' image generation' + (day === 1 ? '' : 's') + ' left today'
      + (typeof month === 'number' ? ', ' + month + ' this month' : '') + '.';
  }

  /**
   * POST /api/images/generate.
   *
   * Resolves {ok:true, image} or {ok:false, message, status}. It rejects ONLY
   * when the request never reached the server, so a caller can tell "the
   * service said no" from "there is no service" and word the two differently.
   */
  function generate(req) {
    var r = req || {};
    var body = { prompt: typeof r.prompt === 'string' ? r.prompt : '' };
    if (r.size) body.size = r.size;
    if (r.lang) body.lang = r.lang;
    /* The KIND the user picked, sent as a REF and never as prose. The
       sentence it stands for lives in lib/image/styles.js; this file shows it
       from the catalogue /options returned and holds no copy of its own, so
       there is nothing here to drift — not even the name of the ref that
       means "add nothing", which is why this is a plain truthy check and not
       a comparison against a literal. */
    if (r.style) body.style = r.style;
    /* What to keep OUT of the picture. ONLY ever what the user typed into the
       visible box: no default list, nothing implied by the chosen style, and
       nothing this file adds on anyone's behalf. A negative prompt the user
       cannot see is a prompt they cannot be said to have read. */
    if (r.negative_prompt) body.negative_prompt = r.negative_prompt;

    return call('POST', '/api/images/generate', body).then(function (res) {
      if (!res.ok || !res.data || !res.data.image) {
        return { ok: false, status: res.status, message: failureMessage(res) };
      }
      var img = res.data.image;
      if (img.status !== 'stored' || !img.url) {
        /* A row that exists but holds no bytes is not a success. The server
           normally reports that as a 502 whose message says the provider
           billed for it and the download did not land; a 201 carrying a
           non-stored row would be the same fact arriving by a different door,
           and rendering a broken <img> for it would be worse than saying so. */
        return {
          ok: false,
          status: res.status,
          image: img,
          message: 'The image was generated but could not be stored, so there is '
            + 'nothing to show. It still counted against your quota.'
        };
      }
      return { ok: true, image: img };
    });
  }

  /* The public surface. Small on purpose: everything a page needs to offer
     its own image control, and nothing that would let it build a second
     transport or a second set of error sentences. */
  window.ImageGen = {
    ready: ensureOptions,
    options: function () { return options; },
    error: function () { return optionsError; },
    sizes: normalisedSizes,
    styles: normalisedStyles,
    generate: generate
  };

  /* ══ CONTRACT A — the drop-in panel ═════════════════════════════════════ */

  /* ── THE PANEL ────────────────────────────────────────────────────────────
     Four controls, in the order a person actually decides them:

       1. WHAT   — the description. The box that was already here.
       2. WHAT KIND — the style picker. New, and the reason this round exists:
          the panel used to hand a four-word prompt straight to the model,
          which then chose the medium, the palette and the lighting itself,
          differently every time. Two images made for one campaign did not
          look related. A kind is one click and it is worth a paragraph of
          typing nobody was doing.
       3. SHAPE  — the aspect, unchanged.
       4. AVOID  — optional, collapsed, and VISIBLE. The API has always taken
          a negative prompt and no surface here ever offered one; the reason
          it stayed unoffered was that a hidden one is a prompt the user
          cannot be said to have read. A box they type into is not hidden.

     And under them, "Exactly what will be sent" — the user's own words and,
     when a kind is picked, the sentence that kind appends, shown as separate
     blocks rather than one concatenated string. Two blocks because a joined
     preview would mean this file owning a copy of the server's join rule, and
     a copy is a thing that drifts. The parts are the server's; the order is
     stated in words.
     ───────────────────────────────────────────────────────────────────────── */
  function build(host) {
    if (host.getAttribute('data-imagegen-ready') === '1') return;
    host.setAttribute('data-imagegen-ready', '1');

    var wrap = el('div', 'igen');
    var head = el('div', 'igen-h');
    head.appendChild(el('span', 'igen-t', 'Image'));
    head.appendChild(el('span', 'igen-sub', '— generated, then stored here'));
    wrap.appendChild(head);

    var ta = el('textarea', 'igen-ta');
    ta.placeholder = 'What should be in the picture? A subject, where it is, '
      + 'what is happening. Leave the look to the style below.';
    ta.setAttribute('aria-label', 'Image description');
    wrap.appendChild(ta);

    var count = el('div', 'igen-count');
    wrap.appendChild(count);

    /* ── the kind ───────────────────────────────────────────────────────── */
    var styleLab = el('label', 'igen-lbl', 'What kind of image?');
    var styleSel = el('select', 'igen-sel igen-sel-wide');
    styleLab.appendChild(styleSel);
    wrap.appendChild(styleLab);

    var styleNote = el('div', 'igen-hint');
    wrap.appendChild(styleNote);

    /* ── shape, avoid, go ───────────────────────────────────────────────── */
    var row = el('div', 'igen-row');
    var sel = el('select', 'igen-sel');
    sel.setAttribute('aria-label', 'Image shape');
    row.appendChild(sel);

    var avoidBtn = el('button', 'igen-link', '+ Avoid');
    avoidBtn.type = 'button';
    avoidBtn.setAttribute('aria-expanded', 'false');
    row.appendChild(avoidBtn);

    var btn = el('button', 'igen-btn', 'Generate image');
    btn.type = 'button';
    row.appendChild(btn);
    wrap.appendChild(row);

    var avoidWrap = el('label', 'igen-lbl igen-avoid', 'Keep these out of the image');
    avoidWrap.hidden = true;
    var avoid = el('input', 'igen-in');
    avoid.type = 'text';
    avoid.placeholder = 'e.g. text, lettering, watermark, extra hands';
    avoidWrap.appendChild(avoid);
    wrap.appendChild(avoidWrap);

    /* ── what will actually be sent ─────────────────────────────────────── */
    var prev = el('details', 'igen-prev');
    var prevSum = el('summary', null, 'Exactly what will be sent');
    prev.appendChild(prevSum);
    var prevBody = el('div', 'igen-prev-body');
    prev.appendChild(prevBody);
    wrap.appendChild(prev);

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
      var list = normalisedSizes();
      if (!list.length) {
        var o = el('option', null, 'Default shape');
        o.value = '';
        sel.appendChild(o);
        return;
      }
      list.forEach(function (s) {
        var opt = el('option', null, s.label);
        opt.value = s.value;
        if (s.isDefault) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    function fillStyles() {
      styleSel.innerHTML = '';
      var list = normalisedStyles();
      if (!list.length) {
        /* The server sent no catalogue — an older deployment, or an /options
           call that failed. One inert option with an EMPTY value, so nothing
           is put on the wire: offering a ref this server might not accept
           would turn a missing catalogue into a 400 on click. Its wording is
           deliberately not any catalogue label, so the drift guard in
           test/image-contract.js §7c can assert this file holds no copy of
           lib/image/styles.js. */
        var o = el('option', null, 'Default — nothing added');
        o.value = '';
        styleSel.appendChild(o);
        return;
      }
      /* Which one starts selected is the SERVER's call, named in
         options.defaultStyle. When it names nothing the browser selects the
         first, which is the catalogue's own first entry — this file does not
         know or hard-code which ref that is. */
      var want = options && options.defaultStyle;
      list.forEach(function (s) {
        var opt = el('option', null, s.label);
        opt.value = s.ref;
        if (want && s.ref === want) opt.selected = true;
        styleSel.appendChild(opt);
      });
    }

    /** The catalogue entry currently picked, or null. */
    function chosenStyle() {
      var ref = styleSel.value;
      if (!ref) return null;
      var list = normalisedStyles();
      for (var i = 0; i < list.length; i++) if (list[i].ref === ref) return list[i];
      return null;
    }

    function part(label, text, muted) {
      var b = el('div', 'igen-prev-part' + (muted ? ' igen-prev-muted' : ''));
      b.appendChild(el('div', 'igen-prev-lbl', label));
      b.appendChild(el('div', null, text));
      return b;
    }

    /** Redraw the style summary, the counter and the send preview. */
    function reflect() {
      var st = chosenStyle();
      styleNote.textContent = st ? st.summary : '';

      var max = (options && options.maxPromptChars) || 0;
      var typed = ta.value.trim();
      count.textContent = max ? (ta.value.length + ' / ' + max) : '';
      count.setAttribute('data-over', max && ta.value.length > max ? '1' : '0');

      prevBody.innerHTML = '';
      prevBody.appendChild(typed
        ? part('Your description', typed)
        : part('Your description', 'Nothing typed yet.', true));
      if (st && st.phrase) {
        prevBody.appendChild(part('Added by “' + st.label + '”', st.phrase));
      }
      var neg = avoid.value.trim();
      if (neg) prevBody.appendChild(part('Kept out', neg));
      prevBody.appendChild(el('div', 'igen-prev-foot',
        st && st.phrase
          ? 'Both paragraphs are sent, in that order, and both are saved with the image.'
          : 'Sent exactly as written, and saved with the image.'));
    }

    function setBusy(on) {
      btn.disabled = on;
      ta.disabled = on;
      sel.disabled = on;
      styleSel.disabled = on;
      avoid.disabled = on;
      btn.textContent = on ? 'Generating…' : 'Generate image';
    }

    ta.addEventListener('input', reflect);
    avoid.addEventListener('input', reflect);
    styleSel.addEventListener('change', reflect);
    avoidBtn.addEventListener('click', function () {
      avoidWrap.hidden = !avoidWrap.hidden;
      avoidBtn.setAttribute('aria-expanded', avoidWrap.hidden ? 'false' : 'true');
      avoidBtn.textContent = avoidWrap.hidden ? '+ Avoid' : '− Avoid';
      if (!avoidWrap.hidden) avoid.focus();
    });

    btn.addEventListener('click', function () {
      var prompt = ta.value.trim();
      clearSay();
      out.innerHTML = '';
      if (!prompt) { say('error', 'Describe the image first.'); ta.focus(); return; }

      setBusy(true);
      generate({
        prompt: prompt,
        size: sel.value || undefined,
        style: styleSel.value || undefined,
        negative_prompt: avoid.value.trim() || undefined
      }).then(function (result) {
        setBusy(false);
        if (!result.ok) { say('error', result.message); return; }

        var img = result.image;
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
        var dl = el('a', null, 'Download');
        dl.href = img.url;
        dl.download = 'image-' + img.id;
        actions.appendChild(dl);
        if (img.size) actions.appendChild(el('span', 'igen-sub', img.size));
        out.appendChild(actions);

        /* The server returns the caller's own remaining quota alongside the
           image. Printing it costs nothing — "how many do I have left" is the
           next question every time, and asking again would be a second round
           trip for a number already in hand. */
        var left = quota(img.usage);
        if (left) out.appendChild(el('div', 'igen-note', left));
      }, function () {
        /* The second argument to .then, not a trailing .catch: this handler is
           for a request that never left the machine, and a .catch here would
           also swallow a bug thrown by the success handler above it and
           report it to the user as a network problem. */
        setBusy(false);
        say('error', 'Cannot reach the server. Check your connection and try again.');
      });
    });

    function fill() { fillSizes(); fillStyles(); reflect(); }

    // Reflect whatever the options call already told us.
    if (options) { fill(); }
    else if (optionsError) { fill(); say('error', optionsError); btn.disabled = true; }
    else { reflect(); }

    mounted.push({ fill: fill, say: say, btn: btn });
  }

  function scan() {
    var hosts = document.querySelectorAll('[data-imagegen-mount]');
    for (var i = 0; i < hosts.length; i++) build(hosts[i]);
  }

  function start() {
    injectStyle();
    scan();
    ensureOptions().then(function () {
      mounted.forEach(function (m) {
        m.fill();
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

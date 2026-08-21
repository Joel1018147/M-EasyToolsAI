/* ═══════════════════════════════════════════════════════════════════════════
   POSTIMAGE — the image option inside the Social Media Posts tool
   ───────────────────────────────────────────────────────────────────────────
   THIS FILE EXISTS BECAUSE THE TOOL SHIPPED TWICE.

   `social-media` is defined in public/social.html AND in public/app.html —
   two FORMS tables, two openTool(), two generate(). The hub's copy is the one
   behind the dashboard's "Social Post" tile, which is the one people actually
   click; the module page's copy is reached through /social's landing page and
   its "Open Tool →" button. The first pass of this feature was built into
   social.html only, so the option was live on a page most users never open
   and absent from the one they do. Joel found it by looking for it.

   Writing it into app.html as well would have made THREE copies of the same
   hundred lines — the aspect map, the description, the failure rendering, the
   token guard. So it is one module and both pages call it. What each page
   supplies is only what genuinely differs between them: where to put the
   section, where to paint the result, and the class names that make it look
   native to that page.

   ╔═════════════════════════════════════════════════════════════════════════╗
   ║  PostImage.attach(cfg)   build the option into a form (replaces any     ║
   ║                          previous attachment)                           ║
   ║  PostImage.detach()      forget it — call when another tool opens       ║
   ║  PostImage.refresh()     re-derive the defaults (tone changed)          ║
   ║  PostImage.start()       fire the request if the option is switched on; ║
   ║                          returns true when this run has an image on     ║
   ║                          screen or on the way                           ║
   ║                                                                         ║
   ║  cfg = {                                                                ║
   ║    form,      element the section is appended to                        ║
   ║    output,    element the image block is painted into                   ║
   ║    tone,      () => the active tone, read at build time not cached      ║
   ║    fields,    {topic, platform, goal} — element ids on the page         ║
   ║    css,       {section,label,select,textarea,block,head,blockLabel,     ║
   ║                acts,btn,body} — the page's own class names              ║
   ║    hideEmpty  optional () => void, to clear the page's empty state      ║
   ║  }                                                                      ║
   ╚═════════════════════════════════════════════════════════════════════════╝

   ── NO ID LOOKUPS FOR ITS OWN CONTROLS ────────────────────────────────────
   Every node this module creates is held by reference in a closure. It never
   asks the document for one back. An id typo between the markup a function
   writes and the markup it reads is a whole class of bug, and the way to not
   have it is to not use ids. The page's OWN fields are still looked up by id,
   because the page built them — that is the one boundary where a name has to
   be agreed, and it is the one thing the suite checks statically.

   ── THE TRANSPORT IS NOT HERE ─────────────────────────────────────────────
   /js/imagegen.js owns window.ImageGen: the options fetch, the legal size
   catalogue and the sentences a refusal is reported with. This module is the
   social-post POLICY on top of it — which platform wants which aspect, and
   how a topic becomes a description. Both pages get the same policy and the
   same transport, and neither holds a copy of either.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var STYLE_ID = 'postimage-style';

  /* Which aspect each platform wants.
     The five legal values are NOT enumerated here — lib/image/sizes.js owns
     them and ImageGen.sizes() carries them to the <select>. This only says
     which of whatever came back each platform prefers, and a preference that
     is not in the catalogue is dropped rather than forced, so the server can
     add or remove a size without this map being able to send an illegal one. */
  var PLATFORM_ASPECT = {
    'Instagram': '1328*1328',     // square: the feed, and it crops safely to a story
    'TikTok': '928*1664',         // 9:16, full screen
    'LinkedIn': '1664*928',       // landscape reads widest in a scrolling feed
    'X (Twitter)': '1664*928',
    'Facebook': '1664*928',
    'All platforms': '1328*1328'  // square is the one that survives every crop
  };

  var cfg = null;            // the current attachment, or null
  var ui = null;             // the nodes this module made, by reference
  var run = 0;               // token of the most recent request
  var promptEdited = false;  // the user has taken over the description
  var sizeEdited = false;    // …or the aspect

  /* Styles for the controls this module owns. Tokens only, with currentColor
     fallbacks, so it is plain but never invisible on a page whose palette is
     spelled differently — app.html and social.html do not share a full token
     vocabulary and this file must look right on both. */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.pimg-tog{display:flex;align-items:flex-start;gap:9px;cursor:pointer;margin-top:2px}',
      '.pimg-tog input{width:15px;height:15px;margin-top:3px;flex-shrink:0;cursor:pointer;',
      '  accent-color:var(--accent,currentColor)}',
      '.pimg-tog input:focus-visible{outline:2px solid var(--accent,currentColor);outline-offset:2px}',
      '.pimg-tog input:disabled{cursor:default;opacity:.5}',
      '.pimg-txt{font-size:.8125rem;color:var(--muted,currentColor);line-height:1.5}',
      '.pimg-txt b{display:block;font-size:.75rem;font-weight:600;color:var(--text-2,currentColor)}',
      '.pimg-hint{font-size:.75rem;color:var(--muted,currentColor);line-height:1.5;margin-top:7px}',
      '.pimg-sub{margin-top:12px}',
      '.pimg-frame{background:var(--surface-2,transparent)}',
      '.pimg-frame img{display:block;width:100%;height:auto}',
      '.pimg-acts a{text-decoration:none}'
    ].join('');
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML
    return n;
  }

  function field(name) {
    var ids = (cfg && cfg.fields) || {};
    return ids[name] ? document.getElementById(ids[name]) : null;
  }
  function fieldValue(name) {
    var node = field(name);
    return node ? String(node.value || '').trim() : '';
  }

  /* ── the description ─────────────────────────────────────────────────────
     The description the user READS is the description that gets SENT. The API
     accepts a negative prompt and "no text, no watermark" is genuinely the
     right guidance — image models render lettering badly, and the caption is
     the other half of this tool's output anyway — but putting it in a hidden
     field would mean the prompt stored against the image is not the one
     anybody saw. So it goes in the visible box, where it can be read, kept or
     deleted. */
  function derived() {
    var topic = fieldValue('topic');
    if (!topic) return '';
    var platform = fieldValue('platform') || 'social media';
    var goal = fieldValue('goal');
    var tone = (cfg && typeof cfg.tone === 'function' && cfg.tone()) || '';
    return 'A ' + (tone ? tone.toLowerCase() + ' ' : '') + platform + ' image for: ' + topic + '.'
      + (goal ? ' It has to carry this at a glance: ' + goal.toLowerCase() + '.' : '')
      + ' Photographic, sharp, bright even lighting, one clear subject, uncluttered'
      + ' background with room for a caption to sit over it.'
      + ' No text, no lettering, no logo and no watermark anywhere in the image.';
  }

  function refresh() {
    if (!ui) return;
    if (!promptEdited) ui.prompt.value = derived();
    if (!sizeEdited) {
      var want = PLATFORM_ASPECT[fieldValue('platform')];
      if (want) {
        for (var i = 0; i < ui.size.options.length; i++) {
          if (ui.size.options[i].value === want) { ui.size.value = want; break; }
        }
      }
    }
  }

  /* Off, and saying why. Not hidden: a control that vanishes and a control
     that was never built look identical, and only one is worth asking about. */
  function disable(reason) {
    if (!ui) return;
    ui.toggle.checked = false;
    ui.toggle.disabled = true;
    ui.detail.hidden = true;
    ui.note.textContent = reason;
    ui.note.hidden = false;
  }

  function detach() {
    cfg = null;
    ui = null;
    promptEdited = false;
    sizeEdited = false;
    run++;   // anything still in flight belongs to a form that is gone
  }

  function attach(options) {
    detach();
    if (!options || !options.form || !options.output) return false;
    injectStyle();
    cfg = options;
    var css = options.css || {};

    var section = el('div', css.section || '');
    section.appendChild(el('div', css.label || '', 'Image'));

    var toggleLabel = el('label', 'pimg-tog');
    var toggle = el('input');
    toggle.type = 'checkbox';
    var txt = el('span', 'pimg-txt');
    txt.appendChild(el('b', null, 'Also generate a matching image'));
    txt.appendChild(document.createTextNode(
      'One image, made alongside the posts and saved to your account. '
      + 'It counts against your image quota.'));
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(txt);
    section.appendChild(toggleLabel);

    var note = el('div', 'pimg-hint');
    note.hidden = true;
    section.appendChild(note);

    var detail = el('div');
    detail.hidden = true;

    var sizeLabel = el('div', (css.label || '') + ' pimg-sub', 'Aspect');
    var size = el('select', css.select || '');
    size.setAttribute('aria-label', 'Image aspect');
    detail.appendChild(sizeLabel);
    detail.appendChild(size);

    var promptLabel = el('div', (css.label || '') + ' pimg-sub', 'Image description');
    var prompt = el('textarea', css.textarea || '');
    prompt.rows = 4;
    prompt.placeholder = 'Describe the image…';
    prompt.setAttribute('aria-label', 'Image description');
    detail.appendChild(promptLabel);
    detail.appendChild(prompt);
    detail.appendChild(el('div', 'pimg-hint',
      'Written from your topic, platform and tone, and sent exactly as you see it. '
      + 'Edit it and it stays as you left it.'));

    section.appendChild(detail);
    options.form.appendChild(section);

    ui = { section: section, toggle: toggle, detail: detail, size: size, prompt: prompt, note: note };

    toggle.addEventListener('change', function () {
      detail.hidden = !toggle.checked;
      if (toggle.checked) refresh();
    });
    prompt.addEventListener('input', function () { promptEdited = true; });
    size.addEventListener('change', function () { sizeEdited = true; });

    // The module wires itself to the page's fields, so neither page has to.
    ['topic', 'platform', 'goal'].forEach(function (name) {
      var node = field(name);
      if (!node) return;
      node.addEventListener('input', refresh);
      node.addEventListener('change', refresh);
    });

    if (!window.ImageGen) {
      disable('Image generation did not load on this page. The posts are unaffected.');
      return true;
    }

    /* Ask BEFORE the click whether this deployment can generate at all. A tick
       box that answers "not configured" only after someone has written a
       description and pressed Generate is a control that lied about existing.
       ImageGen.ready() shares one request with every other caller on the page,
       so opening this tool costs no extra round trip. */
    var mine = ui;
    window.ImageGen.ready().then(function () {
      if (ui !== mine) return;                   // the tool changed while in flight
      if (window.ImageGen.error()) { disable(window.ImageGen.error()); return; }
      window.ImageGen.sizes().forEach(function (z) {
        var o = el('option', null, z.label);
        o.value = z.value;
        if (z.isDefault) o.selected = true;
        size.appendChild(o);
      });
      var opts = window.ImageGen.options();
      if (opts && opts.maxPromptChars) prompt.maxLength = opts.maxPromptChars;
      refresh();
    });
    return true;
  }

  /** What would be sent right now, or null if the option is off or unusable. */
  function pending() {
    if (!ui || !cfg || !window.ImageGen) return null;
    if (ui.toggle.disabled || !ui.toggle.checked) return null;
    return {
      prompt: String(ui.prompt.value || '').trim(),
      size: ui.size.value || '',
      /* The run's output language, recorded against the row so an image says
         which language surface produced it. lib/image stores it; it does not
         rewrite the prompt with it. */
      lang: (window.GenLang && typeof window.GenLang.get === 'function') ? window.GenLang.get() : ''
    };
  }

  /* ── painting ────────────────────────────────────────────────────────────*/

  function block(labelText) {
    var css = (cfg && cfg.css) || {};
    var host = cfg.output;
    host.innerHTML = '';
    if (cfg.hideEmpty) cfg.hideEmpty();
    var b = el('div', css.block || '');
    var h = el('div', css.head || '');
    h.appendChild(el('span', css.blockLabel || '', labelText));
    var acts = el('div', (css.acts || '') + ' pimg-acts');
    h.appendChild(acts);
    b.appendChild(h);
    host.appendChild(b);
    return { block: b, acts: acts, css: css };
  }

  function paintPending() {
    var b = block('Image');
    var body = el('div', b.css.body || '');
    body.innerHTML = '<div class="r3-working"><div class="r3-working-dots"><i></i><i></i><i></i></div>'
      + '<span class="r2-thinking">Generating your image…</span></div>';
    b.block.appendChild(body);
  }

  function paint(image, req) {
    var b = block('Image · ' + (image.size || ''));

    var open = el('a', b.css.btn || '', '↗ Open');
    open.href = image.url; open.target = '_blank'; open.rel = 'noopener';
    var dl = el('a', b.css.btn || '', '⤓ Download');
    dl.href = image.url; dl.download = 'social-image-' + image.id;
    var again = el('button', b.css.btn || '', '↻ Regenerate');
    again.type = 'button';
    again.addEventListener('click', start);
    b.acts.appendChild(open); b.acts.appendChild(dl); b.acts.appendChild(again);

    var frame = el('div', 'pimg-frame');
    var img = new Image();
    img.alt = String(req.prompt || '').slice(0, 120);
    img.src = image.url;
    frame.appendChild(img);
    b.block.appendChild(frame);

    /* The server returns the caller's own remaining quota with the image. It
       is printed because "how many do I have left" is the next question every
       time and the answer is already in the response — asking again would be
       a second round trip for a number we are holding. */
    var left = quota(image.usage);
    if (left) b.block.appendChild(el('div', b.css.body || '', left));
  }

  function paintError(message) {
    var b = block('Image · not generated');
    var again = el('button', b.css.btn || '', '↻ Try again');
    again.type = 'button';
    again.addEventListener('click', start);
    b.acts.appendChild(again);
    b.block.appendChild(el('div', b.css.body || '', message));
  }

  function quota(usage) {
    var day = usage && usage.remaining ? usage.remaining.day : undefined;
    var month = usage && usage.remaining ? usage.remaining.month : undefined;
    if (typeof day !== 'number') return '';
    return day + ' image generation' + (day === 1 ? '' : 's') + ' left today'
      + (typeof month === 'number' ? ', ' + month + ' this month' : '') + '.';
  }

  /**
   * Fire the request. Returns true when this run has an image on screen or on
   * the way — each page uses that to decide whether its "nothing here yet"
   * empty state is still true after a text failure.
   */
  function start() {
    var req = pending();
    if (!req) return false;
    if (!req.prompt) {
      paintError('Describe the image, or switch the image option off. '
        + 'Nothing was sent and nothing was charged.');
      return true;
    }
    var token = ++run;
    paintPending();
    window.ImageGen.generate(req).then(function (res) {
      if (token !== run) return;
      if (res.ok) paint(res.image, req); else paintError(res.message);
    }, function () {
      /* The second argument to .then, not a trailing .catch, so a bug thrown
         by the render above is not reported as a network failure. */
      if (token !== run) return;
      paintError('Cannot reach the server, so no image was made. '
        + 'Anything above this is unaffected.');
    });
    return true;
  }

  window.PostImage = {
    attach: attach,
    detach: detach,
    refresh: refresh,
    start: start,
    pending: pending,
    PLATFORM_ASPECT: PLATFORM_ASPECT
  };
})();

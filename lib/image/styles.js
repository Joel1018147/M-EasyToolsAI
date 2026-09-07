/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE STYLES — "what KIND of image do you want?"
   ───────────────────────────────────────────────────────────────────────────
   ── WHY THIS EXISTS ───────────────────────────────────────────────────────
   The panel shipped as one empty box whose placeholder said "be specific".
   That is the whole art direction a user gets, and most people type four
   words into it. A four-word prompt to qwen-image returns a four-word image:
   the model picks a medium, a palette and a lighting setup on its own, and it
   picks a different one next time, so two images made for the same campaign
   do not look like they belong together.

   The fix is not a longer placeholder. It is a small, closed set of KINDS —
   photograph, flat vector, watercolour, product shot — each carrying the
   art-direction sentence a photographer or illustrator would have written,
   so one click does what a paragraph of typing would have.

   ── THE RULE THIS FILE KEEPS ──────────────────────────────────────────────
   NOTHING IS ADDED UNLESS THE USER PICKED IT, AND WHAT IS ADDED IS PUBLISHED
   VERBATIM.

   `phrase` is not an internal implementation detail. GET /api/images/options
   returns this catalogue in full, phrases included, and the panel prints the
   exact composed prompt under the box before anything is sent. So the older
   invariant — the prompt the user READ is the prompt that gets SENT, and the
   prompt SENT is the prompt STORED — survives a feature that appends text,
   because the appended text is on screen.

   That is also why there is no hidden negative prompt attached to a style.
   "No text, no watermark" is genuinely right for most of these, and it is
   still not going on the wire behind anyone's back — the panel offers a
   visible "Avoid" box instead, the same call public/js/postimage.js already
   made when it wrote that guidance into the visible description.

   ── AND WHY THE DEFAULT IS `none` ─────────────────────────────────────────
   A request that names no style sends the user's prompt BYTE-IDENTICAL, and
   test/image-contract.js §7(a) asserts exactly that. Defaulting the server to
   'photo' because it makes the average first image nicer would mean every
   existing caller — public/js/postimage.js, the M-Ai tools, anything built
   next — silently got a prompt it did not write. The picker in the UI can
   suggest; the SERVICE never assumes.

   ── ONE SOURCE OF TRUTH ───────────────────────────────────────────────────
   The refs, the labels and the phrases exist here and nowhere else.
   public/js/imagegen.js renders whatever /options hands it and enumerates no
   style of its own, so adding a twelfth kind is this file plus a test — the
   same arrangement ../sizes.js has with the five legal sizes.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * The kinds of image this platform offers, in the order a picker shows them.
 *
 * `phrase` is appended to the user's prompt verbatim, after a blank line. It
 * is written as art direction rather than as adjectives — "soft even studio
 * lighting, a soft shadow beneath it" survives translation into pixels in a
 * way "professional, high quality, 4k" does not.
 *
 * `summary` is the one line under the label in the picker. It says what the
 * kind is FOR, because "Flat vector" means nothing to a café owner and "menu
 * boards, icons, slides" means everything.
 */
const STYLES = Object.freeze({
  none: {
    ref: 'none',
    label: 'My words, exactly',
    summary: 'Nothing is added. The model gets only what you typed.',
    phrase: null,
  },

  photo: {
    ref: 'photo',
    label: 'Photograph',
    summary: 'Looks like a real photo. People, places, food, everyday scenes.',
    phrase: 'Style: photography. A real photograph — true-to-life colour and '
      + 'texture, natural depth of field, one clear subject in sharp focus, '
      + 'even natural lighting, an uncluttered background.',
  },

  product: {
    ref: 'product',
    label: 'Product shot',
    summary: 'One item on a clean background. Listings, catalogues, ads.',
    phrase: 'Style: studio product photography. The product centred and filling '
      + 'the frame on a clean seamless background, soft even studio lighting, '
      + 'a soft contact shadow beneath it, no props competing for attention.',
  },

  cinematic: {
    ref: 'cinematic',
    label: 'Cinematic',
    summary: 'A film still. Moody, atmospheric, for a hero banner.',
    phrase: 'Style: a cinematic film still. Shallow depth of field, dramatic '
      + 'directional light with deep shadow, a muted filmic colour grade, '
      + 'the subject placed off-centre with room around it.',
  },

  illustration: {
    ref: 'illustration',
    label: 'Illustration',
    summary: 'Hand-drawn and warm. Blog headers, explainers, storybooks.',
    phrase: 'Style: a digital illustration. Hand-drawn character, confident '
      + 'linework, flat shading, a limited warm colour palette, a simple '
      + 'background that stays behind the subject.',
  },

  vector: {
    ref: 'vector',
    label: 'Flat vector graphic',
    summary: 'Clean shapes and solid colour. Slides, icons, menu boards.',
    phrase: 'Style: a flat vector graphic. Simple geometric shapes, bold solid '
      + 'colours, no gradients and no texture, crisp clean edges, generous '
      + 'empty space around the subject.',
  },

  render3d: {
    ref: 'render3d',
    label: '3D render',
    summary: 'Soft, rounded, modern. App screens, product concepts, mascots.',
    phrase: 'Style: a soft 3D render. Smooth rounded surfaces, matte materials, '
      + 'gentle studio lighting with soft ambient shadow, a plain pastel '
      + 'backdrop, an isometric or three-quarter view.',
  },

  watercolour: {
    ref: 'watercolour',
    label: 'Watercolour',
    summary: 'Soft and painterly. Invitations, cards, gentle branding.',
    phrase: 'Style: a watercolour painting. Visible paper texture, soft bleeding '
      + 'washes of colour, loose unfinished edges, generous white space, a '
      + 'light delicate touch.',
  },

  line: {
    ref: 'line',
    label: 'Line art',
    summary: 'Black ink on white. Colouring pages, diagrams, stamps, logos.',
    phrase: 'Style: black-and-white line art. Clean even ink strokes on a plain '
      + 'white background, no shading, no colour fill, no gradient — outline '
      + 'and negative space only.',
  },

  anime: {
    ref: 'anime',
    label: 'Anime',
    summary: 'Japanese animation look. Characters, mascots, youth campaigns.',
    phrase: 'Style: anime illustration. Cel shading, crisp dark outlines, '
      + 'expressive features, vivid saturated colour, a simple painted '
      + 'background.',
  },

  poster: {
    ref: 'poster',
    label: 'Poster graphic',
    summary: 'Bold and loud, with space for a headline. Promos, events.',
    phrase: 'Style: a bold promotional poster graphic. Strong graphic shapes, '
      + 'high-contrast colour blocking, one focal subject, and a clear empty '
      + 'band of background where a headline can sit.',
  },

  minimal: {
    ref: 'minimal',
    label: 'Minimal',
    summary: 'One thing, lots of space. Backgrounds, covers, calm branding.',
    phrase: 'Style: minimal. A single simple subject on a large plain '
      + 'background, a very limited colour palette, generous negative space, '
      + 'nothing decorative anywhere in the frame.',
  },
});

/** The ref used when a request names no style. Adds nothing. */
const DEFAULT_STYLE = 'none';

/** The legal refs, derived from the object above and never re-listed. */
function allowedRefs() {
  return Object.keys(STYLES);
}

/**
 * The whole catalogue, phrases included, in picker order.
 *
 * The phrase is PUBLISHED on purpose — see the header. A UI that cannot show
 * the sentence it is about to append cannot honestly claim the user read what
 * was sent, and a UI that has to hard-code the sentence to show it is a
 * second copy of this file waiting to drift.
 */
function catalogue() {
  return allowedRefs().map((ref) => {
    const s = STYLES[ref];
    return { ref: s.ref, label: s.label, summary: s.summary, phrase: s.phrase };
  });
}

/**
 * Resolve a caller-supplied style ref.
 *
 * DELIBERATELY NOT FORGIVING, for the same reason ../sizes.js is not: an
 * unrecognised ref is a bug in whatever built the request — a stale preset, a
 * typo, a UI that shipped a kind the server does not have — and quietly
 * generating without it would leave that bug producing wrong-looking images
 * forever. Refuse, name the legal set, and cost nothing: this runs before the
 * provider call, so nothing is charged.
 *
 * @returns {{ok: true, ref: string|null, phrase: string|null}
 *          |{ok: false, code: string, message: string, allowed: string[]}}
 */
function resolve(requested) {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, ref: null, phrase: null };
  }
  if (typeof requested !== 'string') {
    return {
      ok: false,
      code: 'unknown_style',
      message: 'style must be one of ' + allowedRefs().join(', ') + '.',
      allowed: allowedRefs(),
    };
  }
  const ref = requested.trim();
  if (!Object.prototype.hasOwnProperty.call(STYLES, ref)) {
    return {
      ok: false,
      code: 'unknown_style',
      message: `"${ref}" is not a style this platform offers. `
        + `Allowed: ${allowedRefs().join(', ')}. `
        + 'Nothing was sent and nothing was charged.',
      allowed: allowedRefs(),
    };
  }
  return { ok: true, ref, phrase: STYLES[ref].phrase };
}

/**
 * Append the chosen kind's art direction to the user's prompt.
 *
 * WITH NO STYLE, OR WITH `none`, THE RETURN VALUE IS THE PROMPT UNCHANGED.
 * Byte-identical — not "unchanged apart from a trailing space".
 *
 * The separator is a blank line, matching ../brand.js, so a prompt carrying
 * both reads as three paragraphs: what the user asked for, how it should
 * look, and whose brand it is.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {*}      input.styleRef   the raw request value
 * @returns {{ok: true, prompt: string, styleRef: string|null, appended: string|null}
 *          |{ok: false, code: string, message: string, allowed: string[]}}
 */
function compose({ prompt, styleRef }) {
  const basePrompt = String(prompt);
  const r = resolve(styleRef);
  if (!r.ok) return r;
  if (!r.phrase) {
    return { ok: true, prompt: basePrompt, styleRef: r.ref, appended: null };
  }
  return {
    ok: true,
    prompt: basePrompt + '\n\n' + r.phrase,
    styleRef: r.ref,
    appended: r.phrase,
  };
}

module.exports = { STYLES, DEFAULT_STYLE, allowedRefs, catalogue, resolve, compose };

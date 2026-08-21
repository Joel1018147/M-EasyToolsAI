/* ═══════════════════════════════════════════════════════════════════════════
   BRAND ASSETS — travel only on an explicit, per-request opt-in
   ───────────────────────────────────────────────────────────────────────────
   ── THE RULE ──────────────────────────────────────────────────────────────
   A user's brand material is NEVER sent to the image API as prompt content
   unless the user explicitly initiated that specific action. Not "unless they
   opted out". Not "unless a setting says no". The default is that it does not
   travel, and the only thing that changes that is a flag on THE REQUEST THAT
   SENDS IT — because that is the moment the user chose.

   `image_generations.used_brand_asset` and `.brand_asset_ref` exist to RECORD
   that choice, so "did we send this customer's brand copy to Alibaba?" is a
   query with an answer, not an argument.

   ── WHY THIS FILE EXISTS RATHER THAN AN `if` IN THE ROUTE ─────────────────
   Because the failure mode is a SIDE EFFECT, and side effects are added by
   people who are not thinking about this rule at all.

   The tempting edit is one line, and it is already precedented in this repo:
   helpers/generation.js builds its system prompt as

       `… Brand: ${user.brand_desc || 'General marketing'} …`

   — that is text generation folding the brand description in automatically,
   for every call, with no opt-in anywhere. It is the correct behaviour there
   (the copy is FOR that brand, and it never leaves the Groq call that
   produced the user's own text). Copying the pattern here would silently ship
   the user's brand description to a third-party image vendor on every
   generation. So the composition of the outgoing prompt is done HERE, in one
   function, whose entire job is to refuse to add anything the caller did not
   ask for.

   ── AND LANE B ────────────────────────────────────────────────────────────
   Lane B is landing `docintel_documents` — uploaded customer files, held as
   BYTEA with an `extracted_text` column. Those bytes must never be auto-fed
   into an image prompt. There is no code path here that reads that table, and
   there cannot be one by accident: the allowlist below is derived from the
   `users` row's own brand columns, and a ref naming anything else is refused
   with `unknown_brand_asset` rather than resolved. A future "use my uploaded
   logo" feature is a deliberate addition to ALLOWED_ASSETS plus a test, not
   an emergent behaviour.

   ── WHAT COUNTS AS AN OPT-IN ──────────────────────────────────────────────
   Strictly `use_brand_asset === true` (the boolean, not "true", not 1, not
   any truthy value) AND a `brand_asset_ref` naming an asset that exists on
   THIS user's row. A string "false" is truthy in JavaScript, and a form that
   posts checkbox state as text is not an unusual thing to meet.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/**
 * The only brand assets this platform actually holds, as columns on `users`
 * (server.js:82-84). Each entry says which column it reads and how the value
 * is phrased when it is appended — so the composed prompt is auditable.
 *
 * `docintel_documents`, `documents`, and every other table are absent, and
 * their absence is the enforcement.
 */
const ALLOWED_ASSETS = Object.freeze({
  brand_name: {
    ref: 'brand_name',
    column: 'brand_name',
    label: 'Brand name',
    phrase: (v) => `The brand is "${v}".`,
  },
  brand_desc: {
    ref: 'brand_desc',
    column: 'brand_desc',
    label: 'Brand description',
    phrase: (v) => `Brand context: ${v}`,
  },
  brand_tone: {
    ref: 'brand_tone',
    column: 'brand_tone',
    label: 'Brand tone',
    phrase: (v) => `Visual tone: ${v}.`,
  },
});

/** The legal refs, derived from the object above and never re-listed. */
function allowedRefs() {
  return Object.keys(ALLOWED_ASSETS);
}

/** Strict boolean true. Nothing else. See the header. */
function isExplicitOptIn(value) {
  return value === true;
}

/**
 * Compose the prompt that will actually be sent to the provider.
 *
 * WITHOUT AN OPT-IN THE RETURN VALUE IS THE USER'S PROMPT, UNCHANGED. Not
 * "mostly unchanged", not "with a small style hint appended". Byte-identical.
 * test/image-contract.js asserts exactly that, for a user row whose brand
 * columns are all populated — a user with no brand data would pass a broken
 * implementation.
 *
 * @param {object} input
 * @param {string} input.prompt              the user's prompt
 * @param {object} input.user                the `users` row
 * @param {*}      input.useBrandAsset       the raw request flag
 * @param {*}      input.brandAssetRef       the raw request ref
 * @returns {{ok: true, prompt: string, usedBrandAsset: boolean, brandAssetRef: string|null, appended: string|null}
 *          |{ok: false, code: string, message: string, allowed: string[]}}
 */
function compose({ prompt, user, useBrandAsset, brandAssetRef }) {
  const basePrompt = String(prompt);

  // ── The default path. No opt-in, nothing added, nothing recorded. ────────
  if (!isExplicitOptIn(useBrandAsset)) {
    // A ref without the flag is a refusal, not a quiet opt-in. A client that
    // sends a ref and forgets the flag has a bug, and answering it with a
    // silent "we ignored that" hides the bug in the direction that matters
    // least — but answering it by USING the ref hides it in the direction
    // that matters most. Neither: say so.
    if (brandAssetRef !== undefined && brandAssetRef !== null && brandAssetRef !== '') {
      return {
        ok: false,
        code: 'brand_asset_not_opted_in',
        message: 'brand_asset_ref was supplied without use_brand_asset:true. ' +
                 'Brand material is only sent to the image provider when the user explicitly initiates it, ' +
                 'so this request was refused rather than silently sent either way.',
        allowed: allowedRefs(),
      };
    }
    return {
      ok: true,
      prompt: basePrompt,
      usedBrandAsset: false,
      brandAssetRef: null,
      appended: null,
    };
  }

  // ── The opt-in path. ─────────────────────────────────────────────────────
  if (typeof brandAssetRef !== 'string' || brandAssetRef.trim() === '') {
    return {
      ok: false,
      code: 'brand_asset_ref_required',
      message: 'use_brand_asset:true requires brand_asset_ref naming which asset to send. ' +
               'There is no "send all my brand data" option, by design.',
      allowed: allowedRefs(),
    };
  }

  const ref = brandAssetRef.trim();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_ASSETS, ref)) {
    return {
      ok: false,
      code: 'unknown_brand_asset',
      message: `"${ref}" is not a brand asset this platform can send. ` +
               `Allowed: ${allowedRefs().join(', ')}. ` +
               'Uploaded documents are deliberately not addressable here.',
      allowed: allowedRefs(),
    };
  }

  const asset = ALLOWED_ASSETS[ref];
  const raw = user ? user[asset.column] : null;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      code: 'brand_asset_empty',
      message: `${asset.label} is not set on this account, so there is nothing to send. ` +
               'Set it in the workspace before opting in.',
      allowed: allowedRefs(),
    };
  }

  const appended = asset.phrase(raw.trim());
  return {
    ok: true,
    prompt: basePrompt + '\n\n' + appended,
    usedBrandAsset: true,
    brandAssetRef: ref,
    appended,
  };
}

module.exports = { ALLOWED_ASSETS, allowedRefs, isExplicitOptIn, compose };

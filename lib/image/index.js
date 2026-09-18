/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE SERVICE — the order of operations, and why it is that order
   ───────────────────────────────────────────────────────────────────────────
   routes/images.js does HTTP. This does the work. The route can be replaced
   without re-deriving any of the rules below, and the rules can be tested
   without an HTTP server.

   ── THE PIPELINE, IN ORDER, WITH THE REASON FOR EACH POSITION ─────────────

     1  validate the prompt        cheapest possible refusal
     2  resolve the size LOCALLY   via the ACTIVE PROVIDER's own resolveSize()
                                   (../provider.js) — DashScope's
                                   `1328*1328` and nanobanana's `16:9` are
                                   different vocabularies, so which module
                                   validates `size` depends on which provider
                                   is actually selected. A size illegal for
                                   the active provider is rejected HERE, not
                                   by paying for a vendor 400
     3  capability check           provider.isConfigured() — has() semantics,
                                   e.g. FAL_API_KEY for the current default —
                                   a deployment that never configured images
                                   says so honestly instead of failing on
                                   click
     4  compose the prompt         ./styles.js then ./brand.js, in that order.
                                   The style is the KIND the user picked, and
                                   its sentences are PUBLISHED through
                                   options() so the panel can print exactly
                                   what will be sent. Brand material travels
                                   only on an explicit per-request opt-in.
                                   These two are the ONLY places the outgoing
                                   prompt is built, so there is no path that
                                   folds brand data in as a side effect — and
                                   with neither named, the prompt is
                                   byte-identical to what the user typed
     5  MODERATE                   ./moderation.js, over the composed prompt
                                   AND the negative prompt AND anything the
                                   opt-in appended. Refuse before spending
     6  CAP CHECK                  ./caps.js. BEFORE the provider call. A cap
                                   checked afterwards is an invoice, not a cap
     7  insert 'pending'           BEFORE the call, so a crash mid-flight
                                   leaves evidence — and ./caps.js counts
                                   'pending' as billable for exactly that
                                   reason
     8  provider.generate()        synchronous, a few seconds. NO QUEUE, NO
                                   setTimeout — the Engineering Bar forbids
                                   scheduling and this repo has no job runner
     9  rehost.download()          the URL EXPIRES. The bytes come home in
                                   this same request
    10  markStored()               ONE UPDATE writes the bytes AND
                                   status='stored'. There is no statement in
                                   this file that sets 'stored' without also
                                   setting content, so a row can never be
                                   readable while pointing at an expiring URL

   Steps 5 and 6 are both before 8, which is what "refuse before spending"
   and "caps enforced before the provider call" mean concretely. Moderation
   runs before the cap so a prohibited prompt does not consume budget it was
   never going to be allowed to use.

   ── source_url IS AUDIT ONLY ──────────────────────────────────────────────
   It is written, because "what URL did the vendor give us" is a real audit
   question. It is never returned. `PUBLIC_COLUMNS` below is the explicit
   allowlist every response is built from, and it does not contain it. An
   allowlist rather than a delete-the-field-afterwards, because a field
   removed by hand is a field that comes back the next time somebody adds a
   `SELECT *`.

   ── DEPENDENCY INJECTION, NOT A MODULE-SCOPE CLIENT ───────────────────────
   `createImageService({ pool, ... })`. Nothing here requires ../../db, reads
   an environment variable at import time, or constructs a provider until a
   request asks for one (recurring-bugs #1). It is also what lets
   test/image-contract.js run the REAL code against a fake pool and a fake
   fetch, with no database and no paid API call — recurring-bugs #21, a suite
   that reads source as text and never executes it.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const providerRegistry = require('./provider');
const sizes = require('./sizes');
const styles = require('./styles');
const moderation = require('./moderation');
const brand = require('./brand');
const caps = require('./caps');
const rehost = require('./rehost');
const { normaliseLang } = require('../../helpers/lang');

/** Long enough for a detailed art direction, short enough to be a prompt. */
const MAX_PROMPT_CHARS = 2000;
const MAX_NEGATIVE_PROMPT_CHARS = 500;

/**
 * THE ALLOWLIST EVERY RESPONSE IS BUILT FROM.
 *
 * `source_url` and `source_url_expires_at` are absent on purpose: they are
 * audit columns for an address that expires, and handing one to a client is
 * how it ends up saved into a document. `content` is absent because it is
 * megabytes of BYTEA — it is served by its own route.
 */
const PUBLIC_COLUMNS = Object.freeze([
  'id', 'user_id', 'team_id', 'prompt', 'negative_prompt', 'lang',
  'provider', 'model', 'size', 'content_type', 'byte_size', 'sha256',
  'status', 'error_text', 'moderation_status', 'moderation_reason',
  'style', 'used_brand_asset', 'brand_asset_ref', 'created_at',
]);

/** The SELECT list, derived from the allowlist. No `SELECT *` anywhere. */
const PUBLIC_SELECT = PUBLIC_COLUMNS.join(', ');

/** Terminal statuses a row can hold. Mirrors migration 004's comment. */
const STATUSES = Object.freeze(['pending', 'stored', 'rehost_failed', 'refused', 'failed']);

/** UUID v4-ish shape. Checked before any query, so a bad id is a 404, not a PG 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * A service error carrying the HTTP status the route should use. The route
 * maps, it does not decide — so the policy lives with the rule that made it.
 */
function serviceError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.httpStatus = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** The public shape of a row. Never includes source_url. */
function present(row, options = {}) {
  if (!row) return null;
  const out = {};
  for (const col of PUBLIC_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = row[col];
  }
  // The ONLY address a caller ever gets: this platform's own, owner-scoped,
  // and serving bytes we hold. Present only once the bytes actually exist.
  out.url = row.status === 'stored' ? `/api/images/${row.id}/file` : null;
  if (options.usage) out.usage = options.usage;
  return out;
}

/**
 * @param {object}   deps
 * @param {object}   deps.pool          pg Pool — injected, never imported here
 * @param {string}   [deps.providerName]
 * @param {object}   [deps.provider]    a pre-built provider (tests)
 * @param {function} [deps.fetchImpl]   injected fetch (tests)
 */
function createImageService(deps) {
  const pool = deps && deps.pool;
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createImageService requires a pg Pool with .query()');
  }

  /**
   * Build the provider LAZILY, per call. `deps.provider` lets a test supply a
   * fake without monkey-patching a module; production passes nothing and gets
   * a fresh client whose environment is read now, not at require() time.
   */
  function getProvider() {
    if (deps.provider) return deps.provider;
    return providerRegistry.get(deps.providerName, { fetchImpl: deps.fetchImpl });
  }

  /** Insert the pending row. Parameterized; every column named explicitly. */
  async function insertPending(fields) {
    const { rows } = await pool.query(
      `INSERT INTO image_generations
         (user_id, team_id, prompt, negative_prompt, lang, provider, model, size,
          status, moderation_status, moderation_reason, used_brand_asset, brand_asset_ref,
          style)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${PUBLIC_SELECT}`,
      [
        fields.userId, fields.teamId, fields.prompt, fields.negativePrompt, fields.lang,
        fields.provider, fields.model, fields.size,
        fields.status, fields.moderationStatus, fields.moderationReason,
        fields.usedBrandAsset, fields.brandAssetRef,
        fields.style,
      ]
    );
    return rows[0];
  }

  /**
   * THE ONE STATEMENT THAT MAY SET status='stored'.
   *
   * It writes `content` in the same UPDATE. That is the structural guarantee
   * that re-hosting happened before the row became usable: there is no
   * statement anywhere in this lane that sets 'stored' on its own, so no
   * ordering mistake in a later edit can produce a 'stored' row holding no
   * bytes. test/image-contract.js asserts this by scanning the file for the
   * literal and by driving the real code with a failing download.
   */
  async function markStored(id, userId, bytes, source) {
    const { rows } = await pool.query(
      `UPDATE image_generations
          SET content = $1,
              content_type = $2,
              byte_size = $3,
              sha256 = $4,
              source_url = $5,
              source_url_expires_at = $6,
              provider_request_id = $7,
              status = 'stored'
        WHERE id = $8 AND user_id = $9
        RETURNING ${PUBLIC_SELECT}`,
      [
        bytes.content, bytes.contentType, bytes.byteSize, bytes.sha256,
        source.url, source.expiresAt, source.requestId,
        id, userId,
      ]
    );
    return rows[0];
  }

  /** Terminal failure. Records source_url when there was one, for audit. */
  async function markFailed(id, userId, status, errorText, source) {
    const { rows } = await pool.query(
      `UPDATE image_generations
          SET status = $1,
              error_text = $2,
              source_url = $3,
              source_url_expires_at = $4,
              provider_request_id = $5
        WHERE id = $6 AND user_id = $7
        RETURNING ${PUBLIC_SELECT}`,
      [
        status,
        String(errorText || '').slice(0, 2000),
        source ? source.url : null,
        source ? source.expiresAt : null,
        source ? source.requestId : null,
        id, userId,
      ]
    );
    return rows[0];
  }

  /** A refusal that never reached the provider. Recorded, not silently dropped. */
  async function recordRefusal(fields, verdict) {
    return insertPending({
      ...fields,
      status: 'refused',
      moderationStatus: 'refused',
      moderationReason: verdict.reason,
    });
  }

  return {
    PUBLIC_COLUMNS,
    STATUSES,

    /** Exposed so a diagnostics surface can report the real capability. */
    isConfigured() {
      return getProvider().isConfigured();
    },

    /** Everything a UI needs to render the controls, with no generation. */
    options() {
      const p = getProvider();
      return {
        provider: p.name,
        configured: p.isConfigured(),
        missing: p.missingVars(),
        model: p.model(),
        // Delegated to the ACTIVE provider, not a hardcoded module — see
        // ../provider.js's interface doc, sizeCatalogue(). Before 2026-09-18
        // this was the shared ./sizes.js (DashScope's own catalogue) even
        // when a different provider was selected, which was silently wrong
        // the day a second provider with a different size vocabulary shipped.
        sizes: p.sizeCatalogue(),
        defaultSize: p.defaultSize(),
        brandAssets: brand.allowedRefs(),
        // The full catalogue, PHRASES INCLUDED. A picker that cannot show the
        // sentence it is about to append cannot claim the user read what was
        // sent — and one that hard-codes the sentence to show it is a second
        // copy of ./styles.js waiting to drift.
        styles: styles.catalogue(),
        defaultStyle: styles.DEFAULT_STYLE,
        maxPromptChars: MAX_PROMPT_CHARS,
        maxNegativePromptChars: MAX_NEGATIVE_PROMPT_CHARS,
      };
    },

    /** The cap state for this user, without generating anything. */
    async usage(user, subscription) {
      const state = await caps.check(pool, user, subscription);
      return {
        tier: state.tier.key,
        tierLabel: state.tier.label,
        tierFrom: state.from,
        limits: state.limits,
        used: state.usage,
        remaining: state.remaining,
        countedStatuses: state.countedStatuses,
        windows: { day: caps.WINDOWS.day.label, month: caps.WINDOWS.month.label },
      };
    },

    /**
     * Generate one image, end to end, in this request.
     *
     * @param {object} ctx
     * @param {object} ctx.user           the `users` row (req.user)
     * @param {object} ctx.subscription   req.subscription, or null
     * @param {object} ctx.input          the request body
     */
    async generate({ user, subscription, input }) {
      const body = input || {};

      /* ── 1. prompt ──────────────────────────────────────────────────── */
      const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (rawPrompt === '') {
        throw serviceError(400, 'prompt_required', 'A prompt is required.');
      }
      if (rawPrompt.length > MAX_PROMPT_CHARS) {
        throw serviceError(400, 'prompt_too_long',
          `The prompt is ${rawPrompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.`);
      }

      const rawNegative = typeof body.negative_prompt === 'string' ? body.negative_prompt.trim() : '';
      if (rawNegative.length > MAX_NEGATIVE_PROMPT_CHARS) {
        throw serviceError(400, 'negative_prompt_too_long',
          `The negative prompt is ${rawNegative.length} characters; the limit is ${MAX_NEGATIVE_PROMPT_CHARS}.`);
      }

      /* ── 2/3. resolve the ACTIVE provider, then ITS legal size set ─────
         The provider object is constructed here (cheap — recurring-bugs #1
         means this never touches the environment until isConfigured()/
         generate() actually reads it), so step 2's size validation can ask
         the provider that will actually run rather than a hardcoded module.
         DashScope's `1328*1328` and nanobanana's `16:9` are different
         vocabularies; validating against the wrong one would reject every
         legal request or accept an illegal one depending on which way the
         mismatch ran. `1024*1024`-shaped mistakes are still rejected HERE,
         not by paying for a vendor 400 — that guarantee just now belongs to
         the provider instead of to this file. */
      const provider = getProvider();
      const sizeResult = provider.resolveSize(body.size);
      if (!sizeResult.ok) {
        throw serviceError(400, sizeResult.code, sizeResult.message, { legal: sizeResult.legal });
      }

      /* ── 3. is this deployment configured at all ─────────────────────── */
      if (!provider.isConfigured()) {
        throw serviceError(503, 'image_generation_unavailable',
          'Image generation is not configured on this deployment. ' +
          'Text generation is unaffected.',
          { missing: provider.missingVars() });
      }

      /* ── 4. compose — the ONLY place anything joins the user's prompt ─
         TWO steps, both explicit, both refusing to add anything the caller
         did not name:

           a. ./styles.js  the KIND the user picked. Its sentences are
                           PUBLISHED through options() and printed by the
                           panel before sending, so appending one does not
                           break "the prompt you read is the prompt we send".
           b. ./brand.js   the user's own brand material, and still the ONLY
                           place that can enter a prompt — per-request opt-in,
                           never a side effect of having filled in a profile.

         With neither, `composed.prompt` is the user's prompt byte-identical.
         The order is deliberate: what it is, then how it looks, then whose it
         is, which is how the finished prompt reads. */
      const styled = styles.compose({ prompt: rawPrompt, styleRef: body.style });
      if (!styled.ok) {
        /* An unrecognised ref is a stale preset or a typo in whatever built
           the request, and generating without it would leave that bug
           producing wrong-looking images indefinitely. Refused HERE and not
           earlier beside the size check: one refusal in one place, and this
           one is still ahead of moderation, the cap and the provider call, so
           nothing was charged. A second copy up at step 2 would be an
           unreachable branch that looks like a guard. */
        throw serviceError(400, styled.code, styled.message, { allowed: styled.allowed });
      }

      const composed = brand.compose({
        prompt: styled.prompt,
        user,
        useBrandAsset: body.use_brand_asset,
        brandAssetRef: body.brand_asset_ref,
      });
      if (!composed.ok) {
        throw serviceError(400, composed.code, composed.message, { allowed: composed.allowed });
      }

      const lang = normaliseLang(body.lang);

      const baseFields = {
        userId: user.id,
        teamId: user.team_id || null,
        // The prompt STORED is the prompt SENT, including anything the opt-in
        // appended. An audit row that records a different prompt from the one
        // that produced the image describes something that did not happen.
        prompt: composed.prompt,
        negativePrompt: rawNegative || null,
        lang,
        provider: provider.name,
        model: provider.model(),
        size: sizeResult.size,
        // WHICH kind was picked, recorded beside the prompt it shaped — so
        // "what art direction did we add to this image" is a query rather
        // than a substring search over free text.
        style: styled.styleRef,
        usedBrandAsset: composed.usedBrandAsset,
        brandAssetRef: composed.brandAssetRef,
      };

      /* ── 5. moderate — every piece that would leave the process ──────── */
      const verdict = moderation.screen([
        { field: 'prompt', text: composed.prompt },
        { field: 'negative_prompt', text: rawNegative },
      ]);
      if (verdict.status === 'refused') {
        const row = await recordRefusal(baseFields, verdict);
        throw serviceError(422, 'moderation_refused', verdict.reason, {
          category: verdict.category,
          field: verdict.field,
          image: present(row),
        });
      }

      /* ── 6. caps — BEFORE the provider call ──────────────────────────── */
      const capState = await caps.check(pool, user, subscription);
      if (!capState.allowed) {
        const e = capState.exceeded;
        throw serviceError(429, 'image_cap_exceeded',
          `Your ${capState.tier.label} plan allows ${e.limit} image generations in ${e.windowLabel}, ` +
          `and ${e.used} have been used. This limit is checked before the request is sent, so nothing was charged.`,
          {
            tier: capState.tier.key,
            tierLabel: capState.tier.label,
            window: e.window,
            windowLabel: e.windowLabel,
            limit: e.limit,
            used: e.used,
            limits: capState.limits,
            usage: capState.usage,
            countedStatuses: capState.countedStatuses,
          });
      }

      /* ── 7. the pending row, written before the money is spent ───────── */
      const pending = await insertPending({
        ...baseFields,
        status: 'pending',
        moderationStatus: 'allowed',
        moderationReason: null,
      });

      /* ── 8. the provider call — synchronous, no queue, no timer ───────── */
      let generated;
      try {
        generated = await provider.generate({
          prompt: composed.prompt,
          negativePrompt: rawNegative || null,
          size: sizeResult.size,
          n: 1,
        });
      } catch (err) {
        // The row is closed out either way. `billed` decides which status,
        // and therefore whether it consumes budget.
        const status = err.billed ? 'rehost_failed' : 'failed';
        await markFailed(pending.id, user.id, status, err.message, null);
        throw serviceError(502, 'provider_failed', err.message, {
          provider: provider.name,
          providerStatus: err.providerStatus || null,
          billed: Boolean(err.billed),
          imageId: pending.id,
        });
      }

      /* ── 9. RE-HOST. The URL expires; the bytes come home now. ─────────── */
      const source = {
        url: generated.url,
        expiresAt: generated.expiresAt,
        requestId: generated.requestId,
      };

      let bytes;
      try {
        bytes = await rehost.download(generated.url, { fetchImpl: deps.fetchImpl });
      } catch (err) {
        // 'rehost_failed', NOT 'failed': the provider generated the image and
        // billed for it. ./caps.js counts this status for exactly that reason.
        // source_url is written here for audit — it is the only evidence of
        // what we were handed — and it is still never rendered to a user.
        await markFailed(pending.id, user.id, 'rehost_failed', err.message, source);
        throw serviceError(502, 'rehost_failed',
          'The image was generated but could not be downloaded and stored, so it has not been kept. ' +
          "The provider's own link expires, so it is not returned. " + err.message,
          { imageId: pending.id, billed: true });
      }

      /* ── 10. bytes and status='stored' in ONE statement ───────────────── */
      const stored = await markStored(pending.id, user.id, bytes, source);
      if (!stored) {
        throw serviceError(500, 'store_failed',
          'The image was generated and downloaded but the row could not be updated.',
          { imageId: pending.id });
      }

      return present(stored, {
        usage: {
          tier: capState.tier.key,
          limits: capState.limits,
          used: { day: capState.usage.day + 1, month: capState.usage.month + 1 },
          remaining: {
            day: Math.max(0, capState.remaining.day - 1),
            month: Math.max(0, capState.remaining.month - 1),
          },
        },
      });
    },

    /** Owner-scoped list. Explicit column list; no source_url, no content. */
    async list(userId, { limit = 30, offset = 0 } = {}) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
      const safeOffset = Math.max(0, Number(offset) || 0);
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_SELECT}
           FROM image_generations
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [userId, safeLimit, safeOffset]
      );
      return rows.map((r) => present(r));
    },

    /** Owner-scoped metadata for one row. */
    async get(userId, id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_SELECT} FROM image_generations WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return rows[0] ? present(rows[0]) : null;
    },

    /**
     * The bytes. Owner-scoped AND status-scoped.
     *
     * `status = 'stored'` in the WHERE clause is the second half of the
     * re-hosting guarantee: even if a 'stored' row with NULL content could
     * somehow exist, and even if a 'pending' row held bytes, this route can
     * only ever serve a row that completed the whole pipeline.
     */
    async file(userId, id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `SELECT id, content, content_type, byte_size, sha256
           FROM image_generations
          WHERE id = $1 AND user_id = $2 AND status = 'stored'`,
        [id, userId]
      );
      const row = rows[0];
      if (!row || !row.content) return null;
      return row;
    },

    /** Owner-scoped delete. Returns true when a row was actually removed. */
    async remove(userId, id) {
      if (!isUuid(id)) return false;
      const result = await pool.query(
        'DELETE FROM image_generations WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      return (result.rowCount || 0) > 0;
    },
  };
}

module.exports = {
  createImageService,
  PUBLIC_COLUMNS,
  STATUSES,
  MAX_PROMPT_CHARS,
  MAX_NEGATIVE_PROMPT_CHARS,
  isUuid,
  present,
  sizes,
  moderation,
  brand,
  styles,
  caps,
  rehost,
  provider: providerRegistry,
};

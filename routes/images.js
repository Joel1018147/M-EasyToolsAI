/* ═══════════════════════════════════════════════════════════════════════════
   IMAGE GENERATION — LANE D
   ───────────────────────────────────────────────────────────────────────────
   Mounted by Foundation as:

       app.use('/api/images', requireAuth, checkSub, require('./routes/images'))

   so `req.user` is a real `users` row (passport deserialises it fresh from
   the database on every request, server.js:304) and `req.subscription` is
   whatever middleware/checkSub.js resolved. Neither is re-derived here.

   ── THIS FILE DOES HTTP AND NOTHING ELSE ──────────────────────────────────
   Every rule — the legal size set, the moderation verdict, the budget cap,
   the brand-asset opt-in, the re-hosting — lives in lib/image/. The word
   "DashScope" does not appear below, which is the test of whether the
   provider abstraction is real: a second vendor is a new file in
   lib/image/providers/ and one line in lib/image/provider.js, with no change
   here.

   ── THE SERVICE IS BUILT PER REQUEST, NOT AT IMPORT ───────────────────────
   recurring-bugs #1. A module-scope client captures the environment as it was
   the instant this file was first required — which on Railway is before a
   later deploy's variables exist, and in a test harness is before the harness
   has set anything. `serviceFor(req)` constructs on every call; the objects
   involved are plain and the allocation is not measurable next to a 3.6-second
   provider round trip.

   ── NO setTimeout, NO QUEUE, ANYWHERE IN THIS LANE ────────────────────────
   The Engineering Bar forbids scheduling and this repo has no job runner.
   DashScope's SYNCHRONOUS API was chosen for that reason (UPGRADE-SPEC §0.9),
   so generation and re-hosting both complete inside the request. The two
   network timeouts in lib/image use `AbortSignal.timeout` (a Node 20 global),
   not an AbortController armed with a timer.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const { pool } = require('../db');
const { createImageService } = require('../lib/image');

const router = express.Router();

/**
 * Build the service for this request.
 *
 * `req.app.locals.imageService` is the injection seam test/image-contract.js
 * uses to drive the REAL router with a fake pool and a fake fetch — no
 * database, no paid API call, and no string-matching-instead-of-executing
 * (recurring-bugs #21). Production never sets it, so production always gets
 * a service built here, now, around the real pool.
 */
function serviceFor(req) {
  const injected = req.app && req.app.locals && req.app.locals.imageService;
  if (injected) return injected;
  return createImageService({ pool });
}

/**
 * One error mapper. lib/image decides the status and the code; this turns it
 * into a body. An error with no `httpStatus` is an unexpected one and gets a
 * 500 with a logged stack — never a 200 with an empty result, which is the
 * shape RULE 6 exists to prevent.
 */
function sendError(res, err, where) {
  if (err && Number.isFinite(err.httpStatus)) {
    const body = { ok: false, error: err.code, message: err.message };
    for (const key of ['legal', 'allowed', 'missing', 'category', 'field', 'tier', 'tierLabel',
                       'window', 'windowLabel', 'limit', 'used', 'limits', 'usage',
                       'countedStatuses', 'provider', 'providerStatus', 'billed',
                       'imageId', 'image']) {
      if (err[key] !== undefined) body[key] = err[key];
    }
    return res.status(err.httpStatus).json(body);
  }
  console.error(`routes/images.js ${where}:`, err);
  return res.status(500).json({
    ok: false,
    error: 'internal_error',
    message: 'The image request failed unexpectedly. The failure was logged.',
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/images/options
   What a UI needs to render the controls: the legal sizes (from the one
   source of truth), the model, whether this deployment is configured at all,
   and which brand assets can be explicitly opted into.
   ───────────────────────────────────────────────────────────────────────── */
router.get('/options', (req, res) => {
  try {
    res.json({ ok: true, ...serviceFor(req).options() });
  } catch (err) {
    sendError(res, err, 'GET /options');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/images/usage
   The caller's own cap state. Declared BEFORE /:id so "usage" is never read
   as an id — and /:id rejects a non-UUID anyway, so the two guards agree.
   ───────────────────────────────────────────────────────────────────────── */
router.get('/usage', async (req, res) => {
  try {
    const usage = await serviceFor(req).usage(req.user, req.subscription);
    res.json({ ok: true, ...usage });
  } catch (err) {
    sendError(res, err, 'GET /usage');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/images/generate

   Body:
     prompt            required, ≤2000 chars
     negative_prompt   optional, ≤500 chars
     size              optional; one of lib/image/sizes.js's five legal values
                       — 1024*1024 IS REJECTED, locally, before any spend
     lang              optional 'en' | 'ms' | 'zh'
     use_brand_asset   optional; strictly boolean true to opt in
     brand_asset_ref   required when use_brand_asset is true

   The response never carries the provider's URL. `url` is this platform's
   own /api/images/:id/file, and it is non-null only once the bytes are
   stored.
   ───────────────────────────────────────────────────────────────────────── */
router.post('/generate', async (req, res) => {
  try {
    const image = await serviceFor(req).generate({
      user: req.user,
      subscription: req.subscription,
      input: req.body,
    });
    res.status(201).json({ ok: true, image });
  } catch (err) {
    sendError(res, err, 'POST /generate');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/images
   Owner-scoped list, newest first.
   ───────────────────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const images = await serviceFor(req).list(req.user.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ ok: true, images });
  } catch (err) {
    sendError(res, err, 'GET /');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/images/:id/file — THE BYTES

   Owner-scoped and status-scoped: lib/image's `file()` filters on
   `user_id = $2 AND status = 'stored'`, so another account's image is a 404
   and a row that never completed re-hosting cannot be served at all.

   X-Content-Type-Options: nosniff, with a content_type that came from the
   MAGIC BYTES rather than from the provider's header. Both halves matter —
   nosniff tells the browser to trust the declared type, so the declared type
   has to be one we verified ourselves.
   ───────────────────────────────────────────────────────────────────────── */
router.get('/:id/file', async (req, res) => {
  try {
    const row = await serviceFor(req).file(req.user.id, req.params.id);
    if (!row) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: 'No stored image with that id belongs to this account.',
      });
    }
    res.setHeader('Content-Type', row.content_type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(row.byte_size || row.content.length));
    // Private: this is one account's asset, served from an authenticated
    // route. A shared cache holding it would serve it to the next caller.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Immutable content, so the digest is a free and honest validator.
    if (row.sha256) res.setHeader('ETag', '"' + row.sha256 + '"');
    // Never inline-rendered as a document; it is an image being downloaded
    // by an <img> tag, and attachment-vs-inline is not this route's call —
    // but the filename gives a save-as something sensible.
    res.setHeader('Content-Disposition', `inline; filename="image-${row.id}"`);
    res.end(row.content);
  } catch (err) {
    sendError(res, err, 'GET /:id/file');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   GET /api/images/:id — metadata only, owner-scoped, no source_url
   ───────────────────────────────────────────────────────────────────────── */
router.get('/:id', async (req, res) => {
  try {
    const image = await serviceFor(req).get(req.user.id, req.params.id);
    if (!image) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: 'No image with that id belongs to this account.',
      });
    }
    res.json({ ok: true, image });
  } catch (err) {
    sendError(res, err, 'GET /:id');
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   DELETE /api/images/:id — owner-scoped
   ───────────────────────────────────────────────────────────────────────── */
router.delete('/:id', async (req, res) => {
  try {
    const removed = await serviceFor(req).remove(req.user.id, req.params.id);
    if (!removed) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: 'No image with that id belongs to this account.',
      });
    }
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    sendError(res, err, 'DELETE /:id');
  }
});

module.exports = router;

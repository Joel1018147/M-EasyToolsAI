'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   routes/docIntel.js — Document Intelligence over HTTP.   UPGRADE-SPEC.md §1.2
   ───────────────────────────────────────────────────────────────────────────
   Mounted by Foundation in server.js as:
       app.use('/api/docintel', requireAuth, checkSub, require('./routes/docIntel'));
   so everything below runs with a signed-in `req.user` on a subscription that
   checkSub let through. This lane does not edit server.js and does not widen
   its own guard — the guard is the boundary and it is decided at the mount.

   ── THIS FILE'S JOB IS IDENTITY, AND NOTHING ELSE ─────────────────────────
   `userId` and `teamId` come from `req.user`, which comes from the SESSION.
   `req.body` supplies the document's bytes, a category, a target id, a nonce
   and a rejection reason — NEVER an identity. There is no branch here that
   lets a request body, a query string or a header contribute an owner.
   (GAUNTLET.md §S records why: `requireSeller` takes its key from
   `req.query.key`, and query strings land in access logs and Referer headers.)

   ── THERE IS NO BULK ENDPOINT, AND THAT IS THE FEATURE ────────────────────
   EXACTLY ONE route in this file writes to a business table:

       POST /proposals/:id/accept          one field, one nonce

   and exactly one route mints an approval:

       GET  /proposals/:id/card            one field, one token

   There is no `accept-all`, no `commit-document`, no `POST /documents/:id/
   accept`, and no route anywhere in this file whose body carries an array of
   ids. GAUNTLET.md §H fails a design where one click covers several
   independent decisions, and the way to not have one is to NOT BUILD ONE. The
   absence is the enforcement; `test/docintel-confirm-test.js` enumerates this
   router's own stack and asserts it.

   A five-field document is five decisions and five requests. That is more work
   than an approve-all button, and it is the difference between "5 fields were
   updated" being a count and being a claim.

   ── THE NONCE IS ALSO WHAT MAKES THIS PATH CSRF-SAFE ──────────────────────
   The session cookie is `sameSite: 'none'` in production (server.js), so a
   cross-site POST does arrive carrying a session. It cannot arrive carrying a
   valid nonce: the nonce is minted only in the JSON body of
   GET /proposals/:id/card, and `app.use(cors({ origin: … }))` in server.js is
   configured WITHOUT `credentials`, so no `Access-Control-Allow-Credentials`
   header is ever sent and a cross-origin script cannot read a response to a
   request that carried the session. An accept without a nonce this server
   minted is refused before any target row is touched.

   Stated honestly, twice over:
     · That is an argument about THIS write path, not a CSRF defence for the
       rest of the app. If `credentials: true` were ever added to that cors()
       call, this paragraph stops being true and this path would need its own
       token — which is exactly why it is written down here.
     · GET /proposals/:id/card MUTATES (it mints). A cross-site `<img>` or a
       no-cors fetch can therefore make it re-mint without being able to read
       the result, which VOIDS a token a reviewer was holding. That is a
       nuisance — the reviewer re-opens the card — and it is the safe
       direction: it can destroy an approval, never create one. It is not
       silently accepted; it is the reason this endpoint is the mint and the
       accept is a POST.

   ── UPLOADS: RAW BYTES, NO MULTIPART, NO DISK ─────────────────────────────
   There is no multer in package.json and package.json is not this lane's file
   to edit. So an upload is a POST whose body IS the file and whose
   Content-Type IS the file's type. `express.raw()` below is mounted on that
   ONE route and produces a Buffer that goes straight into a BYTEA parameter.
   Nothing is written to a filesystem on any path (§E: PostgreSQL only).

   The one seam: server.js mounts a global `express.json({limit:'10mb'})`
   ahead of this router, so a file uploaded with `Content-Type: application/
   json` is consumed there and arrives here as a parsed object rather than a
   Buffer. That is caught — `Buffer.isBuffer(req.body)` is false and ingest()
   answers `empty_upload` — and application/json is not an accepted document
   type anyway. It is a named seam, not a silent one.
   ═══════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { pool } = require('../db');
/* GROQ_MODEL is imported, never re-derived. CLAUDE.md: helpers/groq.js is the
   single reader of process.env.GROQ_MODEL in this repository, so one env var
   still switches every call site including this one. This file also never
   sends a `model` field of its own to /api/chat — it calls chat() directly. */
const { chat, GROQ_MODEL } = require('../helpers/groq');
const { createDocIntel } = require('../lib/docintel/service');
const fieldMap = require('../lib/docintel/fieldMap');
const textLayer = require('../lib/docintel/textLayer');

/* Two endpoints here are expensive in a way the rest of this app's routes are
   not: one accepts up to 8 MB of bytes, the other spends the Groq budget.
   server.js rate-limits the login and generation paths; these carry their own.
   Keyed by the SIGNED-IN USER, not by IP — every request that reaches this
   router is authenticated, and an office behind one NAT would otherwise share
   a bucket. */
const spendLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req.user && req.user.id) || req.ip),
  message: { ok: false, reason: 'rate_limited', message: 'Too many uploads or extraction runs in the last minute.' },
});

/* The model call. temperature 0, because this is an extraction, not a
   conversation. The per-user key first, then the platform key — the same
   resolution every other Groq call site in this repo uses. */
function makeGenerate(req) {
  const apiKey = (req.user && req.user.groq_key) || process.env.GROQ_API_KEY;
  return async function generate({ system, user }) {
    if (!apiKey) throw new Error('Groq API key not configured on this deployment or on this account');
    const { text } = await chat({
      apiKey,
      model: GROQ_MODEL,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 700,
      temperature: 0,
    });
    return text;
  };
}

/* The service is constructed PER REQUEST because `generate` closes over the
   caller's own Groq key. `db` is the shared pool either way. */
const svcFor = (req) => createDocIntel({ db: pool, generate: makeGenerate(req), model: GROQ_MODEL });

/** Identity, derived from the session on every single request. */
const who = (req) => ({
  userId: req.user.id,
  teamId: req.user.team_id || null,
});

/* One wrapper so no handler can forget its own failure path. A throw becomes a
   logged 500 with a generic body — never a 200 with an empty result, which is
   the shape that makes a broken write look like an empty document. */
const guard = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('docintel:', req.method, req.originalUrl, err && err.stack ? err.stack : err);
    if (!res.headersSent) res.status(500).json({ ok: false, reason: 'server_error' });
  });
};

/* ── what this deployment can actually do, resolved PER REQUEST ────────────
   Never cached from boot: a value read once at start-up survives the
   credential being rotated away, and then reports a capability that is gone. */
router.get('/status', guard(async (req, res) => {
  const hasKey = !!((req.user && req.user.groq_key) || process.env.GROQ_API_KEY);
  res.json({
    model: GROQ_MODEL,
    modelConfigured: hasKey,
    reason: hasKey ? null
      : 'No Groq key is configured for this account or this deployment, so no proposals can be generated. '
      + 'Uploading and reading a document still works; the propose step refuses and says so.',
    maxBytes: textLayer.MAX_BYTES,
    reads: ['application/pdf (text layer only)', 'text/plain', 'text/csv', 'text/markdown'],
    /* Two different absences, answered separately, because one boolean would
       misdescribe whichever half it was not about. */
    imageOcr: false,
    imageOcrReason:
      'This deployment carries no OCR engine and no vision model call, so text cannot be read out of a picture. '
      + 'An image uploads and stores, and is honestly reported as having no text layer.',
    officeDocuments: false,
    officeDocumentsReason:
      '.docx and .xlsx need a parser (mammoth, exceljs) that is not in this repository\'s package.json. Export to '
      + 'PDF, or save as .txt or .csv — both are read.',
  });
}));

/* The field map, from the server's own truth, so the page can never advertise
   a destination the server would refuse. */
router.get('/field-map', guard(async (req, res) => {
  res.json(fieldMap.describe());
}));

/* ── documents ───────────────────────────────────────────────────────────── */
router.get('/documents', guard(async (req, res) => {
  const { userId } = who(req);
  res.json({ documents: await svcFor(req).listDocuments(userId, req.query.limit) });
}));

/* Upload. THE BODY IS THE FILE.
   `type: () => true` because the parser is mounted on ONE route and every
   request that reaches it is an upload; which types are readable is decided by
   textLayer.isAccepted() inside ingest(), which owns that list. */
router.post('/documents',
  spendLimit,
  express.raw({ type: () => true, limit: textLayer.MAX_BYTES }),
  guard(async (req, res) => {
    const { userId, teamId } = who(req);
    const out = await svcFor(req).ingest({
      userId, teamId,
      filename: req.get('x-filename') || req.query.filename || 'document',
      mimeType: req.get('content-type') || '',
      bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    if (!out.ok) return res.status(out.reason === 'too_large' ? 413 : 415).json(out);
    res.status(201).json({ ok: true, document: out.document });
  }));

/* The document view. A PURE READ — it mints nothing. Polling it therefore
   does not invalidate an approval a reviewer is part-way through, and it can
   never hand back a token for a card nobody opened. Each pending row carries
   `openable: true`, which is a statement about the row, not an approval. */
router.get('/documents/:id', guard(async (req, res) => {
  const { userId } = who(req);
  const out = await svcFor(req).listProposals({ documentId: req.params.id, userId });
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
}));

/* ═════════════════════════════════════════════════════════════════════════
   THE CARD. ONE proposal, in the PATH. This is the ONLY endpoint in this
   application that mints an approval token, and it mints exactly one, for
   exactly the field named in the path, alongside the full disclosure that
   makes an approval mean something — the value, the column, the record, the
   verbatim quote, and what it would overwrite.

   `Cache-Control: no-store` because the body carries a single-use approval; a
   proxy or a browser holding a copy would be holding a spendable one.
   ═════════════════════════════════════════════════════════════════════════ */
router.get('/proposals/:id/card', guard(async (req, res) => {
  const { userId } = who(req);
  const out = await svcFor(req).openCard({ proposalId: req.params.id, userId });
  if (!out.ok) return res.status(out.reason === 'not_found' ? 404 : 422).json(out);
  res.set('Cache-Control', 'no-store, private');
  res.json(out);
}));

/* The original bytes back, owner-scoped, so a reviewer can read the source
   next to the quote. The filename is stripped of anything that could break the
   header, and nosniff is set because these bytes are a stranger's upload. */
router.get('/documents/:id/file', guard(async (req, res) => {
  const { userId } = who(req);
  const row = await svcFor(req).getDocumentBytes(req.params.id, userId);
  if (!row) return res.status(404).json({ ok: false, reason: 'not_found' });
  const safe = String(row.filename || 'document').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  res.set('Content-Type', row.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${safe}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(row.content);
}));

/* Candidate records to bind to. Read-only and owner-scoped. */
router.get('/targets/:category', guard(async (req, res) => {
  const cat = fieldMap.getCategory(req.params.category);
  if (!cat) {
    const absent = fieldMap.ABSENT_CATEGORIES[req.params.category];
    return res.status(404).json({
      ok: false,
      reason: absent ? 'category_absent' : 'unknown_category',
      message: absent || `"${req.params.category}" is not a category of M-EasyTools' field map.`,
    });
  }
  const { userId } = who(req);
  const targets = await svcFor(req).listTargets(req.params.category, userId);
  res.json({ ok: true, category: cat.key, label: cat.label, selfOnly: !!cat.selfOnly, targets });
}));

/* Bind. A HUMAN chooses which record the document is about, before any value
   is proposed for it. The model is never asked. */
router.post('/documents/:id/bind', guard(async (req, res) => {
  const { userId } = who(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const out = await svcFor(req).bindTarget({
    documentId: req.params.id, userId,
    category: typeof body.category === 'string' ? body.category : '',
    targetId: body.targetId === undefined || body.targetId === null ? null : String(body.targetId),
  });
  if (!out.ok) return res.status(out.reason === 'not_found' ? 404 : 422).json(out);
  res.json(out);
}));

router.post('/documents/:id/propose', spendLimit, guard(async (req, res) => {
  const { userId } = who(req);
  const out = await svcFor(req).propose({ documentId: req.params.id, userId });
  if (!out.ok) return res.status(out.reason === 'not_found' ? 404 : 422).json(out);
  res.json(out);
}));

/* ═════════════════════════════════════════════════════════════════════════
   THE ONE WRITE ROUTE. ONE proposal id, in the PATH. ONE nonce, in the body.
   No sibling takes several. No sibling takes an array.
   ═════════════════════════════════════════════════════════════════════════ */
router.post('/proposals/:id/accept', guard(async (req, res) => {
  const { userId } = who(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  /* `body.nonce` is passed through as-is when it is a string and as null
      otherwise. There is deliberately no coercion: `true`, `1` and
      `{confirmed:true}` must not become anything the service can read as a
      confirmation. */
  const out = await svcFor(req).acceptProposal({
    proposalId: req.params.id,
    nonce: typeof body.nonce === 'string' ? body.nonce : null,
    userId,
  });
  if (out.ok) return res.json(out);

  /* ONE status and ONE body for EVERY nonce failure — unknown proposal, wrong
     owner, expired, replayed, wrong user, never-carded. Splitting them would
     answer "does this proposal exist on this platform" for anyone willing to
     ask. `target_changed` is deliberately distinct: the caller already held a
     valid nonce for that row, so it already knew the row existed, and telling
     them the value moved is the only way they can act on it. */
  if (out.reason === 'confirm_invalid') {
    return res.status(403).json({
      ok: false, reason: 'confirm_invalid',
      message: 'This approval could not be honoured and nothing was changed. Re-open the document; each card carries '
             + 'a single-use approval that expires, and re-opening issues a fresh one.',
    });
  }
  res.status(409).json(out);
}));

router.post('/proposals/:id/reject', guard(async (req, res) => {
  const { userId } = who(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const out = await svcFor(req).rejectProposal({ proposalId: req.params.id, userId, reason: body.reason });
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
}));

module.exports = router;

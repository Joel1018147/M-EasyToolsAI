'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   DOCUMENT INTELLIGENCE — the service.                  lib/docintel/service.js
   GAUNTLET.md §H (Human-Confirmation Bar) · UPGRADE-SPEC.md §1.2
   ───────────────────────────────────────────────────────────────────────────
   THE ONE RULE THIS FILE EXISTS TO ENFORCE:

       No extracted value reaches a business table except through
       acceptProposal(), which takes ONE proposal id and ONE nonce this
       server issued while displaying that one field's evidence.

   THERE IS NO BATCH ACCEPT. THERE IS NO "COMMIT DOCUMENT". There is no code
   path in this repository that loops over proposals and writes them, and that
   ABSENCE IS THE ENFORCEMENT — a per-field dialog in front of a bulk endpoint
   is a dialog, not a gate. `acceptProposal` takes a single scalar id; every
   shape that could name two proposals (an array, a comma list, an object)
   fails the UUID test on the first line and returns confirm_invalid.

   ── WHY A NONCE AND NOT A BOOLEAN — settled ecosystem precedent ───────────
   M-EasyDo's blind critic proved that `{ confirmed: true }` off a request body
   performed a write with NO approval step having happened at all: nothing
   required that a confirmation had ever been ISSUED, and nothing bound the
   approval to the action, so an approved `cancel_appointment(7)` was observed
   cancelling appointment 8 — a different customer's booking. That is exactly
   the shape a "per-field confirmation" would take if the field were a flag:
   `POST /accept {id, confirmed:true}` is the same bug with a different noun.

   So a confirmation here is NOT a claim the caller makes. It is a nonce this
   server minted at the moment it rendered THIS proposal's value, target field,
   verbatim evidence, and the value it would overwrite. Presenting it writes
   exactly that field, or nothing.

   Five properties, each deliberate:
     · SINGLE USE, SPENT BY BEING TOUCHED. The nonce is CLEARED BEFORE any
       check that could reject it, so a nonce presented by the wrong session is
       burned rather than left live for its rightful owner. The cost is that a
       leaked nonce can deny one confirmation; the alternative leaves a
       demonstrably-leaked approval spendable, and a denied confirmation is a
       re-ask while a spendable leaked approval is an unapproved write.
     · A COLUMN, NOT AN IN-PROCESS MAP. `accept_nonce_hash` survives a restart
       and crosses replicas, and single-use has somewhere durable to live. Only
       the sha256 HASH is stored; the plaintext is returned once, in the JSON
       that renders that one field's card, and never written to the database
       and never to a log line.
     · BOUND TO A USER. A nonce with no identity on it is a nonce anybody can
       spend. Compared with crypto.timingSafeEqual, over equal-length digests.
     · LAZILY EXPIRED. `accept_nonce_expires_at` is compared in JS against an
       injectable clock and the row is re-read inside the transaction. There is
       no setTimeout and no setInterval anywhere in this feature (§E).
     · ONE REFUSAL REASON. Unknown id, wrong owner, already accepted, expired,
       replayed and issued-to-someone-else ALL return `confirm_invalid`.
       Distinguishing them turns the endpoint into an oracle for "does this
       proposal exist on this platform".

   ── TOCTOU, BOTH HALVES ───────────────────────────────────────────────────
   The card told the human two things: "this writes to record R" and "this
   replaces the value X". Both are captured at mint time (`shown_target_id`,
   `shown_previous_json`) and BOTH are re-verified inside the accept
   transaction. If the document has been re-bound, or the live value has moved,
   the sentence the human approved is no longer the sentence that would be
   executed, and nothing is changed.

   ── THE BURN IS DURABLE, AND IT IS NOT PART OF THE WRITE ────────────────
   The nonce is cleared by its OWN autocommitted statement on the pool, before
   the transaction that does the write is even opened. Integration's blind
   critic proved why: when the burn lived inside that transaction, three
   ROLLBACK paths handed the same approval back live — a lost claim, a write
   that matched no row, and a transient error. "Single use" means spent on
   presentation, not spent on success. §12 of the suite is the regression.

   ── AUDIT ───────────────────────────────────────────────────
   `audit_log` is created by migrations/004 (Integration added it on this
   branch) and every accept writes exactly one row to it — SUCCESS OR REFUSAL.
   It records the disclosure the human was shown, a non-secret handle for the
   approval, and what happened. It never contains the nonce in any form, and a
   failing audit insert is logged loudly but never turns a completed write into
   an error the caller sees.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const fieldMap = require('./fieldMap');
const guards = require('./guards');
const textLayer = require('./textLayer');

/** Five minutes: long enough to read a sentence naming a real record and
 *  decide, short enough that a nonce left in a closed laptop's network tab is
 *  dead. */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** Bounds one document's model spend and wall clock. */
const MAX_CHARS_PER_CALL = 6000;
const MAX_CALLS = 6;

/** Every id in this feature is a `gen_random_uuid()` from migration 004. An
 *  array, a comma list, a number or an object all fail this. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/* Table and column names are interpolated into SQL — they are the ONLY things
   in this file that are, because a parameter cannot be an identifier. They come
   from fieldMap.js, which is authored source, never from a request and never
   from a model. This assertion is the belt to that braces: an identifier that
   is not lower-snake-case THROWS before it can reach a query string. */
const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
function ident(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new Error(`docintel: refusing to build SQL with ${what} ${JSON.stringify(name)}`);
  }
  return name;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Constant-time compare of two hex digests. Length is checked first because
 *  timingSafeEqual throws on a length mismatch — and a length mismatch is not
 *  secret, it is a malformed nonce. */
function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ── the model contract ────────────────────────────────────────────────────
   The system prompt asks for four things that guards.js then ENFORCES rather
   than trusts: quote verbatim, never invent a field, the value must be inside
   the quote, output nothing else. A prompt is a request; guards.js is the
   rule. If this prompt were deleted entirely the guards would still hold —
   which is the test of whether a guard is a guard. */
function buildSystem(categoryKey) {
  const cat = fieldMap.getCategory(categoryKey);
  return [
    `You read an excerpt of a business document and say which of a FIXED list of ${cat.label} fields it evidences.`,
    'For each field you can evidence IN THIS EXCERPT, output exactly one line:',
    'field|verbatim quote|value',
    'The quote MUST be copied word-for-word from the excerpt. Never paraphrase it.',
    `The quote must be at least ${guards.MIN_QUOTE_CHARS} characters long.`,
    'The value MUST appear inside the quote you gave. Never state a value the quote does not contain.',
    'Never output a field name that is not in the list. Never invent a field.',
    'Never output a field you cannot quote — leave it out entirely rather than guessing.',
    'Output nothing else — no preamble, no explanation, no markdown.',
  ].join(' ');
}

function buildPrompt(categoryKey, excerpt) {
  const cat = fieldMap.getCategory(categoryKey);
  const list = Object.entries(cat.fields).map(([k, f]) => `${k} — ${f.hint}`).join('\n');
  return `FIELDS:\n${list}\n\nEXCERPT:\n"""\n${excerpt}\n"""\n\nLines only.`;
}

/** Blocks → excerpts no larger than one call's budget, never splitting a block
 *  unless the block alone is bigger than the budget. */
function chunk(blocks) {
  const out = [];
  let buf = '';
  for (const b of blocks) {
    let rest = String(b);
    while (rest.length > MAX_CHARS_PER_CALL) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(rest.slice(0, MAX_CHARS_PER_CALL));
      rest = rest.slice(MAX_CHARS_PER_CALL);
    }
    if (buf.length + rest.length + 1 > MAX_CHARS_PER_CALL) { out.push(buf); buf = ''; }
    buf = buf ? `${buf}\n${rest}` : rest;
  }
  if (buf) out.push(buf);
  return out.slice(0, MAX_CALLS);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The service. `db` is a pg Pool (or anything with .query and .connect) and
   `generate` is the model call. Both are INJECTED, so the suite drives the
   real code against a recording fake and a scripted model — a suite that reads
   source as text and never executes it has been the shape of three consecutive
   escapes in this ecosystem.

   `now` is injectable for the same reason: a wall-clock expiry that only real
   time can reach is an expiry no test ever exercises.
   ═══════════════════════════════════════════════════════════════════════════ */
function createDocIntel({ db, generate, model = 'unknown', now = Date.now } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('docintel: a database is required');

  const q = (text, params) => db.query(text, params);

  /* ── 1. intake ───────────────────────────────────────────────────────────
     The bytes go into a BYTEA column and nowhere else. No temp file, no
     uploads/ directory, no os.tmpdir — the ENGINEERING BAR says PostgreSQL
     only, and a Buffer bound as $n never touches a filesystem. Text extraction
     runs here, once, synchronously, so a document's text_status is decided
     before anyone can ask for proposals against it. */
  async function ingest({ userId, teamId, filename, mimeType, bytes }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return { ok: false, reason: 'empty_upload', message: 'The request carried no bytes.' };
    }
    if (bytes.length > textLayer.MAX_BYTES) {
      return { ok: false, reason: 'too_large',
               message: `${bytes.length} bytes; the limit for one document is ${textLayer.MAX_BYTES}.` };
    }
    if (!textLayer.isAccepted(mimeType, filename)) {
      return { ok: false, reason: 'unsupported_type', message: textLayer.extract(bytes, mimeType, filename).note };
    }

    const parsed = textLayer.extract(bytes, mimeType, filename);
    const readable = parsed.status === 'extracted';

    const r = await q(
      `INSERT INTO docintel_documents
         (user_id, team_id, uploaded_by, filename, mime_type, byte_size, sha256, content,
          text_status, extracted_text, block_count, extraction_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, filename, mime_type, byte_size, text_status, block_count, extraction_note, created_at`,
      [userId, teamId == null ? null : teamId, userId,
       String(filename || 'document').slice(0, 255), String(mimeType || '').slice(0, 120), bytes.length,
       crypto.createHash('sha256').update(bytes).digest('hex'), bytes,
       parsed.status,
       readable ? parsed.text : null,
       parsed.blocks.length, parsed.note]
    );
    return { ok: true, document: r.rows[0] };
  }

  async function getDocument(documentId, userId) {
    if (!isUuid(documentId)) return null;
    const r = await q(
      `SELECT id, user_id, filename, mime_type, byte_size, sha256, text_status, extracted_text,
              block_count, extraction_note, category, target_kind, target_id, model, proposed_at, created_at
         FROM docintel_documents WHERE id = $1 AND user_id = $2`,
      [documentId, userId]
    );
    return r.rows[0] || null;
  }

  /** The bytes back out, owner-scoped, so a reviewer can open the original
   *  next to the quote. Read straight from BYTEA; never staged on disk. */
  async function getDocumentBytes(documentId, userId) {
    if (!isUuid(documentId)) return null;
    const r = await q(
      'SELECT filename, mime_type, content FROM docintel_documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    return r.rows[0] || null;
  }

  /* The extracted text, re-split into the blocks locateQuote() needs. Stored
     joined so one column holds the document; split on the same '\n' the
     extractor joined with. A quote spanning a block boundary is not locatable
     — correctly, because the two blocks are not adjacent on any page. */
  const blocksOf = (doc) => (doc.extracted_text ? String(doc.extracted_text).split('\n') : []);

  /* ── 2. bind a target ────────────────────────────────────────────────────
     A HUMAN decides which record this document is about, before any value is
     proposed for it. That decision is not a field approval and it is not made
     by the model: nothing in a document can be trusted to say which of two
     press releases it belongs to. */
  async function bindTarget({ documentId, userId, category, targetId }) {
    const cat = fieldMap.getCategory(category);
    if (!cat) {
      const absent = fieldMap.ABSENT_CATEGORIES[category];
      return { ok: false, reason: absent ? 'category_absent' : 'unknown_category',
               message: absent || `"${category}" is not a category of M-EasyTools' field map.` };
    }
    const doc = await getDocument(documentId, userId);
    if (!doc) return { ok: false, reason: 'not_found', message: 'No such document in this workspace.' };

    /* A brand profile IS the signed-in user's own row. The target is not the
       caller's to choose, so it is not read from the request at all — which
       removes the whole class of "bind to someone else's id" rather than
       guarding against it. */
    const wanted = cat.selfOnly ? String(userId) : String(targetId == null ? '' : targetId);
    if (!wanted) {
      return { ok: false, reason: 'target_required', message: `Choose which ${cat.label} this document is about.` };
    }

    const exists = await targetExists(cat, userId, wanted);
    if (!exists) {
      return { ok: false, reason: 'target_not_found',
               message: `There is no ${cat.label} matching ${JSON.stringify(wanted)} in this workspace.` };
    }

    /* Re-binding invalidates every nonce on the document's proposals. A card
       that said "write this to release 12" must not stay spendable once the
       document points at release 13 — and the accept path checks
       shown_target_id as well, so this is defence in depth, not the only
       check. */
    await q(
      `UPDATE docintel_proposals
          SET accept_nonce_hash=NULL, accept_nonce_user=NULL, accept_nonce_expires_at=NULL
        WHERE document_id=$1 AND user_id=$2`,
      [documentId, userId]
    );
    await q(
      `UPDATE docintel_documents
          SET category=$3, target_kind='existing', target_id=$4, bound_by=$5, bound_at=NOW()
        WHERE id=$1 AND user_id=$2`,
      [documentId, userId, category, wanted, userId]
    );
    return { ok: true, category, targetKind: 'existing', targetId: wanted, label: cat.label };
  }

  async function targetExists(cat, userId, targetId) {
    const table = ident(cat.table, 'a table name');
    const own = ident(cat.ownerColumn, 'an owner column');
    const r = await q(`SELECT id FROM ${table} WHERE id = $1 AND ${own} = $2`, [targetId, userId]);
    return r.rows.length > 0;
  }

  /** What a field holds RIGHT NOW on the bound target, and WHETHER THE RECORD
   *  EXISTS AT ALL. Those are two different facts and this returns both.
   *
   *  {found:false}            the record is gone (or was never this user's)
   *  {found:true, value:null} the record is there and the field is empty
   *  {found:true, value:'x'}  the record is there and the field holds 'x'
   *
   *  THE SPLIT IS THE FIX FOR A REAL BREACH. This used to return a plain null
   *  for both of the first two, and Integration's blind critic used that: a
   *  card minted over an EMPTY field snapshotted `null`, the bound record was
   *  then deleted, and at accept time `null === null` so the TOCTOU check
   *  passed over a record that no longer existed. The write then failed and
   *  rolled the whole transaction back — including, at the time, the burn.
   *
   *  `forUpdate` takes a row lock, so the caller can read the value and write
   *  it in the same transaction without another committed change slipping
   *  between the two under READ COMMITTED.
   *
   *  The value is JSON-compared by the caller, which is why null, '' and 'x'
   *  must stay three distinct answers: they are three different sentences on
   *  the card. */
  async function readTargetValue(cat, fieldKey, userId, targetId, client, forUpdate = false) {
    const field = fieldMap.getField(cat.key, fieldKey);
    if (!field) return { found: false, value: null };
    const table = ident(cat.table, 'a table name');
    const col = ident(field.column, 'a column name');
    const own = ident(cat.ownerColumn, 'an owner column');
    const runner = client || db;
    const r = await runner.query(
      `SELECT ${col} AS v FROM ${table} WHERE id = $1 AND ${own} = $2` + (forUpdate ? ' FOR UPDATE' : ''),
      [targetId, userId]
    );
    if (!r.rows.length) return { found: false, value: null };
    const v = r.rows[0].v;
    if (v === undefined || v === null || v === '') return { found: true, value: null };
    return { found: true, value: v instanceof Date ? v.toISOString() : String(v) };
  }

  /* ── 3. propose ──────────────────────────────────────────────────────────
     Runs the model over the DOCUMENT'S OWN TEXT and turns each reply line
     through guards.js. Everything it writes is a docintel_proposals row.
     NOTHING here touches a business table (GUARD 4). */
  async function propose({ documentId, userId }) {
    const doc = await getDocument(documentId, userId);
    if (!doc) return { ok: false, reason: 'not_found', message: 'No such document in this workspace.' };
    if (!doc.category || !doc.target_id) {
      return { ok: false, reason: 'not_bound',
               message: 'Choose which record this document is about before asking for proposals. Nothing can say '
                      + 'what a value would overwrite until there is a record to overwrite it on.' };
    }
    if (doc.text_status !== 'extracted') {
      return { ok: false, reason: doc.text_status, message: doc.extraction_note };
    }
    const cat = fieldMap.getCategory(doc.category);
    if (!cat) {
      return { ok: false, reason: 'unknown_category',
               message: `This document is bound to "${doc.category}", which is no longer a category of the field map.` };
    }
    const blocks = blocksOf(doc);
    const excerpts = chunk(blocks);

    /* Re-proposing replaces the previous run's UNREVIEWED rows only. An
       accepted or rejected proposal is a decision a human made and is never
       deleted by a machine. */
    await q(
      `DELETE FROM docintel_proposals WHERE document_id=$1 AND user_id=$2 AND status IN ('pending','auto_rejected')`,
      [documentId, userId]
    );

    const seen = new Set();
    let calls = 0, kept = 0, rejected = 0;
    const failures = [];

    for (const excerpt of excerpts) {
      let reply = null;
      try {
        reply = await generate({ system: buildSystem(doc.category), user: buildPrompt(doc.category, excerpt) });
        calls += 1;
      } catch (err) {
        /* One bad excerpt must not abandon the document — but it must not
           vanish either. It is counted AND named in the return value, so a
           document extracted from 2 of 6 excerpts can never be mistaken for a
           document that only had 2 excerpts' worth of content in it. */
        failures.push(err && err.message ? err.message : String(err));
        continue;
      }

      const { kept: lines, dropped } = guards.parseProposals(reply, doc.category);

      for (const d of dropped) {
        rejected += 1;
        await recordAutoReject(documentId, userId, doc.category, d.fieldKey || '?', d.line, null, d.reason);
      }

      for (const line of lines) {
        const v = guards.verify(line, doc.category, blocks);
        if (!v.ok) {
          rejected += 1;
          await recordAutoReject(documentId, userId, doc.category, v.fieldKey,
                                 String(v.modelValue), String(v.evidenceQuote || ''), v.reason);
          continue;
        }
        if (seen.has(v.fieldKey)) continue;            // first verified proposal per field wins
        seen.add(v.fieldKey);
        kept += 1;
        await q(
          `INSERT INTO docintel_proposals
             (document_id, user_id, category, field_key, raw_value, normalised_value, model_value,
              evidence_quote, evidence_block, quote_verified, status, model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'pending',$10)`,
          [documentId, userId, doc.category, v.fieldKey, v.rawValue, v.normalisedValue,
           String(v.modelValue).slice(0, 400), v.evidenceQuote.slice(0, 2000), v.evidenceBlock, model]
        );
      }
    }

    await q('UPDATE docintel_documents SET model=$3, proposed_at=NOW() WHERE id=$1 AND user_id=$2',
            [documentId, userId, model]);

    return {
      ok: true,
      category: doc.category,
      fieldsInMap: Object.keys(cat.fields).length,
      excerpts: excerpts.length,
      calls,
      proposals: kept,
      autoRejected: rejected,
      modelCallFailures: failures,
    };
  }

  /** An auto-rejected row is PERSISTED, never dropped on the floor. It carries
   *  quote_verified=false, which the accept path's WHERE clause also requires
   *  to be true — so one of these can never become a write even if its status
   *  were somehow moved. */
  function recordAutoReject(documentId, userId, category, fieldKey, modelValue, quote, reason) {
    return q(
      `INSERT INTO docintel_proposals
         (document_id, user_id, category, field_key, model_value, evidence_quote,
          quote_verified, status, reject_reason, model)
       VALUES ($1,$2,$3,$4,$5,$6,false,'auto_rejected',$7,$8)`,
      [documentId, userId, category, String(fieldKey).slice(0, 60), String(modelValue == null ? '' : modelValue).slice(0, 400),
       quote === null || quote === undefined ? null : String(quote).slice(0, 2000), String(reason).slice(0, 400), model]
    );
  }

  /* ── 4. list — A PURE READ. NO NONCE IS MINTED HERE. ─────────────────────
     Deliberately different from the M-EasyDo reference, which mints a token
     for every pending proposal while rendering the document view. That is one
     request handing back N spendable approvals, and while each still writes
     only its own field, it means a token can exist for a card nobody opened.

     §H says a nonce is minted "only while rendering that ONE field's evidence
     card", so here it is: this function renders the list and mints nothing,
     and `openCard()` below is the one place a token is created — one call, one
     field, one token, and a human had to ask for it.

     A second consequence worth having: this GET no longer mutates anything, so
     a document can be polled without silently invalidating approvals a
     reviewer is part-way through. */
  async function listProposals({ documentId, userId }) {
    const doc = await getDocument(documentId, userId);
    if (!doc) return { ok: false, reason: 'not_found', message: 'No such document in this workspace.' };

    const r = await q(
      `SELECT id, field_key, raw_value, normalised_value, model_value, evidence_quote, evidence_block,
              quote_verified, status, reject_reason, accepted_at, written_target, created_at
         FROM docintel_proposals WHERE document_id=$1 AND user_id=$2 ORDER BY status, field_key, id`,
      [documentId, userId]
    );

    const cat = doc.category ? fieldMap.getCategory(doc.category) : null;
    const out = [];
    for (const row of r.rows) {
      const field = cat ? fieldMap.getField(cat.key, row.field_key) : null;
      const item = {
        id: row.id,
        field: row.field_key,
        label: field ? field.label : row.field_key,
        writesTo: field ? fieldMap.targetOf(doc.category, row.field_key) : null,
        value: row.normalised_value,
        documentSaid: row.raw_value,
        modelTyped: row.model_value,
        evidence: row.evidence_quote,
        evidenceBlock: row.evidence_block,
        status: row.status,
        rejectReason: row.reject_reason,
        acceptedAt: row.accepted_at,
        writtenTarget: row.written_target,
      };

      /* `openable` is a statement about this row, not an approval: it says a
         card COULD be drawn for it. No token exists until one is. */
      item.openable = row.status === 'pending' && row.quote_verified === true && !!field && !!doc.target_id;
      out.push(item);
    }

    const counts = { pending: 0, accepted: 0, rejected: 0, auto_rejected: 0 };
    for (const p of out) if (Object.prototype.hasOwnProperty.call(counts, p.status)) counts[p.status] += 1;

    /* `extracted_text` is deliberately NOT in the response. A document can be
       megabytes and the page has no use for it — the evidence a reviewer reads
       is the per-proposal quote, and the original is one click away at
       /documents/:id/file. Shipping it here would put the full text of every
       document into every poll of this endpoint. */
    const summary = Object.assign({}, doc);
    delete summary.extracted_text;
    return { ok: true, document: summary, category: doc.category, counts, proposals: out };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     4b. OPEN ONE FIELD'S CARD — THE ONLY PLACE A NONCE IS EVER MINTED.
     ═════════════════════════════════════════════════════════════════════════
     One call, one proposal, one token. It renders the FULL disclosure a person
     needs in order for their approval to mean something:

         the value that would be written, cut from the document's own text
         the column it would be written to, and on which record
         the verbatim quote it came from, and which block
         what the model TYPED, beside what the document SAYS
         WHAT IT WOULD OVERWRITE — the sentence the TOCTOU check re-verifies

     …and only then mints. A caller that never opened this holds no token and
     therefore cannot accept anything. Re-opening re-mints and voids the
     previous token for that field: the newest card is the one showing the
     current `overwrites` value, and an older card's approval would be an
     approval of a sentence that is no longer true.
     ═════════════════════════════════════════════════════════════════════════ */
  async function openCard({ proposalId, userId }) {
    if (!isUuid(proposalId)) return { ok: false, reason: 'not_found' };
    const r = await q(
      `SELECT id, document_id, category, field_key, raw_value, normalised_value, model_value,
              evidence_quote, evidence_block, quote_verified, status
         FROM docintel_proposals WHERE id=$1 AND user_id=$2`,
      [proposalId, userId]
    );
    const p = r.rows[0];
    if (!p) return { ok: false, reason: 'not_found', message: 'No such proposal in this workspace.' };
    if (p.status !== 'pending' || p.quote_verified !== true) {
      return { ok: false, reason: 'not_pending',
               message: `This proposal is ${p.status}, so there is nothing left to approve on it.` };
    }
    const doc = await getDocument(p.document_id, userId);
    if (!doc || !doc.category || !doc.target_id || doc.category !== p.category) {
      return { ok: false, reason: 'not_bound',
               message: 'This document is not bound to a record, so nothing can say what this value would '
                      + 'overwrite — and an approval that cannot name what it replaces is not an approval.' };
    }
    const cat = fieldMap.getCategory(p.category);
    const field = fieldMap.getField(p.category, p.field_key);
    if (!cat || !field) return { ok: false, reason: 'not_bound', message: 'That field is no longer in the field map.' };

    /* A card for a record that is gone is a card whose "this replaces X"
       sentence has no subject. Refuse before minting rather than issue an
       approval that can only ever be refused. */
    const live = await readTargetValue(cat, p.field_key, userId, doc.target_id);
    if (!live.found) {
      return { ok: false, reason: 'target_not_found',
               message: `The ${cat.label} this document is bound to no longer exists in this workspace, so `
                      + 'there is nothing to say this value would replace. Bind the document to a record that '
                      + 'exists.' };
    }
    const overwrites = live.value;
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now() + NONCE_TTL_MS);

    /* The expiry is computed HERE and BOUND AS A PARAMETER rather than written
       as `NOW() + interval` in the SQL, so `now` is the one clock both the mint
       and the accept read, and the suite can drive a nonce past its expiry
       without sleeping. A wall-clock expiry that only real time can reach is an
       expiry no test ever exercises. */
    const upd = await q(
      `UPDATE docintel_proposals
          SET accept_nonce_hash=$3, accept_nonce_user=$4, accept_nonce_expires_at=$5,
              shown_previous_json=$6, shown_target_id=$7
        WHERE id=$1 AND user_id=$2 AND status='pending' AND quote_verified=TRUE
        RETURNING id`,
      /* `shown_target_id` is the RECORD the card named, and the accept refuses
         if the document has since been re-bound to a different one. Without it
         there is a real hole: bind to release A, draw the card (overwrites:
         null, because A's field is empty), re-bind to release B whose field is
         ALSO empty, and the overwrite snapshot passes because null equals null
         — so an approval that said "write this to release A" would land on
         release B. The value being overwritten is only half of what a human
         approved; the record is the other half. */
      [proposalId, userId, sha256(nonce), userId, expiresAt,
       JSON.stringify(overwrites), String(doc.target_id)]
    );
    if (!upd.rows.length) {
      return { ok: false, reason: 'not_pending',
               message: 'This proposal changed while its card was being built. Reload the document.' };
    }

    return {
      ok: true,
      card: {
        id: p.id,
        field: p.field_key,
        label: field.label,
        writesTo: fieldMap.targetOf(p.category, p.field_key),
        targetId: String(doc.target_id),
        targetLabel: cat.label,
        value: p.normalised_value,
        documentSaid: p.raw_value,
        modelTyped: p.model_value,
        evidence: p.evidence_quote,
        evidenceBlock: p.evidence_block,
        overwrites,
        /* The plaintext exists here and in the response body ONLY. It is never
           a parameter to an INSERT or UPDATE and never reaches a log line. */
        acceptNonce: nonce,
        acceptNonceExpiresAt: expiresAt.toISOString(),
      },
    };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     5. ACCEPT — THE GATE. ONE FIELD. ONE NONCE. ONE WRITE.
     ═════════════════════════════════════════════════════════════════════════
     `proposalId` is a single scalar and is tested against a UUID pattern on
     the first line. There is no shape of this argument that names two
     proposals: an array fails `typeof v === 'string'`, and a comma list fails
     the pattern. THERE IS NO SIBLING FUNCTION THAT TAKES SEVERAL.
     ═════════════════════════════════════════════════════════════════════════ */
  async function acceptProposal({ proposalId, userId, teamId = null, nonce }) {
    if (!isUuid(proposalId)) return { ok: false, reason: 'confirm_invalid' };
    /* A nonce is 32 random bytes rendered as hex. `true`, 'true', 1 and
       {confirmed:true} all fail here — a boolean is not a confirmation. */
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return { ok: false, reason: 'confirm_invalid' };

    /* ═══════════════════════════════════════════════════════════════════════
       STEP 1 — BURN THE NONCE, DURABLY, BEFORE ANY TRANSACTION EXISTS.
       ═══════════════════════════════════════════════════════════════════════
       THIS RUNS ON THE POOL, NOT ON THE TRANSACTION CLIENT, AND THAT IS THE
       WHOLE POINT. It is its own autocommitted statement, so nothing that
       happens afterwards can undo it.

       ── WHY, WRITTEN DOWN SO A LATER EDIT DOES NOT QUIETLY UNDO IT ────────
       The previous version burned the nonce INSIDE the transaction and
       asserted in a comment that every path committed. Three did not: a lost
       claim, a `writeField` that matched no row, and the catch — all ROLLBACK,
       and a ROLLBACK takes the burn with it. Integration's blind critic
       reached that state with no injected fault at all: delete the bound
       record, and an approval over an empty field passed its snapshot check
       (null for "empty" read the same as null for "gone"), claimed the row,
       failed the write, rolled back, and handed the SAME nonce back live to be
       spent again. A transient 40P01 reached it by the catch.

       Single use has to mean SPENT ON PRESENTATION, not spent on success. A
       failed write must never return a spendable approval.

       The CTE reads the row FOR UPDATE and returns its PRE-burn values, so the
       checks below run against what the row held a moment ago while the row
       itself already holds nothing. One statement, so there is no window
       between the read and the clear for a second request to slip through.
       ═══════════════════════════════════════════════════════════════════════ */
    const burn = await q(
      `WITH prev AS (
         SELECT id, accept_nonce_hash, accept_nonce_user, accept_nonce_expires_at
           FROM docintel_proposals WHERE id = $1 AND user_id = $2 FOR UPDATE
       )
       UPDATE docintel_proposals d
          SET accept_nonce_hash = NULL, accept_nonce_user = NULL, accept_nonce_expires_at = NULL
         FROM prev WHERE d.id = prev.id
       RETURNING prev.accept_nonce_hash       AS prev_hash,
                 prev.accept_nonce_user       AS prev_user,
                 prev.accept_nonce_expires_at AS prev_expires`,
      [proposalId, userId]
    );
    const spent = burn.rows[0];

    /* No row means the proposal does not exist, or belongs to another account.
       NOTHING WAS BURNED, and that is correct rather than a gap: the statement
       is user-scoped, so one account can never burn another account's approval
       by presenting a guess at it. Burning on a stranger's presentation would
       hand anyone who can guess a UUID a denial of service against a reviewer.

       The comment that used to sit here claimed a wrong session's presentation
       burned the nonce. It never did — the read was user-scoped then too — and
       a comment asserting a property the code does not have is worse than no
       comment. What IS true, and is what the Bar asks for: an approval
       presented by the session it was issued to is spent, whether or not it
       was correct and whether or not the write then succeeded. */
    if (!spent) {
      await audit({ userId, teamId, ok: false, entity: 'docintel_proposals', entityId: proposalId,
                    detail: 'confirm_invalid: no such proposal for this account' });
      return { ok: false, reason: 'confirm_invalid' };
    }

    const client = await db.connect();
    let outcome = null;
    try {
      await client.query('BEGIN');

      const sel = await client.query(
        `SELECT id, document_id, category, field_key, normalised_value, evidence_quote,
                quote_verified, status, shown_previous_json, shown_target_id
           FROM docintel_proposals WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [proposalId, userId]
      );
      const p = sel.rows[0];

      /* ONE REFUSAL REASON for every nonce failure. Unknown id, wrong owner,
         already accepted, expired, replayed and issued-to-someone-else all
         answer `confirm_invalid`; distinguishing them turns the endpoint into
         an oracle for "does this proposal exist on this platform". `why` is
         for the audit row and never reaches the caller — routes/docIntel.js
         answers one fixed body. */
      const invalid = async (why) => {
        await client.query('COMMIT');
        outcome = { ok: false, reason: 'confirm_invalid', why };
        return { ok: false, reason: 'confirm_invalid' };
      };

      if (!p) return await invalid('the row vanished between the burn and the read');
      if (p.status !== 'pending') return await invalid(`status is ${p.status}`);
      if (p.quote_verified !== true) return await invalid('never evidenced');

      /* THE CHECKS RUN AGAINST THE PRE-BURN VALUES. The row itself is already
         clear, so this proposal is unusable from here on, whichever way the
         rest of this function ends. */
      if (!spent.prev_hash) return await invalid('no card had been opened for this field');
      if (!hashEquals(spent.prev_hash, sha256(nonce))) return await invalid('nonce does not match');
      if (String(spent.prev_user) !== String(userId)) return await invalid('nonce was issued to another user');
      if (!spent.prev_expires || new Date(spent.prev_expires).getTime() <= now()) {
        return await invalid('nonce had expired');
      }

      const docRes = await client.query(
        'SELECT id, category, target_id FROM docintel_documents WHERE id=$1 AND user_id=$2 FOR UPDATE',
        [p.document_id, userId]
      );
      const d = docRes.rows[0];
      if (!d || !d.target_id || d.category !== p.category) {
        return await invalid('document is unbound or re-categorised');
      }

      /* THE CARD NAMED A RECORD. If the document has been re-bound since, this
         approval is for a record that is no longer the one that would be
         written. `invalid()` rather than a distinct reason, because a re-bind
         is a different document state entirely, not a stale value on the same
         row. */
      if (String(p.shown_target_id) !== String(d.target_id)) return await invalid('document was re-bound');

      const cat = fieldMap.getCategory(p.category);
      const field = fieldMap.getField(p.category, p.field_key);
      if (!cat || !field) return await invalid('field is no longer in the field map');
      /* A brand profile is the signed-in user's own row and nothing else. Even
         with a valid nonce and a matching snapshot, a target that is not this
         user cannot be written. */
      if (cat.selfOnly && String(d.target_id) !== String(userId)) return await invalid('self-only target mismatch');

      const shown = p.shown_previous_json === null || p.shown_previous_json === undefined
        ? null : JSON.parse(p.shown_previous_json);

      /* The disclosure the human approved, assembled from the columns that HOLD
         it rather than re-derived: `shown_previous_json` and `shown_target_id`
         were captured at mint time, and `normalised_value` and `evidence_quote`
         are written once by propose() and cannot change while status is
         'pending' — which is checked above. */
      const disclosure = JSON.stringify({
        value: p.normalised_value,
        writesTo: fieldMap.targetOf(p.category, p.field_key),
        targetId: String(d.target_id),
        replaces: shown,
        evidence: p.evidence_quote,
      });
      /* A NON-SECRET handle for the approval. Not the nonce, and not a
         truncation of its hash — a prefix of a digest is still derived from the
         secret. A card is one issuance per proposal (re-opening overwrites), so
         the proposal id plus the expiry that card carried names it uniquely. */
      const approvalRef = `${proposalId}@${new Date(spent.prev_expires).toISOString()}`;

      /* ── TOCTOU, AND THE SENTINEL THAT MAKES IT WORK ────────────────────
         `readTargetValue` answers {found, value}. The old `currentValue`
         returned a plain null for BOTH "the row is gone" and "the field is
         empty", and conflating those is exactly what let an approval over an
         empty field sail past its snapshot check onto a deleted record. A
         missing row is refused HERE, before the claim, so a deleted target
         never reaches the write at all.

         `forUpdate` locks the business row. Without it, under READ COMMITTED, a
         change committed by another transaction between this read and
         writeField() is silently overwritten — the snapshot is read before that
         commit and the write applied after it. The lock closes the window: the
         row cannot move between the two statements. */
      const live = await readTargetValue(cat, p.field_key, userId, d.target_id, client, true);
      if (!live.found) {
        await client.query('COMMIT');
        outcome = { ok: false, reason: 'target_not_found', why: 'the bound record no longer exists' };
        return { ok: false, reason: 'target_not_found',
                 message: `The ${cat.label} this document is bound to no longer exists in this workspace. `
                        + 'Nothing was changed, and this approval has been used up — re-open the field to '
                        + 'issue a fresh one.' };
      }

      /* The card said "this replaces X". If the target no longer holds X, the
         sentence the human approved is not the sentence that would be executed.
         A DISTINCT reason, because unlike every nonce failure this one is not
         an oracle: the caller already held a valid nonce for this row, so it
         already knew the row existed. */
      if (JSON.stringify(live.value) !== JSON.stringify(shown)) {
        await client.query('COMMIT');
        outcome = { ok: false, reason: 'target_changed', why: 'the live value moved after the card was drawn' };
        return {
          ok: false, reason: 'target_changed',
          message: `This card said it would replace ${JSON.stringify(shown)}, but `
                 + `${fieldMap.targetOf(p.category, p.field_key)} now holds ${JSON.stringify(live.value)}. `
                 + 'Nothing was changed. Re-open the document to see the current value.',
        };
      }

      /* THE STATUS FLIP IS THE CLAIM, AND IT COMES FIRST. If this UPDATE
         matches no row — because something between the SELECT and here moved
         the proposal off 'pending', or because quote_verified is not TRUE — the
         transaction is rolled back and the write below never runs. The write is
         not reachable except through a row this statement claimed. The burn is
         NOT part of this transaction, so rolling back here does not resurrect
         the approval. */
      const claim = await client.query(
        `UPDATE docintel_proposals
            SET status='accepted', accepted_by=$3, accepted_at=NOW(), written_target=$4
          WHERE id=$1 AND user_id=$2 AND status='pending' AND quote_verified=TRUE
          RETURNING id`,
        [proposalId, userId, userId, `${fieldMap.targetOf(p.category, p.field_key)}#${d.target_id}`]
      );
      if (!claim.rows.length) {
        await client.query('ROLLBACK');
        outcome = { ok: false, reason: 'confirm_invalid', why: 'the claim matched no pending, evidenced row' };
        return { ok: false, reason: 'confirm_invalid' };
      }

      /* THE VALUE WRITTEN IS `normalised_value` — the document's own
         characters, normalised. `model_value` is not read here and is not a
         parameter to this statement. */
      const wrote = await writeField(client, cat, field, userId, d.target_id, p.normalised_value);
      if (!wrote) {
        /* Reachable only if the row went away between the locked read above and
           this statement, which the FOR UPDATE should prevent. Kept as a real
           branch rather than an assertion: a write that changed nothing must
           never be reported as a write that succeeded. */
        await client.query('ROLLBACK');
        outcome = { ok: false, reason: 'target_not_found', why: 'the record disappeared under a row lock' };
        return { ok: false, reason: 'target_not_found',
                 message: `The ${cat.label} this document is bound to no longer exists in this workspace. `
                        + 'Nothing was changed.' };
      }

      await client.query('COMMIT');

      outcome = {
        ok: true, reason: null, why: null,
        entity: cat.table, disclosure, approvalRef,
        writesTo: fieldMap.targetOf(p.category, p.field_key), targetId: String(d.target_id),
      };
      return {
        ok: true, proposalId, field: p.field_key,
        writesTo: fieldMap.targetOf(p.category, p.field_key),
        targetId: String(d.target_id), replaced: shown, value: p.normalised_value,
        approvalRef,
      };
    } catch (err) {
      /* A throw here means the write failed. Roll back so the status flip goes
         with it — a proposal marked 'accepted' beside a column that was never
         written is the "logged success without doing work" defect. The nonce
         stays burned regardless, because the burn was never in this
         transaction. The error is re-thrown, not absorbed. */
      await client.query('ROLLBACK').catch((rbErr) => {
        console.error('docintel: rollback failed:', rbErr && rbErr.message ? rbErr.message : rbErr);
      });
      outcome = { ok: false, reason: 'write_failed', why: err && err.message ? err.message : String(err) };
      throw err;
    } finally {
      client.release();
      /* AUDITED ON EVERY PATH, INCLUDING THE THROW. An unrecorded failed write
         is the one an investigation cannot find later. This sits in `finally`
         so a `return` inside the try cannot skip it, and audit() swallows its
         own failure so a broken audit table cannot turn a completed write into
         an error the caller sees. */
      if (outcome) {
        await audit({
          userId, teamId,
          ok: outcome.ok === true,
          entity: outcome.entity || 'docintel_proposals',
          entityId: proposalId,
          approvedShown: outcome.disclosure || null,
          approvalRef: outcome.approvalRef || null,
          detail: outcome.ok ? `wrote ${outcome.writesTo} on ${outcome.targetId}`
                             : `${outcome.reason}: ${outcome.why || 'refused'}`,
        });
      }
    }
  }

  /* ── the audit row ───────────────────────────────────────────────────────
     `audit_log` is created by migrations/004 — Integration added it on this
     branch. The comment that used to sit at the top of this file saying the
     table did not exist has been removed rather than left to mislead.

     IT NEVER THROWS INTO THE CALLER. A write that really happened must not be
     reported as a failure because an audit insert failed. The failure is not
     swallowed either: it is logged loudly and names the proposal, because an
     audit trail with a silent hole in it is worse than one visibly broken.

     THE NONCE IS NOT IN HERE. Not the plaintext, not the hash, not a prefix of
     the hash. */
  async function audit({ userId, teamId, ok, entity, entityId, approvedShown = null, approvalRef = null, detail }) {
    try {
      await q(
        `INSERT INTO audit_log (user_id, team_id, actor, action, entity, entity_id,
                                approved_shown, approval_ref, ok, detail)
         VALUES ($1,$2,'docintel','docintel.accept',$3,$4,$5,$6,$7,$8)`,
        [userId, teamId == null ? null : teamId, entity, entityId == null ? null : String(entityId),
         approvedShown, approvalRef, !!ok, detail == null ? null : String(detail).slice(0, 2000)]
      );
    } catch (err) {
      console.error('docintel: AUDIT ROW NOT WRITTEN for proposal ' + entityId + ' — '
                    + (err && err.message ? err.message : err));
    }
  }

  /** THE ONE STATEMENT THAT WRITES AN EXTRACTED VALUE.
   *
   *  Table, column and owner column are `ident()`-checked constants out of
   *  fieldMap.js. The VALUE is `$1`, always. Returns false if the target row is
   *  gone, so the caller rolls back rather than reporting a success that
   *  changed nothing. */
  async function writeField(client, cat, field, userId, targetId, value) {
    const table = ident(cat.table, 'a table name');
    const col = ident(field.column, 'a column name');
    const own = ident(cat.ownerColumn, 'an owner column');
    const r = await client.query(
      `UPDATE ${table} SET ${col} = $1 WHERE id = $2 AND ${own} = $3 RETURNING id`,
      [value, targetId, userId]
    );
    return r.rows.length > 0;
  }

  /* ── 6. reject ───────────────────────────────────────────────────────────
     Also ONE AT A TIME, and deliberately NOT nonce-gated: a rejection writes
     nothing to a business table, so requiring a card for it would make
     dismissing a bad proposal harder than accepting a good one — the wrong way
     round for a feature whose whole purpose is friction on writes. */
  async function rejectProposal({ proposalId, userId, reason }) {
    if (!isUuid(proposalId)) return { ok: false, reason: 'not_found' };
    const r = await q(
      `UPDATE docintel_proposals
          SET status='rejected', reject_reason=$3, accepted_by=$4, accepted_at=NOW(),
              accept_nonce_hash=NULL, accept_nonce_user=NULL, accept_nonce_expires_at=NULL
        WHERE id=$1 AND user_id=$2 AND status='pending'
        RETURNING id, document_id, field_key`,
      [proposalId, userId, String(reason || 'Rejected by reviewer').slice(0, 400), userId]
    );
    if (!r.rows.length) return { ok: false, reason: 'not_found' };
    return { ok: true, proposalId };
  }

  async function listDocuments(userId, limit = 50) {
    const r = await q(
      `SELECT id, filename, mime_type, byte_size, text_status, extraction_note, category,
              target_kind, target_id, created_at, proposed_at
         FROM docintel_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
    );
    return r.rows;
  }

  /** Candidate records to bind to. Read-only, owner-scoped, and the ONLY way a
   *  target id gets in front of a human — the model is never asked which
   *  record a document is about. */
  async function listTargets(categoryKey, userId) {
    const cat = fieldMap.getCategory(categoryKey);
    if (!cat) return null;
    if (cat.selfOnly) {
      const r = await q('SELECT id, name, email, brand_name FROM users WHERE id = $1', [userId]);
      return r.rows.map((u) => ({
        id: String(u.id),
        label: [u.brand_name || u.name, u.email].filter(Boolean).join(' — ') || `Account ${u.id}`,
      }));
    }
    const r = await q(
      `SELECT id, headline, company_name, created_at FROM pr_releases
        WHERE user_id = $1 ORDER BY id DESC LIMIT 200`,
      [userId]
    );
    return r.rows.map((p) => ({
      id: String(p.id),
      label: [p.company_name, p.headline].filter(Boolean).join(' — ') || `Release ${p.id}`,
    }));
  }

  return {
    ingest, getDocument, getDocumentBytes, bindTarget, propose,
    listProposals, openCard, acceptProposal, rejectProposal, listDocuments, listTargets,
    // exposed for the harness; not used by the routes
    readTargetValue, audit, blocksOf, chunk, buildSystem, buildPrompt, writeField, ident, isUuid,
    NONCE_TTL_MS,
  };
}

module.exports = { createDocIntel, NONCE_TTL_MS, MAX_CHARS_PER_CALL, MAX_CALLS, UUID_RE, isUuid, sha256 };

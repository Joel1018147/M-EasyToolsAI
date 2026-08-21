'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   LANE B — DOCUMENT INTELLIGENCE · THE HUMAN-CONFIRMATION BAR
   GAUNTLET.md §H · UPGRADE-SPEC.md §1.2
   ───────────────────────────────────────────────────────────────────────────
   THIS SUITE EXECUTES THE REAL CODE. It does not read source as text and
   assert on strings — a suite that greps has been the shape of three
   consecutive escapes in this ecosystem. `lib/docintel/service.js` is
   constructed here against a HAND-ROLLED FAKE pg CLIENT that is a real little
   store (rows go in, rows come out, a ROLLBACK really rolls back) and that
   RECORDS EVERY SQL STATEMENT IT WAS GIVEN, so the assertions below are about
   what the code actually did to a database, in what order.

   ── WHY A FAKE AND NOT A DATABASE ─────────────────────────────────────────
   There is no local PostgreSQL: `postgres.railway.internal` resolves only
   inside Railway, and `pg-mem` is not installed and package.json is not this
   lane's file to edit. Stated plainly rather than worked around — see the GAPS
   section at the bottom of this file, which is printed on every run.

   Three things stop the fake from making this vacuous:
     1. It is a STORE, not a script of canned answers. Replay, the status flip,
        the burn-before-check ordering and the TOCTOU snapshot are all observed
        against real state transitions, not stubbed.
     2. Every statement is recorded, so "the nonce was checked before the
        write" is an assertion about the ORDER OF REAL STATEMENTS.
     3. The guards are additionally driven DIRECTLY with adversarial inputs, so
        their behaviour does not depend on the fake at all.
     4. §11 MUTATION-TESTS EVERY GUARD. Five broken copies of the service are
        compiled in memory, one per guard, and each one is observed PERFORMING
        THE WRITE the intact build refuses. A guard nobody can break is a guard
        nobody has shown to be load-bearing.
   ═══════════════════════════════════════════════════════════════════════════ */

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');

const guards = require('../lib/docintel/guards');
const fieldMap = require('../lib/docintel/fieldMap');
const textLayer = require('../lib/docintel/textLayer');
const { createDocIntel, sha256 } = require('../lib/docintel/service');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + label); }
  else { fail += 1; failures.push(label); console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function head(t) { console.log('\n' + t); }

/* ═══════════════════════════════════════════════════════════════════════════
   THE FAKE DATABASE
   ═══════════════════════════════════════════════════════════════════════════ */
const uuid = () => crypto.randomUUID();
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function makeDb() {
  const store = {
    docintel_documents: new Map(),
    docintel_proposals: new Map(),
    pr_releases: new Map(),
    users: new Map(),
    audit_log: [],
  };
  const log = [];
  let snapshot = null;

  /* THE TRANSACTION SNAPSHOT COVERS ONLY WHAT A TRANSACTION COVERS.
     `audit_log` is deliberately excluded, and so is anything written through
     `query()` while no BEGIN is open — the fake models a POOL statement as
     autocommitted, which is the whole property the durable burn relies on. A
     fake that rolled those back would hide the bug rather than expose it. */
  const clone = () => JSON.parse(JSON.stringify({
    d: [...store.docintel_documents], p: [...store.docintel_proposals],
    r: [...store.pr_releases], u: [...store.users],
  }));
  const restore = (snap) => {
    store.docintel_documents = new Map(snap.d);
    store.docintel_proposals = new Map(snap.p);
    store.pr_releases = new Map(snap.r);
    store.users = new Map(snap.u);
  };

  let failOn = null;
  let legacyBurn = false;
  let legacyPending = null;

  function route(text, params) {
    const s = norm(text);
    const P = params || [];

    /* Fault injection. A transient database error on the business write is the
       second way the critic reached a replayable nonce, and it has to be
       reproducible without waiting for a real deadlock. */
    if (failOn && failOn.test(s)) {
      failOn = null;
      const e = new Error('deadlock detected');
      e.code = '40P01';
      throw e;
    }

    if (s === 'BEGIN') {
      snapshot = clone();
      /* LEGACY MODE ONLY. `legacyBurnInTransaction()` makes the fake behave the
         way the code did before this branch: the burn is part of the
         transaction, so the snapshot a ROLLBACK restores still holds the nonce.
         Modelled by rewinding the snapshot's copy of the burned row to its
         pre-burn values — the burn is then, in effect, inside the BEGIN. */
      if (legacyBurn && legacyPending) {
        for (const entry of snapshot.p) {
          if (entry[0] === legacyPending.id) {
            entry[1].accept_nonce_hash = legacyPending.hash;
            entry[1].accept_nonce_user = legacyPending.user;
            entry[1].accept_nonce_expires_at = legacyPending.expires;
          }
        }
      }
      return { rows: [] };
    }
    if (s === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (s === 'ROLLBACK') { if (snapshot) restore(snapshot); snapshot = null; return { rows: [] }; }

    /* ── docintel_documents ─────────────────────────────────────────────── */
    if (/^INSERT INTO docintel_documents/.test(s)) {
      const id = uuid();
      const row = {
        id, user_id: P[0], team_id: P[1], uploaded_by: P[2], filename: P[3], mime_type: P[4],
        byte_size: P[5], sha256: P[6], content: P[7], text_status: P[8], extracted_text: P[9],
        block_count: P[10], extraction_note: P[11], category: null, target_kind: null, target_id: null,
        model: null, proposed_at: null, created_at: new Date().toISOString(),
      };
      store.docintel_documents.set(id, row);
      return { rows: [{ id, filename: row.filename, mime_type: row.mime_type, byte_size: row.byte_size,
                        text_status: row.text_status, block_count: row.block_count,
                        extraction_note: row.extraction_note, created_at: row.created_at }] };
    }
    if (/^SELECT id, user_id, filename,.*FROM docintel_documents WHERE id = \$1 AND user_id = \$2/.test(s)) {
      const d = store.docintel_documents.get(P[0]);
      return { rows: d && String(d.user_id) === String(P[1]) ? [Object.assign({}, d)] : [] };
    }
    if (/^SELECT filename, mime_type, content FROM docintel_documents/.test(s)) {
      const d = store.docintel_documents.get(P[0]);
      return { rows: d && String(d.user_id) === String(P[1]) ? [d] : [] };
    }
    if (/^SELECT id, category, target_id FROM docintel_documents WHERE id=\$1 AND user_id=\$2 FOR UPDATE/.test(s)) {
      const d = store.docintel_documents.get(P[0]);
      return { rows: d && String(d.user_id) === String(P[1]) ? [Object.assign({}, d)] : [] };
    }
    if (/^UPDATE docintel_documents SET category=\$3/.test(s)) {
      const d = store.docintel_documents.get(P[0]);
      if (d && String(d.user_id) === String(P[1])) {
        d.category = P[2]; d.target_kind = 'existing'; d.target_id = P[3]; d.bound_by = P[4];
      }
      return { rows: [] };
    }
    if (/^UPDATE docintel_documents SET model=\$3/.test(s)) {
      const d = store.docintel_documents.get(P[0]);
      if (d && String(d.user_id) === String(P[1])) { d.model = P[2]; d.proposed_at = new Date().toISOString(); }
      return { rows: [] };
    }
    if (/^SELECT id, filename, mime_type, byte_size, text_status/.test(s)) {
      return { rows: [...store.docintel_documents.values()].filter((d) => String(d.user_id) === String(P[0])) };
    }

    /* ── docintel_proposals ─────────────────────────────────────────────── */
    if (/^INSERT INTO docintel_proposals .*'pending'/.test(s)) {
      const id = uuid();
      store.docintel_proposals.set(id, {
        id, document_id: P[0], user_id: P[1], category: P[2], field_key: P[3], raw_value: P[4],
        normalised_value: P[5], model_value: P[6], evidence_quote: P[7], evidence_block: P[8],
        quote_verified: true, status: 'pending', reject_reason: null, model: P[9],
        accept_nonce_hash: null, accept_nonce_user: null, accept_nonce_expires_at: null,
        shown_previous_json: null, shown_target_id: null, written_target: null,
        accepted_by: null, accepted_at: null, created_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (/^INSERT INTO docintel_proposals .*'auto_rejected'/.test(s)) {
      const id = uuid();
      store.docintel_proposals.set(id, {
        id, document_id: P[0], user_id: P[1], category: P[2], field_key: P[3], raw_value: null,
        normalised_value: null, model_value: P[4], evidence_quote: P[5], evidence_block: null,
        quote_verified: false, status: 'auto_rejected', reject_reason: P[6], model: P[7],
        accept_nonce_hash: null, accept_nonce_user: null, accept_nonce_expires_at: null,
        shown_previous_json: null, shown_target_id: null, written_target: null,
        accepted_by: null, accepted_at: null, created_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (/^DELETE FROM docintel_proposals WHERE document_id=\$1/.test(s)) {
      for (const [k, v] of store.docintel_proposals) {
        if (v.document_id === P[0] && String(v.user_id) === String(P[1])
            && (v.status === 'pending' || v.status === 'auto_rejected')) store.docintel_proposals.delete(k);
      }
      return { rows: [] };
    }
    if (/^SELECT id, document_id, category, field_key, raw_value, normalised_value, model_value, evidence_quote, evidence_block, quote_verified, status FROM docintel_proposals WHERE id=\$1 AND user_id=\$2$/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      return { rows: p && String(p.user_id) === String(P[1]) ? [Object.assign({}, p)] : [] };
    }
    if (/^SELECT id, field_key, raw_value,.*FROM docintel_proposals WHERE document_id=\$1/.test(s)) {
      const rows = [...store.docintel_proposals.values()]
        .filter((p) => p.document_id === P[0] && String(p.user_id) === String(P[1]))
        .sort((a, b) => (a.status + a.field_key).localeCompare(b.status + b.field_key));
      return { rows: rows.map((r) => Object.assign({}, r)) };
    }
    if (/^UPDATE docintel_proposals SET accept_nonce_hash=\$3, accept_nonce_user=\$4/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      if (!p || String(p.user_id) !== String(P[1]) || p.status !== 'pending' || p.quote_verified !== true) {
        return { rows: [] };
      }
      p.accept_nonce_hash = P[2]; p.accept_nonce_user = P[3]; p.accept_nonce_expires_at = P[4];
      p.shown_previous_json = P[5]; p.shown_target_id = P[6];
      return { rows: [{ id: p.id }] };
    }
    /* THE DURABLE BURN. Modelled as an autocommitted pool statement: it is
       applied to `store` immediately and is NOT captured by any open BEGIN
       snapshot, because the real statement runs on the pool and commits on its
       own. It returns the PRE-burn values. */
    if (/^WITH prev AS \( SELECT id, accept_nonce_hash, accept_nonce_user, accept_nonce_expires_at FROM docintel_proposals WHERE id = \$1 AND user_id = \$2 FOR UPDATE \) UPDATE docintel_proposals d/.test(s)) {
      const row = store.docintel_proposals.get(P[0]);
      if (!row || String(row.user_id) !== String(P[1])) return { rows: [] };
      const prev = { prev_hash: row.accept_nonce_hash, prev_user: row.accept_nonce_user,
                     prev_expires: row.accept_nonce_expires_at };
      legacyPending = { id: P[0], hash: prev.prev_hash, user: prev.prev_user, expires: prev.prev_expires };
      row.accept_nonce_hash = null; row.accept_nonce_user = null; row.accept_nonce_expires_at = null;
      /* Nothing else to do. This statement runs BEFORE any BEGIN, so the
         snapshot a later ROLLBACK restores is taken from a store in which the
         nonce is already gone — which is precisely the durability the real
         pool statement buys, expressed in the fake. */
      return { rows: [prev] };
    }

    if (/^INSERT INTO audit_log /.test(s)) {
      store.audit_log.push({
        user_id: P[0], team_id: P[1], actor: 'docintel', action: 'docintel.accept',
        entity: P[2], entity_id: P[3], approved_shown: P[4], approval_ref: P[5],
        ok: P[6], detail: P[7],
      });
      return { rows: [] };
    }

    if (/^UPDATE docintel_proposals SET accept_nonce_hash=NULL, accept_nonce_user=NULL, accept_nonce_expires_at=NULL WHERE document_id=\$1/.test(s)) {
      for (const p of store.docintel_proposals.values()) {
        if (p.document_id === P[0] && String(p.user_id) === String(P[1])) {
          p.accept_nonce_hash = null; p.accept_nonce_user = null; p.accept_nonce_expires_at = null;
        }
      }
      return { rows: [] };
    }
    if (/^UPDATE docintel_proposals SET accept_nonce_hash=NULL, accept_nonce_user=NULL, accept_nonce_expires_at=NULL WHERE id=\$1/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      if (p && String(p.user_id) === String(P[1])) {
        p.accept_nonce_hash = null; p.accept_nonce_user = null; p.accept_nonce_expires_at = null;
      }
      return { rows: [] };
    }
    if (/^SELECT id, document_id, category, field_key, normalised_value,.*FOR UPDATE/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      return { rows: p && String(p.user_id) === String(P[1]) ? [Object.assign({}, p)] : [] };
    }
    if (/^UPDATE docintel_proposals SET status='accepted'/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      if (!p || String(p.user_id) !== String(P[1]) || p.status !== 'pending' || p.quote_verified !== true) {
        return { rows: [] };
      }
      p.status = 'accepted'; p.accepted_by = P[2]; p.written_target = P[3];
      p.accepted_at = new Date().toISOString();
      return { rows: [{ id: p.id }] };
    }
    if (/^UPDATE docintel_proposals SET status='rejected'/.test(s)) {
      const p = store.docintel_proposals.get(P[0]);
      if (!p || String(p.user_id) !== String(P[1]) || p.status !== 'pending') return { rows: [] };
      p.status = 'rejected'; p.reject_reason = P[2]; p.accepted_by = P[3];
      p.accept_nonce_hash = null; p.accept_nonce_user = null; p.accept_nonce_expires_at = null;
      return { rows: [{ id: p.id, document_id: p.document_id, field_key: p.field_key }] };
    }

    /* ── business tables ────────────────────────────────────────────────── */
    let m = /^SELECT id FROM ([a-z_]+) WHERE id = \$1 AND ([a-z_]+) = \$2$/.exec(s);
    if (m) {
      const row = store[m[1]] && store[m[1]].get(String(P[0]));
      const owned = row && (m[2] === 'id' ? String(row.id) === String(P[1]) : String(row[m[2]]) === String(P[1]));
      return { rows: owned ? [{ id: row.id }] : [] };
    }
    m = /^SELECT ([a-z_]+) AS v FROM ([a-z_]+) WHERE id = \$1 AND ([a-z_]+) = \$2(?: FOR UPDATE)?$/.exec(s);
    if (m) {
      const row = store[m[2]] && store[m[2]].get(String(P[0]));
      const owned = row && (m[3] === 'id' ? String(row.id) === String(P[1]) : String(row[m[3]]) === String(P[1]));
      return { rows: owned ? [{ v: row[m[1]] === undefined ? null : row[m[1]] }] : [] };
    }
    m = /^UPDATE ([a-z_]+) SET ([a-z_]+) = \$1 WHERE id = \$2 AND ([a-z_]+) = \$3 RETURNING id$/.exec(s);
    if (m) {
      const row = store[m[1]] && store[m[1]].get(String(P[1]));
      const owned = row && (m[3] === 'id' ? String(row.id) === String(P[2]) : String(row[m[3]]) === String(P[2]));
      if (!owned) return { rows: [] };
      row[m[2]] = P[0];
      return { rows: [{ id: row.id }] };
    }
    if (/^SELECT id, headline, company_name, created_at FROM pr_releases/.test(s)) {
      return { rows: [...store.pr_releases.values()].filter((r) => String(r.user_id) === String(P[0])) };
    }
    if (/^SELECT id, name, email, brand_name FROM users/.test(s)) {
      const u = store.users.get(String(P[0]));
      return { rows: u ? [u] : [] };
    }

    throw new Error('fake db: no route for SQL — ' + s.slice(0, 160));
  }

  const query = (text, params) => {
    log.push({ text: norm(text), params: params || [] });
    return Promise.resolve(route(text, params));
  };

  return {
    query,
    connect: () => Promise.resolve({ query, release() {} }),
    log,
    store,
    /** Statements that wrote to a BUSINESS table — the thing the Bar is about. */
    businessWrites: () => log.filter((e) => /^UPDATE (pr_releases|users) SET/.test(e.text)),
    reset: () => { log.length = 0; },
    failNext: (re) => { failOn = re; },
    /* Models the OLD, broken arrangement: the burn inside the transaction, so a
       ROLLBACK takes it with it. Used by §11's M8 to reproduce the breach. */
    legacyBurnInTransaction: () => { legacyBurn = true; },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   A FIXTURE DOCUMENT AND A SCRIPTED MODEL
   ═══════════════════════════════════════════════════════════════════════════ */
const DOC_TEXT = [
  'PRESS BRIEF — CONFIDENTIAL DRAFT',
  'Company: Kedai Kopi Serumpun Sdn Bhd, a speciality coffee roaster based in George Town.',
  'Headline: Kedai Kopi Serumpun opens its first roastery in Penang this November.',
  'Spokesperson available for comment: Aisyah binti Rahman, Managing Director.',
  'Primary audience for this announcement: consumers across the northern region.',
  'Distribution region: Malaysia only, with a Singapore follow-up under consideration.',
].join('\n');

const USER_A = 7;
const USER_B = 8;
const RELEASE_1 = '101';
const RELEASE_2 = '102';

function seed(db) {
  db.store.users.set(String(USER_A), { id: USER_A, name: 'Joel', email: 'joel@example.com',
                                       brand_name: null, brand_desc: null, brand_tone: 'Professional' });
  db.store.users.set(String(USER_B), { id: USER_B, name: 'Other', email: 'other@example.com', brand_name: null });
  db.store.pr_releases.set(RELEASE_1, { id: RELEASE_1, user_id: USER_A, company_name: null, headline: null,
                                        spokesperson: null, audience: null, region: null });
  db.store.pr_releases.set(RELEASE_2, { id: RELEASE_2, user_id: USER_A, company_name: null, headline: null,
                                        spokesperson: null, audience: null, region: null });
}

/** A deliberately adversarial model. One honest line, and four attacks. */
const ADVERSARIAL_REPLY = [
  // honest: quote is verbatim, value is inside it
  'spokesperson|Spokesperson available for comment: Aisyah binti Rahman, Managing Director.|Aisyah binti Rahman',
  // GUARD 1 attack: quotes a real sentence, then types a DIFFERENT name
  'company_name|Company: Kedai Kopi Serumpun Sdn Bhd, a speciality coffee roaster based in George Town.|Nurul Holdings Berhad',
  // GUARD 2 attack: a fabricated sentence that is not in the document
  'headline|Kedai Kopi Serumpun announces a RM40 million funding round led by Khazanah.|RM40 million',
  // GUARD 3 attack: a column that exists on `users` but is not in the field map
  'api_key|Distribution region: Malaysia only, with a Singapore follow-up under consideration.|Malaysia',
  // GUARD 3 attack: value is genuinely in the quote, but the normaliser refuses it
  'audience|Primary audience for this announcement: consumers across the northern region.|northern region',
  // GUARD 2 attack: a correct value with a quote too short to be evidence
  'region|Malaysia only|Malaysia',
].join('\n');

async function buildBound(reply, clockRef) {
  const db = makeDb();
  seed(db);
  const svc = createDocIntel({
    db,
    generate: async () => reply,
    model: 'test-model',
    now: () => clockRef.t,
  });
  const up = await svc.ingest({
    userId: USER_A, teamId: null, filename: 'brief.txt', mimeType: 'text/plain',
    bytes: Buffer.from(DOC_TEXT, 'utf8'),
  });
  assert.strictEqual(up.ok, true, 'fixture ingest must succeed');
  const docId = up.document.id;
  const bound = await svc.bindTarget({ documentId: docId, userId: USER_A, category: 'pr_release', targetId: RELEASE_1 });
  assert.strictEqual(bound.ok, true, 'fixture bind must succeed');
  return { db, svc, docId };
}

/* ═══════════════════════════════════════════════════════════════════════════ */
(async function run() {

/* ── §1 · GUARD 1 — THE MODEL IS A LOCATOR, NEVER A SOURCE ───────────────── */
head('§1  GUARD 1 — the model is a locator, never a source');
{
  const blocks = DOC_TEXT.split('\n');

  const attack = guards.verify(
    { fieldKey: 'company_name',
      quote: 'Company: Kedai Kopi Serumpun Sdn Bhd, a speciality coffee roaster based in George Town.',
      value: 'Nurul Holdings Berhad' },
    'pr_release', blocks);
  ok('a model that quotes a REAL sentence and types a DIFFERENT value gets nothing',
     attack.ok === false, JSON.stringify(attack));
  ok('  …and the rejection carries no value field at all (no partial shape to mis-read)',
     attack.rawValue === undefined && attack.normalisedValue === undefined);
  ok('  …and the reason names the actual failure',
     /does not appear inside the quote/.test(attack.reason || ''), attack.reason);

  const honest = guards.verify(
    { fieldKey: 'company_name',
      quote: 'Company: Kedai Kopi Serumpun Sdn Bhd, a speciality coffee roaster based in George Town.',
      value: 'Kedai Kopi Serumpun Sdn Bhd' },
    'pr_release', blocks);
  ok('an honest proposal survives all three guards', honest.ok === true, JSON.stringify(honest));
  ok('  …and the value written is sliced from the DOCUMENT, not copied from the model',
     honest.rawValue === 'Kedai Kopi Serumpun Sdn Bhd');

  /* The value is the document's characters even when the model retypes them in
     a different case — proof the write comes from the slice, not the reply. */
  const recased = guards.verify(
    { fieldKey: 'company_name',
      quote: 'company: KEDAI KOPI SERUMPUN SDN BHD, a speciality coffee roaster based in George Town.',
      value: 'kedai kopi serumpun sdn bhd' },
    'pr_release', blocks);
  ok('a quote and value retyped in the wrong case still yield the DOCUMENT\'s own characters',
     recased.ok === true && recased.rawValue === 'Kedai Kopi Serumpun Sdn Bhd',
     JSON.stringify(recased));
  ok('  …and model_value keeps what the model actually typed, for the audit row',
     recased.modelValue === 'kedai kopi serumpun sdn bhd');
}

/* ── §2 · GUARD 2 — EVERY PROPOSAL NEEDS LOCATED EVIDENCE ────────────────── */
head('§2  GUARD 2 — every proposal needs a verbatim quote, located in the document');
{
  const blocks = DOC_TEXT.split('\n');

  const fabricated = guards.verify(
    { fieldKey: 'headline',
      quote: 'Kedai Kopi Serumpun announces a RM40 million funding round led by Khazanah.',
      value: 'RM40 million' },
    'pr_release', blocks);
  ok('a fabricated quote is rejected', fabricated.ok === false && /does not appear anywhere/.test(fabricated.reason));

  const tooShort = guards.verify(
    { fieldKey: 'region', quote: 'Malaysia only', value: 'Malaysia' }, 'pr_release', blocks);
  ok('a quote under ' + guards.MIN_QUOTE_CHARS + ' characters is not evidence, even when the value is correct',
     tooShort.ok === false && /at least 25/.test(tooShort.reason), tooShort.reason);
  ok('  …and "too short" is a DIFFERENT reason from "not found" (laziness vs fabrication)',
     tooShort.reason !== fabricated.reason);

  /* PDF line-wrapping must not fail a correct quote: same sentence, broken
     across lines, double-spaced, and in the wrong case. */
  const wrapped = guards.verify(
    { fieldKey: 'spokesperson',
      quote: 'Spokesperson  available\nfor   comment:  AISYAH BINTI RAHMAN,\nManaging Director.',
      value: 'Aisyah   binti\nRahman' },
    'pr_release', blocks);
  ok('a correct quote broken by a line wrap and re-cased still locates',
     wrapped.ok === true && wrapped.rawValue === 'Aisyah binti Rahman', JSON.stringify(wrapped));

  const huge = guards.verify(
    { fieldKey: 'headline', quote: 'x'.repeat(guards.MAX_QUOTE_CHARS + 1), value: 'x' }, 'pr_release', blocks);
  ok('quoting more than a human reads at a glance is not evidence either', huge.ok === false);
}

/* ── §3 · GUARD 3 — UNKNOWN KEY OR UNPARSEABLE VALUE IS DROPPED ──────────── */
head('§3  GUARD 3 — an unknown field key or unparseable value is DROPPED, never coerced');
{
  const blocks = DOC_TEXT.split('\n');

  for (const forbidden of ['password', 'api_key', 'groq_key', 'role', 'plan', 'email', 'id']) {
    ok('`users.' + forbidden + '` is unreachable — getField(brand, ' + forbidden + ') is null',
       fieldMap.getField('brand', forbidden) === null);
  }
  ok('`__proto__` and `constructor` do not resolve to a field definition',
     fieldMap.getField('brand', '__proto__') === null && fieldMap.getField('pr_release', 'constructor') === null);
  ok('an unknown CATEGORY does not resolve either',
     fieldMap.getCategory('journalist') === null && fieldMap.getCategory('__proto__') === null);
  ok('journalists / media_outlets are named as ABSENT with a reason, not silently missing',
     typeof fieldMap.ABSENT_CATEGORIES.journalist === 'string'
     && /no per-user owner column/.test(fieldMap.ABSENT_CATEGORIES.journalist));

  const parsed = guards.parseProposals(ADVERSARIAL_REPLY, 'pr_release');
  ok('a line naming `api_key` is dropped at the parse, before any verification',
     parsed.dropped.some((d) => d.fieldKey === 'api_key')
     && !parsed.kept.some((k) => k.fieldKey === 'api_key'));

  const refused = guards.verify(
    { fieldKey: 'audience',
      quote: 'Primary audience for this announcement: consumers across the northern region.',
      value: 'northern region' },
    'pr_release', blocks);
  ok('a value that IS in the quote but which the normaliser refuses is dropped, not coerced',
     refused.ok === false && /not one of the audiences/.test(refused.reason), refused.reason);

  const accepted = guards.verify(
    { fieldKey: 'audience',
      quote: 'Primary audience for this announcement: consumers across the northern region.',
      value: 'consumers' },
    'pr_release', blocks);
  ok('  …while a value from the fixed vocabulary is accepted', accepted.ok === true);

  /* No branch anywhere builds an identifier from model output. `ident()` is the
     belt to fieldMap's braces, and it must actually throw. */
  const db0 = makeDb();
  const svc0 = createDocIntel({ db: db0, generate: async () => '', model: 'm' });
  let threw = 0;
  for (const bad of ['headline; DROP TABLE users', 'Headline', '1abc', '', 'a'.repeat(80), null]) {
    try { svc0.ident(bad, 'a column name'); } catch (e) { threw += 1; }
  }
  ok('ident() refuses every non-identifier it was handed (' + threw + '/6)', threw === 6);
}

/* ── §4 · THE NONCE — MINTED ONLY WITH THE CARD ──────────────────────────── */
head('§4  THE NONCE — server-issued, per-field, and minted only with the evidence card');
{
  const clock = { t: Date.now() };
  const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);

  const proposed = await svc.propose({ documentId: docId, userId: USER_A });
  ok('propose() writes NOTHING to a business table', db.businessWrites().length === 0);
  ok('exactly ONE of six adversarial lines survived the guards',
     proposed.proposals === 1, JSON.stringify(proposed));
  ok('the other five are PERSISTED as auto_rejected, not discarded',
     proposed.autoRejected === 5, String(proposed.autoRejected));

  const persistedRejects = [...db.store.docintel_proposals.values()].filter((p) => p.status === 'auto_rejected');
  ok('  …and a reviewer can read the model\'s failure rate out of the table',
     persistedRejects.length === 5 && persistedRejects.every((p) => typeof p.reject_reason === 'string'
                                                                 && p.reject_reason.length > 10));
  ok('  …every auto_rejected row carries quote_verified = FALSE',
     persistedRejects.every((p) => p.quote_verified === false));

  /* LISTING THE DOCUMENT MINTS NOTHING. This is the property that makes the
     token belong to a card a person opened, rather than to a page they loaded. */
  db.reset();
  const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
  ok('the document view is a PURE READ — it issues no approval token at all',
     listed.proposals.every((p) => p.acceptNonce === undefined)
     && !db.log.some((e) => /SET accept_nonce_hash=\$3/.test(e.text)));
  ok('  …and it does not disclose what would be overwritten either — that is the card’s job',
     listed.proposals.every((p) => p.overwrites === undefined));
  const pendingRows = listed.proposals.filter((p) => p.status === 'pending');
  ok('  …it says only that a card COULD be opened for the one pending field',
     pendingRows.length === 1 && pendingRows[0].openable === true);

  /* OPENING ONE FIELD is what mints. One call, one proposal, one token. */
  const before = db.log.length;
  const opened = await svc.openCard({ proposalId: pendingRows[0].id, userId: USER_A });
  ok('opening ONE field’s card mints exactly one token',
     opened.ok === true && typeof opened.card.acceptNonce === 'string' && opened.card.acceptNonce.length === 64,
     JSON.stringify(opened));
  const card = opened.card;
  ok('  …and the card discloses what it would overwrite',
     Object.prototype.hasOwnProperty.call(card, 'overwrites') && card.overwrites === null);
  ok('  …and which record, and which column',
     card.targetId === RELEASE_1 && card.writesTo === 'pr_releases.spokesperson');
  ok('  …and it shows BOTH what the document says and what the model typed',
     card.documentSaid === 'Aisyah binti Rahman' && card.modelTyped === 'Aisyah binti Rahman');
  const pending = [card];

  const nonce = card.acceptNonce;
  const minted = db.log.slice(before).filter((e) => /SET accept_nonce_hash=\$3/.test(e.text));
  ok('opening one card issued exactly ONE token, not one per proposal', minted.length === 1, String(minted.length));
  ok('only the sha256 HASH is stored — the plaintext is never a query parameter',
     minted.length === 1 && minted[0].params[2] === sha256(nonce) && minted[0].params[2] !== nonce);
  ok('the plaintext nonce appears in NO recorded SQL text and NO recorded parameter',
     !db.log.some((e) => e.text.includes(nonce) || e.params.some((p) => String(p) === nonce)));
  ok('the nonce is bound to a user and to an expiry',
     minted[0].params[3] === USER_A && minted[0].params[4] instanceof Date);
  ok('the snapshot of BOTH halves of the sentence is captured (value AND record)',
     minted[0].params[5] === 'null' && minted[0].params[6] === RELEASE_1);
  ok('the mint statement is itself guarded by status=pending AND quote_verified=TRUE',
     /status='pending' AND quote_verified=TRUE/.test(minted[0].text));

  /* An auto_rejected row has no card to open, so no token can be minted for
     one — the refusal happens before crypto.randomBytes is ever reached. */
  const rejectedRow = [...db.store.docintel_proposals.values()].find((p) => p.status === 'auto_rejected');
  const noCard = await svc.openCard({ proposalId: rejectedRow.id, userId: USER_A });
  ok('an auto_rejected proposal cannot have a card opened for it',
     noCard.ok === false && noCard.reason === 'not_pending', JSON.stringify(noCard));
  ok('  …and no token was written to its row',
     db.store.docintel_proposals.get(rejectedRow.id).accept_nonce_hash === null);
  const otherCard = await svc.openCard({ proposalId: pendingRows[0].id, userId: USER_B });
  ok('another account cannot open a card on this account’s proposal',
     otherCard.ok === false && otherCard.reason === 'not_found');

  /* ── the happy path, and the ORDER of what it did ─────────────────────── */
  db.reset();
  const wrote = await svc.acceptProposal({ proposalId: pending[0].id, userId: USER_A, nonce });
  ok('a valid, freshly-minted nonce writes the one field it was issued for', wrote.ok === true, JSON.stringify(wrote));

  const bw = db.businessWrites();
  ok('exactly ONE business-table statement ran', bw.length === 1, String(bw.length));
  ok('  …and it is a parameterized UPDATE of one allow-listed column',
     bw[0].text === 'UPDATE pr_releases SET spokesperson = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
     bw[0].text);
  ok('  …the VALUE travels as a parameter and never appears in the SQL text',
     bw[0].params[0] === 'Aisyah binti Rahman' && !bw[0].text.includes('Aisyah'));
  ok('  …and it landed on the right row', db.store.pr_releases.get(RELEASE_1).spokesperson === 'Aisyah binti Rahman');
  ok('  …and the OTHER record was not touched', db.store.pr_releases.get(RELEASE_2).spokesperson === null);

  const iBurn  = db.log.findIndex((e) => /^WITH prev AS \( SELECT id, accept_nonce_hash/.test(e.text));
  const iBegin = db.log.findIndex((e) => e.text === 'BEGIN');
  const iCheck = db.log.findIndex((e) => /FROM docintel_proposals WHERE id=\$1 AND user_id=\$2 FOR UPDATE/.test(e.text));
  const iClaim = db.log.findIndex((e) => /SET status='accepted'/.test(e.text));
  const iWrite = db.log.findIndex((e) => /^UPDATE pr_releases SET/.test(e.text));
  ok('THE NONCE IS SPENT BY BEING TOUCHED — burned before any check that could reject it',
     iBurn !== -1 && iCheck !== -1 && iBurn < iCheck && iBurn < iClaim, `${iBurn},${iCheck},${iClaim}`);
  ok('  …and the burn happens BEFORE `BEGIN`, so no rollback can reach it',
     iBegin !== -1 && iBurn < iBegin, `burn at ${iBurn}, BEGIN at ${iBegin}`);
  ok('  …in ONE statement, so there is no window between reading the hash and clearing it',
     db.log[iBurn].text.includes('FOR UPDATE') && /SET accept_nonce_hash = NULL/.test(db.log[iBurn].text)
     && /RETURNING prev\.accept_nonce_hash/.test(db.log[iBurn].text), db.log[iBurn].text.slice(0, 120));
  ok('  …and the burn is user-scoped, so one account cannot burn another’s approval',
     /WHERE id = \$1 AND user_id = \$2/.test(db.log[iBurn].text) && db.log[iBurn].params[1] === USER_A);
  ok('THE STATUS FLIP IS THE CLAIM AND IT COMES FIRST — before the business write',
     iClaim !== -1 && iWrite !== -1 && iClaim < iWrite, `${iClaim} < ${iWrite}`);
  ok('the business row is LOCKED before its value is snapshotted, so a concurrent commit cannot slip in',
     db.log.some((e) => /^SELECT spokesperson AS v FROM pr_releases WHERE id = \$1 AND user_id = \$2 FOR UPDATE$/
       .test(e.text)),
     db.log.filter((e) => /AS v FROM pr_releases/.test(e.text)).map((e) => e.text).join(' | '));

  /* ── THE AUDIT ROW ─────────────────────────────────────────────────────
     One row per accept, success or refusal, carrying the disclosure the human
     was shown and a handle that is not the secret. */
  const auditRows = db.store.audit_log;
  ok('the accept wrote exactly one audit_log row', auditRows.length === 1, String(auditRows.length));
  ok('  …with actor=docintel, ok=true, and the table it actually wrote',
     auditRows[0].actor === 'docintel' && auditRows[0].ok === true && auditRows[0].entity === 'pr_releases',
     JSON.stringify(auditRows[0]));
  ok('  …carrying the disclosure the human approved, not a reconstruction of it',
     JSON.parse(auditRows[0].approved_shown).value === 'Aisyah binti Rahman'
     && JSON.parse(auditRows[0].approved_shown).replaces === null
     && JSON.parse(auditRows[0].approved_shown).writesTo === 'pr_releases.spokesperson'
     && /Aisyah binti Rahman/.test(JSON.parse(auditRows[0].approved_shown).evidence),
     auditRows[0].approved_shown);
  ok('  …and an approval_ref that names the issuance', /@/.test(auditRows[0].approval_ref || ''));
  ok('  …THE NONCE IS NOWHERE IN THE AUDIT ROW — not the plaintext, not the hash, not a prefix of it',
     !JSON.stringify(auditRows[0]).includes(nonce)
     && !JSON.stringify(auditRows[0]).includes(sha256(nonce))
     && !JSON.stringify(auditRows[0]).includes(sha256(nonce).slice(0, 12)),
     auditRows[0].approval_ref);
  ok('  …and the audit insert is parameterized like everything else',
     db.log.some((e) => /^INSERT INTO audit_log /.test(e.text) && !e.text.includes('Aisyah')));

  /* A broken audit table must not turn a completed write into an error. */
  {
    const clock2 = { t: Date.now() };
    const built = await buildBound(ADVERSARIAL_REPLY, clock2);
    await built.svc.propose({ documentId: built.docId, userId: USER_A });
    const l2 = await built.svc.listProposals({ documentId: built.docId, userId: USER_A });
    const c2 = (await built.svc.openCard({
      proposalId: l2.proposals.filter((x) => x.status === 'pending')[0].id, userId: USER_A })).card;
    built.db.failNext(/^INSERT INTO audit_log/);
    const still = await built.svc.acceptProposal({ proposalId: c2.id, userId: USER_A, nonce: c2.acceptNonce });
    ok('a failing audit insert does NOT fail the response for a write that really happened',
       still.ok === true && built.db.store.pr_releases.get(RELEASE_1).spokesperson === 'Aisyah binti Rahman',
       JSON.stringify(still));
  }
  ok('  …the claim is guarded by WHERE status=pending AND quote_verified=TRUE',
     /WHERE id=\$1 AND user_id=\$2 AND status='pending' AND quote_verified=TRUE/.test(db.log[iClaim].text));
  ok('  …and the model\'s typed value is NOT a parameter to the business write',
     !bw[0].params.some((p) => String(p) === 'Nurul Holdings Berhad'));

  /* ── REPLAY ───────────────────────────────────────────────────────────── */
  db.reset();
  const replay = await svc.acceptProposal({ proposalId: pending[0].id, userId: USER_A, nonce });
  ok('REPLAY of the same nonce is refused', replay.ok === false && replay.reason === 'confirm_invalid');
  ok('  …and it wrote nothing', db.businessWrites().length === 0);
}

/* ── §5 · EVERY WAY OF NOT HAVING A VALID NONCE ──────────────────────────── */
head('§5  a boolean is not a confirmation — every refusal path, and they are indistinguishable');
{
  const reasons = new Set();
  const write = [];

  async function attempt(label, mutate, arg) {
    const clock = { t: Date.now() };
    const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
    await svc.propose({ documentId: docId, userId: USER_A });
    const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
    const row = listed.proposals.filter((p) => p.status === 'pending')[0];
    const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;
    db.reset();
    if (mutate) await mutate({ db, svc, docId, card, clock });
    const out = await svc.acceptProposal(arg({ card, clock }));
    reasons.add(out.reason);
    write.push({ label, wrote: db.businessWrites().length, out });
    return { db, out, card };
  }

  const cases = [
    ['{confirmed:true} — a boolean off the request body', null, ({ card }) => ({ proposalId: card.id, userId: USER_A, nonce: true })],
    ['the string "true"', null, ({ card }) => ({ proposalId: card.id, userId: USER_A, nonce: 'true' })],
    ['no nonce at all', null, ({ card }) => ({ proposalId: card.id, userId: USER_A })],
    ['a nonce of the right shape that this server never issued', null,
      ({ card }) => ({ proposalId: card.id, userId: USER_A, nonce: crypto.randomBytes(32).toString('hex') })],
    ['a TAMPERED nonce (one hex character changed)', null,
      ({ card }) => ({ proposalId: card.id, userId: USER_A,
                       nonce: (card.acceptNonce[0] === 'a' ? 'b' : 'a') + card.acceptNonce.slice(1) })],
    ['a nonce that has EXPIRED', (ctx) => { ctx.clock.t += 5 * 60 * 1000 + 1; },
      ({ card }) => ({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce })],
    ['a nonce issued to a DIFFERENT user, presented by its owner\'s session',
      ({ db, card }) => { db.store.docintel_proposals.get(card.id).accept_nonce_user = USER_B; },
      ({ card }) => ({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce })],
    ['another account presenting a nonce it somehow obtained', null,
      ({ card }) => ({ proposalId: card.id, userId: USER_B, nonce: card.acceptNonce })],
    ['a proposal id that is an ARRAY of ids', null,
      ({ card }) => ({ proposalId: [card.id, card.id], userId: USER_A, nonce: card.acceptNonce })],
    ['a proposal id that is a comma list', null,
      ({ card }) => ({ proposalId: card.id + ',' + card.id, userId: USER_A, nonce: card.acceptNonce })],
    ['an auto_rejected proposal, with a nonce hash forced onto its row',
      ({ db, card, clock }) => {
        const bad = [...db.store.docintel_proposals.values()].find((p) => p.status === 'auto_rejected');
        bad.accept_nonce_hash = sha256(card.acceptNonce);
        bad.accept_nonce_user = USER_A;
        bad.accept_nonce_expires_at = new Date(clock.t + 60000);
        bad.shown_target_id = RELEASE_1;
        bad.shown_previous_json = 'null';
        card.forcedId = bad.id;
      },
      ({ card }) => ({ proposalId: card.forcedId, userId: USER_A, nonce: card.acceptNonce })],
  ];

  for (const [label, mutate, arg] of cases) {
    const { out, db } = await attempt(label, mutate, arg);
    ok(label + ' → refused', out.ok === false, JSON.stringify(out));
    ok('  …and nothing was written', db.businessWrites().length === 0);
  }

  ok('EVERY refusal returns the SAME reason — the endpoint is not an oracle',
     reasons.size === 1 && reasons.has('confirm_invalid'), [...reasons].join(','));
  ok('no refusal path wrote to a business table',
     write.every((w) => w.wrote === 0), JSON.stringify(write.filter((w) => w.wrote)));
}

/* ── §6 · TOCTOU — BOTH HALVES OF THE SENTENCE ───────────────────────────── */
head('§6  TOCTOU — the record AND the value the card displayed are both re-verified');
{
  /* (a) the value moved under the card */
  {
    const clock = { t: Date.now() };
    const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
    await svc.propose({ documentId: docId, userId: USER_A });
    const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
    const row = listed.proposals.filter((p) => p.status === 'pending')[0];
    const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;

    // somebody else edits the field between the card being drawn and approved
    db.store.pr_releases.get(RELEASE_1).spokesperson = 'Someone Else';
    db.reset();
    const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('the card said it replaced NOTHING; the field now holds a value → refused',
       out.ok === false && out.reason === 'target_changed', JSON.stringify(out));
    ok('  …nothing was written', db.businessWrites().length === 0);
    ok('  …the value a human never approved is still there',
       db.store.pr_releases.get(RELEASE_1).spokesperson === 'Someone Else');
    ok('  …and the refusal names both values so the reviewer can act on it',
       /now holds/.test(out.message) && /Nothing was changed/.test(out.message));
  }

  /* (b) THE HOLE shown_target_id EXISTS TO CLOSE: re-bind to a record whose
         field is ALSO empty, so the value snapshot (null === null) would pass. */
  {
    const clock = { t: Date.now() };
    const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
    await svc.propose({ documentId: docId, userId: USER_A });
    const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
    const row = listed.proposals.filter((p) => p.status === 'pending')[0];
    const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;

    // Re-bind DIRECTLY in the store, bypassing bindTarget's own nonce-clearing,
    // so this tests the accept path's check rather than the bind path's.
    db.store.docintel_documents.get(docId).target_id = RELEASE_2;
    db.reset();
    const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('an approval for release 101 does not land on release 102 when the document is re-bound',
       out.ok === false && out.reason === 'confirm_invalid', JSON.stringify(out));
    ok('  …and NEITHER record was written',
       db.businessWrites().length === 0
       && db.store.pr_releases.get(RELEASE_1).spokesperson === null
       && db.store.pr_releases.get(RELEASE_2).spokesperson === null);
  }

  /* (c) bindTarget itself voids outstanding approvals — defence in depth */
  {
    const clock = { t: Date.now() };
    const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
    await svc.propose({ documentId: docId, userId: USER_A });
    const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
    const row = listed.proposals.filter((p) => p.status === 'pending')[0];
    const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;
    await svc.bindTarget({ documentId: docId, userId: USER_A, category: 'pr_release', targetId: RELEASE_2 });
    ok('re-binding through the API clears every outstanding nonce on the document',
       db.store.docintel_proposals.get(card.id).accept_nonce_hash === null);
    db.reset();
    const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('  …so the old card is dead', out.ok === false && out.reason === 'confirm_invalid');
    ok('  …and wrote nothing', db.businessWrites().length === 0);
  }
}

/* ── §7 · NO BULK ENDPOINT — the absence IS the enforcement ──────────────── */
head('§7  NO BULK ENDPOINT — enumerated from the live router, not from a comment');
{
  const router = require('../routes/docIntel');
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) routes.push(method.toUpperCase() + ' ' + layer.route.path);
    }
  }
  ok('the router really was enumerated (an empty enumeration passes vacuously, #14)',
     routes.length >= 8, JSON.stringify(routes));

  const EXPECTED = [
    'GET /status', 'GET /field-map', 'GET /documents', 'POST /documents',
    'GET /documents/:id', 'GET /documents/:id/file', 'GET /targets/:category',
    'POST /documents/:id/bind', 'POST /documents/:id/propose',
    'GET /proposals/:id/card', 'POST /proposals/:id/accept', 'POST /proposals/:id/reject',
  ].sort();
  ok('the router exposes EXACTLY the twelve routes this lane declares',
     JSON.stringify(routes.slice().sort()) === JSON.stringify(EXPECTED),
     JSON.stringify(routes.slice().sort()));

  const banned = routes.filter((r) => /(accept|commit|approve|write|apply)[-_]?all|bulk|batch|\ball\b/i.test(r));
  ok('no route name contains accept-all / commit / bulk / batch', banned.length === 0, banned.join(', '));

  ok('the accept route takes its subject from the PATH, so a body cannot name a second one',
     routes.includes('POST /proposals/:id/accept'));

  /* The service surface itself must not offer a plural writer. */
  const db = makeDb();
  const svc = createDocIntel({ db, generate: async () => '', model: 'm' });
  const plural = Object.keys(svc).filter((k) => /(accept|write|commit|approve).*(all|many|each|batch|bulk)/i.test(k));
  ok('the service exports no plural accept/write function', plural.length === 0, plural.join(', '));

  /* And the one writer is called from exactly one place. Read as source
     DELIBERATELY here — this assertion is about a call site existing at all,
     which is the one question executing the code cannot answer. */
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const files = ['lib/docintel/service.js', 'lib/docintel/guards.js', 'lib/docintel/fieldMap.js',
                 'lib/docintel/textLayer.js', 'routes/docIntel.js', 'public/docintel.html'];
  const sources = files.map((f) => ({ f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
                        .replace(/<!--[\s\S]*?-->/g, ' ');

  const writeFieldCalls = sources.reduce((n, s) => n + (strip(s.src).match(/writeField\s*\(/g) || []).length, 0);
  ok('`writeField(` appears exactly once in the whole feature — one definition, one call',
     writeFieldCalls === 2, String(writeFieldCalls));

  const acceptCalls = sources.reduce((n, s) => n + (strip(s.src).match(/acceptProposal\s*\(/g) || []).length, 0);
  ok('`acceptProposal(` appears exactly twice — its definition and its one route',
     acceptCalls === 2, String(acceptCalls));

  const mintSites = sources.reduce((n, s) => n + (strip(s.src).match(/randomBytes\s*\(/g) || []).length, 0);
  ok('THE NONCE IS GENERATED IN EXACTLY ONE PLACE in the whole feature',
     mintSites === 1, String(mintSites));
  const mintSql = sources.reduce((n, s) => n + (strip(s.src).match(/accept_nonce_hash=\$3/g) || []).length, 0);
  ok('  …and exactly one statement stores a nonce hash', mintSql === 1, String(mintSql));

  const loopy = sources.filter((s) => /(for|forEach|map|Promise\.all)[^\n]{0,120}acceptProposal/.test(strip(s.src)));
  ok('nothing loops over acceptProposal', loopy.length === 0, loopy.map((s) => s.f).join(', '));

  const idsArray = sources.filter((s) => /\b(body|req\.body)\.(ids|proposalIds|proposals)\b/.test(strip(s.src)));
  ok('no handler reads an array of ids out of a request body', idsArray.length === 0, idsArray.map((s) => s.f).join(', '));

  /* The page. Prose is allowed to SAY "there is no approve-all" — that is the
     copy explaining the design. What must not exist is a CONTROL, so the check
     is against the page's actual buttons and its actual accept call site, not
     against its sentences. (A first cut matched the word anywhere and failed on
     the paragraph documenting the rule, which is a guard reading its own
     documentation as a violation.) */
  const page = strip(sources.find((s) => s.f === 'public/docintel.html').src);
  const buttonText = (page.match(/<button[^>]*>([^<]*)<\/button>/gi) || [])
    .concat(page.match(/\.textContent\s*=\s*'([^']*)'/g) || []);
  const bulkButton = buttonText.filter((t) => /\ball\b|bulk|every|batch/i.test(t));
  ok('no button on the review page offers to approve more than one field',
     bulkButton.length === 0, bulkButton.join(' | '));
  const acceptPosts = (page.match(/\/accept'/g) || []).length;
  ok('the page has exactly one accept call site', acceptPosts === 1, String(acceptPosts));
  const cardGets = (page.match(/\/card'/g) || []).length;
  ok('and exactly one card-open call site, naming one proposal', cardGets === 1, String(cardGets));
  const pageLoop = /(forEach|for\s*\(|map\s*\()[^\n]{0,200}\/accept/.test(page);
  ok('and it is not inside a loop over proposals', pageLoop === false);
}

/* ── §8 · TEXT EXTRACTION IS REAL, AND ITS ABSENCES ARE HONEST ───────────── */
head('§8  extraction — real bytes in, real text out; and no faked extraction');
{
  /* A genuine, hand-built PDF: a FlateDecode'd content stream with Tj/TJ. */
  const content = 'BT /F1 12 Tf 72 720 Td (Company: Kedai Kopi Serumpun Sdn Bhd) Tj '
                + '0 -16 Td [(Spokesperson: Aisyah binti Rahman) -300 (Managing Director)] TJ ET';
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + z.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    z,
    Buffer.from('endstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  const outPdf = textLayer.extract(pdf, 'application/pdf', 'brief.pdf');
  ok('a real FlateDecode PDF content stream is decoded with zlib and read',
     outPdf.status === 'extracted' && /Kedai Kopi Serumpun Sdn Bhd/.test(outPdf.text), outPdf.note);
  ok('  …and the TJ kerning array\'s big negative number became a space',
     /Aisyah binti Rahman Managing Director/.test(outPdf.text.replace(/\s+/g, ' ')), outPdf.text);

  const scan = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Filter /DCTDecode >>\nstream\n', 'latin1'),
    crypto.randomBytes(400),
    Buffer.from('endstream\n%%EOF\n', 'latin1'),
  ]);
  const outScan = textLayer.extract(scan, 'application/pdf', 'scan.pdf');
  ok('a scanned PDF with no text layer is reported as no_text_layer, not faked',
     outScan.status === 'no_text_layer' && outScan.text === '' && /no OCR engine/.test(outScan.note), outScan.note);

  const img = textLayer.extract(Buffer.alloc(2000, 1), 'image/png', 'photo.png');
  ok('an image is stored and honestly reported as unreadable — never guessed at',
     img.status === 'no_text_layer' && img.blocks.length === 0 && /no OCR engine/.test(img.note));

  const docx = textLayer.extract(Buffer.from('PKrest', 'latin1'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'brief.docx');
  ok('a .docx says WHICH parser is missing and what does work, rather than reading empty',
     docx.status === 'unsupported' && /mammoth/.test(docx.note) && /\.csv/.test(docx.note), docx.note);

  const tiny = textLayer.extract(Buffer.from('hello', 'utf8'), 'text/plain', 'a.txt');
  ok('a file with too little text to quote is no_text_layer with the reason',
     tiny.status === 'no_text_layer' && /Fewer than/.test(tiny.note));

  const weird = textLayer.extract(Buffer.from('x'), 'application/x-tar', 'a.tar');
  ok('an unknown container is `unsupported` and lists what IS accepted',
     weird.status === 'unsupported' && /application\/pdf/.test(weird.note));

  ok('nothing this deployment cannot read is ever accepted at the door',
     textLayer.isAccepted('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x.xlsx') === false
     && textLayer.isAccepted('application/x-tar', 'x.tar') === false
     && textLayer.isAccepted('text/csv', 'x.csv') === true);
}

/* ── §9 · THE BRAND CATEGORY CANNOT BE POINTED AT ANOTHER ACCOUNT ────────── */
head('§9  the self-only category — a brand profile is the caller\'s own row and nothing else');
{
  const db = makeDb();
  seed(db);
  const clock = { t: Date.now() };
  const svc = createDocIntel({ db, generate: async () => '', model: 'm', now: () => clock.t });
  const up = await svc.ingest({ userId: USER_A, teamId: null, filename: 'brand.txt', mimeType: 'text/plain',
                                bytes: Buffer.from(DOC_TEXT, 'utf8') });
  const bound = await svc.bindTarget({ documentId: up.document.id, userId: USER_A,
                                       category: 'brand', targetId: String(USER_B) });
  ok('binding a brand profile ignores the targetId in the request entirely',
     bound.ok === true && bound.targetId === String(USER_A), JSON.stringify(bound));
  ok('  …so the other account\'s row was never even looked up',
     !db.log.some((e) => /FROM users WHERE id = \$1 AND id = \$2/.test(e.text) && String(e.params[0]) === String(USER_B)));
}

/* ── §10 · THE BURN IS REAL — a touched nonce is a spent nonce ───────────── */
head('§10  spent by being touched — one wrong presentation kills the card');
{
  const clock = { t: Date.now() };
  const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
  await svc.propose({ documentId: docId, userId: USER_A });
  const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
  const row = listed.proposals.filter((p) => p.status === 'pending')[0];
  const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;

  db.reset();
  const wrong = await svc.acceptProposal({
    proposalId: card.id, userId: USER_A, nonce: crypto.randomBytes(32).toString('hex') });
  ok('a wrong nonce is refused', wrong.ok === false && wrong.reason === 'confirm_invalid');
  ok('  …and the REAL, correct nonce is now dead too — the card was burned by being touched',
     (await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce })).reason
       === 'confirm_invalid');
  ok('  …and nothing was written on either attempt', db.businessWrites().length === 0);
  ok('  …the row itself no longer holds a hash',
     db.store.docintel_proposals.get(card.id).accept_nonce_hash === null);

  /* The remedy is to open the card again, which shows the CURRENT value. */
  const reopened = await svc.openCard({ proposalId: card.id, userId: USER_A });
  ok('re-opening the field issues a fresh approval',
     reopened.ok === true && reopened.card.acceptNonce !== card.acceptNonce);
  const finalWrite = await svc.acceptProposal({
    proposalId: card.id, userId: USER_A, nonce: reopened.card.acceptNonce });
  ok('  …which works', finalWrite.ok === true, JSON.stringify(finalWrite));
}

/* ── §11 · MUTATION — every guard is load-bearing, proved by breaking it ──── */
head('§11  MUTATION — break each guard in a compiled-in-memory copy, and watch the write happen');
{
  const fs = require('fs');
  const Module = require('module');
  const ROOT = path.join(__dirname, '..');
  const SERVICE = path.join(ROOT, 'lib', 'docintel', 'service.js');
  const serviceSrc = fs.readFileSync(SERVICE, 'utf8');

  /* Compile a MUTATED copy of service.js in memory. Nothing is written to
     disk, and the real module in require.cache is untouched — so a mutant
     cannot leak into the assertions above or below it. The last check in this
     section proves that it did not. */
  function mutantService(find, replace) {
    const idx = serviceSrc.indexOf(find);
    assert.notStrictEqual(idx, -1, 'mutation target not found in service.js: ' + find.slice(0, 60));
    const src = serviceSrc.slice(0, idx) + replace + serviceSrc.slice(idx + find.length);
    const m = new Module(SERVICE, null);
    m.filename = SERVICE;
    m.paths = Module._nodeModulePaths(path.dirname(SERVICE));
    m._compile(src, SERVICE);
    return m.exports.createDocIntel;
  }

  async function drive(create, opts) {
    const db = makeDb();
    seed(db);
    const clock = { t: Date.now() };
    const svc = create({ db, generate: async () => ADVERSARIAL_REPLY, model: 'mutant', now: () => clock.t });
    const up = await svc.ingest({ userId: USER_A, teamId: null, filename: 'b.txt', mimeType: 'text/plain',
                                  bytes: Buffer.from(DOC_TEXT, 'utf8') });
    await svc.bindTarget({ documentId: up.document.id, userId: USER_A, category: 'pr_release', targetId: RELEASE_1 });
    await svc.propose({ documentId: up.document.id, userId: USER_A });
    const listed = await svc.listProposals({ documentId: up.document.id, userId: USER_A });
    const row = listed.proposals.filter((p) => p.status === 'pending')[0];
    const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;
    if (opts && opts.before) await opts.before({ db, docId: up.document.id, card });
    db.reset();
    const out = await svc.acceptProposal({
      proposalId: card.id, userId: USER_A,
      nonce: opts && opts.nonce ? opts.nonce(card) : card.acceptNonce,
    });
    return { db, out, card };
  }

  /* M1 — delete the nonce comparison. */
  {
    const create = mutantService(
      "if (!hashEquals(spent.prev_hash, sha256(nonce))) return await invalid('nonce does not match');",
      'if (false) return await invalid();');
    const r = await drive(create, { nonce: () => crypto.randomBytes(32).toString('hex') });
    ok('M1 · with the nonce comparison deleted, a nonce this server NEVER issued writes the field',
       r.out.ok === true && r.db.businessWrites().length === 1, JSON.stringify(r.out));
  }

  /* M2 — delete the TOCTOU value-snapshot check. */
  {
    const create = mutantService(
      'if (JSON.stringify(live.value) !== JSON.stringify(shown)) {',
      'if (false) {');
    const r = await drive(create, {
      before: ({ db }) => { db.store.pr_releases.get(RELEASE_1).spokesperson = 'Someone Else'; },
    });
    ok('M2 · with the value-snapshot check deleted, an approval overwrites a value nobody was shown',
       r.out.ok === true && r.db.store.pr_releases.get(RELEASE_1).spokesperson === 'Aisyah binti Rahman',
       JSON.stringify(r.out));
  }

  /* M3 — delete the shown_target_id check. */
  {
    const create = mutantService(
      "if (String(p.shown_target_id) !== String(d.target_id)) return await invalid('document was re-bound');",
      'if (false) return await invalid();');
    const r = await drive(create, {
      before: ({ db, docId }) => { db.store.docintel_documents.get(docId).target_id = RELEASE_2; },
    });
    ok('M3 · with the record check deleted, an approval for release 101 lands on release 102',
       r.out.ok === true && r.db.store.pr_releases.get(RELEASE_2).spokesperson === 'Aisyah binti Rahman'
       && r.db.store.pr_releases.get(RELEASE_1).spokesperson === null, JSON.stringify(r.out));
  }

  /* M4 — delete the expiry check. */
  {
    const create = mutantService(
      'if (!spent.prev_expires || new Date(spent.prev_expires).getTime() <= now()) {',
      'if (false) {');
    const db = makeDb();
    seed(db);
    const clock = { t: Date.now() };
    const svc = create({ db, generate: async () => ADVERSARIAL_REPLY, model: 'mutant', now: () => clock.t });
    const up = await svc.ingest({ userId: USER_A, teamId: null, filename: 'b.txt', mimeType: 'text/plain',
                                  bytes: Buffer.from(DOC_TEXT, 'utf8') });
    await svc.bindTarget({ documentId: up.document.id, userId: USER_A, category: 'pr_release', targetId: RELEASE_1 });
    await svc.propose({ documentId: up.document.id, userId: USER_A });
    const listed = await svc.listProposals({ documentId: up.document.id, userId: USER_A });
    const card = (await svc.openCard({ proposalId: listed.proposals.filter((p) => p.status === 'pending')[0].id,
                                       userId: USER_A })).card;
    clock.t += 24 * 60 * 60 * 1000;                       // a day later
    const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('M4 · with the expiry check deleted, a day-old approval still writes',
       out.ok === true && db.businessWrites().length === 1, JSON.stringify(out));
  }

  /* ── THE CLAIM'S WHERE CLAUSE, PROVED BEHAVIOURALLY ─────────────────────
     Integration's note: this guard was only ever asserted by matching the SQL
     text, which proves the characters are present and nothing about whether
     they do anything. So: delete the EARLIER in-memory check that shadows it,
     move the row underneath, and watch the claim itself refuse. If the WHERE
     clause were decorative these two would write. */

  /* M6 · status. The early `p.status !== 'pending'` check is removed, and the
     row is flipped to 'accepted' after the transaction has read it. */
  {
    const create = mutantService(
      "if (p.status !== 'pending') return await invalid(`status is ${p.status}`);",
      'if (false) return await invalid();');
    const r = await drive(create, {
      before: ({ db, card }) => { db.store.docintel_proposals.get(card.id).status = 'accepted'; },
    });
    ok('M6 · with the early status check gone, THE CLAIM ITSELF still refuses an already-accepted row',
       r.out.ok === false && r.out.reason === 'confirm_invalid', JSON.stringify(r.out));
    ok('  …and no business write ran — the claim is what stopped it, not the check above it',
       r.db.businessWrites().length === 0);
  }

  /* M7 · quote_verified. The early check is removed and the row is marked
     unevidenced — an auto_rejected proposal wearing a 'pending' status. */
  {
    const create = mutantService(
      "if (p.quote_verified !== true) return await invalid('never evidenced');",
      'if (false) return await invalid();');
    const r = await drive(create, {
      before: ({ db, card }) => { db.store.docintel_proposals.get(card.id).quote_verified = false; },
    });
    ok('M7 · with the early evidence check gone, THE CLAIM ITSELF still refuses an unevidenced row',
       r.out.ok === false && r.out.reason === 'confirm_invalid', JSON.stringify(r.out));
    ok('  …and nothing was written', r.db.businessWrites().length === 0);
  }

  /* M8 · THE REGRESSION MUTANT. Two changes put the code back exactly where
     Integration's critic found it: the record-exists sentinel is removed (so
     null-for-gone reads the same as null-for-empty again), and the fake is
     told to treat the burn as part of the transaction. The breach reappears,
     which is what makes §12 a regression test rather than a description. */
  {
    const create = mutantService(
      'const live = await readTargetValue(cat, p.field_key, userId, d.target_id, client, true);',
      'const live = { found: true, value: (await readTargetValue(cat, p.field_key, userId, d.target_id, client, true)).value };');
    const db = makeDb();
    seed(db);
    const clock = { t: Date.now() };
    const svc = create({ db, generate: async () => ADVERSARIAL_REPLY, model: 'mutant', now: () => clock.t });
    const up = await svc.ingest({ userId: USER_A, teamId: null, filename: 'b.txt', mimeType: 'text/plain',
                                  bytes: Buffer.from(DOC_TEXT, 'utf8') });
    await svc.bindTarget({ documentId: up.document.id, userId: USER_A, category: 'pr_release', targetId: RELEASE_1 });
    await svc.propose({ documentId: up.document.id, userId: USER_A });
    const l = await svc.listProposals({ documentId: up.document.id, userId: USER_A });
    const card = (await svc.openCard({ proposalId: l.proposals.filter((x) => x.status === 'pending')[0].id,
                                       userId: USER_A })).card;

    db.legacyBurnInTransaction();                 // the burn is rollback-able again
    db.store.pr_releases.delete(RELEASE_1);
    const first = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('M8 · with the sentinel removed and the burn back inside the transaction, the write fails…',
       first.ok === false, JSON.stringify(first));
    ok('  …the ROLLBACK resurrects the nonce on the row',
       db.store.docintel_proposals.get(card.id).accept_nonce_hash !== null);
    db.store.pr_releases.set(RELEASE_1, { id: RELEASE_1, user_id: USER_A, company_name: null, headline: null,
                                          spokesperson: null, audience: null, region: null });
    const replay = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
    ok('  …AND THE SAME NONCE THEN SUCCEEDS — the exact breach the critic reported, reproduced',
       replay.ok === true && db.store.pr_releases.get(RELEASE_1).spokesperson === 'Aisyah binti Rahman',
       JSON.stringify(replay));
  }

  /* M5 — delete GUARD 1 from verify(). sliceValue is called by reference INSIDE
     guards.verify, so the mutation replaces the exported function the service
     actually calls, and restores it in a finally block. */
  {
    const realVerify = guards.verify;
    guards.verify = function (parsed, categoryKey, blocks) {
      const located = guards.locateQuote(parsed.quote, blocks);
      if (!located.verbatim) {
        return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value,
                 evidenceQuote: parsed.quote, reason: located.reason };
      }
      const field = fieldMap.getField(categoryKey, parsed.fieldKey);
      if (!field) return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value, reason: 'unknown field' };
      const n = field.normalise(parsed.value);                  // ← the model's TYPED value, not the slice
      if (!Object.prototype.hasOwnProperty.call(n, 'value')) {
        return { ok: false, fieldKey: parsed.fieldKey, modelValue: parsed.value,
                 evidenceQuote: located.verbatim, reason: n.reason };
      }
      return { ok: true, fieldKey: parsed.fieldKey, evidenceQuote: located.verbatim,
               evidenceBlock: located.block, rawValue: parsed.value, normalisedValue: n.value,
               modelValue: parsed.value };
    };
    try {
      const db = makeDb();
      seed(db);
      const clock = { t: Date.now() };
      const svc = createDocIntel({ db, generate: async () => ADVERSARIAL_REPLY, model: 'mutant', now: () => clock.t });
      const up = await svc.ingest({ userId: USER_A, teamId: null, filename: 'b.txt', mimeType: 'text/plain',
                                    bytes: Buffer.from(DOC_TEXT, 'utf8') });
      await svc.bindTarget({ documentId: up.document.id, userId: USER_A, category: 'pr_release', targetId: RELEASE_1 });
      await svc.propose({ documentId: up.document.id, userId: USER_A });
      const listed = await svc.listProposals({ documentId: up.document.id, userId: USER_A });
      const company = listed.proposals.filter((p) => p.status === 'pending' && p.field === 'company_name')[0];
      ok('M5 · with GUARD 1 removed, the FABRICATED company name becomes a pending proposal',
         !!company && company.value === 'Nurul Holdings Berhad', JSON.stringify(company));
      const card = (await svc.openCard({ proposalId: company.id, userId: USER_A })).card;
      const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
      ok('  …and a human approving it writes a company name that is nowhere in the document',
         out.ok === true && db.store.pr_releases.get(RELEASE_1).company_name === 'Nurul Holdings Berhad',
         JSON.stringify(out));
    } finally {
      guards.verify = realVerify;
    }
  }

  /* The real build, immediately afterwards, still refuses all five. A mutation
     harness that leaves a patch behind turns every later assertion into a
     measurement of the mutant. */
  {
    const clock = { t: Date.now() };
    const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
    await svc.propose({ documentId: docId, userId: USER_A });
    const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
    ok('the UNMUTATED build is intact after the mutants ran — no patch leaked',
       listed.proposals.filter((p) => p.status === 'pending').length === 1
       && !listed.proposals.some((p) => p.value === 'Nurul Holdings Berhad'));
  }
}

/* ── §12 · THE BURN MUST SURVIVE A FAILED WRITE ──────────────────────────────
   REGRESSION. Found by Integration's blind critic, not by this suite, and that
   is the honest record: §4 asserted the burn happened BEFORE the checks and
   §5 asserted every refusal wrote nothing, and BOTH were true while the nonce
   was still replayable — because three paths after the checks ROLLBACK, and a
   ROLLBACK takes the burn with it.

       :claim-failed   ROLLBACK  → hash restored
       :write-returned-false  ROLLBACK  → hash restored
       :catch          ROLLBACK  → hash restored

   The critic reached it with NO injected fault at all: currentValue() returned
   null both for "the row is gone" and for "the field is empty", so a card
   minted over an empty field still matched its snapshot after the target row
   was deleted, the claim succeeded, writeField returned false, and the
   rollback handed the nonce back live.

   "Single use" has to mean spent on presentation, not spent on success.
   ──────────────────────────────────────────────────────────────────────────── */
head('§12  REGRESSION — a nonce presented once is dead, even when the write fails');

/** Mint a card and hand back everything needed to attack it. */
async function freshCard() {
  const clock = { t: Date.now() };
  const { db, svc, docId } = await buildBound(ADVERSARIAL_REPLY, clock);
  await svc.propose({ documentId: docId, userId: USER_A });
  const listed = await svc.listProposals({ documentId: docId, userId: USER_A });
  const row = listed.proposals.filter((p) => p.status === 'pending')[0];
  const card = (await svc.openCard({ proposalId: row.id, userId: USER_A })).card;
  return { db, svc, docId, card, clock };
}

/* (a) THE CRITIC'S REPRODUCTION — the bound record is deleted between the card
       being drawn and the approval being presented. */
{
  const { db, svc, card } = await freshCard();

  db.store.pr_releases.delete(RELEASE_1);
  db.reset();
  const first = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  ok('a deleted target is refused, and named as such',
     first.ok === false && first.reason === 'target_not_found', JSON.stringify(first));
  ok('  …and nothing was written', db.businessWrites().length === 0);
  ok('  …AND THE NONCE IS GONE FROM THE ROW — the burn was not rolled back with the write',
     db.store.docintel_proposals.get(card.id).accept_nonce_hash === null,
     'accept_nonce_hash is still set: the approval is replayable');

  /* The record comes back — restored from a backup, or re-created by the user. */
  db.store.pr_releases.set(RELEASE_1, { id: RELEASE_1, user_id: USER_A, company_name: null, headline: null,
                                        spokesperson: null, audience: null, region: null });
  db.reset();
  const replay = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  ok('THE SAME NONCE, PRESENTED A SECOND TIME, IS REFUSED',
     replay.ok === false && replay.reason === 'confirm_invalid', JSON.stringify(replay));
  ok('  …and still nothing was written',
     db.businessWrites().length === 0 && db.store.pr_releases.get(RELEASE_1).spokesperson === null);
}

/* (b) A TRANSIENT DATABASE ERROR on the business write — the same state by the
       catch/ROLLBACK path rather than the !wrote path. */
{
  const { db, svc, card } = await freshCard();

  db.reset();
  db.failNext(/^UPDATE pr_releases SET/);
  let threw = null;
  try {
    await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  } catch (e) {
    threw = e;
  }
  ok('an injected 40P01 on the business write propagates rather than being swallowed',
     threw !== null && threw.code === '40P01', String(threw && threw.message));
  ok('  …the field was not written', db.store.pr_releases.get(RELEASE_1).spokesperson === null);
  ok('  …the proposal is not left marked accepted beside a column that was never written',
     db.store.docintel_proposals.get(card.id).status === 'pending');
  ok('  …AND THE NONCE IS GONE FROM THE ROW despite the rollback',
     db.store.docintel_proposals.get(card.id).accept_nonce_hash === null,
     'accept_nonce_hash survived the rollback: the approval is replayable after a transient error');

  db.reset();
  const replay = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  ok('THE SAME NONCE, AFTER THE ERROR, IS REFUSED',
     replay.ok === false && replay.reason === 'confirm_invalid', JSON.stringify(replay));
  ok('  …and wrote nothing', db.businessWrites().length === 0);
}

/* (c) The remedy is the same as every other burn: re-open the card. */
{
  const { db, svc, card } = await freshCard();
  db.store.pr_releases.delete(RELEASE_1);
  await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  db.store.pr_releases.set(RELEASE_1, { id: RELEASE_1, user_id: USER_A, company_name: null, headline: null,
                                        spokesperson: null, audience: null, region: null });
  const reopened = await svc.openCard({ proposalId: card.id, userId: USER_A });
  ok('re-opening after a failed write issues a fresh approval',
     reopened.ok === true && reopened.card.acceptNonce !== card.acceptNonce);
  const done = await svc.acceptProposal({ proposalId: card.id, userId: USER_A,
                                          nonce: reopened.card.acceptNonce });
  ok('  …and that one writes', done.ok === true && db.store.pr_releases.get(RELEASE_1).spokesperson
     === 'Aisyah binti Rahman', JSON.stringify(done));
}

/* (d) A DELETED RECORD IS NOT AN EMPTY FIELD. currentValue() conflating them is
       what let the TOCTOU snapshot pass over a row that no longer existed. */
{
  const { db, svc, card } = await freshCard();
  db.store.pr_releases.delete(RELEASE_1);
  db.reset();
  const out = await svc.acceptProposal({ proposalId: card.id, userId: USER_A, nonce: card.acceptNonce });
  ok('a missing record is refused as target_not_found, NOT silently treated as an empty field',
     out.reason === 'target_not_found', JSON.stringify(out));
  ok('  …and the claim never ran, so the proposal is still pending for a later, honest approval',
     !db.log.some((e) => /SET status='accepted'/.test(e.text))
     && db.store.docintel_proposals.get(card.id).status === 'pending',
     db.store.docintel_proposals.get(card.id).status);
}

/* ── §13 · WHAT THIS SUITE DOES NOT PROVE ────────────────────────────────── */
head('§13  GAPS — stated, not implied');
console.log([
  '  · There is no local PostgreSQL (postgres.railway.internal resolves only inside Railway) and pg-mem',
  '    cannot be installed from this lane, so every assertion above ran against a hand-rolled fake pg client.',
  '    The SQL TEXT, the PARAMETERS and the ORDER of statements are real; PostgreSQL\'s own behaviour is not.',
  '    Specifically NOT proved here: that the CTE burn is genuinely atomic under real concurrency, that FOR',
  '    UPDATE really serialises two simultaneous accepts, and that a column type rejects an over-long value',
  '    the normaliser let through. All three need a real database. What IS proved: the burn is a separate',
  '    pool statement issued before BEGIN, and no rollback path reaches it (§12 is the regression, and',
  '    §11 M8 reproduces the original breach the moment that property is removed).',
  '  · The HTTP layer is exercised only through the router\'s own stack (§7). requireAuth / checkSub are',
  '    mounted in server.js, which this lane does not own, and are covered by test/auth-guard-test.js.',
  '  · No model was called. `generate` is scripted, deliberately — the guards must hold for ANY reply, and a',
  '    live model would make the suite non-deterministic without making it stronger.',
].join('\n'));

/* ── summary ─────────────────────────────────────────────────────────────── */
console.log('\ndocintel-confirm-test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('  failed: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);

})().catch((e) => {
  /* A suite that dies mid-way must still REPORT — an abort scored as silence is
     an abort scored as a pass. */
  console.log('  ✗ suite aborted before completing — ' + (e && e.stack ? e.stack : e));
  console.log('\ndocintel-confirm-test: ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});

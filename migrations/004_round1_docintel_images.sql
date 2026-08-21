-- ============================================================================
-- ROUND 1 — Document Intelligence and image generation
-- ----------------------------------------------------------------------------
-- ONE migration for TWO lanes, on purpose. GAUNTLET-CORE's Integration Bar
-- requires that no two lanes wrote conflicting migrations; the cheapest way to
-- guarantee that is for the lanes not to write migrations at all. Foundation
-- owns this file. Lane B (Document Intelligence) and Lane D (image generation)
-- read it and add no DDL of their own.
--
-- PRIMARY KEYS ARE UUID, per the Engineering Bar. Note the deliberate
-- asymmetry: every FK pointing at an EXISTING table is INTEGER, because
-- users.id, teams.id and documents.id are all SERIAL and have been since this
-- platform was built. Matching the column you reference is not a violation of
-- the UUID rule, it is the only thing that works — a UUID column cannot
-- reference a SERIAL one.
--
-- gen_random_uuid() is built into PostgreSQL 13+ (pgcrypto was needed before
-- that). Railway serves 15/16. If this ever runs somewhere older, the failure
-- is loud at migration time rather than silent at insert time.
--
-- BYTEA, not a filesystem path and not an object-store URL. This repo has no
-- object store and the Engineering Bar forbids filesystem writes; verified by
-- grep for multer/s3/cloudinary/blob across server.js, routes/ and helpers/,
-- which returns nothing. See UPGRADE-SPEC §0.6.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- DOCUMENT INTELLIGENCE
-- ─────────────────────────────────────────────────────────────────────────────

-- The uploaded file, its bytes, and the text layer recovered from it.
CREATE TABLE IF NOT EXISTS docintel_documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id          INTEGER REFERENCES teams(id),
  uploaded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,

  filename         TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  content          BYTEA NOT NULL,

  -- 'pending' | 'extracted' | 'extracted_by_vision' | 'no_text_layer' | 'unsupported'
  --
  -- extracted_by_vision is kept SEPARATE from extracted and must stay that
  -- way: one is bytes that were really in the file, the other is a model's
  -- reading of a picture. Collapsing them would let a confident misreading of
  -- a scan look exactly like a verbatim text layer to the person approving it.
  text_status      TEXT NOT NULL DEFAULT 'pending',
  extracted_text   TEXT,
  block_count      INTEGER NOT NULL DEFAULT 0,
  extraction_note  TEXT,

  -- What record this document is bound to, once a human has said so.
  category         TEXT,
  target_kind      TEXT,
  target_id        TEXT,
  bound_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bound_at         TIMESTAMPTZ,

  model            TEXT,
  proposed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docintel_docs_user
  ON docintel_documents (user_id, created_at DESC);

-- A proposed value, held pending. NOTHING here has been written anywhere.
--
-- THREE COLUMNS FOR ONE VALUE, AND THE SPLIT IS THE SAFETY PROPERTY:
--   raw_value        the substring cut out of the document's OWN text
--   normalised_value that substring after the field's normaliser — what gets written
--   model_value      what the model TYPED — audit trail only, never written
--
-- The model is a locator, never a source. It names a field and quotes the
-- document; the value that reaches a column is sliced out of the document at
-- the offsets where that quote was found. A model that quotes a real sentence
-- and then types a different number gets nothing, because the typed value is
-- not inside the quote.
CREATE TABLE IF NOT EXISTS docintel_proposals (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             UUID NOT NULL REFERENCES docintel_documents(id) ON DELETE CASCADE,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  category                TEXT NOT NULL,
  field_key               TEXT NOT NULL,

  raw_value               TEXT,
  normalised_value        TEXT,
  model_value             TEXT,

  evidence_quote          TEXT,
  evidence_block          INTEGER,
  quote_verified          BOOLEAN NOT NULL DEFAULT FALSE,

  -- 'pending' | 'accepted' | 'rejected' | 'auto_rejected'
  --
  -- auto_rejected rows are KEPT. A reviewer who is shown only the proposals
  -- that passed the evidence guard sees a suspiciously short, suspiciously
  -- clean list and has no way to judge how much the model got wrong.
  status                  TEXT NOT NULL DEFAULT 'pending',
  reject_reason           TEXT,
  model                   TEXT,

  -- THE CONFIRMATION NONCE. A COLUMN, NOT A BOOLEAN, AND NOT AN IN-PROCESS MAP.
  --
  -- Settled ecosystem precedent, not a preference: M-EasyDo's blind critic
  -- proved that `{confirmed: true}` off a request body performed a write with
  -- no approval step having happened at all — nothing required that a
  -- confirmation had ever been ISSUED, and nothing bound the approval to the
  -- action. An approved cancel_appointment(7) was observed cancelling
  -- appointment 8, i.e. a different customer's booking.
  --
  -- Only the sha256 HASH is stored. The plaintext nonce is returned once, in
  -- the JSON that renders that one field's evidence card, and never written to
  -- the database or to a log line.
  accept_nonce_hash       TEXT,
  accept_nonce_user       INTEGER,
  accept_nonce_expires_at TIMESTAMPTZ,

  -- What the card actually displayed, captured at mint time so the accept path
  -- can refuse if the world moved underneath it (TOCTOU).
  shown_previous_json     TEXT,
  shown_target_id         TEXT,

  written_target          TEXT,
  accepted_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docintel_props_doc
  ON docintel_proposals (document_id, user_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- IMAGE GENERATION
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per generation attempt that reached the provider.
--
-- WHY THE BYTES LIVE HERE AND NOT AS A URL:
-- DashScope returns a signed OSS URL that EXPIRES. Alibaba's docs say 24
-- hours; the live service was measured on 2026-08-21 returning Expires
-- 7 days out. Either number is fatal to a saved document that stored the URL —
-- the image simply stops loading, later, with nothing in the logs. So the
-- bytes are downloaded and re-hosted inside the same request that generated
-- them, before this row is marked stored, and source_url is retained for
-- audit only. Nothing user-facing ever renders source_url.
CREATE TABLE IF NOT EXISTS image_generations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id               INTEGER REFERENCES teams(id),

  prompt                TEXT NOT NULL,
  negative_prompt       TEXT,
  lang                  VARCHAR(5),

  provider              TEXT NOT NULL DEFAULT 'dashscope',
  model                 TEXT NOT NULL,
  size                  TEXT NOT NULL,
  provider_request_id   TEXT,

  -- Audit only. Expires; never rendered to a user. See the note above.
  source_url            TEXT,
  source_url_expires_at TIMESTAMPTZ,

  -- The re-hosted image. NULL until status = 'stored'.
  content               BYTEA,
  content_type          TEXT,
  byte_size             INTEGER,
  sha256                TEXT,

  -- 'pending' | 'stored' | 'rehost_failed' | 'refused' | 'failed'
  --
  -- rehost_failed is distinct from failed BECAUSE IT STILL COST MONEY. The
  -- provider generated an image and billed for it; only the download failed.
  -- A cap that counts 'stored' alone would let a user with a flaky download
  -- path spend without limit, so the usage query counts both.
  status                TEXT NOT NULL DEFAULT 'pending',
  error_text            TEXT,

  -- Same moderation posture as every other AI output on this platform.
  moderation_status     TEXT,
  moderation_reason     TEXT,

  -- EXPLICIT BRAND-ASSET OPT-IN.
  -- A user's uploaded brand material is never folded into an image prompt as
  -- a side effect of having been uploaded. It travels only when the user
  -- initiated that specific action, and this column records that they did —
  -- so "did we send their logo to Alibaba?" is a query, not an argument.
  used_brand_asset      BOOLEAN NOT NULL DEFAULT FALSE,
  brand_asset_ref       TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The index the per-account budget cap reads. Covering (user_id, created_at)
-- so counting a rolling window does not scan the table as it grows.
CREATE INDEX IF NOT EXISTS idx_image_gen_user_window
  ON image_generations (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_gen_status
  ON image_generations (status);

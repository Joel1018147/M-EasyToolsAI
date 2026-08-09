/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS — Modus UI Contract §4.2
   ───────────────────────────────────────────────────────────────────────────
     GET   /api/settings            -> 200 { profile, security, … , _unavailable }
     PATCH /api/settings/:section   -> 200 { ok, updated } | 422 { error, fields }
     POST  /api/settings/password   -> 200 | 401 | 422
     POST  /api/settings/export     -> 501   (see below — it is NOT a 202 here)

   THE FIELD NAMES ARE THE CONTRACT (§4.2b). Every `name` in
   public/settings.html arrives here, and both come from the master. They are
   never re-derived from local markup: a locally-derived key set is a different
   key set on every platform the moment one `name` drifts, silently.

   ── WHY EXPORT ANSWERS 501 AND NOT 202 ────────────────────────────────────
   §B3: a 202 is only truthful if something drains the queue. Mall and Dragon
   Ginseng answer 202 because they have `scheduled_jobs`, a job runner started
   from the entry point, and registered handlers. This platform has none of
   those — its only deferred work is a bare `setInterval(runScheduledTasks, 1h)`
   in server.js, which is not a queue and has no handler registry. Enqueuing
   into nothing and answering 202 is indistinguishable from success on the
   caller's side, and the user waits for an archive that will never exist.
   Campus answers 501 for exactly this reason. Checked, not copied.

   ── UNAVAILABLE IS NOT THE SAME AS OFF ────────────────────────────────────
   Several of the ten sections' controls describe capabilities this platform
   does not have. §4.2 says the section still renders — hiding it teaches the
   user the capability does not exist and they never look again — and §4.3c
   says a control that cannot succeed must not pretend it can. So those fields
   are declared `unavailable` with a REASON: GET reports them in
   `_unavailable`, the page disables them and prints the reason, and a PATCH
   that carries one anyway is REFUSED with a 422 rather than silently ignored.
   Silently ignoring is how a client and a server disagree for months: the user
   toggles something, the page says "saved", and nothing ever changes.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

// ── parsers ───────────────────────────────────────────────────────────────
const oneOf = (...vals) => (v) => (vals.includes(v) ? v : undefined);
const bool  = (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const text  = (max) => (v) => {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length <= max ? t : undefined;
};

const FIELDS = {
  profile: {
    name:     { table: 'users', col: 'name', parse: text(255) },
    timezone: { col: 'timezone', parse: text(64) },
    // `email` is READ-ONLY: it is the sign-in identity and the unique key.
    // `phone` is accepted and IGNORED rather than rejected — see PATCH below.
    // `users` has no phone column here and adding one is a schema change this
    // rollout does not need.
  },
  security: {
    // There is no second-factor code path in this repo: no TOTP secret column,
    // no challenge at login, nothing that would read this. A stored flag
    // nothing enforces is worse than an absent feature — the user believes
    // their account is protected.
    twofa: { unavailable: true,
      why: 'Two-factor authentication is not available on M-EasyTools yet. Turning this on would store a flag that nothing checks at sign-in.' },
  },
  appearance: {
    theme:            { col: 'theme', parse: oneOf('light', 'dark', 'auto') },
    sidebarCollapsed: { col: 'sidebar_collapsed', parse: bool },
  },
  language: {
    lang:       { col: 'lang', parse: oneOf('en', 'ms', 'zh') },
    currency:   { col: 'currency', parse: oneOf('MYR', 'SGD', 'USD') },
    dateFormat: { col: 'date_format', parse: oneOf('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD') },
    // §B4 / §C3. Tax is a payment computation and this rollout does not touch
    // one. Subscription pricing on this platform is set in routes/subscription.js
    // and billed per plan; a user-editable rate here would look like it changed
    // what they are charged and would change nothing. A misleading control on
    // money is worse than a dead one.
    sstRate: { unavailable: true,
      why: 'SST on your subscription is set by billing, not per account. Contact support if your tax treatment is wrong.' },
  },
  notifications: {
    notifyEmail: { col: 'notify_email', parse: bool },
    notifyInApp: { col: 'notify_in_app', parse: bool },
    digest:      { col: 'digest', parse: oneOf('off', 'daily', 'weekly') },
    // No WhatsApp integration exists on this platform — no WABA credentials,
    // no send path, no webhook. Storing an opt-in for a channel that cannot
    // deliver is the §4.3d "reports a broken thing as healthy" shape.
    notifyWhatsapp: { unavailable: true,
      why: 'M-EasyTools does not send WhatsApp notifications. There is no WhatsApp channel connected to this platform.' },
  },
  ai: {
    // Section 6 is present and explains itself, per §4.2 — it is NOT removed.
    //
    // "Asha" is the ecosystem's customer-facing conversational agent
    // (M-EasyCommerce, M-EasyMall, Dragon Ginseng). M-EasyTools' AI is a
    // GENERATION layer: eleven tools that produce content on demand. There is
    // no conversation to set a tone for, nobody to escalate to, and no live
    // chat to hand over. Every one of these four controls would be inert.
    //
    // The brand voice that DOES steer this platform's output is
    // `users.brand_tone`, edited in the workspace next to the brand name and
    // description it belongs with. Surfacing it here under a different name
    // would give one setting two homes that can disagree.
    ashaTone: { unavailable: true,
      why: 'M-EasyTools has no conversational agent. The voice your generated content uses is the Brand Tone setting in your workspace.' },
    escalationPhone: { unavailable: true,
      why: 'Nothing on this platform escalates to a person — there is no live conversation to hand over.' },
    trilingualAutoDetect: { unavailable: true,
      why: 'Language is chosen per device and shared across all Modus platforms. Use the EN / BM / 中文 switch in the top bar.' },
    humanEscalation: { unavailable: true,
      why: 'Nothing on this platform escalates to a person — there is no live conversation to hand over.' },
  },
};

// Sections the page renders but that have nothing to PATCH.
const READ_ONLY_SECTIONS = ['team', 'integrations', 'billing', 'danger'];
const SECTIONS = [...Object.keys(FIELDS), ...READ_ONLY_SECTIONS];

const DEFAULTS = {
  timezone: 'Asia/Kuala_Lumpur', theme: 'light', sidebarCollapsed: false,
  lang: 'en', currency: 'MYR', dateFormat: 'DD/MM/YYYY',
  notifyEmail: true, notifyInApp: true, digest: 'off',
};

// ── schema ────────────────────────────────────────────────────────────────
// Applied by initDB() on every boot, before listen. There is deliberately no
// unapplied-migration state for these routes to degrade through.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    timezone          VARCHAR(64)  DEFAULT 'Asia/Kuala_Lumpur',
    theme             VARCHAR(16)  DEFAULT 'light',
    sidebar_collapsed BOOLEAN      DEFAULT FALSE,
    lang              VARCHAR(8)   DEFAULT 'en',
    currency          VARCHAR(8)   DEFAULT 'MYR',
    date_format       VARCHAR(16)  DEFAULT 'DD/MM/YYYY',
    notify_email      BOOLEAN      DEFAULT TRUE,
    notify_in_app     BOOLEAN      DEFAULT TRUE,
    digest            VARCHAR(16)  DEFAULT 'off',
    created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
  );
`;

// ── read ──────────────────────────────────────────────────────────────────
// §4.2d: a settings page that cannot read is not a settings page. Without this
// every field renders its template default and a user cannot tell a saved
// setting from a placeholder.
async function readSettings(req, res) {
  try {
    const r = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [req.user.id]);
    const stored = r.rows[0] || {};

    const out = {};
    const unavailable = {};
    for (const [section, fields] of Object.entries(FIELDS)) {
      out[section] = {};
      for (const [apiName, spec] of Object.entries(fields)) {
        if (spec.unavailable) {
          (unavailable[section] || (unavailable[section] = {}))[apiName] = spec.why;
          out[section][apiName] = false;
          continue;
        }
        const raw = spec.table === 'users' ? req.user[spec.col] : stored[spec.col];
        out[section][apiName] = raw === undefined || raw === null
          ? (DEFAULTS[apiName] === undefined ? null : DEFAULTS[apiName])
          : raw;
      }
    }
    out.profile.email = req.user.email;
    out.profile.role  = req.user.role;
    out.platform = { key: 'tools', name: 'M-EasyTools AI+ Super App' };
    out._unavailable = unavailable;
    res.json(out);
  } catch (err) {
    console.error('GET /api/settings:', err.message);
    res.status(500).json({ error: 'Could not load settings.' });
  }
}

// ── write ─────────────────────────────────────────────────────────────────
async function patchSection(req, res) {
  const { section } = req.params;
  if (!SECTIONS.includes(section)) return res.status(404).json({ error: 'No such settings section.' });
  const fields = FIELDS[section];
  if (!fields) return res.status(422).json({ error: 'This section has nothing to save.' });

  const body = req.body || {};
  const fieldErrors = {};
  const userUpdates = {};
  const settingUpdates = {};
  const updated = [];

  for (const [apiName, value] of Object.entries(body)) {
    // The canonical page posts `phone` and `email`; this platform keeps
    // neither as an editable profile field. Rejecting them would fail an
    // otherwise-valid save for fields it simply does not have.
    if (apiName === 'phone' || apiName === 'email') continue;
    const spec = fields[apiName];
    // Any OTHER unknown field is REJECTED, not dropped.
    if (!spec) { fieldErrors[apiName] = 'This platform does not have that setting.'; continue; }
    if (spec.unavailable) { fieldErrors[apiName] = spec.why; continue; }
    const parsed = spec.parse(value);
    if (parsed === undefined) { fieldErrors[apiName] = 'That value is not allowed.'; continue; }
    if (spec.table === 'users') userUpdates[spec.col] = parsed;
    else settingUpdates[spec.col] = parsed;
    updated.push(apiName);
  }

  if (Object.keys(fieldErrors).length) {
    return res.status(422).json({ error: 'Please check the highlighted fields.', fields: fieldErrors });
  }
  if (!updated.length) return res.json({ ok: true, updated: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (Object.keys(userUpdates).length) {
      const cols = Object.keys(userUpdates);
      const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(`UPDATE users SET ${set} WHERE id = $1`,
        [req.user.id, ...cols.map((c) => userUpdates[c])]);
    }
    if (Object.keys(settingUpdates).length) {
      const cols = Object.keys(settingUpdates);
      const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ');
      const conflict = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      // Upsert on the primary key: a user who has never opened settings has no
      // row at all, and a read-then-insert races itself across two tabs.
      await client.query(
        `INSERT INTO user_settings (user_id, ${cols.join(', ')})
         VALUES ($1, ${placeholders})
         ON CONFLICT (user_id) DO UPDATE SET ${conflict}, updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, ...cols.map((c) => settingUpdates[c])]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PATCH /api/settings/${section}:`, err.message);
    res.status(500).json({ error: 'Could not save. Please try again.' });
  } finally {
    client.release();
  }
}

// ── password ──────────────────────────────────────────────────────────────
async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const fields = {};
  if (!currentPassword) fields.currentPassword = 'Enter your current password.';
  if (!newPassword) fields.newPassword = 'Choose a new password.';
  else if (String(newPassword).length < 8) fields.newPassword = 'Use at least 8 characters.';
  if (Object.keys(fields).length) {
    return res.status(422).json({ error: 'Please check the highlighted fields.', fields });
  }
  try {
    const r = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    const hash = r.rows[0] && r.rows[0].password;
    // A Google-only account has no hash. Telling that user their current
    // password is wrong would be a lie they cannot act on.
    if (!hash) {
      return res.status(422).json({ error: 'This account signs in with Google and has no password to change.' });
    }
    if (!(await bcrypt.compare(String(currentPassword), hash))) {
      return res.status(401).json({
        error: 'That is not your current password.',
        fields: { currentPassword: 'Incorrect password.' },
      });
    }
    await pool.query('UPDATE users SET password = $2 WHERE id = $1',
      [req.user.id, await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS)]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/settings/password:', err.message);
    res.status(500).json({ error: 'Could not change the password. Please try again.' });
  }
}

// ── export ────────────────────────────────────────────────────────────────
// 501, honestly. See the header. Never enqueue into a queue nothing drains.
function exportData(_req, res) {
  res.status(501).json({
    error: 'Data export is not available on M-EasyTools yet.',
    detail: 'This platform has no background job runner, so an export could be accepted and then never produced. Email support@modusaiassociates.com and we will send you your data.',
  });
}

/**
 * Mounted from server.js, which owns the guard. Passing it in rather than
 * importing it keeps this file free of a circular require back into server.js
 * — and means the guard used here is provably the same object the rest of the
 * app uses, not a second one that could drift.
 */
function mount(app, requireAuth) {
  app.get('/api/settings', requireAuth, readSettings);
  app.patch('/api/settings/:section', requireAuth, patchSection);
  app.post('/api/settings/password', requireAuth, changePassword);
  app.post('/api/settings/export', requireAuth, exportData);
}

module.exports = { router, mount, SCHEMA, FIELDS, SECTIONS, DEFAULTS };
module.exports.settingsPagePath = path.join(__dirname, '..', 'public', 'settings.html');

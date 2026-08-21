'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   LANE D · IMAGE GENERATION — the contract
   ───────────────────────────────────────────────────────────────────────────
   THIS SUITE EXECUTES THE SHIPPED CODE. recurring-bugs #21 is this repo's own
   entry ("M-EasyTools — 6 suites green; the five suites that MENTION
   seller.html / content.html / server.js read them as TEXT"). So the
   behavioural half below mounts the REAL `routes/images.js` on a real Express
   app, drives it over real HTTP, and runs the REAL `lib/image` service and
   the REAL DashScope provider — including its request builder and its
   response parser — against an injected `fetch`.

   NO REAL API CALL IS MADE AND NO DATABASE IS NEEDED. `fetch` is injected, so
   nothing leaves the process and nothing is billed. `pg` is replaced by an
   in-memory pool that RECORDS EVERY QUERY, which is what lets the ordering
   claims ("the cap was checked before the provider call") be assertions
   rather than prose.

   The static half is a second, different class of check — ordering and
   structure that behaviour cannot prove on one path, e.g. "there exists no
   statement anywhere that sets status='stored' without also setting content".
   Both halves are kept; neither is treated as evidence of the other.
   ═══════════════════════════════════════════════════════════════════════════ */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'image');
const ROUTE_FILE = path.join(ROOT, 'routes', 'images.js');

let failures = 0;
let checks = 0;
function ok(msg) { checks += 1; console.log('  ✓ ' + msg); }
function fail(msg) { failures += 1; checks += 1; console.error('  ✗ ' + msg); }
function check(cond, msg) { if (cond) ok(msg); else fail(msg); }
async function section(name, fn) {
  console.log('\n' + name);
  try {
    await fn();
  } catch (err) {
    fail(`${name} threw: ${err && err.stack ? err.stack : err}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   HARNESS
   ═════════════════════════════════════════════════════════════════════════ */

/** A minimal but real PNG: the 8-byte signature the sniffer looks for. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(512, 0x2a),
]);

const PROVIDER_IMAGE_URL =
  'https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/1d/generated.png' +
  '?Expires=1787896093&OSSAccessKeyId=SECRET&Signature=abcdef%2Bgh';

/**
 * A user row shaped like this repo's `users` table, WITH EVERY BRAND COLUMN
 * POPULATED. That matters: a brand-leak test run against a user with no brand
 * data would pass a completely broken implementation.
 */
function makeUser(over = {}) {
  return {
    id: 101,
    name: 'Aina Rahman',
    email: 'aina@example.my',
    plan: 'free',
    role: 'user',
    team_id: null,
    brand_name: 'Kopi Sentral',
    brand_desc: 'A Malaysian specialty coffee chain with a warm, minimalist identity',
    brand_tone: 'Warm',
    ...over,
  };
}

/**
 * In-memory pg Pool. Records every (text, params) pair, and pushes an ordered
 * event so "before" and "after" are checkable across the pool and the network.
 */
function makePool({ events = [], dayCount = 0, monthCount = 0, seed = [] } = {}) {
  const store = new Map();
  for (const row of seed) store.set(row.id, row);
  const log = [];

  const pool = {
    log,
    store,
    events,
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      log.push({ sql, params, raw: String(text) });

      if (/^SELECT\s+COUNT/i.test(sql)) {
        events.push({ kind: 'db', op: 'cap_count', params });
        return { rows: [{ day_count: String(dayCount), month_count: String(monthCount) }] };
      }

      if (/^INSERT INTO image_generations/i.test(sql)) {
        const [user_id, team_id, prompt, negative_prompt, lang, provider, model, size,
               status, moderation_status, moderation_reason, used_brand_asset, brand_asset_ref] = params;
        const row = {
          id: crypto.randomUUID(),
          user_id, team_id, prompt, negative_prompt, lang, provider, model, size,
          status, moderation_status, moderation_reason, used_brand_asset, brand_asset_ref,
          content: null, content_type: null, byte_size: null, sha256: null,
          source_url: null, source_url_expires_at: null, provider_request_id: null,
          error_text: null, created_at: new Date().toISOString(),
        };
        store.set(row.id, row);
        events.push({ kind: 'db', op: 'insert', status, id: row.id });
        return { rows: [publicView(row)] };
      }

      if (/^UPDATE image_generations SET content = \$1/i.test(sql)) {
        const [content, content_type, byte_size, sha256, source_url, source_url_expires_at,
               provider_request_id, id, user_id] = params;
        const row = store.get(id);
        if (!row || row.user_id !== user_id) return { rows: [] };
        Object.assign(row, {
          content, content_type, byte_size, sha256, source_url, source_url_expires_at,
          provider_request_id, status: 'stored',
        });
        events.push({
          kind: 'db', op: 'mark_stored', id,
          hasContent: Buffer.isBuffer(content) && content.length > 0,
        });
        return { rows: [publicView(row)] };
      }

      if (/^UPDATE image_generations SET status = \$1/i.test(sql)) {
        const [status, error_text, source_url, source_url_expires_at, provider_request_id, id, user_id] = params;
        const row = store.get(id);
        if (!row || row.user_id !== user_id) return { rows: [] };
        Object.assign(row, { status, error_text, source_url, source_url_expires_at, provider_request_id });
        events.push({ kind: 'db', op: 'mark_failed', id, status });
        return { rows: [publicView(row)] };
      }

      if (/FROM image_generations WHERE id = \$1 AND user_id = \$2 AND status = 'stored'/i.test(sql)) {
        const [id, user_id] = params;
        const row = store.get(id);
        if (!row || row.user_id !== user_id || row.status !== 'stored') return { rows: [] };
        return { rows: [{ id: row.id, content: row.content, content_type: row.content_type, byte_size: row.byte_size, sha256: row.sha256 }] };
      }

      if (/FROM image_generations WHERE id = \$1 AND user_id = \$2$/i.test(sql)) {
        const [id, user_id] = params;
        const row = store.get(id);
        if (!row || row.user_id !== user_id) return { rows: [] };
        return { rows: [publicView(row)] };
      }

      if (/FROM image_generations WHERE user_id = \$1 ORDER BY/i.test(sql)) {
        const [user_id, limit, offset] = params;
        const rows = [...store.values()].filter((r) => r.user_id === user_id).slice(offset, offset + limit);
        return { rows: rows.map(publicView) };
      }

      if (/^DELETE FROM image_generations/i.test(sql)) {
        const [id, user_id] = params;
        const row = store.get(id);
        if (!row || row.user_id !== user_id) return { rowCount: 0, rows: [] };
        store.delete(id);
        return { rowCount: 1, rows: [] };
      }

      throw new Error('fake pool received an unrecognised statement: ' + sql);
    },
  };
  return pool;
}

/** Mirrors lib/image's PUBLIC_COLUMNS — the fake DB returns what the real SELECT would. */
function publicView(row) {
  const cols = require('../lib/image').PUBLIC_COLUMNS;
  const out = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

function fakeResponse({ status = 200, body = '', bytes = null, headers = {} }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) },
    async text() { return body; },
    async arrayBuffer() {
      const b = bytes || Buffer.from(body);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

const GOOD_GENERATION_BODY = JSON.stringify({
  request_id: 'req-abc-123',
  output: {
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        // A text part FIRST, on purpose: content[0].image is an assumption
        // that costs a paid generation the day the vendor reorders.
        content: [{ text: 'Here is your image.' }, { image: PROVIDER_IMAGE_URL }],
      },
    }],
  },
});

/**
 * Injected fetch. Distinguishes the generation POST from the image-download
 * GET by method, and records both on the shared event list.
 */
function makeFetch({
  events = [],
  generate = { status: 200, body: GOOD_GENERATION_BODY },
  download = { status: 200, bytes: PNG_BYTES, contentType: 'image/png' },
} = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'POST') {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ kind: 'generate', url, headers: init.headers, body });
      events.push({ kind: 'net', op: 'provider_generate', url });
      if (generate.throws) throw new Error(generate.throws);
      return fakeResponse({
        status: generate.status,
        body: generate.body,
        headers: { 'x-request-id': 'hdr-req-1' },
      });
    }
    calls.push({ kind: 'download', url });
    events.push({ kind: 'net', op: 'image_download', url });
    if (download.throws) throw new Error(download.throws);
    return fakeResponse({
      status: download.status,
      bytes: download.bytes,
      body: download.body || '',
      headers: { 'content-type': download.contentType || 'image/png' },
    });
  };
  impl.calls = calls;
  return impl;
}

/** Mount the REAL router with an injected service. Returns { base, close }. */
async function makeServer({ pool, fetchImpl, user, subscription }) {
  const { createImageService } = require('../lib/image');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.locals.imageService = createImageService({ pool, fetchImpl });
  // Stands in for requireAuth + checkSub, which server.js mounts in front.
  app.use((req, _res, next) => { req.user = user; req.subscription = subscription; next(); });
  app.use('/api/images', require('../routes/images'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(base, url, body) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text.startsWith('{') ? JSON.parse(text) : null };
}

async function get(base, url) {
  const res = await fetch(base + url);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  return {
    status: res.status,
    headers: res.headers,
    buf,
    text,
    json: text.startsWith('{') ? JSON.parse(text) : null,
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   STATIC HELPERS — comment-stripping, template extraction
   ═════════════════════════════════════════════════════════════════════════ */

/** Every .js under lib/image, plus routes/images.js. DERIVED, not listed (#24). */
function laneFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
    }
  })(LIB);
  out.push(ROUTE_FILE);
  return out.sort();
}

/**
 * Blank out `//` and `/* *\/` comments, preserving offsets and newlines.
 * Necessary, not cosmetic: every file in this lane DOCUMENTS the banned
 * shapes it avoids, so a raw scan reports each explanation as a violation
 * (recurring-bugs #16, "strip comments first").
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let inS = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inS) {
      if (c === '\\') { i += 2; continue; }
      if (c === inS) inS = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; i += 1; continue; }
    if (c === '/' && n === '/') {
      let j = i; while (j < src.length && src[j] !== '\n') { out[j] = ' '; j += 1; }
      i = j; continue;
    }
    if (c === '/' && n === '*') {
      let j = i;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
        if (src[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      for (let k = j; k < Math.min(j + 2, src.length); k++) out[k] = ' ';
      i = j + 2; continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every backtick template literal in a source file. */
function templateLiterals(src) {
  const found = [];
  const re = /`(?:[^`\\]|\\[\s\S])*`/g;
  let m;
  while ((m = re.exec(src)) !== null) found.push(m[0]);
  return found;
}

const SQL_RE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

/** Every SQL-carrying string literal in the lane. Derived from the files. */
function sqlLiterals() {
  const out = [];
  for (const file of laneFiles()) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const lit of templateLiterals(src)) {
      if (SQL_RE.test(lit)) out.push({ file: path.relative(ROOT, file), sql: lit });
    }
    // Ordinary quoted strings carrying SQL too — a one-line DELETE does not
    // need a template, and a scanner that only reads templates would miss it.
    const quoted = src.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g) || [];
    for (const lit of quoted) {
      if (SQL_RE.test(lit) && /image_generations/.test(lit)) {
        out.push({ file: path.relative(ROOT, file), sql: lit });
      }
    }
  }
  return out;
}

/* ═════════════════════════════════════════════════════════════════════════
   THE SUITE
   ═════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log('image-contract  ·  Lane D — image generation');

  const savedEnv = {
    key: process.env.DASHSCOPE_API_KEY,
    base: process.env.DASHSCOPE_BASE_URL,
    model: process.env.QWEN_IMAGE_MODEL,
  };
  process.env.DASHSCOPE_API_KEY = 'test-key-never-sent-anywhere';

  const image = require('../lib/image');
  const { sizes, moderation, brand, caps, rehost } = image;

  /* ── 0. the modules' own self-tests ─────────────────────────────────── */
  await section('0 · module self-tests (a guard that cannot fail is not a guard)', async () => {
    const n = moderation.selfTest();
    check(n >= 15, `moderation self-test ran ${n} assertions (every category reachable, benign prompts survive)`);

    // Prove THIS suite's own static scanner can see a violation, before its
    // silence is allowed to mean anything (recurring-bugs #14).
    const planted = "const sql = `SELECT * FROM image_generations WHERE user_id = ${userId}`;";
    const lits = templateLiterals(stripComments(planted)).filter((l) => SQL_RE.test(l));
    check(lits.length === 1 && /\$\{userId\}/.test(lits[0]),
      'the SQL-literal scanner detects an interpolated query in a planted sample');
    const plantedComment = '// setTimeout(fn, 1000)\nconst x = 1;';
    check(!/setTimeout\s*\(/.test(stripComments(plantedComment)),
      'the comment stripper removes a setTimeout mentioned in prose (no false positive)');
    const plantedReal = 'setTimeout(fn, 1000);';
    check(/setTimeout\s*\(/.test(stripComments(plantedReal)),
      'the comment stripper leaves a REAL setTimeout visible (no false negative)');
  });

  /* ── 1. the legal size set ──────────────────────────────────────────── */
  await section('1 · the legal size set is enforced locally, and 1024*1024 is REJECTED', async () => {
    assert.deepStrictEqual(
      sizes.LEGAL_SIZES.slice().sort(),
      ['1104*1472', '1328*1328', '1472*1104', '1664*928', '928*1664'].sort()
    );
    ok('LEGAL_SIZES is exactly the five values the live API named on 2026-08-21');

    const rejected = sizes.resolveSize('1024*1024');
    check(rejected.ok === false && rejected.code === 'illegal_size',
      '1024*1024 is REJECTED — the value every example uses, and the one this model family refuses');
    check(Array.isArray(rejected.legal) && rejected.legal.length === 5,
      'the rejection hands back the legal set, so the next request can be right');

    const withX = sizes.resolveSize('1328x1328');
    check(withX.ok === false && /asterisk/i.test(withX.message),
      'an "x" instead of "*" is rejected AND the message names the actual mistake');

    check(sizes.resolveSize(undefined).size === '1328*1328', 'the default is the measured square');
    for (const legal of sizes.LEGAL_SIZES) {
      const r = sizes.resolveSize(legal);
      if (!r.ok) fail(`legal size ${legal} was rejected`);
    }
    ok('every one of the five legal values is accepted');

    // Derived, not enumerated: nothing outside the legal set may be a literal
    // size anywhere in the lane.
    let strays = 0;
    for (const file of laneFiles()) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/['"](\d{3,4}\*\d{3,4})['"]/g)) {
        if (!sizes.LEGAL_SIZES.includes(m[1])) {
          fail(`${path.relative(ROOT, file)} contains a size literal outside the legal set: ${m[1]}`);
          strays += 1;
        }
      }
    }
    if (strays === 0) ok('no size literal anywhere in the lane falls outside LEGAL_SIZES');

    // And the HTTP surface refuses it without spending anything.
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser(), subscription: { status: 'trial' } });
    const res = await post(srv.base, '/api/images/generate', { prompt: 'A coffee cup', size: '1024*1024' });
    await srv.close();
    check(res.status === 400 && res.json.error === 'illegal_size',
      'POST /generate with 1024*1024 answers 400 illegal_size');
    check(fetchImpl.calls.length === 0,
      'NOTHING was sent to the provider — an illegal size never becomes a paid 400');
    check(pool.log.filter((q) => /^INSERT/i.test(q.sql)).length === 0,
      'and no row was written for a request that never happened');
  });

  /* ── 2. the happy path, and the ORDER of operations ─────────────────── */
  let storedImageId = null;
  await section('2 · the full pipeline, and the order it runs in', async () => {
    const events = [];
    const pool = makePool({ events, dayCount: 0, monthCount: 0 });
    const fetchImpl = makeFetch({ events });
    const user = makeUser();
    const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
    const res = await post(srv.base, '/api/images/generate', {
      prompt: 'A warm photo of a flat white on a marble counter',
      size: '1328*1328',
      lang: 'en',
    });

    check(res.status === 201 && res.json.ok === true, 'a clean generation answers 201');
    const img = res.json.image;
    check(img && img.status === 'stored', 'the row is status=stored');
    storedImageId = img && img.id;

    // ── the exact wire shape, asserted against the verified contract ────
    const gen = fetchImpl.calls.find((c) => c.kind === 'generate');
    check(!!gen, 'the provider was called');
    check(gen.url === 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'the endpoint is the Singapore international host + the multimodal-generation path');
    check(gen.headers.Authorization === 'Bearer test-key-never-sent-anywhere',
      'the key travels as a Bearer token');
    check(gen.body.model === 'qwen-image-plus', 'the model default is qwen-image-plus');
    assert.deepStrictEqual(
      gen.body.input,
      { messages: [{ role: 'user', content: [{ text: 'A warm photo of a flat white on a marble counter' }] }] }
    );
    ok('input.messages[].content[] carries the prompt as a { text } part');
    check(gen.body.parameters.size === '1328*1328', 'parameters.size uses the asterisk form');
    check(gen.body.parameters.n === 1 && gen.body.parameters.watermark === false &&
          gen.body.parameters.prompt_extend === false,
      'parameters carry n:1, watermark:false, prompt_extend:false');
    check(!('negative_prompt' in gen.body.parameters),
      'negative_prompt is omitted entirely when none was supplied');

    // ── ORDER: cap check, then insert, then provider, then download ─────
    const order = events.map((e) => e.op);
    const iCap = order.indexOf('cap_count');
    const iInsert = order.indexOf('insert');
    const iGen = order.indexOf('provider_generate');
    const iDl = order.indexOf('image_download');
    const iStored = order.indexOf('mark_stored');
    check(iCap !== -1 && iCap < iGen, 'THE CAP WAS CHECKED BEFORE THE PROVIDER CALL');
    check(iInsert !== -1 && iInsert < iGen, 'the pending row exists before the money is spent');
    check(iDl !== -1 && iDl > iGen, 'the image was downloaded after generation');
    check(iStored !== -1 && iDl < iStored, 'THE DOWNLOAD COMPLETED BEFORE THE ROW WAS MARKED stored');
    const storedEvent = events.find((e) => e.op === 'mark_stored');
    check(storedEvent && storedEvent.hasContent === true,
      "the statement that set status='stored' carried the image BYTES in the same UPDATE");

    // ── the cap counted the right statuses ──────────────────────────────
    const capQ = pool.log.find((q) => /^SELECT COUNT/i.test(q.sql));
    check(Array.isArray(capQ.params[1]) &&
          capQ.params[1].includes('stored') && capQ.params[1].includes('rehost_failed'),
      "the usage count includes BOTH 'stored' AND 'rehost_failed' — a rehost failure still cost money");
    check(capQ.params[1].includes('pending'),
      "and 'pending' too, because a row stuck mid-flight may also have been billed");
    check(!capQ.params[1].includes('refused') && !capQ.params[1].includes('failed'),
      "'refused' and 'failed' cost nothing and do NOT consume budget");

    await srv.close();
    return { pool, fetchImpl, user };
  });

  /* ── 3. the URL never reaches a user ────────────────────────────────── */
  await section('3 · the expiring provider URL is audit-only and never rendered', async () => {
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events });
    const user = makeUser();
    const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });

    const gen = await post(srv.base, '/api/images/generate', { prompt: 'A teh tarik glass on a wooden table' });
    const id = gen.json.image.id;
    const one = await get(srv.base, '/api/images/' + id);
    const many = await get(srv.base, '/api/images');

    for (const [label, payload] of [['POST /generate', gen.text], ['GET /:id', one.text], ['GET /', many.text]]) {
      check(!payload.includes('source_url'), `${label} response carries no source_url field`);
      check(!payload.includes('dashscope-result-sgp'), `${label} response carries no provider host`);
      check(!payload.includes('OSSAccessKeyId') && !payload.includes('Signature='),
        `${label} response leaks no signed-URL credentials`);
    }

    check(gen.json.image.url === `/api/images/${id}/file`,
      "the only address returned is this platform's own owner-scoped route");

    // It IS stored, for audit — the requirement is "retained, never rendered".
    const row = pool.store.get(id);
    check(row.source_url === PROVIDER_IMAGE_URL, 'source_url IS persisted, for audit');
    check(row.source_url_expires_at instanceof Date,
      'and its expiry is recorded from the URL\'s own Expires parameter');

    // The allowlist that makes this structural rather than a habit.
    check(!image.PUBLIC_COLUMNS.includes('source_url') &&
          !image.PUBLIC_COLUMNS.includes('source_url_expires_at') &&
          !image.PUBLIC_COLUMNS.includes('content'),
      'PUBLIC_COLUMNS — the allowlist every response is built from — excludes source_url and content');

    await srv.close();
  });

  /* ── 4. re-hosting is what makes a row usable ───────────────────────── */
  await section('4 · a re-host failure NEVER produces a stored row', async () => {
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events, download: { status: 403, body: '<Error>AccessDenied</Error>' } });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser(), subscription: { status: 'trial' } });
    const res = await post(srv.base, '/api/images/generate', { prompt: 'A nasi lemak flatlay' });

    check(res.status === 502 && res.json.error === 'rehost_failed',
      'a 403 on the download answers 502 rehost_failed');
    check(!events.some((e) => e.op === 'mark_stored'),
      "NO statement set status='stored' — the row never became usable");
    const row = [...pool.store.values()][0];
    check(row.status === 'rehost_failed', "the row's terminal status is 'rehost_failed'");
    check(row.content === null, 'and it holds no bytes');
    check(row.source_url === PROVIDER_IMAGE_URL, 'source_url is kept for audit even on failure');
    check(res.json.billed === true, 'the response states plainly that the generation WAS billed');
    check(!res.text.includes('dashscope-result-sgp'),
      'and the dead URL is still not handed to the caller');

    // The file route cannot serve it either.
    const f = await get(srv.base, `/api/images/${row.id}/file`);
    check(f.status === 404, 'GET /:id/file on a non-stored row is a 404, not a partial image');
    await srv.close();
  });

  await section('4b · a body that is not an image is refused, not stored', async () => {
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({
      events,
      download: { status: 200, bytes: Buffer.from('<html>gateway error</html>'), contentType: 'image/png' },
    });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser(), subscription: { status: 'trial' } });
    const res = await post(srv.base, '/api/images/generate', { prompt: 'A durian stall at night' });
    check(res.status === 502, 'a 200 whose body is HTML labelled image/png is refused');
    check(!events.some((e) => e.op === 'mark_stored'),
      'and no stored row is produced — the content-type came from the MAGIC BYTES, not the header');
    await srv.close();

    check(rehost.sniff(PNG_BYTES).type === 'image/png', 'the sniffer identifies a real PNG');
    check(rehost.sniff(Buffer.from('<html>')) === null, 'and refuses to identify HTML as an image');
  });

  /* ── 5. caps ────────────────────────────────────────────────────────── */
  await section('5 · budget caps are enforced BEFORE the provider call', async () => {
    // 'free' tier, month cap already reached.
    const events = [];
    const pool = makePool({ events, dayCount: 0, monthCount: caps.TIERS.free.month });
    const fetchImpl = makeFetch({ events });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser({ plan: 'free' }), subscription: null });
    const res = await post(srv.base, '/api/images/generate', { prompt: 'A kopitiam interior' });

    check(res.status === 429 && res.json.error === 'image_cap_exceeded', 'a exceeded budget answers 429');
    check(fetchImpl.calls.length === 0, 'THE PROVIDER WAS NEVER CALLED — nothing was charged');
    check(pool.log.filter((q) => /^INSERT/i.test(q.sql)).length === 0, 'and no pending row was written');
    check(res.json.limit === caps.TIERS.free.month && res.json.windowLabel === 'the last 30 days',
      'the 429 names the cap and the window it applies to');
    check(/before the request is sent/i.test(res.json.message),
      'and says explicitly that nothing was charged');
    await srv.close();

    // Daily throttle, separately.
    const e2 = [];
    const pool2 = makePool({ events: e2, dayCount: caps.TIERS.free.day, monthCount: 0 });
    const fetch2 = makeFetch({ events: e2 });
    const srv2 = await makeServer({ pool: pool2, fetchImpl: fetch2, user: makeUser(), subscription: null });
    const res2 = await post(srv2.base, '/api/images/generate', { prompt: 'A kopitiam interior' });
    check(res2.status === 429 && res2.json.window === 'day', 'the daily window is enforced independently');
    check(fetch2.calls.length === 0, 'and again the provider was never reached');
    await srv2.close();

    // Tier resolution — including the real repo defect it works around.
    check(caps.tierForPlan('free').tier.key === 'free', "users.plan='free' maps to the free tier");
    check(caps.tierForPlan('WHATEVER-ADMIN-TYPED').tier.key === 'free',
      'an unrecognised plan name FAILS CLOSED to the floor tier, never open');
    check(caps.tierForPlan('WHATEVER').recognised === false,
      'and the mismatch is reported rather than hidden');
    const paying = caps.resolveTier({ plan: 'free' }, { status: 'active' });
    check(paying.tier.key === 'monthly' && paying.from === 'subscription',
      "a paying customer whose users.plan is still 'free' (server.js never updates it on payment) " +
      'is capped on the SUBSCRIPTION, not the stale column');
    const agency = caps.resolveTier({ plan: 'agency' }, { status: 'trial' });
    check(agency.tier.key === 'agency', 'the more generous of the two signals wins in both directions');

    // Every tier the map declares must be strictly ordered — derived, not listed.
    const tiers = Object.values(caps.TIERS).sort((a, b) => a.rank - b.rank);
    check(tiers.length >= 5, `the tier table declares ${tiers.length} tiers (floor check, #24)`);
    let monotonic = true;
    for (let i = 1; i < tiers.length; i++) {
      if (!(tiers[i].day >= tiers[i - 1].day && tiers[i].month > tiers[i - 1].month)) monotonic = false;
    }
    check(monotonic, 'allowances increase monotonically with rank — no tier is a downgrade');

    // GET /usage reports without generating.
    const e3 = [];
    const pool3 = makePool({ events: e3, dayCount: 1, monthCount: 4 });
    const fetch3 = makeFetch({ events: e3 });
    const srv3 = await makeServer({ pool: pool3, fetchImpl: fetch3, user: makeUser(), subscription: null });
    const usage = await get(srv3.base, '/api/images/usage');
    check(usage.status === 200 && usage.json.used.month === 4 &&
          usage.json.remaining.month === caps.TIERS.free.month - 4,
      'GET /usage reports the real window counts and what is left');
    check(fetch3.calls.length === 0, 'and reaches no provider to do it');
    await srv3.close();
  });

  /* ── 6. moderation ──────────────────────────────────────────────────── */
  await section('6 · moderation refuses before the money is spent, and records the verdict', async () => {
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser(), subscription: { status: 'trial' } });

    const res = await post(srv.base, '/api/images/generate', {
      prompt: 'a photorealistic nude child on a beach',
    });
    check(res.status === 422 && res.json.error === 'moderation_refused', 'a prohibited prompt answers 422');
    check(fetchImpl.calls.length === 0, 'THE PROVIDER WAS NEVER CALLED — refused before spending');
    const row = [...pool.store.values()][0];
    check(row && row.status === 'refused' && row.moderation_status === 'refused',
      "the refusal is RECORDED (status='refused', moderation_status='refused')");
    check(typeof row.moderation_reason === 'string' && row.moderation_reason.length > 20,
      'with a human-readable reason, not an opaque code');

    // The negative prompt is screened too — a moderator that reads only the
    // prompt has a documented bypass in it.
    const res2 = await post(srv.base, '/api/images/generate', {
      prompt: 'A product photo of a water bottle',
      negative_prompt: 'deepfake',
    });
    check(res2.status === 422 && res2.json.field === 'negative_prompt',
      'the NEGATIVE prompt is screened as well, and the refusal names which field tripped');

    // A refusal must not consume budget.
    const capQ = pool.log.find((q) => /^SELECT COUNT/i.test(q.sql));
    check(capQ === undefined, 'no cap query even ran — the refusal happened first');

    // Allowed marketing work still passes, in all three platform languages.
    for (const [lang, prompt] of [
      ['en', 'A bright poster for a family cafe with two children sharing dessert'],
      ['ms', 'Poster promosi kedai kopi untuk kanak-kanak dan keluarga'],
      ['zh', '马来西亚咖啡店的儿童套餐宣传海报'],
    ]) {
      const good = await post(srv.base, '/api/images/generate', { prompt, lang });
      check(good.status === 201, `a benign ${lang} marketing prompt is allowed through`);
    }

    // #7: the Han path must match by substring, never \b.
    const cjk = moderation.screen([{ field: 'prompt', text: '生成一张儿童裸体的照片' }]);
    check(cjk.status === 'refused',
      'a prohibited Chinese prompt is refused — the Han terms match by substring, because \\b never matches between Han characters');

    await srv.close();
  });

  /* ── 7. brand assets ────────────────────────────────────────────────── */
  await section('7 · brand material travels ONLY on an explicit per-request opt-in', async () => {
    const user = makeUser();
    const USER_PROMPT = 'A minimalist product shot of a cold brew bottle';

    // (a) THE DEFAULT. Nothing is folded in — asserted against a user row
    //     whose brand columns are ALL populated.
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
      const res = await post(srv.base, '/api/images/generate', { prompt: USER_PROMPT });
      const sent = fetchImpl.calls.find((c) => c.kind === 'generate').body.input.messages[0].content[0].text;
      check(sent === USER_PROMPT,
        'with no opt-in the prompt sent to the provider is BYTE-IDENTICAL to the user\'s prompt');
      check(!sent.includes(user.brand_name) && !sent.includes(user.brand_desc) && !sent.includes(user.brand_tone),
        'no brand_name, brand_desc or brand_tone leaked into it as a side effect');
      check(res.json.image.used_brand_asset === false && res.json.image.brand_asset_ref === null,
        'and the row records used_brand_asset=false');
      await srv.close();
    }

    // (b) A ref with no flag is a refusal, not a quiet opt-in.
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
      const res = await post(srv.base, '/api/images/generate',
        { prompt: USER_PROMPT, brand_asset_ref: 'brand_desc' });
      check(res.status === 400 && res.json.error === 'brand_asset_not_opted_in',
        'brand_asset_ref without use_brand_asset:true is REFUSED, not silently honoured');
      check(fetchImpl.calls.length === 0, 'and nothing was sent');
      await srv.close();
    }

    // (c) A truthy string is not a boolean. "false" is truthy in JavaScript.
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
      const res = await post(srv.base, '/api/images/generate',
        { prompt: USER_PROMPT, use_brand_asset: 'false', brand_asset_ref: 'brand_desc' });
      check(res.status === 400,
        'use_brand_asset:"false" (a truthy STRING) is not an opt-in — strict boolean true is required');
      check(fetchImpl.calls.length === 0, 'and nothing was sent');
      await srv.close();
    }

    // (d) Lane B's uploaded documents are not addressable.
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
      for (const ref of ['docintel_documents', 'documents', 'extracted_text', '../../etc/passwd']) {
        const res = await post(srv.base, '/api/images/generate',
          { prompt: USER_PROMPT, use_brand_asset: true, brand_asset_ref: ref });
        check(res.status === 400 && res.json.error === 'unknown_brand_asset',
          `brand_asset_ref "${ref}" is refused — uploaded documents are deliberately not addressable`);
      }
      check(fetchImpl.calls.length === 0, 'and none of those reached the provider');
      await srv.close();
    }

    // (e) The allowlist is derived from the users row's own brand columns,
    //     and contains nothing that could reach another table.
    const refs = brand.allowedRefs();
    assert.deepStrictEqual(refs.slice().sort(), ['brand_desc', 'brand_name', 'brand_tone']);
    ok('the brand-asset allowlist is exactly the three brand columns on `users`');
    for (const file of laneFiles()) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      check(!/docintel_documents|docintel_proposals/.test(src),
        `${path.relative(ROOT, file)} contains no reference to Lane B's document tables`);
    }

    // (f) A real, valid opt-in DOES work — and is recorded.
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const srv = await makeServer({ pool, fetchImpl, user, subscription: { status: 'trial' } });
      const res = await post(srv.base, '/api/images/generate',
        { prompt: USER_PROMPT, use_brand_asset: true, brand_asset_ref: 'brand_desc' });
      const sent = fetchImpl.calls.find((c) => c.kind === 'generate').body.input.messages[0].content[0].text;
      check(res.status === 201 && sent.includes(user.brand_desc),
        'an explicit opt-in DOES send the named asset');
      check(res.json.image.used_brand_asset === true && res.json.image.brand_asset_ref === 'brand_desc',
        'and the row records WHICH asset was sent, so "did we send their brand copy?" is a query');
      check(res.json.image.prompt === sent,
        'the prompt STORED is the prompt SENT — the audit row describes what actually happened');
      await srv.close();
    }

    // (g) Opting in to an empty asset sends nothing rather than the string "null".
    {
      const events = [];
      const pool = makePool({ events });
      const fetchImpl = makeFetch({ events });
      const bare = makeUser({ brand_desc: null });
      const srv = await makeServer({ pool, fetchImpl, user: bare, subscription: { status: 'trial' } });
      const res = await post(srv.base, '/api/images/generate',
        { prompt: USER_PROMPT, use_brand_asset: true, brand_asset_ref: 'brand_desc' });
      check(res.status === 400 && res.json.error === 'brand_asset_empty',
        'opting in to an unset asset is an error, not a prompt containing "null"');
      await srv.close();
    }
  });

  /* ── 8. owner scoping ───────────────────────────────────────────────── */
  await section('8 · every read and write is owner-scoped', async () => {
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events });
    const owner = makeUser({ id: 101 });
    const stranger = makeUser({ id: 202, email: 'other@example.my' });

    const srvA = await makeServer({ pool, fetchImpl, user: owner, subscription: { status: 'trial' } });
    const made = await post(srvA.base, '/api/images/generate', { prompt: 'A latte art heart' });
    const id = made.json.image.id;
    const mine = await get(srvA.base, `/api/images/${id}/file`);
    check(mine.status === 200, 'the owner can fetch their own bytes');
    check(mine.headers.get('content-type') === 'image/png',
      'served with the content-type derived from the magic bytes');
    check(mine.headers.get('x-content-type-options') === 'nosniff',
      'X-Content-Type-Options: nosniff is set');
    check(/private/.test(mine.headers.get('cache-control') || ''),
      'Cache-Control is private — a shared cache must not hand one account\'s asset to the next caller');
    check(mine.buf.equals(PNG_BYTES), 'and the bytes returned are the bytes stored');
    await srvA.close();

    const srvB = await makeServer({ pool, fetchImpl, user: stranger, subscription: { status: 'trial' } });
    check((await get(srvB.base, `/api/images/${id}`)).status === 404,
      "another account's GET /:id is a 404");
    check((await get(srvB.base, `/api/images/${id}/file`)).status === 404,
      "another account's GET /:id/file is a 404");
    const del = await fetch(srvB.base + '/api/images/' + id, { method: 'DELETE' });
    check(del.status === 404, "another account's DELETE is a 404");
    check(pool.store.has(id), 'and the row still exists');
    const strangerList = await get(srvB.base, '/api/images');
    check(strangerList.json.images.length === 0, "another account's list is empty");
    await srvB.close();

    // A malformed id must not reach PostgreSQL as an invalid uuid literal.
    const srvC = await makeServer({ pool, fetchImpl, user: owner, subscription: { status: 'trial' } });
    const before = pool.log.length;
    const bad = await get(srvC.base, '/api/images/not-a-uuid');
    check(bad.status === 404, 'a non-UUID id answers 404');
    check(pool.log.length === before, 'without issuing a query at all (no PG 22P02)');
    await srvC.close();

    // Derived: EVERY statement in the lane that touches image_generations is
    // scoped by user_id. A rule, not a list of the queries someone remembered.
    const stmts = sqlLiterals().filter((s) => /image_generations/.test(s.sql));
    check(stmts.length >= 6, `${stmts.length} statements touch image_generations (floor check, #24)`);
    for (const s of stmts) {
      if (!/user_id/.test(s.sql)) {
        fail(`${s.file}: a statement touching image_generations is not scoped by user_id — ${s.sql.slice(0, 90)}…`);
      }
    }
    ok('every statement touching image_generations names user_id');
  });

  /* ── 9. parameterization, and the stored-vs-content invariant ───────── */
  await section('9 · static structure: parameterized queries, and one way to become "stored"', async () => {
    const stmts = sqlLiterals();
    check(stmts.length >= 6, `${stmts.length} SQL literals found in the lane (floor check)`);

    // Every interpolation inside a SQL literal must be the derived column
    // allowlist and nothing else. A `${userId}` is the shape this forbids.
    const ALLOWED_INTERPOLATION = new Set(['PUBLIC_SELECT']);
    let bad = 0;
    for (const s of stmts) {
      for (const m of s.sql.matchAll(/\$\{([^}]*)\}/g)) {
        const expr = m[1].trim();
        if (!ALLOWED_INTERPOLATION.has(expr)) {
          fail(`${s.file}: SQL literal interpolates \`${expr}\` — parameterized queries only`);
          bad += 1;
        }
      }
      if (/\bSELECT\s+\*/i.test(s.sql)) {
        fail(`${s.file}: SELECT * — the response allowlist is meaningless if the query is not one`);
        bad += 1;
      }
    }
    if (bad === 0) ok('no SQL literal interpolates anything but the derived column allowlist, and none uses SELECT *');

    // THE INVARIANT: status='stored' is only ever set together with content.
    const setsStored = stmts.filter((s) => /SET[\s\S]*status\s*=\s*'stored'/i.test(s.sql));
    check(setsStored.length === 1,
      `exactly one statement in the lane may set status='stored' (found ${setsStored.length})`);
    for (const s of setsStored) {
      check(/content\s*=\s*\$\d/.test(s.sql),
        "that statement writes `content` in the SAME UPDATE — there is no window in which a row is 'stored' with no bytes");
    }

    // And the read path is status-scoped as well as owner-scoped.
    const fileQ = stmts.filter((s) => /SELECT[\s\S]*content[\s\S]*FROM image_generations/i.test(s.sql));
    check(fileQ.length >= 1 && fileQ.every((s) => /status\s*=\s*'stored'/.test(s.sql)),
      "the bytes can only be read from a row whose status is 'stored'");
  });

  /* ── 10. no scheduling anywhere in this lane ────────────────────────── */
  await section('10 · no setTimeout, no setInterval, no queue (Engineering Bar)', async () => {
    const files = laneFiles();
    check(files.length >= 7, `${files.length} lane files scanned (floor check, #24)`);
    let hits = 0;
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const token of ['setTimeout', 'setInterval', 'setImmediate']) {
        const re = new RegExp('\\b' + token + '\\s*\\(');
        if (re.test(src)) {
          fail(`${path.relative(ROOT, file)} calls ${token}() — this repo has no job runner and the Bar forbids scheduling`);
          hits += 1;
        }
      }
    }
    if (hits === 0) ok('no scheduling primitive is called anywhere in lib/image or routes/images.js');

    const anyAbort = files.some((f) => /AbortSignal\.timeout/.test(fs.readFileSync(f, 'utf8')));
    check(anyAbort, 'network timeouts use AbortSignal.timeout, not a timer-armed AbortController');
  });

  /* ── 11. lazy construction and honest capability reporting ──────────── */
  await section('11 · nothing is constructed, and no env var is read, at import time', async () => {
    // Drop the whole lane from the require cache and re-require it with NO
    // key set. If any module read the environment at import, the values below
    // would be frozen wrong.
    for (const key of Object.keys(require.cache)) {
      if (key.includes(path.join('lib', 'image'))) delete require.cache[key];
    }
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_IMAGE_MODEL;
    delete process.env.DASHSCOPE_BASE_URL;

    const fresh = require('../lib/image');
    const providerBefore = fresh.provider.get();
    check(providerBefore.isConfigured() === false,
      'with DASHSCOPE_API_KEY unset the provider reports itself unconfigured');

    // has() semantics: EXISTS is not HAS A VALUE.
    process.env.DASHSCOPE_API_KEY = '   ';
    check(fresh.provider.get().isConfigured() === false,
      'a variable that is set to whitespace is NOT configured (helpers/capabilities.js has() semantics)');
    assert.deepStrictEqual(fresh.provider.get().missingVars(), ['DASHSCOPE_API_KEY']);
    ok('and the diagnostic reports the NAME only, never a value');

    // Now set them, AFTER import. A call-time read picks them up.
    process.env.DASHSCOPE_API_KEY = 'set-after-import';
    process.env.QWEN_IMAGE_MODEL = 'qwen-image-max';
    process.env.DASHSCOPE_BASE_URL = 'https://ws-123.ap-southeast-1.maas.aliyuncs.com/';
    const after = fresh.provider.get();
    check(after.isConfigured() === true, 'setting the key after import takes effect immediately');
    check(after.model() === 'qwen-image-max', 'QWEN_IMAGE_MODEL is read at call time');
    check(after.endpoint() === 'https://ws-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'DASHSCOPE_BASE_URL is read at call time, so a workspace-scoped migration is a variable change, not a code push');

    // An unconfigured deployment answers honestly rather than failing on click.
    delete process.env.DASHSCOPE_API_KEY;
    const events = [];
    const pool = makePool({ events });
    const fetchImpl = makeFetch({ events });
    const srv = await makeServer({ pool, fetchImpl, user: makeUser(), subscription: { status: 'trial' } });
    const res = await post(srv.base, '/api/images/generate', { prompt: 'A cup of kopi' });
    check(res.status === 503 && res.json.error === 'image_generation_unavailable',
      'an unconfigured deployment answers 503 with the reason, matching capabilities.js severity "optional"');
    assert.deepStrictEqual(res.json.missing, ['DASHSCOPE_API_KEY']);
    ok('naming the missing variable, never its value');
    check(fetchImpl.calls.length === 0, 'and reaches no provider');
    await srv.close();

    process.env.DASHSCOPE_API_KEY = 'test-key-never-sent-anywhere';
    delete process.env.QWEN_IMAGE_MODEL;
    delete process.env.DASHSCOPE_BASE_URL;
  });

  /* ── 12. provider abstraction is real ───────────────────────────────── */
  await section('12 · the provider is behind an interface the route does not see through', async () => {
    const routeSrc = fs.readFileSync(ROUTE_FILE, 'utf8');
    const routeCode = stripComments(routeSrc);
    for (const token of ['dashscope', 'DASHSCOPE', 'qwen', 'aliyuncs', 'Bearer']) {
      check(!routeCode.includes(token),
        `routes/images.js contains no "${token}" — a second provider needs no route change`);
    }

    const fresh = require('../lib/image');
    const p = fresh.provider.get();
    for (const method of ['isConfigured', 'missingVars', 'legalSizes', 'defaultSize', 'model', 'endpoint', 'buildBody', 'generate']) {
      check(typeof p[method] === 'function', `the provider interface declares ${method}()`);
    }
    check(p.name === 'dashscope' && fresh.provider.names().includes('dashscope'),
      'the registry key matches the value written to image_generations.provider');
    let threw = false;
    try { fresh.provider.get('fal'); } catch (err) { threw = err.code === 'unknown_provider'; }
    check(threw, 'an unknown provider name THROWS rather than silently routing to the default');

    // The response parser searches the content array rather than indexing it.
    const dashscope = require('../lib/image/providers/dashscope');
    const reordered = { output: { choices: [{ message: { content: [{ text: 'x' }, { image: 'https://a/b.png' }] } }] } };
    check(dashscope.extractImageUrl(reordered).url === 'https://a/b.png',
      'the URL is found by SEARCHING content[], so a leading text part does not cost a paid generation');
    check(dashscope.extractImageUrl({ output: { choices: [] } }).url === null,
      'and an empty response yields null with a note, not an exception');
    check(dashscope.extractExpiry(PROVIDER_IMAGE_URL) instanceof Date,
      "the expiry is read from the signed URL's own Expires parameter");
  });

  /* ── 13. provider failures are classified by whether they cost money ── */
  await section('13 · a provider failure is classified by whether it was billed', async () => {
    // A 400 generated nothing: 'failed', which the cap does NOT count.
    const e1 = [];
    const pool1 = makePool({ events: e1 });
    const fetch1 = makeFetch({
      events: e1,
      generate: { status: 400, body: JSON.stringify({ code: 'InvalidParameter', message: 'The size does not match the allowed size' }) },
    });
    const s1 = await makeServer({ pool: pool1, fetchImpl: fetch1, user: makeUser(), subscription: { status: 'trial' } });
    const r1 = await post(s1.base, '/api/images/generate', { prompt: 'A satay grill' });
    check(r1.status === 502 && r1.json.billed === false, 'a provider 400 is reported as not billed');
    check([...pool1.store.values()][0].status === 'failed',
      "and the row is 'failed' — a status the cap deliberately does not count");
    check(/InvalidParameter/.test(r1.json.message), "the vendor's own error code is surfaced, not swallowed");
    await s1.close();

    // A 200 with no usable URL DID cost money: 'rehost_failed', counted.
    const e2 = [];
    const pool2 = makePool({ events: e2 });
    const fetch2 = makeFetch({ events: e2, generate: { status: 200, body: JSON.stringify({ output: { choices: [{ message: { content: [{ text: 'no image' }] } }] } }) } });
    const s2 = await makeServer({ pool: pool2, fetchImpl: fetch2, user: makeUser(), subscription: { status: 'trial' } });
    const r2 = await post(s2.base, '/api/images/generate', { prompt: 'A satay grill' });
    check(r2.json.billed === true, 'a 200 carrying no image URL is reported as BILLED');
    check([...pool2.store.values()][0].status === 'rehost_failed',
      "and lands in 'rehost_failed', which the cap DOES count — the money was spent");
    check(caps.BILLABLE_STATUSES.includes('rehost_failed'), 'BILLABLE_STATUSES includes rehost_failed');
    await s2.close();
  });

  /* ── restore ────────────────────────────────────────────────────────── */
  if (savedEnv.key === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = savedEnv.key;
  if (savedEnv.base === undefined) delete process.env.DASHSCOPE_BASE_URL;
  else process.env.DASHSCOPE_BASE_URL = savedEnv.base;
  if (savedEnv.model === undefined) delete process.env.QWEN_IMAGE_MODEL;
  else process.env.QWEN_IMAGE_MODEL = savedEnv.model;

  console.log('');
  if (failures) {
    console.error(`✗ image-contract: ${failures} of ${checks} checks failed\n`);
    process.exit(1);
  }
  console.log(`✓ image-contract: ${checks} checks passed\n`);
}

main().catch((err) => {
  console.error('✗ image-contract crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

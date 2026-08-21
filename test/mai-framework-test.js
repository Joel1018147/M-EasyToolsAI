'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   LANE A · M-Ai — THE FRAMEWORK AND ITS GUARDS
   ───────────────────────────────────────────────────────────────────────────
   test/mai-boundary-test.js proves the STAFF-ONLY boundary. This file proves
   the other half: that the thing behind the boundary does what it claims.

   The one rule the framework exists to enforce: THE MODEL NEVER PRODUCES A
   FIGURE. It picks a tool, and it phrases a value an executor handed it. Every
   path where a model-authored number could reach a staff member is closed by
   CONTROL FLOW, and each closure is exercised here with a SCRIPTED model —
   because a test that calls a real model cannot prove the model never invents a
   figure; it can only fail to observe one.

   `lib/mai/{index,registry,dispatcher,validate,confirmations}.js` are COPIED
   VERBATIM from M-EasyDo-AI (Reuse Bar: reused, not re-authored). They are not
   assumed to work because they worked there — every guard is driven here,
   against this platform's own tool pack.

   No database: `postgres.railway.internal` resolves only inside Railway. The
   pool is a hand-rolled stub throughout.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const LIB_MAI = path.join(APP, 'lib', 'mai');

const { createRegistry, ANY_ROLE, NAME_RE } = require(path.join(LIB_MAI, 'registry.js'));
const { validateArgs } = require(path.join(LIB_MAI, 'validate.js'));
const { createDispatcher, figuresAreGrounded, groundedTokens, numbersIn, currenciesIn,
        normaliseArgs } = require(path.join(LIB_MAI, 'dispatcher.js'));
const { createConfirmationStore, TOKEN_RE } = require(path.join(LIB_MAI, 'confirmations.js'));
const roles = require(path.join(LIB_MAI, 'roles.js'));
const toolsMod = require(path.join(LIB_MAI, 'tools', 'index.js'));
const provider = require(path.join(LIB_MAI, 'provider.js'));

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅', n); }
  else { fail++; console.log('  ❌', n, e === undefined ? '' : e); }
};
const section = (m) => console.log('\n── ' + m + ' ' + '─'.repeat(Math.max(0, 66 - m.length)));

/* ── stubs ─────────────────────────────────────────────────────────────── */

function recordingDb(rowsFor) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      const rows = typeof rowsFor === 'function' ? rowsFor(String(sql).replace(/\s+/g, ' ').trim(), params || []) : [];
      return Promise.resolve({ rows: Array.isArray(rows) ? rows : [], rowCount: Array.isArray(rows) ? rows.length : 0 });
    },
  };
}

/** A model scripted turn by turn. Records every call it receives. */
function scriptedModel(turns) {
  const calls = [];
  let i = 0;
  const fn = async (input) => {
    calls.push(JSON.parse(JSON.stringify({ messages: input.messages, tools: (input.tools || []).map(t => t.function.name) })));
    const t = turns[Math.min(i, turns.length - 1)];
    i++;
    if (t instanceof Error) throw t;
    return Object.assign({ content: '', toolCalls: [], model: 'stub', inputTokens: 0, outputTokens: 0 }, t);
  };
  fn.calls = calls;
  return fn;
}

/** A one-tool registry, for driving the guards without the real pack. */
function probeRegistry({ kind = 'read', executor, requiredRoles = ['admin'], parameters, sideEffect } = {}) {
  const reg = createRegistry();
  const seen = { calls: 0, args: null };
  reg.register({
    name: 'probe_count',
    description: 'count the probe rows in this workspace, for the framework test suite',
    parameters: parameters || { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }, required: [] },
    requiredRoles,
    kind,
    reversible: kind === 'write' ? true : undefined,
    sideEffect: kind === 'write' ? (sideEffect || 'change one probe row. The previous value is reported back so it can be set again.') : undefined,
    describe: kind === 'write' ? ((a) => `set the probe row matching "${a.target || '?'}".`) : undefined,
    executor: executor || (async (args) => {
      seen.calls++; seen.args = args;
      return { display: '7 probe rows are open.', data: { count: 7, changed: kind === 'write' ? true : undefined }, rows: ['a', 'b'] };
    }),
  });
  return { reg, seen };
}

(async function main() {

  /* ═══════════════════════════════════════════════════════════════════════
     F1 — validate.js
     ═══════════════════════════════════════════════════════════════════════ */
  section('F1 — validateArgs: coercion, stripping, bounds');
  {
    const schema = {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
        name: { type: 'string', minLength: 1, maxLength: 10 },
        status: { type: 'string', enum: ['draft', 'published'] },
        flag: { type: 'boolean' },
        ids: { type: 'array', items: { type: 'integer' }, maxItems: 3 },
      },
      required: ['name'],
    };
    const v = (a) => validateArgs(schema, a);

    ok('a valid argument list passes', v({ name: 'x', days: 5 }).ok);
    ok('a numeric string is coerced ("5" → 5)', v({ name: 'x', days: '5' }).value.days === 5);
    ok('a non-numeric string is NOT coerced and fails', !v({ name: 'x', days: '5 days' }).ok);
    ok('a default is applied when the key is absent', v({ name: 'x' }).value.days === 30);
    ok('a missing required argument fails', !v({ days: 5 }).ok);
    ok('below minimum fails', !v({ name: 'x', days: 0 }).ok);
    ok('above maximum fails', !v({ name: 'x', days: 366 }).ok);
    ok('a huge float is rejected by the maximum', !v({ name: 'x', days: 1e308 }).ok);
    ok('a value outside an enum fails', !v({ name: 'x', status: 'submitted' }).ok);
    ok('a value inside the enum passes', v({ name: 'x', status: 'draft' }).ok);
    ok('a string longer than maxLength fails', !v({ name: 'x'.repeat(11) }).ok);
    ok('a boolean string is coerced', v({ name: 'x', flag: 'true' }).value.flag === true);
    ok('a single item is wrapped into an array', JSON.stringify(v({ name: 'x', ids: 4 }).value.ids) === '[4]');
    ok('an over-long array fails', !v({ name: 'x', ids: [1, 2, 3, 4] }).ok);

    /* THE SECURITY PROPERTY: a key the schema did not declare NEVER reaches an
       executor, so a model that invents `ownerId`, `role` or `user_id` in its
       argument list has it dropped before the query is built. */
    const inv = v({ name: 'x', ownerId: 1, role: 'admin', user_id: 9 });
    ok('an undeclared key is STRIPPED from the value', !('ownerId' in inv.value) && !('role' in inv.value) && !('user_id' in inv.value), inv.value);
    ok('…and is REPORTED in `ignored` rather than silently dropped',
       inv.ignored.includes('ownerId') && inv.ignored.includes('role') && inv.ignored.includes('user_id'), inv.ignored);
    ok('null arguments are a refusal, not an empty argument list', !v(null).ok);
    ok('an array of arguments is a refusal', !v([1, 2]).ok);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F2 — registry.js
     ═══════════════════════════════════════════════════════════════════════ */
  section('F2 — registry: registration rules and the execute envelope');
  {
    const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    const base = {
      name: 'good_name', description: 'a description long enough to route on, for the framework test',
      parameters: { type: 'object', properties: {}, required: [] },
      requiredRoles: ['admin'], kind: 'read', executor: async () => ({ display: 'x', data: {} }),
    };

    ok('NAME_RE rejects a name with a capital', !NAME_RE.test('Bad_Name'));
    ok('NAME_RE rejects a two-character name', !NAME_RE.test('ab'));
    ok('a bad name is refused at registration', !!throws(() => createRegistry().register({ ...base, name: 'Bad Name' })));
    ok('a duplicate name is refused', !!throws(() => { const r = createRegistry(); r.register(base); r.register(base); }));
    ok('a stub description is refused', !!throws(() => createRegistry().register({ ...base, description: 'short' })));
    ok('a non-object parameter schema is refused', !!throws(() => createRegistry().register({ ...base, parameters: {} })));
    ok('a non-function executor is refused', !!throws(() => createRegistry().register({ ...base, executor: 'nope' })));
    ok("kind other than 'read'/'write' is refused", !!throws(() => createRegistry().register({ ...base, kind: 'delete' })));
    ok('a describe on a READ tool is refused', !!throws(() => createRegistry().register({ ...base, describe: () => 'x' })));

    /* requiredRoles is COPIED at registration: a caller holding the array it
       passed must not be able to widen a tool's permissions after the fact. */
    const arr = ['admin'];
    const reg = createRegistry();
    reg.register({ ...base, requiredRoles: arr });
    arr.push('user');
    ok('pushing onto the array after registration does NOT widen the tool',
       !reg.canAccess('good_name', 'user'), reg.get('good_name').requiredRoles);

    /* The execute envelope. */
    const { reg: r2, seen } = probeRegistry();
    const good = await r2.execute('probe_count', { days: 5 }, { role: 'admin' });
    ok('execute returns ok with display/data/rows', good.ok && good.result.display && Array.isArray(good.result.rows), good);
    ok('execute reports the VALIDATED arguments back', good.args.days === 5, good.args);

    const unknown = await r2.execute('no_such_tool', {}, { role: 'admin' });
    ok('an unknown tool name returns unknown_tool', unknown.ok === false && unknown.reason === 'unknown_tool');

    /* Authorisation is re-checked AT EXECUTION, not only at the point of offer.
       A model can name a tool it was never shown. */
    seen.calls = 0;
    const forbidden = await r2.execute('probe_count', {}, { role: 'user' });
    ok('execute re-checks the role and refuses', forbidden.ok === false && forbidden.reason === 'forbidden');
    ok('…and the executor was never reached', seen.calls === 0, seen.calls);

    seen.calls = 0;
    const bad = await r2.execute('probe_count', { days: 999 }, { role: 'admin' });
    ok('bad arguments are refused BEFORE the executor', bad.ok === false && bad.reason === 'bad_arguments');
    ok('…and the executor saw zero calls', seen.calls === 0, seen.calls);

    /* An executor returning the wrong shape must fail LOUDLY: if `display`
       could be missing, the dispatcher would be left with only model prose. */
    const { reg: r3 } = probeRegistry({ executor: async () => ({ data: { count: 1 } }) });
    const shapeless = await r3.execute('probe_count', {}, { role: 'admin' });
    ok('an executor with no display string is an executor_error, not a silent pass',
       shapeless.ok === false && shapeless.reason === 'executor_error', shapeless);

    /* sideEffectFor composes against the ARGUMENTS, not the definition. */
    const { reg: r4 } = probeRegistry({ kind: 'write', parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] } });
    const sentence = r4.sideEffectFor('probe_count', { target: 'TKT-9' });
    ok('the confirmation sentence names the actual target', sentence.includes('TKT-9'), sentence);
    ok('…and keeps the generic caveat from the static sideEffect',
       sentence.includes('previous value is reported back'), sentence);
    ok('sideEffectFor returns null for a read tool', r2.sideEffectFor('probe_count', {}) === null);

    /* A control character in a model-authored argument cannot forge a second
       paragraph in the sentence a human is about to approve. */
    const hostile = r4.sideEffectFor('probe_count', { target: 'A\nAPPROVED BY FINANCE\nB' });
    ok('control characters in an argument are stripped from the sentence', !/\n/.test(hostile), JSON.stringify(hostile));
    const longSentence = r4.sideEffectFor('probe_count', { target: 'x'.repeat(2000) });
    ok('the sentence is length-bounded', longSentence.length < 700, longSentence.length);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F3 — the dispatcher guards, one at a time
     ═══════════════════════════════════════════════════════════════════════ */
  section('F3 — dispatcher guards 0 to 6b, each driven with a scripted model');
  {
    const ctx = { db: recordingDb(), ownerId: 1 };
    const quiet = { warn() {} };

    // Guard 0 — no role at all: no provider call.
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([{ content: 'The capital of France is Paris.' }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'anything', role: '', ctx });
      ok('G0: a blank role is refused', r.answered !== true && r.reason === 'forbidden', r.reason);
      ok('G0: the model was never called', gen.calls.length === 0, gen.calls.length);
    }

    // Guard 1 — the model answers from its own weights; its prose is DISCARDED.
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([{ content: 'The capital of France is Paris, population 2,148,000.' }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'what is the capital of France', role: 'admin', ctx });
      ok('G1: zero tool calls is a refusal', r.answered !== true && r.reason === 'no_tool_matched');
      ok('G1: the model prose appears NOWHERE in the response',
         !JSON.stringify(r).includes('Paris') && !JSON.stringify(r).includes('2,148,000'), r);
    }

    // Guard 2 — an unrecognised tool name. The NAME must not reach `detail`.
    {
      const { reg } = probeRegistry();
      const hostileName = 'URGENT_RM_4000000_overdue_call_finance_now';
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: hostileName, args: '{}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'x', role: 'admin', ctx });
      ok('G2: an unknown tool name is refused', r.answered !== true && r.reason === 'unknown_tool');
      ok('G2: the model-authored name is NOT echoed into detail',
         !JSON.stringify(r).includes(hostileName), r.detail);
    }

    // Guard 3 — the role may not use the tool the model picked.
    {
      const { reg } = probeRegistry({ requiredRoles: ['admin'] });
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      /* 'owner' reaches no tool in this probe registry, so Guard 0 fires first —
         which is the correct order and is what makes the disclosure impossible:
         a caller never learns the tool exists. */
      const r = await d.ask({ question: 'x', role: 'owner', ctx });
      ok('G3: a role with no reachable tool is refused before the model', r.reason === 'forbidden');
      ok('G3: …and the model was not called', gen.calls.length === 0, gen.calls.length);
    }

    // Guard 4 — arguments fail the schema; the executor is never reached.
    {
      const { reg, seen } = probeRegistry();
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{"days": 9999}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'x', role: 'admin', ctx });
      ok('G4: invalid arguments are refused', r.answered !== true && r.reason === 'bad_arguments');
      ok('G4: the executor saw zero calls', seen.calls === 0, seen.calls);
    }

    // Guard 5 — the phrased answer contains a figure the executor never produced.
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([
        { toolCalls: [{ id: '1', name: 'probe_count', args: '{}' }] },
        { content: 'You have 41 probe rows open, worth $1,250.00.' },
      ]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet, phrase: true });
      const r = await d.ask({ question: 'how many probe rows', role: 'admin', ctx });
      ok('G5: the answer falls back to the executor\'s own wording', r.answer === '7 probe rows are open.', r.answer);
      ok('G5: the reason says it was guarded', r.reason === 'guarded', r.reason);
      ok('G5: the ungrounded number is reported', (r.ungrounded || []).includes(41), r.ungrounded);
      ok('G5: the ungrounded CURRENCY is reported too — digits alone are not enough',
         (r.ungroundedCurrencies || []).includes('$'), r.ungroundedCurrencies);
      ok('G5: the invented figures appear nowhere in the answer',
         !r.answer.includes('41') && !r.answer.includes('1,250'), r.answer);
    }

    // …and a GROUNDED phrasing survives, so Guard 5 is not simply always-on.
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([
        { toolCalls: [{ id: '1', name: 'probe_count', args: '{}' }] },
        { content: 'There are 7 probe rows open.' },
      ]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet, phrase: true });
      const r = await d.ask({ question: 'how many probe rows', role: 'admin', ctx });
      ok('CONTROL: a grounded phrasing is returned as written', r.answer === 'There are 7 probe rows open.' && r.reason === 'answered', r);
    }

    // Guard 6 — a write under confirm mode is DESCRIBED, not performed.
    {
      const { reg, seen } = probeRegistry({
        kind: 'write',
        parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] },
      });
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{"target":"TKT-9"}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet, writeMode: 'confirm' });
      const r = await d.ask({ question: 'change the probe row', role: 'admin', ctx });
      ok('G6: a write returns pendingConfirmation', r.pendingConfirmation === true && r.reason === 'needs_confirmation');
      ok('G6: NOTHING ran — the executor saw zero calls', seen.calls === 0, seen.calls);
      ok('G6: the resolved tool and arguments come back with the sentence',
         r.tool === 'probe_count' && r.args.target === 'TKT-9' && r.sideEffect.includes('TKT-9'), r);
      ok('G6: `answered` is false while a confirmation is pending', r.answered !== true);
    }

    // Guard 6b — a write whose search argument names nothing.
    {
      const { reg, seen } = probeRegistry({
        kind: 'write',
        parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] },
      });
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{"target":" "}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet, writeMode: 'confirm' });
      const r = await d.ask({ question: 'change it', role: 'admin', ctx });
      ok('G6b: a whitespace-only search argument is refused on the ASK leg',
         r.pendingConfirmation !== true && r.reason === 'blank_argument', r.reason);
      ok('G6b: no confirmation sentence naming "(nothing)" was ever composed',
         !JSON.stringify(r).includes('(nothing)'), r);
      ok('G6b: the executor saw zero calls', seen.calls === 0, seen.calls);

      /* …and on the CONFIRM leg too. A token carrying a blank must not execute
         even though Guard 6b means no such token should exist. */
      const r2 = await d.confirm({ tool: 'probe_count', args: { target: '   ' }, role: 'admin', ctx });
      ok('G6b: the same argument is refused on the CONFIRM leg', r2.reason === 'blank_argument', r2.reason);
      ok('G6b: the executor still saw zero calls', seen.calls === 0, seen.calls);
    }

    // `confirmed` on ask() is refused LOUDLY rather than ignored.
    {
      const { reg } = probeRegistry({ kind: 'write', parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] } });
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{"target":"x"}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'do it', role: 'admin', ctx, confirmed: true });
      ok('ask({confirmed:true}) is refused by name, not ignored', r.reason === 'confirmed_removed', r.reason);
      ok('…and the model was never called', gen.calls.length === 0, gen.calls.length);
    }

    // confirm() executes the STORED pair and never consults the model.
    {
      const { reg, seen } = probeRegistry({ kind: 'write', parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] } });
      const gen = scriptedModel([{ toolCalls: [{ id: '1', name: 'probe_count', args: '{"target":"OTHER"}' }] }]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.confirm({ tool: 'probe_count', args: { target: 'APPROVED' }, role: 'admin', ctx,
                                  sideEffectShown: 'set the probe row matching "APPROVED".' });
      ok('confirm() runs and reports the write', r.answered === true && r.confirmed === true, r);
      ok('confirm() called the model ZERO times — this is what makes it a confirmation', gen.calls.length === 0, gen.calls.length);
      ok('confirm() ran the APPROVED arguments, not whatever the model would say now',
         seen.args.target === 'APPROVED', seen.args);
      ok('confirm() echoes the sentence that was actually shown',
         r.sideEffectShown === 'set the probe row matching "APPROVED".', r.sideEffectShown);

      const readBack = await d.confirm({ tool: 'probe_count', args: {}, role: 'admin', ctx });
      ok('confirm() re-validates the arguments', readBack.reason === 'bad_arguments', readBack.reason);
      const wrongRole = await d.confirm({ tool: 'probe_count', args: { target: 'x' }, role: 'user', ctx });
      ok('confirm() re-derives authorisation and refuses a revoked role', wrongRole.reason === 'forbidden', wrongRole.reason);
    }

    // A READ tool is never "confirmed" — that would be a second, unguarded
    // route into the executors that skips the model and Guard 1.
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([{}]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.confirm({ tool: 'probe_count', args: {}, role: 'admin', ctx });
      ok('confirm() refuses a READ tool', r.reason === 'not_confirmable', r.reason);
    }

    // `wrote` is derived from data.changed, not from the tool's kind.
    {
      const { reg } = probeRegistry({
        kind: 'write',
        parameters: { type: 'object', properties: { target: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['target'] },
        executor: async () => ({ display: 'Refused: nothing matched. Nothing was changed.', data: { changed: false, refused: true }, rows: [] }),
      });
      const gen = scriptedModel([{}]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.confirm({ tool: 'probe_count', args: { target: 'x' }, role: 'admin', ctx });
      ok('a write that deliberately changed nothing reports wrote:false',
         r.answered === true && r.wrote === false, { answered: r.answered, wrote: r.wrote });
    }

    // A provider failure is LOUD, not an "I don't know".
    {
      const { reg } = probeRegistry();
      const gen = scriptedModel([new Error('Groq error 429 — rate limit')]);
      const d = createDispatcher({ registry: reg, generate: gen, logger: quiet });
      const r = await d.ask({ question: 'how many probe rows', role: 'admin', ctx });
      ok('a provider failure surfaces as llm_error, not as "no tool matched"', r.reason === 'llm_error', r.reason);
      ok('…and the detail names the provider problem', /429|rate limit/.test(r.detail || ''), r.detail);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F4 — the grounding helpers, directly
     ═══════════════════════════════════════════════════════════════════════ */
  section('F4 — grounding: digits AND units');
  {
    const grounded = groundedTokens({ display: 'MYR 1,234.50 across 3 payments', rows: ['a', 'b', 'c'], data: { total: 1234.5, n: 3 } }, { days: 30 });
    ok('numbers in the display are grounded', grounded.numbers.has(1234.5) && grounded.numbers.has(3));
    ok('the validated arguments are grounded too (a model may echo "the last 30 days")', grounded.numbers.has(30));
    ok('the row COUNT is grounded even though it appears nowhere', grounded.numbers.has(3));
    ok('MYR is a grounded currency unit', grounded.currencies.has('MYR'));

    ok('a phrase quoting the same figures passes',
       figuresAreGrounded('MYR 1,234.50 across 3 payments over 30 days', grounded).ok);
    ok('an invented number fails', !figuresAreGrounded('MYR 1,234.50 across 4 payments', grounded).ok);
    /* The failure that a numbers-only guard waves through: right digits, wrong
       currency, invented symbol. */
    const wrongUnit = figuresAreGrounded('$1,234.50 across 3 payments', grounded);
    ok('right digits with an INVENTED currency symbol fails', !wrongUnit.ok, wrongUnit);
    ok('…and the offending unit is named', wrongUnit.offendingCurrencies.includes('$'), wrongUnit.offendingCurrencies);

    ok('numbersIn parses thousands separators', numbersIn('1,234.50').has(1234.5));
    ok('currenciesIn is case-insensitive and normalises', currenciesIn('rm 5').has('RM'));

    /* normaliseArgs decodes the JSON string a provider sends, and ONLY when it
       decodes to a plain object. */
    ok('a JSON object string is decoded', normaliseArgs('{"a":1}').a === 1);
    ok('malformed JSON passes through untouched, to fail validation', normaliseArgs('{"a":') === '{"a":');
    ok('a JSON array string passes through untouched', normaliseArgs('[1,2]') === '[1,2]');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F5 — confirmations.js
     ═══════════════════════════════════════════════════════════════════════ */
  section('F5 — confirmation tokens: single use, bound, expiring');
  {
    let now = 1_000_000;
    const store = createConfirmationStore({ ttlMs: 60_000, max: 3, now: () => now });
    const issued = store.issue({ tool: 'probe_count', args: { target: 'x' }, question: 'q',
                                 sideEffect: 's', reversible: true, userId: 7, ownerId: 7 });
    ok('a token is 64 hex characters', TOKEN_RE.test(issued.token), issued.token);
    ok('the record stores the RESOLVED tool and arguments', issued.record.tool === 'probe_count' && issued.record.args.target === 'x');

    ok('a token issued without an identity throws',
       (() => { try { store.issue({ tool: 't', args: {}, userId: null, ownerId: 7 }); return false; } catch (e) { return true; } })());

    /* The arguments are deep-copied: mutating the caller's object afterwards
       must not change what was approved. */
    const args = { target: 'x' };
    const i2 = store.issue({ tool: 'probe_count', args, userId: 7, ownerId: 7 });
    args.target = 'MUTATED';
    ok('the stored arguments are a deep copy', i2.record.args.target === 'x', i2.record.args);

    const wrongUser = store.consume(issued.token, { userId: 8, ownerId: 7 });
    ok('a token presented by another session is refused', wrongUser.ok === false && wrongUser.reason === 'confirm_invalid');
    const afterBurn = store.consume(issued.token, { userId: 7, ownerId: 7 });
    ok('…and it is BURNED by being touched, so the real owner cannot spend it either',
       afterBurn.ok === false, afterBurn);

    const i3 = store.issue({ tool: 'probe_count', args: { target: 'y' }, userId: 7, ownerId: 7 });
    const first = store.consume(i3.token, { userId: 7, ownerId: 7 });
    ok('a valid token is spent once', first.ok === true && first.record.args.target === 'y');
    const second = store.consume(i3.token, { userId: 7, ownerId: 7 });
    ok('…and exactly once', second.ok === false && second.reason === 'confirm_invalid');

    const i4 = store.issue({ tool: 'probe_count', args: {}, userId: 7, ownerId: 7 });
    now += 60_001;
    ok('an expired token is refused', store.consume(i4.token, { userId: 7, ownerId: 7 }).ok === false);

    ok('every failure returns the SAME reason — the endpoint is not an oracle',
       ['confirm_invalid'].includes(store.consume('z'.repeat(64), { userId: 7, ownerId: 7 }).reason));

    ok('the audit handle is 12 characters and is not the token',
       store.handle(i3.token).length === 12 && store.handle(i3.token) !== i3.token);
    ok('handle() refuses a non-token', store.handle('nope') === null);

    /* No timers anywhere in that module — the Engineering Bar forbids them and
       expiry is swept lazily on the paths that already run. */
    const CONF = fs.readFileSync(path.join(LIB_MAI, 'confirmations.js'), 'utf8');
    ok('confirmations.js schedules nothing', !/^[^/]*set(Timeout|Interval)\s*\(/m.test(CONF.replace(/\/\/[^\n]*/g, '')));
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F6 — roles.js against the real schema
     ═══════════════════════════════════════════════════════════════════════ */
  section('F6 — roles: only what server.js initDB() can actually store');
  {
    const SERVER = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
    ok("users.role is declared VARCHAR(20) DEFAULT 'user'", /role\s+VARCHAR\(20\)\s+DEFAULT\s+'user'/.test(SERVER));
    ok("team_members.role is declared VARCHAR(20) DEFAULT 'member'", /role\s+VARCHAR\(20\)\s+DEFAULT\s+'member'/.test(SERVER));

    /* Every role constant must be a value this codebase actually writes into
       users.role. A role no row can hold is a permission that can never be
       granted and never revoked. */
    for (const r of roles.ALL_ROLES) {
      ok(`server.js really writes users.role = '${r}' somewhere`,
         new RegExp(`role\\s*=\\s*'${r}'|'${r}'`).test(SERVER), r);
    }
    ok('ALL_ROLES is exactly [admin, owner]', JSON.stringify(roles.ALL_ROLES) === '["admin","owner"]', roles.ALL_ROLES);
    ok('STAFF equals ALL_ROLES', JSON.stringify(roles.STAFF) === JSON.stringify(roles.ALL_ROLES));
    ok('ADMIN_ONLY is exactly [admin]', JSON.stringify(roles.ADMIN_ONLY) === '["admin"]');
    ok('there is no CUSTOMER constant — you cannot name what does not exist', !('CUSTOMER' in roles));
    ok("'user' is not a staff role", !roles.ALL_ROLES.includes('user') && roles.isStaffRole('user') === false);
    ok("'member' is not a staff role", !roles.ALL_ROLES.includes('member') && roles.isStaffRole('member') === false);
    ok('normaliseRole trims (it tightens) …', roles.normaliseRole('  admin  ') === 'admin');
    ok('… and does NOT case-fold (that would grant privilege on a value nothing writes)',
       roles.normaliseRole('Admin') === null && roles.normaliseRole('ADMIN') === null);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F7 — the provider adapter
     ═══════════════════════════════════════════════════════════════════════ */
  section('F7 — provider: the Groq wire shape, and honesty about configuration');
  {
    const hadKey = process.env.GROQ_API_KEY;

    delete process.env.GROQ_API_KEY;
    ok('an ABSENT key reads as unconfigured', provider.isConfigured() === false);
    process.env.GROQ_API_KEY = '   ';
    ok('a PRESENT-BUT-EMPTY key reads as unconfigured — a variable that exists is not one that has a value',
       provider.isConfigured() === false);
    process.env.GROQ_API_KEY = 'gsk_secret_value_for_the_test';
    ok('a real key reads as configured', provider.isConfigured() === true);

    const st = provider.providerStatus();
    ok('providerStatus names the model', typeof st.model === 'string' && st.model.length > 3, st.model);
    ok('providerStatus NEVER echoes the key value', !JSON.stringify(st).includes('gsk_secret_value_for_the_test'), st);
    delete process.env.GROQ_API_KEY;
    const st2 = provider.providerStatus();
    ok('when unconfigured it names the missing VARIABLE, not a value',
       st2.missing.length === 1 && st2.missing[0] === 'GROQ_API_KEY' && typeof st2.reason === 'string', st2);

    /* toToolCalls: the provider's shape → the framework's shape. */
    const mapped = provider.toToolCalls({
      tool_calls: [
        { id: 'c1', function: { name: 'a_tool', arguments: '{"x":1}' } },
        { id: 'c2', function: {} },                       // malformed — dropped
        { function: { name: 'b_tool', arguments: '{}' } }, // no id — synthesised
        null,
      ],
    });
    ok('a well-formed tool call is mapped', mapped[0].name === 'a_tool' && mapped[0].id === 'c1');
    ok('the arguments are passed through RAW, not parsed here',
       mapped[0].args === '{"x":1}', mapped[0].args);
    ok('a malformed entry is DROPPED, never mapped to a blank name', mapped.length === 2, mapped);
    ok('a missing id is synthesised so the next request body is well-formed',
       typeof mapped[1].id === 'string' && mapped[1].id.length > 0, mapped[1]);
    ok('a non-array tool_calls yields []', provider.toToolCalls({}).length === 0);

    /* The tool-calling call itself, against a stubbed fetch. */
    process.env.GROQ_API_KEY = 'gsk_test';
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return { ok: true, status: 200, json: async () => ({ model: 'stub-model', usage: { prompt_tokens: 5, completion_tokens: 2 },
        choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'a_tool', arguments: '{}' } }] } }] }) };
    };
    try {
      const generate = provider.createMaiGenerate({ logger: { warn() {} } });
      const out = await generate({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'a_tool', description: 'd', parameters: {} } }] });
      ok('the tool-calling leg posts to the Groq completions endpoint',
         captured.url === 'https://api.groq.com/openai/v1/chat/completions', captured.url);
      ok('…carrying a tools array and a tool_choice',
         Array.isArray(captured.body.tools) && captured.body.tool_choice === 'auto', captured.body);
      ok('…and a model this file did not choose (it comes from helpers/groq.js)',
         captured.body.model === require(path.join(APP, 'helpers', 'groq.js')).GROQ_MODEL, captured.body.model);
      ok('the key travels in the Authorization header, never in a query string',
         /^Bearer /.test(captured.auth) && !captured.url.includes('key='), captured.url);
      ok('the response is mapped into the framework contract',
         out.toolCalls.length === 1 && out.toolCalls[0].name === 'a_tool' && out.inputTokens === 5, out);

      /* A non-2xx must THROW, so the dispatcher reports llm_error rather than
         "I don't know". */
      global.fetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'model_decommissioned' } }) });
      let threw = null;
      try { await generate({ messages: [], tools: [{ type: 'function', function: { name: 'a', description: 'd', parameters: {} } }] }); }
      catch (e) { threw = e.message; }
      ok('a Groq error THROWS and carries the provider message', threw === 'model_decommissioned', threw);

      global.fetch = async () => ({ ok: false, status: 502, text: async () => '<html>gateway timeout</html>' });
      threw = null;
      try { await generate({ messages: [], tools: [{ type: 'function', function: { name: 'a', description: 'd', parameters: {} } }] }); }
      catch (e) { threw = e.message; }
      ok('a NON-JSON error body is carried into the message rather than discarded',
         /502/.test(threw) && /gateway timeout/.test(threw), threw);
    } finally {
      global.fetch = realFetch;
      if (hadKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = hadKey;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F8 — this platform's tool pack, executed
     ═══════════════════════════════════════════════════════════════════════ */
  section('F8 — the M-EasyTools tool pack: honest empties, refusals, read-backs');
  {
    const registry = toolsMod.createMaiRegistry();
    const ctxFor = (db) => ({ role: 'admin', db, ownerId: 9, userId: 9, teamId: null });

    /* An empty account must get "this is an empty record, not a missing one",
       naming what WOULD have written a row. A bare "0" is the most expensive
       sentence this system can emit. */
    const empties = ['document_activity_summary', 'documents_by_tool', 'recent_documents',
                     'pr_release_pipeline', 'pr_distribution_summary', 'pr_coverage_report',
                     'workspace_team', 'subscription_status', 'billing_history'];
    for (const name of empties) {
      const db = recordingDb(() => []);
      const r = await registry.execute(name, {}, ctxFor(db));
      ok(`${name}: an empty account gets an honest empty answer`, r.ok === true, r.detail);
      if (!r.ok) continue;
      ok(`${name}: …that says it is an empty record, not a missing one`,
         /empty record, not a missing one/.test(r.result.display), r.result.display.slice(0, 90));
      ok(`${name}: …and names what would have written a row`, r.result.display.length > 80, r.result.display);
    }

    /* brand_profile must NOT report a blank profile for an identity the
       database does not recognise. That is a broken session, not a blank form. */
    {
      const db = recordingDb(() => []);
      const r = await registry.execute('brand_profile', {}, ctxFor(db));
      ok('brand_profile REFUSES when the asking account has no users row',
         r.ok === false && r.reason === 'executor_error', r.ok ? r.result.display : r.detail);
    }

    /* A schema gap degrades honestly; a REAL fault does not. */
    {
      const gap = recordingDb(() => { const e = new Error('relation "documents" does not exist'); throw e; });
      const r = await registry.execute('recent_documents', {}, ctxFor(gap));
      ok('a missing table answers "not measured", not zero',
         r.ok === true && /not measured/.test(r.result.display), r);

      const broken = recordingDb(() => { throw new Error('Connection terminated unexpectedly'); });
      const r2 = await registry.execute('recent_documents', {}, ctxFor(broken));
      ok('a dropped connection is NOT laundered into "no data"',
         r2.ok === false && r2.reason === 'executor_error', r2);
    }

    /* The write paths: not found, ambiguous, no change, and the read-back. */
    {
      const notFound = recordingDb(() => []);
      const r = await registry.execute('rename_document', { document: 'nothing', title: 'X' }, ctxFor(notFound));
      ok('rename_document refuses a target that is not on this account',
         r.ok && r.result.data.changed === false && r.result.data.refused === true, r);
      ok('…and the refusal does not say whether the row exists elsewhere',
         !/another account|other user/i.test(r.result.display), r.result.display);

      const ambiguous = recordingDb((sql) => /SELECT id, title/.test(sql)
        ? [{ id: 1, title: 'Q3 report' }, { id: 2, title: 'Q3 report v2' }] : []);
      const r2 = await registry.execute('rename_document', { document: 'Q3', title: 'X' }, ctxFor(ambiguous));
      ok('rename_document REFUSES an ambiguous match rather than picking one',
         r2.ok && r2.result.data.changed === false && r2.result.data.reason === 'ambiguous_match', r2.result.data);

      const same = recordingDb((sql) => /SELECT id, title/.test(sql) ? [{ id: 1, title: 'Same' }] : []);
      const r3 = await registry.execute('rename_document', { document: '1', title: 'Same' }, ctxFor(same));
      ok('rename_document reports no change when the title already matches',
         r3.ok && r3.result.data.changed === false && r3.result.data.reason === 'already_in_state', r3.result.data);

      /* READ BACK AND THROW: a database that reports a matched row but stores
         something else must not be reported as a success. */
      const lying = recordingDb((sql) => {
        if (/^SELECT title FROM documents/i.test(sql)) return [{ title: 'STILL THE OLD ONE' }];
        if (/^UPDATE documents/i.test(sql)) return [{ id: 1 }];
        if (/SELECT id, title/i.test(sql)) return [{ id: 1, title: 'Old' }];
        return [];
      });
      const r4 = await registry.execute('rename_document', { document: '1', title: 'New' }, ctxFor(lying));
      ok('rename_document THROWS when the value does not read back',
         r4.ok === false && /reads back as/.test(r4.detail), r4);
    }

    /* THE SEND-ADJACENT RULE: M-Ai may record a claim the platform made; it may
       not manufacture one. A release with no distribution cannot be labelled
       submitted or published. */
    {
      const noDist = recordingDb((sql) => {
        if (/COUNT\(\*\)::int AS c FROM pr_distributions/i.test(sql)) return [{ c: 0 }];
        if (/SELECT id, headline/i.test(sql)) return [{ id: 3, headline: 'H', company_name: 'C', status: 'draft' }];
        return [];
      });
      for (const status of ['submitted', 'published']) {
        const r = await registry.execute('set_pr_release_status', { release: '3', status }, ctxFor(noDist));
        ok(`set_pr_release_status REFUSES "${status}" on a release that was never distributed`,
           r.ok && r.result.data.changed === false && r.result.data.reason === 'no_distribution_exists', r.result.data);
        const updates = noDist.calls.filter(c => /^\s*UPDATE/i.test(c.sql));
        ok(`…and issued no UPDATE at all for "${status}"`, updates.length === 0, updates.map(c => c.sql));
      }

      /* Going BACK to draft is always allowed — it retracts a claim rather than
         making one. */
      const backToDraft = recordingDb((sql) => {
        if (/^SELECT status FROM pr_releases/i.test(sql)) return [{ status: 'draft' }];
        if (/^UPDATE pr_releases/i.test(sql)) return [{ id: 3 }];
        if (/SELECT id, headline/i.test(sql)) return [{ id: 3, headline: 'H', company_name: 'C', status: 'published' }];
        return [];
      });
      const r = await registry.execute('set_pr_release_status', { release: '3', status: 'draft' }, ctxFor(backToDraft));
      ok('set_pr_release_status ALLOWS the retraction direction (→ draft)',
         r.ok && r.result.data.changed === true, r);
      ok('…and says out loud that nothing was sent',
         /Nothing was sent/i.test(r.result.display) && r.result.data.sent === false, r.result.display);
      ok('…and reports the previous status so the change can be undone',
         r.result.data.previousStatus === 'published', r.result.data);
    }

    /* The describers, which are what a human actually approves. */
    {
      const D = toolsMod.DESCRIBERS;
      ok('every write tool has a describer',
         registry.list().filter(t => t.kind === 'write').every(t => typeof D[t.name] === 'function'));
      ok('rename_document names both the target and the new title',
         D.rename_document({ document: 'Q3', title: 'Q3 final' }).includes('Q3 final'));
      ok('set_pr_release_status names the release and the status',
         /matching "3".*status published/.test(D.set_pr_release_status({ release: '3', status: 'published' })),
         D.set_pr_release_status({ release: '3', status: 'published' }));
      ok('a blank argument renders as "(nothing)" — which Guard 6b makes unreachable',
         D.rename_document({ document: '', title: 'x' }).includes('(nothing)'));

      /* The full sentence a human sees, composed through the registry. */
      const s = registry.sideEffectFor('set_pr_release_status', { release: '3', status: 'draft' });
      ok('the composed sentence carries the generic caveat about sending nothing',
         /emails nobody|no journalist is contacted|no distribution is created/i.test(s), s);
    }

    /* Money is reported with the unit the ROW carried, and the one figure with
       no currency column is left bare. */
    {
      const shared = require(path.join(LIB_MAI, 'tools', 'shared.js'));
      ok('money() prints the ISO code the row recorded', shared.money(1234.5, 'MYR') === 'MYR 1,234.50', shared.money(1234.5, 'MYR'));
      ok('money() does not translate MYR into a symbol the row never carried',
         !shared.money(1, 'MYR').includes('RM'));
      ok('money() honours a different recorded currency', shared.money(1, 'usd') === 'USD 1.00', shared.money(1, 'usd'));
      ok('the package price is emitted with NO unit — pr_distributions records no currency',
         !/[A-Z]{3}|RM|\$/.test(shared.prPackagePrice(1234.5)), shared.prPackagePrice(1234.5));
      ok('ownerIdOf throws on a missing owner rather than binding NULL',
         (() => { try { shared.ownerIdOf({}); return false; } catch (e) { return /must not run|refusing/i.test(e.message); } })());
      ok('ownerIdOf throws on a non-positive owner',
         (() => { try { shared.ownerIdOf({ ownerId: 0 }); return false; } catch (e) { return true; } })());
      ok('a thrown owner-scope error is NOT a schema gap, so safe() cannot launder it',
         shared.isSchemaGap(new Error('M-Ai: ctx.ownerId is missing')) === false);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F9 — the page
     ═══════════════════════════════════════════════════════════════════════ */
  section('F9 — public/mai.html');
  {
    const p = path.join(APP, 'public', 'mai.html');
    ok('public/mai.html exists', fs.existsSync(p), p);
    const html = fs.readFileSync(p, 'utf8');
    ok('it declares data-platform="tools"', /<html[^>]*data-platform="tools"/.test(html));
    ok('it loads the shared design system from /css/', /href="\/css\/modus-design-system\.css"/.test(html));
    ok('it loads the round-2 tokens after it', /href="\/css\/r2-tokens\.css"/.test(html));

    /* NOT ONE COLOUR LITERAL. The platform orange has exactly one definition —
       [data-platform="tools"] in the md5-pinned master — and this page consumes
       it. A literal here would be a second source of truth for it. */
    const style = (html.match(/<style[\s\S]*?<\/style>/) || [''])[0];
    const hexes = style.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    ok('the page stylesheet contains NO colour literal', hexes.length === 0, hexes);
    const fns = style.match(/\b(rgb|rgba|hsl|hsla)\s*\(/g) || [];
    ok('…and no raw rgb()/hsl() either', fns.length === 0, fns);
    ok('it consumes var(--accent)', /var\(--accent\)/.test(style));

    ok('it never references a deleted login surface', !/login\.html|signup\.html/.test(html));

    /* Comments stripped before every behavioural claim below: this page's own
       prose says "it does not go into localStorage", and a guard that a comment
       can trip is a guard that a comment can also satisfy. */
    const code = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

    ok('the confirm token is never persisted outside the page\'s memory',
       !/localStorage|sessionStorage|document\.cookie/.test(code),
       (code.match(/localStorage|sessionStorage|document\.cookie/) || [])[0]);
    ok('every fetch response has its status checked', /res\.ok|res\.status/.test(code));

    /* The only two request bodies this page can build. */
    ok('the ask leg sends exactly { question }', /post\(\s*\{\s*question:\s*q\s*\}/.test(code), 'ask body');
    ok('the confirm leg sends exactly { confirmToken }', /post\(\s*\{\s*confirmToken:\s*token\s*\}/.test(code));
    /* …and they are the ONLY two, and the only thing serialised into a request
       body is that one parameter. A crude "does the word role appear" scan is
       defeated by any ternary (`data.role ? … : …`), so the check is made where
       it is actually decidable: the call sites and the serialisation. */
    const postSites = (code.match(/\bpost\(\s*\{/g) || []).length;
    ok('there are exactly two request-building call sites on this page', postSites === 2, postSites);
    const serialised = code.match(/body:\s*JSON\.stringify\(([^)]*)\)/g) || [];
    ok('every request body is JSON.stringify(body) — the page builds no other',
       serialised.length === 1 && /JSON\.stringify\(body\)/.test(serialised[0]), serialised);
    ok('the page sets no authentication header — the session cookie is the identity',
       !/x-api-key|Authorization|x-seller-key/i.test(code));
    ok('…and sends the session cookie explicitly rather than relying on a default',
       /credentials:\s*'same-origin'/.test(code));

    ok('the daily-use surface animates no transform (text-transform is not one)',
       !/(^|[^-\w])transform\s*:/.test(style), (style.match(/(^|[^-\w])transform\s*:[^;]*/) || [])[0]);
    ok('it honours prefers-reduced-motion', /prefers-reduced-motion/.test(style));
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F10 — the framework files are the SHARED ones, unedited
     ═══════════════════════════════════════════════════════════════════════ */
  section('F10 — the reused framework is reused, not re-authored');
  {
    /* The Reuse Bar's claim is that five files were copied VERBATIM. The
       reference repo is read-only and may not be present on every machine, so
       this checks what can be checked locally: the files carry the shared
       boundary comment, export the shared surface, and name nothing from this
       platform. When the reference IS present, the bytes are compared. */
    const FRAMEWORK = ['index.js', 'registry.js', 'dispatcher.js', 'validate.js', 'confirmations.js'];
    const idx = require(path.join(LIB_MAI, 'index.js'));
    for (const k of ['createRegistry', 'createDispatcher', 'validateArgs', 'ANY_ROLE', 'DEFAULT_REFUSAL']) {
      ok(`lib/mai/index.js re-exports ${k}`, k in idx, Object.keys(idx));
    }
    ok('lib/mai/index.js does NOT re-export roles — the one file that does not travel stays off the surface',
       !('ALL_ROLES' in idx) && !('normaliseRole' in idx), Object.keys(idx));

    const REF = path.join(APP, '..', 'M-EasyDo-AI', 'lib', 'mai');
    if (fs.existsSync(REF)) {
      const crypto = require('crypto');
      const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
      for (const f of FRAMEWORK) {
        ok(`lib/mai/${f} is byte-identical to the shared original`,
           md5(path.join(LIB_MAI, f)) === md5(path.join(REF, f)),
           { here: md5(path.join(LIB_MAI, f)).slice(0, 8), there: md5(path.join(REF, f)).slice(0, 8) });
      }
    } else {
      console.log('       · the reference repo is not present here; the byte comparison was NOT run.');
      console.log('         That is reported, not passed over — it is the one check this file cannot make offline.');
    }

    /* The platform-specific refusal sentence is supplied as an OPTION rather
       than by editing the copied file — which is what keeps the copy a copy. */
    ok('the tool pack supplies its own refusal sentence',
       typeof toolsMod.REFUSAL === 'string' && /documents|press releases/.test(toolsMod.REFUSAL), toolsMod.REFUSAL);
    ok('…and it does not name another platform', !/M-EasyDo/i.test(toolsMod.REFUSAL));

    const gen = scriptedModel([{ content: 'I know the answer already.' }]);
    const a = toolsMod.createMaiAssistant({ generate: gen, logger: { warn() {} } });
    const r = await a.ask({ question: 'what is the capital of France', role: 'admin', ctx: { db: recordingDb(), ownerId: 1 } });
    ok('the refusal a staff member actually sees is this platform\'s sentence',
       r.answer === toolsMod.REFUSAL, r.answer);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     F11 — THE AUDIT TRAIL
     ─────────────────────────────────────────────────────────────────────────
     A write M-Ai performed must be answerable six months from now: who asked,
     what they were shown, whether they approved it, and whether it worked. The
     durable half is `audit_log` (migrations/004, Foundation-owned); the process
     line is kept as a second sink so a database outage at the moment of a write
     does not erase the only evidence of it.
     ═══════════════════════════════════════════════════════════════════════ */
  section('F11 — audit_log: successes, failures, and the token that must never appear');
  {
    /* A pool that serves the tool queries AND captures the audit insert. The
       `auditFails` switch is how a database that is down at exactly the wrong
       moment is simulated. */
    function auditPool({ auditFails = false, lieOnReadBack = false } = {}) {
      const inserts = [];
      const state = { prStatus: 'draft' };
      const db = {
        inserts,
        query(sql, params) {
          const s = String(sql).replace(/\s+/g, ' ').trim();
          if (/^INSERT INTO audit_log/i.test(s)) {
            inserts.push({ sql: s, params: params || [] });
            return auditFails
              ? Promise.reject(new Error('relation "audit_log" does not exist'))
              : Promise.resolve({ rows: [], rowCount: 1 });
          }
          if (/COUNT\(\*\)::int AS c FROM pr_distributions/i.test(s)) return Promise.resolve({ rows: [{ c: 1 }] });
          if (/^SELECT status FROM pr_releases/i.test(s)) {
            return Promise.resolve({ rows: [{ status: lieOnReadBack ? 'draft' : state.prStatus }] });
          }
          if (/^UPDATE pr_releases/i.test(s)) { state.prStatus = params[0]; return Promise.resolve({ rows: [{ id: 5 }] }); }
          if (/SELECT id, headline/i.test(s)) {
            return Promise.resolve({ rows: [{ id: 5, headline: 'Q3 results', company_name: 'Modus', status: 'draft' }] });
          }
          return Promise.resolve({ rows: [] });
        },
      };
      return db;
    }

    /* Console is captured so the assertions can read what was actually emitted
       — the token must not be in a log line either — and so the suite's own
       output stays readable. */
    function capturing(fn) {
      const said = [];
      const log = console.log, warn = console.warn;
      console.log = (...a) => said.push(a.join(' '));
      console.warn = (...a) => said.push(a.join(' '));
      return Promise.resolve().then(fn).finally(() => { console.log = log; console.warn = warn; }).then(() => said);
    }

    const pickWrite = async () => ({
      content: '',
      toolCalls: [{ id: '1', name: 'set_pr_release_status', args: '{"release":"5","status":"published"}' }],
    });

    /* A REAL confirmation round trip, so `sideEffectShown` and `approvalId` are
       the values the mechanism actually produced rather than strings a test
       typed. */
    const store = createConfirmationStore();
    const CTX_USER = 77, CTX_OWNER = 77, CTX_TEAM = 3;

    async function roundTrip(db) {
      const a = toolsMod.createMaiAssistant({ generate: pickWrite, logger: { warn() {} } });
      const ctx = { db, ownerId: CTX_OWNER, userId: CTX_USER, teamId: CTX_TEAM, userName: 'Staff' };
      const asked = await a.ask({ question: 'set release 5 to published', role: 'admin', ctx });
      const issued = store.issue({
        tool: asked.tool, args: asked.args, question: 'set release 5 to published',
        sideEffect: asked.sideEffect, reversible: asked.reversible, userId: CTX_USER, ownerId: CTX_OWNER,
      });
      const spent = store.consume(issued.token, { userId: CTX_USER, ownerId: CTX_OWNER });
      const done = await a.confirm({
        tool: spent.record.tool, args: spent.record.args, question: spent.record.question,
        role: 'admin', ctx, sideEffectShown: spent.record.sideEffect,
        approvalId: store.handle(issued.token),
      });
      return { asked, done, token: issued.token, handle: store.handle(issued.token) };
    }

    // ── 1. A SUCCESSFUL write writes a row ────────────────────────────────
    {
      const db = auditPool();
      let out = null;
      const said = await capturing(async () => { out = await roundTrip(db); });

      ok('the confirmed write succeeded', out.done.answered === true && out.done.wrote === true, out.done.reason);
      ok('exactly one audit_log row was written', db.inserts.length === 1, db.inserts.length);

      const [userId, teamId, actor, action, entity, entityId, shown, ref, okFlag, detail] = db.inserts[0].params;
      ok('the statement is parameterised — ten placeholders, no interpolation',
         /\$1.*\$10/.test(db.inserts[0].sql) && !/\$\{/.test(db.inserts[0].sql), db.inserts[0].sql);
      ok('user_id comes from ctx, not from anything the model produced', userId === CTX_USER, userId);
      ok('team_id comes from ctx', teamId === CTX_TEAM, teamId);
      ok("actor is 'mai'", actor === 'mai', actor);
      ok('action names the tool', action === 'mai:set_pr_release_status', action);
      ok('entity names the table that changed', entity === 'pr_releases', entity);
      ok('entity_id is the row the EXECUTOR reported, not one the model named', entityId === '5', entityId);
      ok('ok is true for a successful write', okFlag === true, okFlag);

      /* THE SENTENCE IS CARRIED THROUGH, NOT RECOMPOSED. Byte-identical to what
         the ask leg produced and the token stored. */
      ok('approved_shown is byte-identical to the sentence the ask leg produced',
         shown === out.asked.sideEffect, { shown, produced: out.asked.sideEffect });
      ok('…and it is a real sentence naming the release and the status',
         typeof shown === 'string' && shown.includes('"5"') && /published/.test(shown), shown);

      /* THE TOKEN MUST NEVER APPEAR — not in a column, not in a log line. */
      ok('approval_ref is the 12-character handle', ref === out.handle && ref.length === 12, ref);
      ok('approval_ref is NOT the token', ref !== out.token);
      ok('the plaintext token appears in NO insert parameter',
         db.inserts[0].params.every(p => String(p === null ? '' : p).indexOf(out.token) === -1),
         db.inserts[0].params.map(p => String(p).slice(0, 40)));
      ok('the plaintext token appears in NO log line',
         said.every(l => l.indexOf(out.token) === -1), said.find(l => l.indexOf(out.token) !== -1));
      ok('detail records the previous value so the change is reversible from the row alone',
         /"previous":"draft"/.test(detail), detail.slice(0, 200));

      /* The second sink fired too. */
      ok('the process log carried the same write', said.some(l => l.startsWith('[M-Ai write] ')), said);
      ok('…and nothing warned, because the row was written',
         !said.some(l => l.startsWith('[M-Ai audit]')), said.filter(l => l.startsWith('[M-Ai audit]')));
    }

    // ── 2. A FAILED write is recorded, with ok = false ────────────────────
    {
      /* The read-back guard fires: the UPDATE reported a matched row and the
         column reads back unchanged, so the executor refuses. The write ATTEMPT
         still has to be in the table — an unrecorded failed write is the one an
         investigation cannot find later. */
      const db = auditPool({ lieOnReadBack: true });
      let out = null;
      await capturing(async () => { out = await roundTrip(db); });

      ok('the write FAILED (the read-back guard fired)',
         out.done.answered !== true && out.done.reason === 'executor_error', out.done.reason);
      ok('the failed write was STILL recorded', db.inserts.length === 1, db.inserts.length);
      const p = db.inserts[0].params;
      ok('…with ok = false', p[8] === false, p[8]);
      ok('…and the error text is in detail', /reads back as/.test(String(p[9])), String(p[9]).slice(0, 160));
      ok('…and the sentence the human approved is still recorded',
         p[6] === out.asked.sideEffect, p[6]);
      ok('…and it is still attributed to the asking account', p[0] === CTX_USER, p[0]);
    }

    // ── 3. A THROWING audit must never fail the response ──────────────────
    {
      const db = auditPool({ auditFails: true });
      let out = null;
      const said = await capturing(async () => { out = await roundTrip(db); });

      ok('the write still succeeded even though the audit insert threw',
         out.done.answered === true && out.done.wrote === true, out.done.reason);
      ok('the response carries no audit error', !/audit/i.test(JSON.stringify(out.done)), out.done.reason);
      ok('the insert was attempted', db.inserts.length === 1, db.inserts.length);
      ok('the failure was reported LOUDLY rather than swallowed silently',
         said.some(l => l.startsWith('[M-Ai audit] could not write the audit_log row')), said);
      ok('…naming the tool and the driver message',
         said.some(l => /set_pr_release_status/.test(l) && /does not exist/.test(l)), said);
      ok('…and the process-log record survived, so the audit is degraded rather than lost',
         said.some(l => l.startsWith('[M-Ai write] ')), said);
    }

    /* The dispatcher's own catch is the second line of defence, for a hook that
       is not ours. A wholly broken onAction must not fail the response either. */
    {
      const db = auditPool();
      const a = toolsMod.createMaiAssistant({
        generate: pickWrite, logger: { warn() {} },
        onAction: () => { throw new Error('a third-party hook exploded'); },
      });
      const ctx = { db, ownerId: CTX_OWNER, userId: CTX_USER, teamId: CTX_TEAM };
      const done = await a.confirm({ tool: 'set_pr_release_status', args: { release: '5', status: 'published' },
                                     role: 'admin', ctx, sideEffectShown: 'x' });
      ok('a hook that throws outright does not fail the response either',
         done.answered === true, done.reason);
    }

    // ── 4. approval_ref cannot be widened into the token ──────────────────
    {
      const S = toolsMod.safeApprovalRef;
      ok('a 12-hex handle is accepted', S('0123456789ab') === '0123456789ab');
      ok('a FULL 64-hex token is REFUSED, not truncated',
         S('a'.repeat(64)) === null, S('a'.repeat(64)));
      ok('a 13-character string is refused', S('0123456789abc') === null);
      ok('a non-hex string is refused', S('not-a-handle') === null);
      ok('a non-string is refused', S(null) === null && S(12) === null);
      ok('handle() and safeApprovalRef agree on what a handle looks like',
         S(store.handle('f'.repeat(64))) === 'f'.repeat(12));

      /* And when a caller does pass the token where the handle belongs, the
         value is dropped AND the drop is announced. */
      const db = auditPool();
      const token = 'b'.repeat(64);
      const said = await capturing(() => toolsMod.auditOnAction({
        tool: 'set_brand_tone', ok: true, approval: 'token', approvalId: token,
        sideEffectShown: 'set this account’s brand tone to Bold.', role: 'admin',
        args: { tone: 'Bold' }, result: { data: { changed: true, previousTone: 'Professional' } },
        ctx: { db, userId: CTX_USER, ownerId: CTX_OWNER, teamId: null },
      }));
      ok('a token passed as the approval reference is DROPPED', db.inserts[0].params[7] === null,
         db.inserts[0].params[7]);
      ok('…and the drop is announced, not done quietly',
         said.some(l => /was DROPPED/.test(l)), said);
      ok('…and the token still appears in no parameter',
         db.inserts[0].params.every(p => String(p === null ? '' : p).indexOf(token) === -1));
      ok('…and in no log line', said.every(l => l.indexOf(token) === -1));
      ok('set_brand_tone is recorded against the account it changed',
         db.inserts[0].params[4] === 'users.brand_tone' && db.inserts[0].params[5] === String(CTX_OWNER),
         db.inserts[0].params.slice(4, 6));
    }

    // ── 5. An UNAPPROVED write records no sentence ────────────────────────
    {
      const db = auditPool();
      await capturing(() => toolsMod.auditOnAction({
        tool: 'rename_document', ok: true, approval: 'none', mode: 'auto',
        sideEffectShown: 'this should not be stored', approvalId: '0123456789ab',
        role: 'admin', args: { document: '5', title: 'X' },
        result: { data: { changed: true, documentId: 5, previousTitle: 'Old' } },
        ctx: { db, userId: CTX_USER, ownerId: CTX_OWNER, teamId: null },
      }));
      ok('an unapproved write stores NO approved_shown — there was no approval to record',
         db.inserts[0].params[6] === null, db.inserts[0].params[6]);
      ok('…and no approval_ref', db.inserts[0].params[7] === null, db.inserts[0].params[7]);
      ok('…and is recorded against the document it changed',
         db.inserts[0].params[4] === 'documents' && db.inserts[0].params[5] === '5',
         db.inserts[0].params.slice(4, 6));
    }

    // ── 5b. THE ROW'S IDENTITY COMES FROM ctx, NEVER FROM MODEL OUTPUT ────
    {
      /* validateArgs already strips any key a tool did not declare, so a model
         cannot in practice get `userId` into `args`. The audit hook must not
         DEPEND on that: it is the last thing to touch a payload before a row is
         written, and a row attributed to the wrong account is worse than no row.
         So the hostile keys are put in `args` directly here, past the validator,
         and the stored identity must still be the session's. */
      const db = auditPool();
      const HOSTILE = { document: '5', title: 'X', userId: 999999, user_id: 999999, ownerId: 999999, teamId: 4242 };
      await capturing(() => toolsMod.auditOnAction({
        tool: 'rename_document', ok: true, approval: 'none', role: 'admin', args: HOSTILE,
        result: { data: { changed: true, documentId: 5 } },
        ctx: { db, userId: CTX_USER, ownerId: CTX_OWNER, teamId: CTX_TEAM },
      }));
      ok('user_id is the SESSION account, not the one the arguments claimed',
         db.inserts[0].params[0] === CTX_USER, db.inserts[0].params[0]);
      ok('team_id is the SESSION team, not the one the arguments claimed',
         db.inserts[0].params[1] === CTX_TEAM, db.inserts[0].params[1]);
      ok('the claimed account id reaches no identity column',
         db.inserts[0].params.slice(0, 8).every(p => p !== 999999 && p !== '999999'),
         db.inserts[0].params.slice(0, 8));
      ok('…though the claim itself is preserved in detail, so the attempt is visible',
         /999999/.test(String(db.inserts[0].params[9])), String(db.inserts[0].params[9]).slice(0, 200));
    }

    // ── 6. No identity means no row, rather than a fabricated one ─────────
    {
      const db = auditPool();
      const said = await capturing(() => toolsMod.auditOnAction({
        tool: 'rename_document', ok: true, approval: 'none',
        result: { data: { changed: true, documentId: 5 } },
        ctx: { db },
      }));
      ok('a payload with no account id writes NO audit row rather than a fabricated one',
         db.inserts.length === 0, db.inserts);
      ok('…and says so', said.some(l => /no account id on ctx/.test(l)), said);
      ok('…and the process-log record is still written', said.some(l => l.startsWith('[M-Ai write] ')), said);

      const noDb = await capturing(() => toolsMod.auditOnAction({
        tool: 'rename_document', ok: true, approval: 'none',
        result: { data: { changed: true, documentId: 5 } },
        ctx: { userId: CTX_USER, ownerId: CTX_OWNER },
      }));
      ok('a payload with no pool degrades to the process log and says so',
         noDb.some(l => /no database on ctx/.test(l)) && noDb.some(l => l.startsWith('[M-Ai write] ')), noDb);
    }

    // ── 7. The wiring, and the table it writes to ─────────────────────────
    {
      const ROUTE = fs.readFileSync(path.join(APP, 'routes', 'mai.js'), 'utf8');
      ok('routes/mai.js wires auditOnAction explicitly', /onAction:\s*auditOnAction/.test(ROUTE));
      ok('…and passes the pool on ctx, which is where the hook finds it',
         /db:\s*pool/.test(ROUTE));

      const MIG = fs.readFileSync(path.join(APP, 'migrations', '004_round1_docintel_images.sql'), 'utf8');
      ok('migrations/004 creates audit_log', /CREATE TABLE IF NOT EXISTS audit_log/i.test(MIG));
      for (const col of ['user_id', 'team_id', 'actor', 'action', 'entity', 'entity_id',
                         'approved_shown', 'approval_ref', 'ok', 'detail']) {
        ok(`audit_log declares ${col}, so the insert cannot be writing into thin air`,
           new RegExp('^\\s*' + col + '\\s', 'm').test(MIG), col);
      }
      const SERVER = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
      ok('the migration runner in server.js applies 004 on startup',
         /migrations\/004_round1_docintel_images\.sql/.test(SERVER));

      /* The insert names its columns in the order the parameters are bound. A
         column list that drifts from the parameter list is the defect this
         catches, and it is invisible at review time. */
      const IDX = fs.readFileSync(path.join(LIB_MAI, 'tools', 'index.js'), 'utf8');
      const cols = (/INSERT INTO audit_log\s*\(([^)]*)\)/.exec(IDX) || [])[1] || '';
      ok('the insert lists exactly ten columns, matching the ten placeholders',
         cols.split(',').map(s => s.trim()).filter(Boolean).length === 10, cols);
      ok('lib/mai/tools/index.js issues exactly one INSERT, and it is the audit row',
         (IDX.match(/INSERT INTO/gi) || []).length === 1);
    }
  }

  console.log('\n══ M-Ai FRAMEWORK ══');
  console.log('   ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.error('\n✗ the M-Ai framework suite failed\n'); process.exit(1); }
  console.log('✓ the M-Ai framework and its guards hold\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n✗ mai-framework-test.js threw — that is a FAILURE, not a skip:\n', err && err.stack);
  process.exit(1);
});

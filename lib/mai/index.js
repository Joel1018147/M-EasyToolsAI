'use strict';
// Entry point for the M-Ai framework.
//
// ── This folder is the boundary of a future shared package ─────────────────
// `registry.js`, `dispatcher.js`, `validate.js` and this file may not import
// from outside `lib/mai/` — no `../db`, no `../groq`, no route, no table name,
// no column name, no business concept. Both dependencies arrive by injection:
// the registry receives executors, the dispatcher receives a `generate`
// function, and the database reaches an executor only inside the `ctx` object
// the caller passes to `ask()`.
//
// M-EasyDo-specific wiring — which tools exist, which roles reach them, how the
// pool and the owner id are obtained — lives in `lib/mai/tools/`. The eventual
// lift into @modus/mai is therefore a MOVE of four files, not a rewrite.
//
// `roles.js` is deliberately NOT re-exported from here. It names M-EasyDo's two
// real roles and is the one file in this folder that does not travel; keeping it
// out of the package's public surface is what stops it travelling by accident.
// Import it directly: require('lib/mai/roles').
//
// ── Where the M-EasyDo tool pack lives ─────────────────────────────────────
// Not here, and not imported from here — importing it would put a table name
// one `require` away from the shared boundary. The wiring entry point is:
//
//     const { createMaiAssistant, createMaiRegistry } = require('./lib/mai/tools');
//
// See lib/mai/tools/index.js.

const { createRegistry, ANY_ROLE, NAME_RE } = require('./registry');
const { createDispatcher, DEFAULT_REFUSAL, figuresAreGrounded, groundedTokens, numbersIn,
        currenciesIn, normaliseArgs, SELECT_SYSTEM_PROMPT, PHRASE_SYSTEM_PROMPT,
        MULTI_ROUND_SUFFIX, selectOfferedSpecs, scoreTool } = require('./dispatcher');
const { validateArgs } = require('./validate');

module.exports = {
  createRegistry,
  createDispatcher,
  validateArgs,
  ANY_ROLE,
  NAME_RE,
  DEFAULT_REFUSAL,
  SELECT_SYSTEM_PROMPT,
  PHRASE_SYSTEM_PROMPT,
  MULTI_ROUND_SUFFIX,
  figuresAreGrounded,
  groundedTokens,
  numbersIn,
  currenciesIn,
  normaliseArgs,
  selectOfferedSpecs,
  scoreTool,
};

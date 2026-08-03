# M-EasyTools AI+

## Model fallback procedure
Primary: qwen/qwen3.6-27b (Groq preview tier — chosen for EN/BM/ZH multilingual
strength). If Groq rate-limits or pulls this model:
1. Railway → this project → Variables → set GROQ_MODEL=openai/gpt-oss-120b
2. Redeploy — no code change needed, the app reads GROQ_MODEL from env with
   the qwen model as code-level default.
3. reasoning_effort/reasoning_format are only sent when the model matches the
   qwen gate — gpt-oss-120b will run without those params automatically,
   no manual toggle needed.

The single source of truth for the model in this repo is `server.js (GROQ_MODEL)`.
Nothing else may read `process.env.GROQ_MODEL` directly — import the exported
constant instead, so one env var still switches every call site.

**Tools-specific caveat:** `POST /api/chat` lets an API-key holder name a model,
and `normaliseModel()` only rewrites *known-dead* names — anything else is
passed through untouched. So GROQ_MODEL does **not** override a model an
external integration hardcodes. Two consequences:
- Our own pages must never send a `model` field. `public/gao.html` used to
  hardcode `qwen/qwen3.6-27b` and would have ignored a GROQ_MODEL switch; it now
  omits the field so the server default applies.
- If qwen is pulled, external `/api/chat` callers pinning it will 400 until they
  change their request, or until `qwen/qwen3.6-27b` is added to
  `DEPRECATED_MODELS` so it maps onto the new default. That second step is a
  code push — it is the one thing the env var cannot fix on its own.

## Agentic Engineering Standards (ecosystem-wide, added 2026-08-03)

1. KEEP THIS FILE MINIMAL. Current models correctly infer stack, structure, and
   conventions by reading the codebase. Only document what a fresh read genuinely
   can't recover: business rules, the vision behind a non-obvious decision, and
   anything that would otherwise require asking Joel. Don't re-add "this is a
   Node/Express app" style boilerplate a codebase read already answers.

2. SOURCE CODE OVER MEMORY FOR THIRD-PARTY INTEGRATIONS. Before writing code
   against any external library, SDK, or API this platform doesn't already have
   documented in this file, pull its real source into reference/repos/<org>/<project>/
   and read that — do not rely on training data or general familiarity with the
   library. See Modus-Agent-OS/skills/source-code-context.md.

3. STRUCTURE CLEANUP BEFORE THE DEPLOY GATE. After a feature works and is tested,
   check whether anything in the diff duplicates a mechanic already in helpers/
   elsewhere in this platform. Extract genuine duplication; leave business policy
   in the route. See Modus-Agent-OS/skills/code-structure-cleanup.md.

4. "DONE" MEANS THE THREE-STAGE GATE, NOT JUST ACTIVE ON RAILWAY. Compile (ACTIVE)
   is a floor, not a finish line. A prompt isn't complete until Verify (live smoke
   test against real-shaped data) and Structure (audit against the known failure
   classes: setTimeout outside the job runner, \b regex on CJK-capable text,
   un-parsed NUMERIC columns, nullable UNIQUE constraints, unsigned webhooks) both
   pass. See Modus-Agent-OS/skills/three-stage-deploy-gate.md.

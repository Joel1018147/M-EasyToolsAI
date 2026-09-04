# M-EasyTools AI+

## Conventions (differ between sibling platforms — check before generating code)

| Thing | Value |
|---|---|
| Accent | Orange `#E8622A` (`data-platform="tools"`) |
| Auth portal | `public/auth.html`, the **canonical** master from `Modus-Agent-OS/design` (md5 `cbd92280`). `/login` serves it. `public/login.html` and `public/signup.html` are **DELETED** — this repo had THREE login surfaces. |
| Settings | `public/settings.html` from the master (`4ecc6cd5`) + `routes/settings.js`. `user_settings` is created by `initDB()`, so there is no unapplied-migration state to degrade through. |
| Export | `POST /api/settings/export` → **501**, honestly. There is no job runner in this repo — only a bare `setInterval` for subscription expiry, which is not a queue. Mall and Dragon Ginseng answer 202 because they *have* a runner; Campus answers 501 for the same reason this does. Do not "make it consistent" by copying the 202. |
| Design system | `public/css/modus-design-system.css`, byte-identical to the master (md5 `8425f456`). **A per-repo edit to this file is a defect** (§1) — the change goes in the master and is re-copied to all twelve repos in the same commit (§1b). |
| Guards | `requireAuth` negotiates (302 for pages, 401 for `/api/`); `requireAuthJSON` **never** redirects and exists for `GET /auth/me`, which §4.1 puts outside `/api/`. Correctness is call-site assignment — `test/auth-guard-test.js` asserts the wiring, not just the functions. |
| Subscriptions | **NOT ENFORCED.** Joel's call, 2026-09-04: every signed-in account reaches every feature. `helpers/subscriptionMode.js` is the one definition; the variable is UNSET on production and unset means open, which is the opposite of the `PREVIEW_LOCK` direction and the helper says why. `SUBSCRIPTION_ENFORCEMENT=on` restores the whole paywall with no code change. Do not "tidy up" `checkSub`, the trial/grace/expired branches or `/billing` — they are switched off, not dead, and `test/billing-reachable-test.js` pins them to the enforced mode. **The image cap is a SECOND gate in another file** (`lib/image/caps.js`): status `open` maps to the top tier, 60/day and 600/30 days. That ceiling is a spend and storage limit, not a price — ~1.9MB of BYTEA per image and no retention policy in this repo. |
| `wantsJson` | ONE definition, `helpers/wantsJson.js`. `server.js` and `middleware/checkSub.js` both import it. Never re-derive it locally. |
| i18n | Engine is `window.I18n.setLang(code)` (capital I) reading `localStorage['msm_lang']`. The canonical pages call `window.i18n.apply(code)` and §4.4 says the shared key is `modus-lang`, so both pages carry a small adapter that bridges the names and **dual-writes both keys**. Do not "clean this up" by renaming `msm_lang` — twenty-odd other pages read it. |
| Locales | `public/locales/{en,ms,zh}.json`. The `auth.*` / `settings.*` key sets come from `Modus-Agent-OS/design/locales/` via `merge-into-repo.js` (§4.2c: keys come from the master, never re-derived here). |

## Two auth paths, one handler

The canonical portal posts to `/auth/login` and `/auth/register`; everything
that predates it — `scripts/smoke-test.js`, the module pages — posts to
`/api/auth/*`. Both are mounted on the **same** `handleLogin` / `handleRegister`
function. Adding a second implementation for the canonical path is the exact
defect Run 11 found on M-EasyMall: two paths into one account-creating endpoint
must never become two things that can drift. `test/auth-contract.js` asserts
they share a handler *identifier*, so a copy-paste fails the suite.

`POST /auth/forgot` answers **503** and that is honest, not a stub: there is no
reset-token table, no `POST /auth/reset` and no template, so nothing would be
sent whatever `RESEND_API_KEY` says. The §4.1 rule is *invariance* — the
response must not vary with whether the address is registered — which is why
the handler never touches the database and has no branches at all. A real flow
is DEFERRED and logged as deferred.

## What is deliberately NOT wired

`routes/settings.js` marks several controls `unavailable` with a reason rather
than storing a flag nothing reads (an inert flag is worse than an absent
feature — the user believes the capability exists):

- `twofa` — there is no second-factor code path at sign-in
- `notifyWhatsapp` — no WABA credentials, no send path, no webhook
- `sstRate` — tax is a payment computation; §C3 says do not touch one
- the whole **AI & Asha** section — "Asha" is the ecosystem's conversational
  agent. This platform's AI is a *generation* layer: no conversation to set a
  tone for, nobody to escalate to. The brand voice that DOES steer output is
  `users.brand_tone`, edited in the workspace beside the brand name it belongs
  with. Surfacing it here under a second name would give one setting two homes.

The section still renders — §4.2 keeps all ten on every platform, because a
section that is present-but-empty and one that does not exist look identical to
a user and mean completely different things. `GET /api/settings` returns
`_unavailable` and the page disables each control and prints the reason.

## Health

`/health` does a real `SELECT 1` and answers 503 when the database is down —
point uptime monitors here. `/health/capabilities` reports unconfigured vs
**broken** capabilities from `helpers/capabilities.js` and answers 503 when
degraded; nothing should page on it. Do not collapse the two. `has()` checks
for a non-empty *value*, never for the key's presence — a variable that exists
is not a variable that has a value.

## Test coverage gap — content.html fetch-response checks

`test/fetch-contract.js` pulls `public/seller.html`'s functions out and runs
them for real in a `vm` sandbox, but `public/content.html`'s save-handling is
only covered by the static `.ok`/`.status`-presence scan in
`test/lib/unchecked-fetch.js` (recurring-bugs-checklist.md #21) — nothing
loads or executes content.html's actual code. `test/mutate-fetch.js` M7 proves
the scan catches an `.ok` check being **deleted**, but the scan cannot catch
the check being **inverted** (`if(!r.ok)` → `if(r.ok)`) — the `.ok` token
would still be present and the scan would still read it as "checked" while the
save/failure toasts fire backwards. Verified by static scan only, not a
live-executing test — do not treat this as closed.

## Model fallback procedure
Primary: qwen/qwen3.6-27b (Groq preview tier — chosen for EN/BM/ZH multilingual
strength). If Groq rate-limits or pulls this model:
1. Railway → this project → Variables → set GROQ_MODEL=openai/gpt-oss-120b
2. Redeploy — no code change needed, the app reads GROQ_MODEL from env with
   the qwen model as code-level default.
3. reasoning_effort/reasoning_format are only sent when the model matches the
   qwen gate — gpt-oss-120b will run without those params automatically,
   no manual toggle needed.

The single source of truth for the model in this repo is
**`helpers/groq.js (GROQ_MODEL)`**. Nothing else may read
`process.env.GROQ_MODEL` directly — import the exported constant instead, so
one env var still switches every call site.

**Moved from `server.js` in Round 1.** The rule is unchanged; what changed is
which file holds the one reader. While it lived in `server.js`, nothing could
be extracted out of `server.js` without a require cycle back to it — which is
what blocked splitting the generation layer into a file a lane could own.
Eight of the nine platforms in the ecosystem already resolve the model in
`helpers/groq.js` or `lib/groq.js`; this repo was the outlier, and the outlier
was the obstacle. Note that `Modus-Agent-OS/context/ecosystem-context.md` still
lists this platform as resolving at `server.js:488` — that table is in another
repo and was not edited from here; it is stale by one file path.

`helpers/groq.js` also owns `normaliseModel()`, the `reasoning_effort` gate,
and `chat()`, the single wire call. Before Round 1 there were three separate
`fetch` calls to Groq in `server.js` and one of them (the PR GEO score) called
a local `withReasoning()` — extracting that helper without moving the call
site would have left a `ReferenceError` firing inside a `try/catch` that
reported it to users as "GEO score unavailable".

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
   test against real-shaped data) and Structure (audit against
   Modus-Agent-OS/skills/recurring-bugs-checklist.md, which is canonical) both
   pass. Gate 0, the pre-deploy env-var diff, runs before all three. See
   Modus-Agent-OS/skills/three-stage-deploy-gate.md.

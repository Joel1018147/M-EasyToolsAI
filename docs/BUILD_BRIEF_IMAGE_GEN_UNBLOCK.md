# BUILD BRIEF — Unblock image generation (M-EasyTools AI+)

Written 2026-09-04, from a live investigation (production browser session +
repo read), not from a build-from-scratch assumption. **Correction to an
earlier claim in this thread:** an earlier pass concluded image generation
did not exist in M-EasyTools at all. That was wrong — it was checked only
against the AI Tools hub search box, which does not cover in-form panels.
The feature is fully built and deployed (`lib/image/`, `routes/images.js`,
mounted on content/social/ads/commerce/mail). Do not rebuild it.

## 0 · LOAD
Read the canonical load list in `Modus-Agent-OS/BUILD_PROTOCOL.md` Phase 0,
and everything on it — `recurring-bugs-checklist.md` and
`railway-deploy-gate.md` especially, since Gate 0 applies here (§5). Confirm
in ONE line what you loaded. If any listed file is missing, STOP and say so.

Also confirm `M-EasyTools-AI/CLAUDE.md` points at `Modus-Agent-OS`. If it does
not, add the pointer before doing anything else.

## 1 · GOAL
A user whose subscription has lapsed must be able to reach and use `/billing`
to renew. Right now they cannot — `/billing` redirects to itself. Fix that,
verify the image-generation lane still gates correctly for everyone else, and
leave a clear note on the one thing that still needs a human decision
(Joel's own account state) and the one thing that still needs a live check
(the DashScope key's region) — do not fix either of those two yourself.

## 2 · CLAIMS — verify these BEFORE building

| # | Claim | How to falsify | If false |
|---|-------|----------------|----------|
| 1 | `DASHSCOPE_API_KEY` is set (non-empty) on the M-EasyTools AI+ production service, and `DASHSCOPE_BASE_URL` is NOT set, so the code default `https://dashscope-intl.aliyuncs.com` (the Singapore/international host) is what's actually called. | `railway variables --kv` on the M-EasyTools AI+ service (`fac8e530-bff8-47e4-8ff6-55214852e96b`), production environment. | If `DASHSCOPE_BASE_URL` IS set, read what it's set to before assuming anything about region — report it, don't guess. |
| 2 | `middleware/checkSub.js`'s HARD-LOCKED branch (the `else` after trial/active/grace all fail) redirects any non-JSON request — **including a request for `/billing` itself** — to `/billing?expired=true`. Since `app.get('/billing', requireAuth, checkSub, ...)` in `server.js` runs the same middleware again on that path, this is a self-redirect loop with no exit. | Sign in as (or fixture) a user whose `subscriptions.status` is `expired` (not trial/active/grace) and `GET /billing` in a real browser. Observed live 2026-09-04, signed in as Joel: Chrome reported the frame as an error page (consistent with `ERR_TOO_MANY_REDIRECTS`) navigating to `https://m-easytools-ai-production.up.railway.app/billing`. | If it does NOT loop (e.g. Express or the browser already special-cases this), the bug is elsewhere — stop and report exactly what `/billing` returns instead of patching a loop that isn't there. |
| 3 | Joel's own account (`joel31255@gmail.com`) is currently in that HARD-LOCKED state, not grace. The image-option panel on `/social` (Social Media Posts tool) showed the exact string `checkSub.js` emits only in the hard-locked JSON branch: `"Your subscription has expired. Please renew at /billing."` (the grace-branch message is worded differently — "Renew within N day(s)…"). | `SELECT status, trial_ends_at, grace_until, paid_until FROM subscriptions WHERE user_id = (SELECT id FROM users WHERE email = 'joel31255@gmail.com');` | If status is `grace` or `active`, the panel copy came from somewhere else — re-read `public/js/imagegen.js` and `public/js/postimage.js` for a second copy of this message before assuming which branch fired. |
| 4 | Whether Joel's actual DashScope key is provisioned for the Singapore/international region (matching claim 1's endpoint) or the Beijing/mainland region has **not been tested end-to-end** — claim 2 blocks reaching a usable subscription state to try a real generation call. `.env.example` in this repo documents, as measured 2026-08-21, that a key from the wrong region returns `401 InvalidApiKey` against the other region's host. | Only testable AFTER claims 2 and 3 are resolved: attempt one real `POST /api/images/generate` (or the UI checkbox) and read the exact error if any. | If it 401s with `InvalidApiKey`, this is a separate, already-documented failure mode — report it to Joel rather than silently switching `DASHSCOPE_BASE_URL`, since which region his key is actually provisioned for is a fact about his Alibaba Cloud console, not something to guess from here. |

## 3 · BUILD

**Modify:** `middleware/checkSub.js` only.

The HARD-LOCKED branch must not redirect a request that is already for the
renewal surface itself. Describe the shape, not a single hardcoded path
(recurring-bugs-checklist #13): the exempt set is "the routes a locked-out
user needs to see and act on their own billing state" —
- `GET /billing` (the page)
- `POST /billing/checkout` (the action that actually fixes the lock)
- `GET /api/subscription/status` and `GET /api/subscription/invoices` (billing.html's own reads — check what `public/billing.html` actually calls via fetch and match that list exactly, don't guess it)

For a request matching that set, `checkSub` should populate `req.subscription`
with the hard-locked state (so `billing.html` can render "your plan has
expired" correctly) and call `next()` — not redirect. Every other route keeps
today's behaviour exactly: redirect (page) or 402 JSON (fetch/API).

**Do not touch:** `lib/image/`, `routes/images.js`, `lib/image/providers/dashscope.js`,
`public/js/imagegen.js`, `public/js/postimage.js`. All reviewed 2026-09-04 and
believed correct — lazy-init, provider abstraction, and error surfacing all
already follow the checklist.

**Do not** attempt to fix Joel's own account state or the DASHSCOPE region
question as part of this build — both are named as out of scope in §6.

## 4 · INVARIANTS — as tests, never as prose

- A fixture user with `subscriptions.status = 'expired'` gets HTTP 200 from
  `GET /billing`, not a redirect back to itself → asserted by a new
  `test/billing-reachable-test.js`, registered in `test/run-all.js`.
- The same fixture user still gets redirected/402'd (today's behaviour,
  unchanged) from `/api/images/*`, `/api/mai`, `/api/docintel`, `/api/pr/*`,
  and every other `checkSub`-gated route → asserted in the same file, so the
  fix can't accidentally widen access.
- Repeat both assertions for `status = 'grace'` and `status = 'trial'` (both
  already work today per the code read — confirm they still do, don't assume).
- Mutation-test per recurring-bugs-checklist #14: temporarily revert the
  exemption, confirm `billing-reachable-test.js` fails with the loop/redirect,
  restore, confirm it passes. Report both outcomes.

## 5 · GATE

- Gate 0 — pre-deploy env-var diff (`railway-deploy-gate.md`). This change
  adds no env var, so the diff should be empty — state that explicitly rather
  than skipping the check.
- `npm test` (expect one more passing suite than today's baseline — record
  today's `npm test` count before changing anything, per recurring-bugs #21:
  name which suite actually executes `middleware/checkSub.js`, don't assume
  one does because the file has tests near it).
- Verify live: after deploy, load `/billing` signed in as Joel's own account
  (it currently qualifies as hard-locked per claim 3) and confirm it renders
  instead of erroring.

## 6 · REPORT BACK

In addition to the standard five items (§6 of the template), this run must
explicitly flag back to Joel, unresolved and undone by this build:

1. **His own account is still hard-locked after this fix ships.** Fixing the
   redirect loop makes `/billing` reachable; it does not renew anything. He
   needs to decide how he wants his own account to carry an active plan —
   go through checkout himself, or have a comp/owner state set on that one
   `subscriptions` row. That's a business call, not made here.
2. **The DashScope region question is still open.** Once he can actually
   reach the image checkbox with an active subscription, the very first
   generation attempt is the real test of claim 4. If it fails with
   `401 InvalidApiKey`, that confirms the key/endpoint region mismatch
   documented in `.env.example`, and the fix is either a new key from the
   correct Alibaba Cloud console region or a `DASHSCOPE_BASE_URL` Railway
   variable change to match wherever the key actually lives — not a code
   change either way.

Append the full §6 to `Modus-Agent-OS/RUN_LOG.md` as usual.

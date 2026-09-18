# BUILD BRIEF — Replace the image-generation provider (Qwen-Image -> Nano Banana 2 Lite)

Written 2026-09-18. Joel: "I want to replace the qwen image model to nanobanana
2 lite in M-Easytools because qwen generates ai slop." This is Lane D
(`lib/image/`, `routes/images.js`) specifically — the DashScope/Qwen-Image
provider behind `POST /api/images/generate` — not the Groq chat model
(`qwen/qwen3.6-27b`, `helpers/groq.js`), which is a separate, unrelated system
also named "qwen" and is untouched by this run.

## 0 · LOAD

Loaded: `Modus-Agent-OS/BUILD_PROTOCOL.md`, `skills/recurring-bugs-checklist.md`
(referenced, not fully quoted here), `skills/railway-deploy-gate.md`,
`skills/three-stage-deploy-gate.md`, `skills/build-brief-template.md`,
`M-EasyTools-AI/CLAUDE.md`. `xss-esc-audit.md` and `design/HANDOVER.md` were
not read in full — this run touches no rendered markup or design tokens (the
UI already renders whatever `GET /api/images/options` publishes; see §3).
All listed files existed. No UI Contract work is involved.

## 1 · GOAL

Make Google's Nano Banana 2 Lite (via fal.ai) the image-generation provider
M-EasyTools actually uses by default, in place of DashScope/Qwen-Image —
end to end: the provider call, the size vocabulary the whole pipeline
validates against, every hardcoded per-platform size preference in the
client, the docs, and the test suite that exercises the DEFAULT path.

## 2 · CLAIMS — verify these BEFORE trusting the new provider in production

| # | Claim | How to falsify | If false |
|---|-------|----------------|----------|
| 1 | `POST https://fal.run/google/nano-banana-2-lite` with `Authorization: Key $FAL_API_KEY` and `{prompt, aspect_ratio, num_images, output_format}` returns `200` with an `images[]` array carrying a real `url`. | Set `FAL_API_KEY` to a real fal.ai key and make ONE real `POST /api/images/generate` call (or curl the endpoint directly) once Joel has provisioned the key. | If the auth header shape, field names, or response shape differ, fix `lib/image/providers/nanobanana.js` only — the interface (`lib/image/provider.js`) does not change. |
| 2 | fal.ai does not bill for a non-2xx response from this endpoint (so classifying every non-2xx as `billed: false`, mirroring dashscope.js's policy, is correct). | Trigger a real 4xx (e.g. an illegal `aspect_ratio` sent by hand) against a real key and check fal.ai's own usage/billing dashboard for that request. | If it DOES bill on error, `nanobanana.js`'s `providerError(..., { billed: false })` on the non-2xx path needs `billed: true` instead, and `lib/image/caps.js`'s counted-statuses story needs re-reading — do not just flip the flag. |
| 3 | fal.ai's actual error-response body on a validation failure is close enough to `{code,message}` / `{error:{type,message}}` / `{detail}` that a user sees something useful, not "— " with nothing after it. | Trigger a real 4xx and read the raw body. | Extend `nanobanana.js`'s error-body parsing (the `if (trimmed.startsWith('{'))` block) to the real shape; do not touch the billed/not-billed classification while doing it. |
| 4 | This model's generation truly completes fast enough (fal.ai's own docs say ~4s) that the existing no-queue, synchronous, in-request design (`lib/image/index.js`'s whole pipeline, `DEFAULT_TIMEOUT_MS = 60_000` in `nanobanana.js`) remains correct and nothing needs a job runner this repo does not have. | Time a handful of real generations. | If it is materially slower under load, report to Joel before building a queue — this repo has none, by design (Engineering Bar), and that is a decision for him, not a silent workaround. |

**SUPERSEDED IN PART — see §8.** The swap is now deployed, configured and
live, and ONE real generation was fired against production on 2026-09-18. It
FAILED, at fal.ai's account balance rather than in this code. Claim 3 is
CONFIRMED, claim 1 is PARTIALLY confirmed, claims 2/4/5 remain open. Read §8
before trusting anything below this line.

None of these four were checked end-to-end in this run — there is no live
`FAL_API_KEY` in this environment, and outbound network from this sandbox may
not reach fal.ai's endpoint even if there were one. Everything below is built
against fal.ai's own published model documentation (read 2026-09-18) and this
repo's existing, measured DashScope integration as the template for the
*shape* of a provider file — not against a real call. Say so plainly rather
than claiming verification that did not happen (RULE 1).

## 3 · BUILD

**Created:**
- `lib/image/providers/nanobanana.js` — the new provider. Same interface as
  `dashscope.js`: lazy construction, `buildBody()` exposed for unit testing,
  billed/not-billed error classification, a search-not-index response parser.
- `lib/image/providers/nanobanana-sizes.js` — this provider's own aspect-ratio
  vocabulary (`16:9, 4:3, 1:1, 3:4, 9:16`), analogous to `../sizes.js` but not
  a rename of it — DashScope's file stays DashScope's, per `provider.js`'s own
  interface doc, which anticipated this and was never exercised until now.

**Modified:**
- `lib/image/provider.js` — registered `nanobanana`, changed `DEFAULT_PROVIDER`
  to it. **`dashscope` stays registered, not deleted** — see §7 below.
- `lib/image/providers/dashscope.js` — added two passthrough methods
  (`resolveSize`, `sizeCatalogue`) so it satisfies the now-fuller provider
  interface. No behavioural change to DashScope itself.
- `lib/image/index.js` — **the one real architectural fix in this run.**
  Before today, `generate()` and `options()` validated/published sizes
  against a hardcoded `require('./sizes')` (DashScope's module) regardless of
  which provider was actually active — `provider.legalSizes()` /
  `defaultSize()` existed on the interface and were partly unused. Both call
  sites now ask the ACTIVE provider (`provider.resolveSize()`,
  `provider.sizeCatalogue()`). Without this fix, nanobanana's `"16:9"` would
  either be rejected by DashScope's `width*height` validator or accepted
  silently and then rejected by fal.ai — the wrong error, from the wrong
  layer, after nothing was gained by validating locally at all.
- `public/js/postimage.js` — `PLATFORM_ASPECT`'s five hardcoded values were
  DashScope pixel sizes (`'1664*928'` etc). Rewritten to nanobanana's aspect
  ratios (`'16:9'` etc), same orientations. The file's own existing guard
  ("a preference not in the catalogue is dropped, not forced") meant this
  would have degraded silently to "no preference" for every platform rather
  than erroring — found by reading the file, not by a test going red, since
  no existing guard scans `public/js/*` for a stray pixel-size literal the way
  `test/image-contract.js` §1 already does for `lib/image/*` — **that gap is
  real and is not closed by this run** (§7).
- `.env.example` — added `FAL_API_KEY` / `FAL_BASE_URL` / `FAL_MODEL`,
  documented DashScope's block as legacy/rollback rather than removing it.
- `helpers/capabilities.js` — `image_generation`'s check now reads
  `FAL_API_KEY`; label updated. Hardcoded to the default on purpose, matching
  every other row in this file.
- Tests — `test/image-contract.js`, `test/imagegen-panel-contract.js`,
  `test/social-image-contract.js`, `test/mutate-image-style.js`,
  `test/mutate-social-image.js` — see §4.

**Not touched:** `routes/images.js` (the whole point of the provider
abstraction), `lib/image/caps.js`, `lib/image/moderation.js`, `lib/image/
brand.js`, `lib/image/styles.js`, `lib/image/rehost.js` (rehosting policy is
provider-agnostic and correct as-is — it downloads unconditionally regardless
of a provider's expiry claims), the `_shared` UI contract, any Railway
variable (Joel provisions `FAL_API_KEY` himself — see §6 and Rule 4a: a real
secret is his to supply).

## 4 · INVARIANTS — as tests

- The active DEFAULT provider is `nanobanana`, and its wire shape
  (`prompt`/`aspect_ratio`/`num_images`/`output_format`, `Key` auth, no
  `input.messages[]` envelope, no `negative_prompt` field) is asserted on the
  real HTTP pipeline → `test/image-contract.js` §2, §7b(g).
- `dashscope` remains registered and its own extraction/expiry logic is still
  covered directly → `test/image-contract.js` §12 (unchanged in kind, just no
  longer the only provider tested there).
- Size resolution is delegated to whichever provider is active, and a size
  legal for one provider but not the other is refused → `test/image-contract.js`
  §1 (unaffected — `1024*1024` is illegal for both, by different reasons) and
  the new `nanobanana-sizes.js` unit shape asserted via §12's direct-module
  checks.
- A negative prompt is folded into the visible prompt as an "Avoid: …" clause
  for nanobanana specifically, and the RAW negative prompt is still recorded
  verbatim on its own column regardless of provider → `test/image-contract.js`
  §7b(g), and MUTATION-TESTED: `test/mutate-image-style.js` M9 now breaks
  `nanobanana.js`'s fold (not `dashscope.js`'s separate-field guard, which the
  default pipeline no longer exercises) and confirms §7b(g) catches it.
- `PLATFORM_ASPECT`'s five values are all legal for whichever provider is
  active, derived rather than hardcoded in the test → `test/social-image-
  contract.js` §2, and MUTATION-TESTED: `test/mutate-social-image.js` M6 (renamed
  from "an aspect lib/image/sizes.js rejects" since the check is now
  provider-agnostic) still injects an illegal value and expects it caught.

Ran and GREEN before this brief was closed out: `node test/image-contract.js`
(246 checks, up from 235 baseline — 11 new nanobanana-specific assertions),
`node test/imagegen-panel-contract.js` (34, unchanged count), `node
test/social-image-contract.js` (138, unchanged count), `node test/mutate-
image-style.js` (all mutations caught, tree restored green), `node test/
mutate-social-image.js` (all mutations caught, tree restored green), full
`npm test`.

## 5 · GATE

- **Gate 0.** This run adds THREE Railway variables to the surface a real
  deploy needs (`FAL_API_KEY` required for the feature to work at all;
  `FAL_BASE_URL` / `FAL_MODEL` optional, code defaults cover them). **None are
  set on the M-EasyTools AI+ Railway service as of this run** — this repo
  lives on Joel's own machine in this session, not linked to Railway from
  here, so `railway variables --kv` was not run. Until `FAL_API_KEY` is set in
  production, `GET /health/capabilities` will correctly report
  `image_generation` as `optional`/missing, and `POST /api/images/generate`
  will correctly 503 — the same honest "not configured" behaviour the
  DashScope integration always had when unset. **Nothing breaks by deploying
  this unconfigured; nothing works until Joel adds the key.**
- `npm test`: see §4 for the count.
- Gates 1-3 (ACTIVE / Verify / Structure) were not run against a live Railway
  deploy in this session — no `railway link` context here. Verify live is
  §2's four claims, all still open.

## 6 · REPORT BACK

1. **What changed** — §3, in full above.
2. **Every claim in §2** — all four UNRESOLVED, for the reason stated there
   (no live key, possibly no network path to fal.ai from this environment
   either). This is the single most important line in this brief: the
   provider is built to the same standard as the DashScope one, but *unlike*
   DashScope's `.env.example` claims (each measured against a real key on
   2026-08-21), nothing here has been measured against a real fal.ai response
   yet.
3. **Found, not asked for:** `lib/image/index.js` was silently size-validating
   every request against DashScope's module regardless of the active
   provider — a real latent bug that this run's second provider is what
   exposed. Fixed as part of this run (§3), not filed for later, because
   leaving it in would have made nanobanana simply not work.
4. **Also found, not fixed:** no guard anywhere scans `public/js/*` for a
   stray provider-specific size literal the way `test/image-contract.js` §1
   already does for `lib/image/*` — this run found `postimage.js`'s hardcoded
   pixel sizes by reading the file, not by a test failing. Worth a Gate-3-style
   guard in a future run; out of scope here.
5. **Decision made, not asked first:** `dashscope.js` stays registered rather
   than deleted, as a same-day rollback (`DEFAULT_PROVIDER` is one constant;
   `provider: 'dashscope'` also works per-request). This trades a small amount
   of dead-weight code for a cheap way back if nanobanana2lite underperforms
   or fal.ai costs more than expected. Reversed in one line if Joel wants a
   clean cut instead.
6. **Nothing else was swept in.** `git status --porcelain` before this run
   showed `docs/gauntlet/GAUNTLET-CORE.md` already modified and an untracked
   `.claude/` — neither is part of this change and neither is touched or
   staged by it.


## 7 · PHASE 5 — BLINDED REVIEW (general-purpose sub-agent, REFUTE brief)

Reviewer was given the diff, this brief's §2 claims, and the relevant SOP
rules (RULE 6/6a/6b, billed/not-billed classification, provider-neutrality
contract) — NOT this brief's own narrative/rationale. It independently read
the live repo (not just the diff) and ran every affected test file and both
mutation harnesses itself rather than trusting the numbers above.

**Findings, triaged:**

1. **FIXED — vendor-neutrality guard did not cover the new default vendor.**
   `test/image-contract.js` §12's static scan of `routes/images.js` checked
   for `dashscope`/`qwen`/`aliyuncs`/`Bearer` tokens only — it would catch a
   regression that reintroduced the OLD provider's name but would have said
   nothing if a future change leaked `fal`/`nanobanana`/`FAL_API_KEY` into the
   route file. No live bug (the route file itself was clean), but the guard
   protecting the property this whole abstraction exists for did not follow
   the default it just changed. Extended the token list to include
   `'fal.run', 'nanobanana', 'banana', 'FAL_API_KEY', 'fal.ai'`. Re-ran:
   251/251 (was 246; +5, one per new token).
2. **FIXED — stale invariant comment in `lib/image/index.js`.** The
   `baseFields` comment claimed "the prompt STORED is the prompt SENT" as a
   universal fact. That's true for DashScope but false for nanobanana, which
   folds the negative prompt into the wire prompt as an `Avoid:` clause
   (`nanobanana.js`, `withAvoidClause`) — the codebase's OWN test
   (`image-contract.js` §7(g)) already asserted the real, deliberate
   behaviour, so the comment was contradicting an already-passing test, not
   describing a bug. Rewrote the comment to state the actual per-provider
   truth (RULE 3 — the artefact is the truth, the doc gets fixed to match).
3. **FIXED — stale doc-comment in `routes/images.js`.** The `POST /generate`
   doc-comment still pointed at `lib/image/sizes.js` (DashScope-only) as the
   universal size source. Reworded to name the active provider's published
   catalogue (`GET /options`) without naming any vendor, preserving the
   property §12 checks for.
4. **NOTED, not fixed — prompt-length risk introduced by the Avoid-clause
   fold, absent from the original §2 claims table.** The composed prompt
   (≤2000 chars, plus style/brand suffixes) plus a folded `Avoid: ` + negative
   prompt (≤500 chars) can exceed 2000 characters in the worst case, and
   fal.ai's actual accepted prompt length for this model is unverified (same
   root cause as claims 1-3: no live key). Failure mode if the real vendor
   limit is lower: a real user with a long prompt AND a real negative prompt
   gets a clean 400 from fal.ai (not billed, per the existing non-2xx
   convention) rather than any crash or silent truncation — fails safely, just
   not obviously from reading the code alone. Added as claim 5 below rather
   than coded around, since inventing a truncation policy without knowing
   the real limit would itself be exactly the kind of unverified assumption
   RULE 1 exists to prevent.
5. No CONFIRMED functional defect. Reviewer independently re-ran
   `rehost.js`'s https-only/magic-byte-sniff/25MB-cap claims, `capabilities.js`'s
   `has()` semantics, lazy-construction discipline in both new files, and the
   billed/not-billed flag's actual downstream consumers (`lib/image/index.js`'s
   status mapping, `routes/images.js`'s error body, `caps.js`'s
   `BILLABLE_STATUSES`) — all confirmed as claimed, none were dead contracts.

**§2 CLAIMS — addendum:**

| # | Claim | How to falsify | If false |
|---|-------|----------------|----------|
| 5 | fal.ai accepts the combined `prompt` (composed + style/brand + folded Avoid-clause) at the lengths this pipeline can actually produce (~2000-2500 chars worst case) without truncating or erroring in a way that surprises a real user. | Send one real generation with a long prompt AND a long negative prompt against a real key; read the actual response. | If fal.ai truncates silently rather than erroring, that is a NEW silent-fallback risk this design did not anticipate — report to Joel before adding any client-side truncation, since where to cut a user's own words is a product decision, not a technical one. |

Tests green after all three fixes: `image-contract.js` 251/251,
`imagegen-panel-contract.js` 34/34, `social-image-contract.js` 138/138,
both mutation harnesses 17/17 caught + restored clean (unaffected by these
three fixes — none touch mutation targets).


## 8 · STAGE-1 LIVE GATE, 2026-09-18 — RUN AGAINST PRODUCTION, **FAILED**

This section supersedes §2's "none of these four were checked end-to-end" and
§5's "no live Railway deploy in this session". Both are now false: the code is
deployed, configured and live. What is still true is that **no image has been
generated**, for a reason that is not in this repo.

`Modus-Agent-OS/RUN_LOG.md` Run 162b carries the same material in log form.

### What is now measured

| | |
|---|---|
| Commits on `origin/main` | `12aee58`, `80c50d5` — pushed this session (`d3a6cdd..80c50d5`); they were sitting local-only |
| Railway deploy | `445453ae`, commit `80c50d5`, `deploymentStopped: false`, instance RUNNING. Gate 1 clean |
| `FAL_API_KEY` on Railway | SET |
| `FAL_BASE_URL` / `FAL_MODEL` | not set; code defaults cover both |
| Live `GET /health/capabilities` | 200, `image_generation` `severity: "ok"`, `missing: []` |
| Live `GET /api/images/options` | `configured: true`, `provider: "nanobanana"`, `model: "google/nano-banana-2-lite"`, `defaultSize: "1:1"`, sizes `16:9 / 4:3 / 1:1 / 3:4 / 9:16` |
| ONE real `POST /api/images/generate` | **502 in 419 ms** — `provider_failed`, `providerStatus: 403`, `billed: false`, message `Image provider returned 403: User is locked. Reason: TOP_UP.` |
| The `image_generations` row it wrote | `80dc3cb3-51fb-407c-be79-8bf0dbbdc791` · `status: failed` · `provider: nanobanana` · `model: google/nano-banana-2-lite` · `size: 1:1` · `content_type`/`byte_size` NULL · `moderation_status: allowed` · `error_text` carries the vendor sentence verbatim. Read out of the production database over `railway ssh`, not inferred from the HTTP body |

### The cause, and why it is an observation rather than a guess

`TOP_UP` is a fal.ai account-level lock for an exhausted credit balance. The
key itself is VALID, and that was established rather than assumed: a request
with **no** `Authorization` header and a request with a **deliberately bogus**
key were both sent by hand to `https://fal.run/google/nano-banana-2-lite`, and
both returned **401** with
`{"detail":"Cannot access application \"github|110602490/nano-banana-lite\". Authentication is required to access this application."}`.
Production got **403 with a billing reason** — the answer for a recognised key
on a locked account. A wrong key produces 401 here; ours does not.

That same by-hand 401 also proves two smaller things: the model slug
`google/nano-banana-2-lite` resolves to a real fal.ai application (it did not
404), and fal.ai really does use a bare `{"detail": "…"}` error body, which is
one of the three shapes `nanobanana.js` parses.

### §2 claims — status after this run

| # | Claim | Status |
|---|-------|--------|
| 1 | endpoint + `Authorization: Key` + body field names | **PARTIALLY CONFIRMED.** Host, path, model slug and auth header shape are all correct — the request reached fal.ai, resolved to a real application and authenticated. The BODY's field names remain unverified: fal.ai refused on account state before validating the input. |
| 2 | fal.ai does not bill a non-2xx | **STILL OPEN.** `billed: false` held for this 403, but an account lock is the one non-2xx nobody would bill for. It is no evidence about a 4xx validation error. |
| 3 | the error body parses into something a user can read | **CONFIRMED.** The parsing produced `Image provider returned 403: User is locked. Reason: TOP_UP.` — a legible sentence naming the real cause, which is exactly what this claim was written to check, and the opposite of the `"— "`-with-nothing-after-it failure it feared. |
| 4 | ~4s latency, so the no-queue synchronous design holds | **STILL OPEN.** Nothing was generated. The 419 ms round trip measures a refusal, not a generation. |
| 5 | prompt length at the worst case | **STILL OPEN.** |

### What this run DID exercise, and it passed

The provider-failure path, end to end: a vendor refusal produced a 502 with
`billed: false`, an honest `failed` row carrying the real vendor message in
`error_text`, `moderation_status: allowed`, no bytes, and `url: null`. Nothing
was swallowed, nothing was retried into a silent fallback, and nothing claimed
success. That is the half of RULE 6 this failure was able to test.

### RULE 6 fact that Stage 2 must respect

Production's `image_generations` holds **three `status='stored'` rows with
`provider='dashscope'`, `model='qwen-image-plus'`** (user_id 1, 2026-09-04 and
2026-09-07, 1.6–2.3 MB, `size='1328*1328'`). They are real images a real
account can still open today. Deleting `lib/image/providers/dashscope.js` must
not make them unreadable or unrenderable. This is now a measured fact rather
than a hypothesis, and it is the specific thing the removal's blinded review
has to attack.

### Stage 2 (removing DashScope) was NOT started

Joel's instruction gated it on a real image, and there is none. The removal
deletes the only rollback path — `DEFAULT_PROVIDER` is one constant and
`provider: 'dashscope'` still works per request — and that path is worth more
today than the dead weight costs. Nothing in `lib/image/`, `.env.example`,
`helpers/capabilities.js` or `test/image-contract.js` was touched, and no
Railway variable was changed or deleted.

### Unblocking it

One thing: top up the fal.ai account (https://fal.ai/dashboard/billing). The
Railway key needs no change. Stage 1 then re-runs in a single call.

### Swept in, unasked — declared per §6.4

A throwaway account was registered on production through the public
`/api/auth/register` route to hold a session for the gate — the same path
`scripts/seed-demo.js` uses, and the only one available, since `DATABASE_URL`
points at `postgres.railway.internal` and `POST /api/images/generate` sits
behind `requireAuth`. `users.id = 6`,
`nanobanana-gate-1789721735524@modus-probe.invalid`, role `user`, plan `free`.
It owns the one `failed` image row above and nothing else. Not deleted:
removing a row from `users` on production is Joel's call.

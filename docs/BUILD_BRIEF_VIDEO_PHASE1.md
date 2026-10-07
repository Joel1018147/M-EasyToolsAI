# BUILD BRIEF — M-EasyVideo AI+, Phase 1 (image-to-video)

Repo: `M-EasyTools-AI`  ·  Platform accent: `tools` (#E8622A)  ·  Drafted 2026-09-21
Template: `Modus-Agent-OS/skills/build-brief-template.md`

Decisions taken by Joel, 2026-09-21:
  * Video lives as a SUBSYSTEM of M-EasyTools, not a fifteenth platform.
  * Phase 1 provider lane: DashScope / Wan only. No fal, no self-hosted GPU.

---

## 0 · LOAD

Read the canonical load list in `Modus-Agent-OS/BUILD_PROTOCOL.md` Phase 0 and
everything on it, plus `M-EasyTools-AI/CLAUDE.md`. Confirm in ONE line what you
loaded. If any listed file is missing, STOP.

`M-EasyTools-AI/CLAUDE.md` already points at Modus-Agent-OS (lines 8, 120, 157,
162) — no pointer gap to close here.

---

## 1 · GOAL

A M-EasyTools user turns an approved generated image into a short video clip,
asynchronously, with the true provider cost stamped on the row and the bytes
stored durably before the row is readable.

Not in Phase 1: text-to-video, reference-to-video, ffmpeg assembly, voice,
lip-sync, campaigns, bulk. Each is an additional method on an interface this
run establishes; none of them is worth building before the lane is proven on
the cheapest unit that exists.

---

## 2 · CLAIMS — verify these BEFORE building

These are asserted from documentation and from reading this repo, not from a
live call. Each is a hypothesis. Check it; if one is false, STOP and report.

| # | Claim | How to falsify | If false |
|---|-------|----------------|----------|
| 1 | The DashScope key already in Railway for this service is entitled to **video** generation, not only multimodal image generation. | Submit one 480p 2-second job with `X-DashScope-Async: enable`; expect HTTP 200 + `task_id`. A 401/403 means the entitlement is absent. | STOP. Entitlement is an Alibaba console action behind Joel's account — no agent can do it. Report and wait. |
| 2 | The video endpoint is reachable at the **same base URL this repo already uses**. `lib/image/providers/dashscope.js:70` defaults to `https://dashscope-intl.aliyuncs.com`, but the Wan video reference documents a **workspace-scoped** host, `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis`. | Call both. Compare status codes. | If the workspace host is required, `DASHSCOPE_WORKSPACE_ID` is a **NEW env var the image lane never needed** → Gate 0 item, and the video provider gets its own base resolver rather than reusing the image one. |
| 3 | Per-second price. Two third-party sources disagree by 3×: one says Wan 2.6 is $0.05/sec, another $0.0708/sec standard with **Flash variants at $0.021–0.069/sec**. Neither is Alibaba. | Read Alibaba's own model pricing page for the exact model ID and region, then reconcile against ONE real billed generation in the console. | Nothing about plan pricing, caps or credit copy ships until the real number is in hand. A wrong number here is a margin error on every future generation. |
| 4 | This repo has **no object storage** — no R2, no S3, no bucket. | `grep -rn "S3\|R2_\|bucket\|aws-sdk" --include=*.js lib routes helpers server.js` | Already checked: nothing. `test/r2-visual-contract.js` is **"Round 2 visual"**, NOT Cloudflare R2 — do not mistake it for existing storage. Treat this claim as CONFIRMED by inspection; re-confirm the Railway side with `railway variables --kv \| findstr R2` (recurring-bugs **#19** — without `--kv` that output is not machine-readable). |
| 5 | This repo has **no job runner**. `lib/image/rehost.js:22` states it; `server.js:442` is a bare `setInterval(runScheduledTasks, 1h)`; `grep -rn scheduled_jobs migrations/ server.js` returns nothing. | The greps above. | Treat as CONFIRMED. The queue is net-new, and it is **not optional** — the vendor API is task-based and cannot be served in-request the way `routes/images.js` is. |
| 6 | The Railway project for M-EasyTools can host a **second service** off this same repo (the worker) without a plan change. | Railway dashboard / `railway status`. | Cost and plan implication — Joel's call, not an agent's. Report before provisioning. |
| 7 | `ffmpeg` is **not** present in the deployed container and must be declared. | `which ffmpeg` in the deployed worker. | Phase 1 does not assemble video, so this may be deferred — but record the answer now so Phase 2 does not discover it late. |
| 8 | The `users.plan` payment defect documented in `lib/image/caps.js` is **still unfixed** — the iPay88 success path writes `subscriptions`, not `users`, so a paying customer still reads `users.plan='free'`. | `grep -n "SET status='active'" server.js` and check whether `users.plan` is written alongside. | Do NOT fix it inside this lane (file ownership). Report it. It is tolerable for count-caps; it is a money bug once per-second cost is involved. |
| 9 | **Platform-shaped, therefore in §2 by default** (template rule): every path, temp-file and byte-stream operation in this lane behaves identically on Windows and on Railway's Linux. | Run the lane's tests on Windows before pushing. | Report. Do not patch blind. See recurring-bugs **#12**. |
| 10 | Provider video URLs expire in **24 hours and are then purged**. | Alibaba's own text-to-video API reference states it. | This is `rehost.js`'s problem again, harder. If the expiry is shorter than documented, the re-host step moves earlier in the job, not later. |

---

## 3 · BUILD

**Create**

| File | Purpose |
|---|---|
| `migrations/005_video.sql` | `scheduled_jobs`, `video_generations`. UUID PKs, `created_at`/`updated_at`, every statement idempotent (`schema.sql` is replayed on EVERY boot as ONE transaction). |
| `lib/video/provider.js` | Registry. **Same interface shape as `lib/image/provider.js`** — `create(opts) -> client`, `isConfigured()`, `missingVars()`, `model()`, `endpoint()`, `buildBody()`, `submit()`, `poll()`. Constructed per call; nothing read from `process.env` at require time (recurring-bugs **#1**). |
| `lib/video/providers/wan.js` | The one Phase 1 provider. `submit()` returns a `task_id` and **persists nothing**; `poll()` returns terminal state + a URL that expires. Neither claims durability. |
| `lib/video/rehost.js` | Download → object storage → key. Same three structural guarantees as the image lane: bytes+status in ONE `UPDATE`; read path filters `status='stored'`; a re-host failure is its own terminal status because **the provider already billed for it**. |
| `lib/video/caps.js` | Cost ledger. See INVARIANTS — this is **not** a copy of the image `caps.js`. |
| `lib/video/storage.js` | R2 client. Per-call construction, no import-time client. |
| `routes/videos.js` | `POST /api/videos` → 202 + job id. `GET /api/videos/:id` → status. `GET /api/videos/:id/file` → bytes, `status='stored'` only, `X-Content-Type-Options: nosniff`. |
| `worker.js` | Second Railway service. Claims a job row, submits, polls at the documented ~15s interval, re-hosts, stamps cost, marks terminal. |
| `public/video.html` | UI. `data-platform="tools"`, design-system tokens only, no hardcoded `#E8622A` (`test/r2-visual-contract.js` already enforces this). |
| `test/video-contract.js` | The lane's contract. |
| `test/mutate-video-cost.js` | Mutation harness for the cost guard. |

**Modify:** `server.js` (mount the route), `test/run-all.js` (register the new suites), `helpers/capabilities.js` (declare the video capability the way the image one is declared).

**Do NOT touch:** `lib/image/**`, `routes/images.js`, `lib/image/providers/nanobanana.js`, the DashScope image provider. The image lane is live and working. Copy its *shape*; change none of its files.

---

## 4 · INVARIANTS — as tests, never as prose

- No row is `stored` without bytes in R2 and a key → one `UPDATE` sets content-key and status together; no statement exists that sets `'stored'` alone → `test/video-contract.js`
- The read path cannot serve a non-`stored` row → `test/video-contract.js`
- `source_url` never appears in any API response → assert the explicit column list, exactly as `test/image-contract.js` does today → `test/video-contract.js`
- **The cost on the row is the provider's, never a constant in our code.** No cap decision may read a hardcoded price. → `test/video-contract.js`
- **Cost is read as a number, not a string.** Postgres `NUMERIC` comes back from `pg` as a **string** — recurring-bugs **#8**. A ledger that sums strings concatenates them and the cap never fires. → `test/mutate-video-cost.js`
- Billable statuses are counted the way `lib/image/caps.js` counts them — `pending` included, because a row inserted before the provider call **may have been billed**. `refused` and `failed` are free. → `test/video-contract.js`
- No `setTimeout`/`setInterval` schedules a job — the queue is the `scheduled_jobs` table (recurring-bugs **#3**) → `test/no-fallbacks-tree.js` extension
- `video_generations.provider_task_id` is **not** a nullable `UNIQUE` — recurring-bugs **#9**: Postgres admits unlimited NULLs past one. Partial unique index, and the test says which rows it covers.
- **Every table added has its writer in the same change** — recurring-bugs **#22**. `scheduled_jobs` without the worker is a table that answers nothing.
- A model failure is **visibly distinct** from a model success that found nothing. No silent fallback (BUILD_PROTOCOL Rule 6). Empty states say WHICH empty state they are.

Every new guard is **mutation-tested**: break the thing it protects, watch it fail, restore, watch it pass. Report both outcomes. A guard that has never seen a failure is not evidence.

---

## 5 · GATE

- **Gate 0 — pre-deploy env-var diff** (`railway-deploy-gate.md`). Grep the WHOLE repo for config reads **including the dynamic `process.env[...]` form** (recurring-bugs **#11** — `lib/image/providers/dashscope.js:91` already uses that form, so a naive grep misses it) and diff against what Railway actually has. New vars expected: `DASHSCOPE_WORKSPACE_ID` (if claim 2 falsifies), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE`. Use `railway variables --kv` (recurring-bugs **#19**).
- `npm test` — **expect 38 suites, up from 37.**
- Negative controls / plant-anchor check.
- Gates 1–3: ACTIVE (a floor) → verify live → structure audit against `recurring-bugs-checklist.md`.
- **On Windows before push** (claim 9).

---

## 6 · REPORT BACK

1. What changed — files, one line each
2. Every claim in §2: CONFIRMED or FALSIFIED, with the evidence
3. Anything found that this brief did not anticipate
4. **Anything done that was not asked for** — including files swept in by `git add -A`
5. Anything that could NOT be verified, and why
6. **Which panel-bound documents this run made STALE.** `Ecosystem Context.md` gains a subsystem under the `tools` platform — say so; no agent can write to the knowledge panel, so the deliverable is a sentence telling Joel what to re-upload.

Append §6 verbatim to `Modus-Agent-OS/RUN_LOG.md` as `## Run 169 — M-EasyTools-AI — M-EasyVideo Phase 1 (image-to-video)`. Confirm 169 is the next free number at the time of the run; the log ended at 168 on 2026-09-21.

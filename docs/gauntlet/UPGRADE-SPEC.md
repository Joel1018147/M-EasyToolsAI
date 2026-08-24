# M-EasyTools AI+ — UPGRADE SPEC (Round 1)

**Source of truth for _what_ gets built this run.** The bar for _how well_ is
`GAUNTLET-CORE.md` (shared mechanism) plus `GAUNTLET.md` (this platform's Bars
and lanes). Written by Stage 0 from a real audit of this codebase on
2026-08-21, not from any prior document.

---

## STAGE 0 — WHAT THE AUDIT ACTUALLY FOUND

Everything below was read out of the repo, the live Railway service, or the
vendor's own API. Nothing here is inferred from a sibling platform's docs.

### 0.1 Content-generation subsystems that exist

Eleven module pages are mounted behind `checkModule()` in `server.js:1676-1686`.
Ten of them generate content; all of them funnel into **one** function.

| Route | Page | Generates | Reaches the model via |
|---|---|---|---|
| `/content` | `content.html` | blog, landing copy, outline, rewrite, humanise | `POST /api/generate` |
| `/social` | `social.html` | social posts | `POST /api/generate` |
| `/mail` | `mail.html` | email marketing | `POST /api/generate` |
| `/ads` | `ads.html` | ad copy | `POST /api/generate` |
| `/seo` | `seo.html` | SEO content | `POST /api/generate` |
| `/sales` | `sales.html` | sales copy | `POST /api/generate` |
| `/commerce` | `commerce.html` | product copy | `POST /api/generate` |
| `/audiobook` | `audiobook.html` | long-form script | `POST /api/generate` |
| `/gao` | `gao.html` | GAO (Generative AI Optimization) analysis | `POST /api/generate` + a direct Groq call at `server.js:825` |
| `/aichat` | `aichat.html` | conversational marketing assistant | `POST /api/chat` |
| PR (in `app.html`) | — | press releases | `POST /api/pr/generate` (`server.js:762`) |

**The single generation choke point is `generateWithGroq()`,
`server.js:660-694`.** Every module page's prompt is built client-side and
posted to `/api/generate`, which is a nine-line wrapper around it. Two call
sites bypass it: `/api/chat` (its own system prompt) and the GAO scoring call
at `server.js:825`.

This matters for the trilingual lane: **there is one place to add language,
not eleven** — plus two named exceptions.

### 0.2 Is there a customer-facing AI surface? — Yes, two

This is the question that decides whether the Security / Registry Bar applies.
It does.

1. **`POST /api/chat`** (`server.js:630`) — guarded by `requireApiKey`, which
   falls back to `requireAuth` when no `x-api-key` header is present. It is
   documented publicly in `public/api-docs.html`, and it lets the caller
   **name a model**. This is an external-integration surface: third parties
   hold API keys against it today.
2. **`POST /api/generate`** (`server.js:695`) — same guard, also documented.

Neither constructs a tool registry — both send a plain `messages` array with no
`tools` field. That is the property the disjointness test must *prove* rather
than assume, because M-Ai will introduce the first tool-calling registry in
this repo.

`/seller` is staff-facing but is **not** an AI surface today.

### 0.3 Current UI state — the honest picture

Measured across all 23 pages in `public/`:

| Property | Count |
|---|---|
| Pages that load `modus-design-system.css` at all | **6 of 23** |
| Pages that define a **private hex palette** instead | **17 of 23** |
| Pages that consume `var(--accent)` | **3 of 23** (`pr-demo`, `seller`, `audiobook`) |
| Distinct hardcoded hex literals in `app.html` alone | **86** |

Worse than "unstyled": several pages carry a *different platform's* accent.
`aichat.html` declares `data-platform="tools"` and then defines
`--mod:#7C3AED` — that is **M-EasyMember's purple** — as its own primary,
so the page renders in another platform's brand colour while claiming this one.

`test/ui-contract.js` already asserts `ACCENT = '#E8622A'` (§2 platform
registry) and md5-pins the design system, so the *stylesheet* is correct and
policed. What is not policed is whether any page actually **consumes** it.

### 0.4 The orange is not a decision this round has to make

`public/css/modus-design-system.css` is byte-identical (md5 `90709d5c…`) across
M-EasyTools, M-EasyDo, M-EasyMember and the `Modus-Agent-OS/design` master, and
it already declares:

```css
[data-platform="tools"] { --accent: #E8622A; }
[data-theme="dark"][data-platform="tools"] { --accent-light: rgba(232,98,42,0.22); --accent-text: #ee8e66; }
```

M-EasyDo's blue is declared the same way (`[data-platform="do"] { --accent: #1a73e8 }`).
So "swap the locked colour token to an orange" is **already true in the shared
master**. The Foundation token lock is therefore *not* "pick an orange" — it is
"consume `--accent` and never restate it", exactly as M-EasyDo's
`r2-tokens.css` does. See §0.5.

### 0.5 Is M-EasyDo's Round 2 revamp real? — **YES, it is real code**

This was flagged as a possible Level 2 interrupt. It resolved cleanly, so no
interrupt was raised.

Evidence: `M-EasyDo-AI/public/css/r2-tokens.css` is **128,995 bytes of shipped
design tokens and components**, first committed in `1fa4bb0` ("Stage R2-0: lock
the Round 2 token foundation and its guards"), merged to its main in `dbc37c7`
("Merge gauntlet/r2-visual: Round 2 visual revamp"), and since extended by
Round 3 (`b92d472`) and Round 4 (`0544fac`). It is guarded by
`test/r2-visual-contract.js`.

**We therefore build from its real tokens and components, not from the
GAUNTLET.md "ROUND 2" spec fallback.** The reference set named in that file
(Linear, Raycast, Perplexity, Vercel, ElevenLabs) is carried forward because
r2-tokens.css itself carries it in its header, and the restraint principle
comes with it.

The single most important property to copy: **r2-tokens.css contains not one
platform-accent hex literal.** Every colour is `var(--accent)` or a
`color-mix()` derived from it, and its own test asserts a literal can never
appear. Ported unchanged into a page carrying `data-platform="tools"`, the
identical file resolves orange. That is what "reads the same way the blue
does" means mechanically, and it is why the port costs no re-derivation.

### 0.6 Asset storage — does not exist

Grep for `multer|s3|cloudinary|blob|Bucket|upload` across `server.js`,
`routes/`, `helpers/` and `package.json` returns **nothing**. There is no
upload path, no object store, no filesystem write, and the Engineering Bar
forbids adding one (`no filesystem writes, PostgreSQL only`).

Both the Document Intelligence lane (which receives files) and the image lane
(which must re-host generated images) need bytes to live somewhere. Foundation
resolves this once, for both, as PostgreSQL `BYTEA`. See §2.2.

### 0.7 A real pre-existing defect the trilingual lane must fix

Recurring-bugs class **#7 (CJK text broken by `\b` / whitespace splitting)** is
live in `generateWithGroq()` today. Verified by execution, not by reading:

```
ZH  chars=59    wordCount=1     sentences=1   readability=100
EN  chars=170   wordCount=24    sentences=3   readability=30
BM  chars=150   wordCount=19    sentences=2   readability=30
```

`text.split(/\s+/)` counts a whole Chinese article as **one word**, because
Chinese does not put spaces between words. Consequences today:

- `documents.word_count` is stored as `1` for any Chinese document.
- The SEO score gate `wordCount >= 300 ? 25 : Math.floor(wordCount/12)` awards
  **0** to every Chinese document however long it is.
- The Flesch readability formula, which is defined over English syllables,
  returns a meaningless `100` for Chinese and is applied unmodified to Malay.

Generating Chinese without fixing this ships a scoring system that silently
marks all Chinese output as worthless. It is in scope for Lane C.

### 0.8 Gate 0 — pre-deploy env-var diff (names only, run 2026-08-21)

Read with `railway variables --kv`; **names only, no values were read or
recorded**, per `railway-deploy-gate.md`.

- **Live on Railway but absent from `.env.example`:** `DASHSCOPE_API_KEY`,
  `JWT_SECRET` (plus Railway's own `RAILWAY_*` injections).
- **In `.env.example` but not set live:** `GROQ_MODEL` (optional by design —
  the code default `qwen/qwen3.6-27b` applies), `PORT` (Railway supplies it).
- **`DASHSCOPE_API_KEY` is already provisioned in production.** The image lane
  therefore does **not** block on Joel for a secret. `.env.example` must be
  updated to document it — an env var that only exists in production is
  invisible to the next person who reads the repo.

### 0.9 The image API, confirmed against the vendor and then against reality

Alibaba's own docs were read, and then the live key was probed, because the
docs and the service disagree in two places that would each have shipped a
broken integration.

**Working configuration, verified end-to-end on 2026-08-21:**

```
POST https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
```

| Finding | Docs say | Live service says |
|---|---|---|
| Endpoint host | only `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` | the legacy `dashscope-intl.aliyuncs.com` **works** and is what this key is provisioned for |
| Image URL expiry | "valid for 24 hours" | **7 days** (`Expires=1787896093` → 2026-08-28 on a 2026-08-21 call) |
| `size` for this model family | range 512×512–2048×2048 | `1024*1024` is **rejected**; the API names the only legal values |

**The `size` finding is the one that would have broken the lane.** The format
is `width*height` with an asterisk — that part of the brief was right — but
`1024*1024` is not a legal *value* here. The API answered:

> `InvalidParameter: The size does not match the allowed size 1664*928,1472*1104,1328*1328,1104*1472,928*1664.`

**Region is confirmed Singapore:** the same key returns
`401 InvalidApiKey` against the Beijing host, which is correct for a
Malaysia-facing platform.

Measured, one image each at `1328*1328`:

| Model | Latency | PNG size | Result |
|---|---|---|---|
| `qwen-image-2.0` | 2.5 s | 1.91 MB | 200 |
| `qwen-image` | 3.5 s | 1.89 MB | 200 |
| `qwen-image-plus` | 3.6 s | 1.87 MB | 200 |
| `qwen-image-max` | 16.4 s | 2.25 MB | 200 |

Every returned URL downloaded cleanly over plain `GET` with
`content-type: image/png` and a valid PNG signature (`89504e47…`).

**Because the URL expires — whether in 24 hours or 7 days — a saved document
that stores the DashScope URL is a dead image link on a timer.** Re-hosting is
part of generation, in the same request, before the row is written. Not a
follow-up job.

The synchronous path is used, so **no job queue and no `setTimeout` are
introduced** — which keeps the Engineering Bar satisfied without building a
scheduler this repo does not have.

---

## 1. WHAT GETS BUILT

### 1.1 M-Ai — staff-only AI assistant (Lane A)

Framework is **shared, not new**: `lib/mai/{index,registry,dispatcher,validate,confirmations}.js`
are platform-free and provider-free by construction in M-EasyDo and are
designed to be moved unchanged. They are copied in verbatim per the Reusable
Module Registry's stated reuse method. M-EasyDo's repo is **read only** and is
not modified.

Built new for this platform:

- `lib/mai/roles.js` — the roles this schema can actually hold. `users.role`
  is `VARCHAR(20) DEFAULT 'user'` and `team_members.role` is
  `VARCHAR(20) DEFAULT 'member'`; `/seller` is gated by a static `SELLER_KEY`,
  not a row. No invented roles.
- `lib/mai/tools/*.js` — the tool pack, built from **this platform's real
  schema**: `documents`, `users` (brand fields), `teams`/`team_members`,
  `platform_modules`, `media_outlets`, `journalists`, `pr_releases`,
  `pr_distributions`, `pr_outlet_reports`, `subscriptions`/`payments`/`invoices`,
  `user_settings`.
- `routes/mai.js`, `public/mai.html`, and the boundary test.

**No M-Ai tool may send anything.** `pr_distributions` reaches real journalists
through Resend; a tool that can trigger it would put an outbound send behind a
model's judgement. Read tools may report on distributions; there is no
distribute tool, and the boundary test asserts none exists.

### 1.2 Document Intelligence (Lane B)

Upload a file → extract values → **propose** them → a human confirms **each
field individually** → only then does anything persist.

The Human-Confirmation Bar is absolute: no `approve all`, no bulk accept, and
the enforcement is at the **database-write boundary**, not in the UI. Every
proposal carries attached evidence (the source snippet and its location).

### 1.3 Trilingual generation — EN / BM / ZH (Lane C)

Applies to every subsystem in §0.1 through the single choke point, plus the two
named exceptions.

Benchmark, per the Localization Bar: generated BM and ZH output is compared
against **M-EasyMember-AI's Campaign AI+** for an equivalent prompt. That repo
stores **no sample outputs** (verified), so the reference is produced by
running its exact prompt construction — quoted verbatim in `GAUNTLET.md` §L —
against the same model. Its hand-written trilingual corpus in `helpers/asha.js`
supplies the house register: BM formal-polite `anda`, baku spelling, no
Manglish particles; ZH Simplified with polite `您`, full-width punctuation,
`RM` left un-localised.

Includes the §0.7 CJK metrics fix.

### 1.4 Image generation — Qwen-Image (Lane D)

Direct backend HTTP integration, no MCP. Configuration per §0.9.

- **Budget/rate cap per account and per tier**, enforced server-side before the
  call is made, not after.
- **Same moderation posture as every other AI output on this platform.**
- **Re-host in the same request:** download the returned PNG, store the bytes,
  serve from this platform's own URL. A DashScope URL is never persisted into
  saved content.
- **Brand assets are never sent to the image API as prompt content unless the
  user explicitly initiates that specific action.** Uploaded brand material is
  not silently folded into a prompt.

### 1.5 Visual / UI-UX revamp (Lane E)

Same design language as M-EasyDo, orange instead of blue, per §0.4 and §0.5.
Surface split: bold and animated for marketing-facing pages, calm and dense for
daily-use tool screens.

The token is locked **in Foundation, before any lane's UI work starts**, and
M-Ai's admin screens (Lane A), Document Intelligence's confirmation UI
(Lane B) and the image controls (Lane D) all consume that one token.

---

## 2. FOUNDATION (Stage 1 — single-threaded, before any lane starts)

Foundation exists so five parallel lanes do not each invent the same thing.
Its output is frozen before Stage 2 begins.

### 2.1 The token lock

`public/css/r2-tokens.css`, ported from M-EasyDo's real file, loaded **after**
`modus-design-system.css` and never instead of it.

**Rule, enforced by test:** not one platform-accent hex literal in the file.
Every colour is `var(--accent)` or a `color-mix()` of it. The orange comes from
`[data-platform="tools"]` in the md5-pinned master and from nowhere else.
Changing it later is a master change synced to all twelve repos and would cost
this round zero rework.

### 2.2 One migration, all lanes

Two lanes need new tables; a lane writing its own migration is how two
migrations collide. Foundation writes **one** migration file.

New tables use **UUID primary keys** per the Engineering Bar. Existing tables
are `SERIAL` (`users.id`, `documents.id`, …), so foreign keys pointing at them
stay `INTEGER` — matching the column they reference is not a violation, it is
the only thing that works.

Binary storage is PostgreSQL `BYTEA`, because §0.6 leaves no alternative that
the Engineering Bar permits.

### 2.3 Shared extraction, so no lane touches `server.js`

`generateWithGroq()` moves out of `server.js` into a helper that Lane C owns.
Route files for Lanes A, B and D are created as stubs and **mounted by
Foundation**. After Stage 1, `server.js` is owned by no lane and edited by no
lane — which is what makes the lanes genuinely parallel.

`GROQ_MODEL` stays the single source of truth in `server.js` and is imported,
never re-read from `process.env`, per CLAUDE.md.

### 2.4 Shared helpers

- `helpers/lang.js` — the three language codes, CJK-safe text metrics (§0.7),
  and script detection. Consumed by Lanes C and D.
- `helpers/capabilities.js` — add the image capability. It is `required: false`
  so an unconfigured deployment reports `optional`, not `broken`.

### 2.5 The cross-lane UI contract

Lane C needs a language selector on pages Lane E owns. Rather than have two
lanes edit the same HTML, Foundation fixes the contract: Lane C ships one
self-contained `public/js/genlang.js`; Lane E adds the mount point and the
script tag as part of its page work. One selector implementation, nine pages,
no shared file.

---

## 3. DEFINITION OF DONE (this platform)

Per `GAUNTLET-CORE.md`, plus:

- Every Bar in `GAUNTLET.md` that applies to the lane passes.
- The full existing suite still passes — `npm test` is green **and** every
  mutation-tested negative control still fails when its guard is broken.
- No new banned shape in `test/no-new-fallbacks.js` (Guard A is what holds the
  line; the whole-tree guard is report-only and says so).
- Gate 3 (`test/gate3-structure.js`) audits the diff against
  `recurring-bugs-checklist.md`.
- The blind critic for each lane ran the specific check it names, and for
  every security-shaped Bar actually attempted the breach and failed.
- Nothing in the Reusable Module Registry's existing consumers regressed —
  `generateWithGroq()` is registered as **built in M-EasyTools**, so its
  contract is an ecosystem interface, not a local function.

---

## 4. KNOWN, DELIBERATE, AND REPORTED

Recorded here so they are decisions rather than omissions.

- **`content.html` fetch-response coverage** (CLAUDE.md) — the static scan
  cannot catch an inverted `.ok` check. Not closed by this round; not made
  worse. Re-stated in the final report.
- **`requireSeller` accepts its key from a query string**
  (`server.js:378`, `req.query.key`), which leaks into logs and referrers. It
  is pre-existing and out of scope, but it is why M-Ai derives identity from
  the **session only** and never from a request field.
- **Image bytes at ~1.9 MB per PNG in `BYTEA`.** The model family's smallest
  legal size is `1328*1328`; there is no smaller option and no image library is
  being added to re-encode. Bounded by the per-tier caps in §1.4 and a
  retention policy, and stated plainly rather than discovered later.

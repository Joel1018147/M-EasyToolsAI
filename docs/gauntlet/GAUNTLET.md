# GAUNTLET — M-EasyTools AI+ (Round 1)

Extends `GAUNTLET-CORE.md`; does not restate it. That file is the mechanism.
This file is *which* Bars apply here, *what* each one means on this platform,
and *how* the lanes are split. `UPGRADE-SPEC.md` is what gets built.

Derived by Stage 0 on 2026-08-21 from a real audit. Level 1 decision, taken
without confirmation, per GAUNTLET-CORE Stage 0.

---

## WHICH STANDING BARS APPLY

All seven. That is not a default — each is justified below from something found
in the audit, and two are scoped narrower than their generic wording.

| Bar | Applies | Why, from the audit |
|---|---|---|
| **Security / Registry** | ✅ | M-Ai will be this repo's **first tool-calling registry**. Two customer-facing AI surfaces already exist and are publicly documented: `POST /api/chat` and `POST /api/generate`, both reachable with an `x-api-key` held by external integrations. |
| **Consent / Compliance** | ✅ *(scoped)* | `POST /api/pr/distribute` sends real press releases to real journalists via Resend. Scoped to: **no lane may add a send path, and no M-Ai tool may trigger one.** |
| **Human-Confirmation** | ✅ | Document Intelligence is in scope and is by definition a document-upload/extraction feature. |
| **Localization** | ✅ | Trilingual generation is in scope. |
| **Visual** | ✅ | This round *is* a visual revamp. |
| **Reuse** | ✅ | Always applies. |
| **Engineering** | ✅ | Always applies. |

### §S — Security / Registry Bar (this platform)

The boundary to prove: **a caller holding only an API key, or an anonymous
caller, can never construct or reach the M-Ai tool registry.**

M-EasyTools differs from M-EasyDo in a way that makes this *harder*, and the
test must reflect the difference rather than be copied across:

- M-EasyDo's customer surfaces are **anonymous**. Here they are
  **authenticated** — `requireApiKey` resolves a real `users` row and sets
  `req.user`. So "a customer session" here is *a real user row with
  `role='user'`*, not an absent identity. A role check that only refuses
  `null` would pass on M-EasyDo and fail open here.
- `users.role` is `VARCHAR(20) DEFAULT 'user'`. **Every self-registered
  account is therefore `'user'`.** `'user'` must never be a staff role, and
  the test asserts it reaches zero tools.
- `requireSeller` takes its key from `req.query.key` (`server.js:378`) —
  query strings land in logs and referrers. M-Ai therefore derives identity
  from the **session only**, never from a query parameter, header or body
  field, and never from `SELLER_KEY`.

Required: a disjointness test that **enumerates both sets or fails loudly**
(an intersection against a set that could not be enumerated is a vacuous
pass), reads the **live** registry rather than a frozen export, includes a
positive control proving the guard actively refuses, and checks imports in
**both** directions. The blind critic runs a **red-team pass** — it must
actually attempt the breach through the real HTTP surface with a prompt-
injection payload and a model scripted to call a staff tool, and observe an
executor spy count of zero. Reading the code and concluding the boundary holds
is not a pass.

### §H — Human-Confirmation Bar (this platform)

No extracted value reaches any table except through a single-field accept that
carries a **server-issued nonce**, minted only while that one field's evidence
was displayed, hashed at rest, single-use, user-bound, and time-limited.

A boolean is not a confirmation. This is settled precedent in the ecosystem,
not a preference: M-EasyDo's blind critic proved `{confirmed: true}` off a
request body performed a write with no approval step having occurred, and an
approved `cancel_appointment(7)` was observed cancelling appointment 8.

Also required:
- **No bulk endpoint.** No `accept-all`, no `commit-document`, no route taking
  an array of ids. The absence is the enforcement — a per-field dialog in
  front of a bulk endpoint is a dialog, not a gate.
- **The model is a locator, never a source.** The value written is sliced out
  of the document's own text at the offsets where the model's quote was found.
  What the model *typed* is stored for audit and never written.
- **Every proposal carries evidence** — a verbatim quote located in the
  document's own extracted text. Unevidenced proposals are auto-rejected
  before a human sees them, and the rejection is persisted so the reviewer
  sees the failure rate rather than a suspiciously short list.
- **TOCTOU is checked**: the record identity and the value the card displayed
  are both re-verified inside the transaction before the write.

### §L — Localization Bar (this platform)

Benchmark is **M-EasyMember-AI's Campaign AI+**, per Joel's brief. The audit
found that repo stores **no sample outputs** (searched: tests, fixtures, seeds,
docs, comments — none). So the reference is produced, not retrieved: its exact
prompt construction is run against the same model for an equivalent prompt.

Its construction, quoted verbatim from `M-EasyMember-AI/routes/campaigns.js:320-367`:

```
system: You are a marketing copywriter for Malaysian F&B and retail merchants. Write short, effective WhatsApp messages.

LANG_INSTRUCTIONS = {
  en: 'Write in English. Warm, personal, Malaysian-friendly tone. Use emojis sparingly.',
  ms: 'Tulis dalam Bahasa Malaysia. Nada mesra dan peribadi. Guna emoji secukupnya.',
  zh: '用简体中文写。温暖友好的马来西亚风格。适当使用emoji。',
}
```
Model `qwen/qwen3.6-27b`, `temperature 0.7`, `max_tokens 1024`,
`reasoning_effort: 'none'`.

The house register, taken from that platform's **hand-written** trilingual
corpus in `helpers/asha.js` (human-authored, therefore a legitimate standard):

- **BM** — formal-polite `anda` throughout, standard *baku* spelling, no
  Manglish particles, emoji used as structure markers not decoration.
- **ZH** — Simplified (`简体中文`), polite `您` for the customer, full-width
  punctuation `！：、`, `RM` left un-localised, no Mainland-specific idiom.
- Both — `RM` currency un-translated, dates `en-MY`.

**The bar is: our BM/ZH output must be at least as good as that reference on a
like-for-like prompt, judged by a blind critic against named criteria** — not
the critic's unaided impression of fluency. Where our output is *better*, the
critic says why; where worse, that is a FAIL and the largest gap gets fixed.

Known weaknesses in the reference the critic should not copy as virtues: its
prompt context stays English even when generating BM/ZH; it has no register
guidance; it never verifies the output is actually in the requested language.
Matching a weakness is not passing.

Also in scope for this Bar: the **CJK metrics defect** (UPGRADE-SPEC §0.7).
Generating Chinese while scoring it with `split(/\s+/)` ships a system that
rates every Chinese document as worthless.

### §V — Visual Bar (this platform)

**Reference set**, carried over from M-EasyDo's real `r2-tokens.css` header
because we are porting that file: **Linear** (hierarchy from size and weight,
near-zero decoration), **Raycast** (glass used sparingly, on floating chrome
only; monospace for figures), **Perplexity** (a processing state that visibly
says "working", not a generic spinner), **Vercel** (one accent, spent
deliberately), **ElevenLabs** (motion that signals a state change).

The common thread is **restraint**. "High-tech" and "premium" are not
instructions.

**Surface split, enforced not just intended:**

| | Marketing (`index.html`, `pr-demo.html`) | Daily-use (`app.html`, module pages, `seller`, `settings`) |
|---|---|---|
| Motion | entrance + scroll reveal, staggered | transitions only — colour and width, no transforms |
| Glass | yes, on floating chrome only | only the sticky top bar |
| Gradient | none in page CSS | only the one AI command surface, as a 2px edge |
| Density | 16px / 1.6 line-height, up to 7rem section air | 15px / 1.55, 26px section gaps |

A blur behind body text is decoration bought with legibility; a content card
never gets one. A gradient that appears twice is a texture.

**The token lock.** `--accent` is **not chosen this round and must not be.**
`[data-platform="tools"] { --accent: #E8622A }` has been in the md5-pinned
shared master for eleven platforms, and `test/ui-contract.js` §2 already fails
the build if that hex drifts. The requirement the Visual Bar is reaching for —
one token, locked once, consumed identically by every lane, never re-derived
per screen — is met by **consuming `var(--accent)`**, not by picking a value.

Therefore, enforced by test: **not one platform-accent hex literal in
`public/css/r2-tokens.css`, and not one raw colour literal on any lane
surface.** A literal is a second source of truth for the orange, which is
exactly what "locked once" exists to prevent. Changing the orange later is a
master change synced to all twelve repos and would cost this round zero
rework.

Two known hazards specific to the orange port, to be resolved in Foundation
rather than discovered later:

1. `--area-sales: var(--accent)` — on M-EasyDo the Sales area colour is blue
   and the chrome accent is blue, which reads as intentional. On orange it
   makes the Sales area indistinguishable from every accent-coloured control.
2. `--r2-accent-wash` (4%) and `--r2-accent-edge` (32%) carry **no dark-mode
   correction** in the source file. A 4% wash of `#E8622A` on a `#0f172a`
   ground is effectively invisible.

### §E — Engineering Bar (this platform)

- No `setTimeout` for anything scheduled. This repo has **no job runner** —
  only a bare `setInterval` for subscription expiry, which is not a queue. The
  image lane therefore uses DashScope's **synchronous** API and completes
  in-request, so no scheduler is introduced.
- Parameterized queries only.
- **UUID primary keys on new tables.** Existing tables are `SERIAL`
  (`users.id`, `documents.id`, …); foreign keys referencing them stay
  `INTEGER`, because matching the column you reference is the only thing that
  works.
- **No filesystem writes, PostgreSQL only.** There is no object store in this
  repo (verified). Uploaded files and re-hosted images live in `BYTEA`.
- `GROQ_MODEL` has exactly one reader (`server.js`); everything else imports
  the exported constant.

### §R — Reuse Bar (this platform)

What was checked, and the finding, before anything new was written:

| Registry entry | Decision |
|---|---|
| `AI generation (Groq) — built in M-EasyTools` | **This repo is the origin.** `generateWithGroq()` is an ecosystem interface, not a local function. Extended, not replaced; its contract is preserved. |
| `Asha AI Agent — M-EasyDo` / M-Ai framework | **Reused verbatim.** `lib/mai/{index,registry,dispatcher,validate,confirmations}.js` are platform-free by construction. Copied in per the registry's stated method. M-EasyDo is read-only and untouched. |
| `Trilingual Asha agent — M-EasyMember (helpers/asha.js)` | **Reused as reference**, per §L. Its language detection is a pattern; its hand-written corpus is the register standard. |
| `PostgreSQL job runner — M-EasyMember (helpers/jobRunner.js)` | **Not adopted.** Lifting a shared module cross-repo is explicitly a separate, manually-supervised task under GAUNTLET-CORE, never part of an autonomous loop. Sidestepped by using the synchronous image API. |
| `i18n (EN/BM/ZH) — all platforms` | **Already present** here (`public/js/i18n.js`, 430 leaf keys × 3 locales). Extended, not rebuilt. Note the `msm_lang` / `modus-lang` dual-write adapter documented in CLAUDE.md — not renamed. |
| Design system + `r2-tokens.css` | **Reused verbatim.** Zero colour edits required (§V). |
| Document Intelligence — M-EasyDo `lib/docintel/*` | **Pattern reused, code re-authored** against this platform's schema. The guard sequence, nonce mechanism and evidence model are copied as *design*; the field map is necessarily this platform's own. |

Genuinely new, with reasons: the DashScope image client (no ecosystem
precedent — this is the first image-generation integration in any Modus
platform), the trilingual generation layer over `generateWithGroq()`, and this
platform's M-Ai tool pack.

---

## LANE SPLIT

Five lanes. Each owns **disjoint files**. A lane needing a file another lane
owns stops and flags rather than editing across the boundary.

The reason this is possible at all is Foundation: it pre-wires every route
mount and extracts the one shared function, so that **after Stage 1 no lane
edits `server.js`.**

| Lane | Owns | Bars it must pass |
|---|---|---|
| **A · M-Ai** | `lib/mai/**`, `routes/mai.js`, `public/mai.html`, `test/mai-*.js` | §S, §R, §E |
| **B · Document Intelligence** | `lib/docintel/**`, `routes/docIntel.js`, `public/docintel.html`, `test/docintel-*.js` | §H, §R, §E |
| **C · Trilingual** | `helpers/generation.js`, `helpers/lang.js`, `public/js/genlang.js`, `public/locales/*.json`, `test/trilingual-*.js` | §L, §R, §E |
| **D · Image generation** | `lib/image/**`, `routes/images.js`, `test/image-*.js` | §E, §R, + moderation & brand-asset rules |
| **E · Visual revamp** | `public/css/r2-tokens.css`, all pre-existing `public/*.html`, `test/r2-visual-contract.js` | §V, §R |

**The one cross-lane contract.** Lane C needs a language selector on pages
Lane E owns. Rather than two lanes editing the same HTML, Foundation fixes the
contract: Lane C ships one self-contained `public/js/genlang.js`; Lane E adds
the mount point and script tag as part of its page work. One selector
implementation across nine pages, no shared file.

Lanes A, B and D own their own new pages, which Lane E does not touch. All
three consume the Foundation token — they do not invent styling.

---

## DEFINITION OF DONE

`GAUNTLET-CORE.md`'s definition, plus this platform's specifics in
`UPGRADE-SPEC.md` §3. Max **8 loop iterations per lane**; a lane hitting the
cap stops and reports the gap honestly. **No bar is lowered to obtain a PASS.**

Blind critics run with fresh context, never see the builder's reasoning, and
state the specific check they ran. For §S the critic must have attempted the
breach and failed.

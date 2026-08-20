# GAUNTLET-CORE — SHARED PROCESS (all Modus platforms)

This file is the mechanism. It has no opinion on what any specific
platform's Bars, lanes, or reference set are — that's each platform's own
`GAUNTLET.md`, which extends this file rather than duplicating it. Copy
this file into `docs/gauntlet/GAUNTLET-CORE.md` in every repo running a
Gauntlet loop.

**Where this sits.** `Modus-Agent-OS/BUILD_PROTOCOL.md` is canonical for
how the ecosystem builds; this file is canonical for how a Gauntlet run
executes inside it. Where the two touch, BUILD_PROTOCOL wins — with one
ruled exception, recorded in its §7: **RULE 4a's "Joel decides what
ships" is carved out for Gauntlet runs**, which merge and deploy
automatically on a fully passing gate (see PRODUCTION SAFETY / GIT
SAFETY). Nothing else in RULE 4a is relaxed: real secrets, 2FA, payment
methods and admin-only actions remain Joel's, because no agent can do
them.

## Before this works
- Run in Claude Code, not a plain chat — a single-turn chat can't produce
  an independent blind critic; it falls back to a self-review pass rather
  than pretend the loop ran.
- **Repo boundary:** every Gauntlet loop is scoped to its own repository
  only. Never read-write or refactor code in another platform's repo,
  even to study a reference pattern — read those, don't edit them.
  Cross-repo extraction (lifting a shared module) is always a separate,
  manually-supervised task, never part of an autonomous loop.
- This runs as one staged pass, and only one: Audit -> Foundation ->
  Parallel Lanes -> Integration Check -> Report -> Merge -> Deploy ->
  Post-Deploy Verification. Stage 0 derives which Bars apply and what the
  lanes are itself, as a Level 1 decision — it doesn't stop to confirm
  this with Joel. The only thing that pauses the run is a genuine Level 2
  interrupt; otherwise it goes straight through from the task description
  to the final notification. Merge and deploy are automatic on a passing
  gate (see PRODUCTION SAFETY / GIT SAFETY) — Joel is notified either
  way, not asked to approve.

## Source of truth
Each platform's own `UPGRADE-SPEC.md` (or equivalent) is the source of
truth for *what* to build. This file and the platform's own `GAUNTLET.md`
are the bar for *how well* — neither gets reinterpreted by an agent's own
judgment.

A **pre-existing** spec that looks wrong, incomplete, or in conflict with
something already live is a Level 2 interrupt: stop and ask. This does
not apply to Stage 0's own derivation — Stage 0 *writes* the spec from
the audit and proceeds without confirmation. Only a conflict it cannot
resolve against the real codebase escalates.

---

## STANDING BARS (apply wherever the relevant surface exists)

Every platform's own `GAUNTLET.md` states which of these actually apply —
don't assume all of them do.

- **Security / Registry Bar** — applies to any platform with more than one
  AI-agent surface (e.g. a staff-only assistant and a customer-facing
  one). A customer-facing session must never construct or reach a
  staff-only tool registry. Ship a disjointness test. The blind critic's
  job here is a red-team pass — actually attempt the breach, don't just
  inspect the code and assume the boundary holds.
- **Consent / Compliance Bar** — applies to any platform sending
  messages/campaigns to contacts. Audience queries filter to consented
  contacts at the query level, not a UI warning. No send path bypasses
  live-verified credentials.
- **Human-Confirmation Bar** — applies to any document-upload/extraction
  feature. No extracted value reaches the database without explicit
  per-field human confirmation; no "approve all" shortcut. Every proposal
  needs attached evidence.
- **Localization Bar** — applies to any platform generating content in
  more than one language. Benchmark against a real, proven in-ecosystem
  reference output, not the critic's own unaided judgment of fluency.
- **Visual Bar** — applies to any UI/UX revamp round. "High-tech,"
  "premium," "modern" are not specific enough alone — name concrete
  reference products and what they're doing right (hierarchy, restraint,
  motion-with-a-reason), and split treatment by surface: bold/animated is
  right for marketing pages, wrong for daily-use dashboards.
- **Reuse Bar** (always applies) — before writing new code, state what
  was checked in the ecosystem's Reusable Module Registry and other
  platforms, and what's being reused vs. genuinely built new, with a
  reason for anything new.
- **Engineering Bar** (always applies) — no `setTimeout` for anything
  scheduled, use the job-queue pattern; parameterized queries only; UUID
  primary keys on new tables; no filesystem writes, PostgreSQL only.

### Blind Critic discipline (always applies)
Fresh context. Never reads the builder's reasoning — only the artifact,
the tests, and the spec. "Should be fine" or "tests pass" is never
sufficient; the critic states the specific check it ran, and for any
security-shaped bar, must have actually attempted the breach and failed,
not just inspected code and assumed a boundary holds.

---

## LOOP
BUILD → deterministic tests → BLIND CRITIC → PASS/FAIL → if FAIL, fix the
largest gap → repeat.

## DEFINITION OF DONE (shape — each platform fills in its own Bars)
A lane is complete only when every Bar that applies to it passes,
deterministic tests pass, the blind critic finds no material gap, nothing
in the Reusable Module Registry's existing consumers regressed, and the
work sits on a clean, fully-committed feature branch.

The whole build is complete only when, additionally, after Integration:
the Integration Bar passes across the merged state of all lanes, no two
lanes wrote conflicting migrations, and shared external resources are used
consistently across every lane that touches them.

**Maximum 8 loop iterations per lane.** If a lane hits the cap without
passing, stop that lane and report the gap honestly — never lower a bar
to obtain a PASS.

Only after all of the above: merge and deploy proceed automatically, per
PRODUCTION SAFETY / GIT SAFETY. Joel is notified either way, not asked to
approve.

## AUTONOMY LADDER
What triggers an interruption — everything else runs without asking.

### Level 0 — Decide without asking
Internal code structure and naming within a lane's own files. Writing
tests. Bug fixes found during the loop. Standard patterns already
established elsewhere in the ecosystem. Styling/layout on new UI, as long
as it follows an existing design system rather than inventing one (unless
the round *is* a visual revamp — then this is Level 1, below).

### Level 1 — Decide using existing architecture, no ask needed
Which existing service or pattern to extend vs. create new — still has to
satisfy the Reuse Bar's "state what you checked" requirement. Internal
helper structure. Exact shape of new columns/tables, as long as UUID PKs
and parameterized queries hold. Design-token choices in a visual revamp,
as long as they're grounded in the Visual Bar's reference set.

### Level 2 — Must interrupt Joel
Interrupt only when:
- A security/registry boundary is genuinely ambiguous.
- A consent/compliance rule is unclear.
- A migration would touch data outside this platform's own tables.
- The spec conflicts with something already live in production.
- The fix would require touching another repo.
- Builder and critic genuinely disagree about what the spec requires.
- A secret, a 2FA step, a payment method or an admin-only action is
  needed — no agent can perform these, so the run blocks on Joel rather
  than working around them.

When interrupting: explain the decision, the options, a recommendation,
ask the smallest possible question, then resume autonomously the moment
it's answered.

## PRODUCTION SAFETY / GIT SAFETY
- Feature branch per lane; lanes merge into one integration branch first
  — no individual lane merges to `main` directly.
- **Merge gate (automatic, no manual click):** merges to `main` only
  once the full Definition of Done is satisfied — every applicable Bar,
  the complete deterministic suite including every mutation-tested
  negative control, and the Integration Bar across all lanes. Nothing
  merges on a partial or weakened check.
- **The ecosystem's existing gates are part of that merge gate, not a
  parallel process.** Run `Modus-Agent-OS/skills/three-stage-deploy-gate.md`
  in full. **Gate 0 — the pre-deploy env-var diff in
  `railway-deploy-gate.md` — runs BEFORE the merge**, because it is the
  only check that catches a fail-closed guard whose secret was never set
  at all; M-EasyDo's webhook secrets passed a healthcheck clean and
  rejected every real customer webhook with a 403. Gate 0 reads variable
  NAMES via `railway variables --kv`, never values. Gate 3 audits the
  diff against `recurring-bugs-checklist.md`. A non-zero exit from the
  document guards (`loadlist-integrity`, `context-split-integrity`,
  `verify-design-system`) is a stop, not a warning.
- **Precondition, verified not assumed:** the repo must be `railway
  link`-ed for the post-deploy checks below to mean anything. Confirm
  with `railway status --json`. If it is not linked, that is a Level 2
  interrupt before the merge, not a reason to skip verification.
- **Deploy:** merging to `main` triggers the platform's deploy pipeline
  automatically.
- **Smoke test runs after deploy**, as a deploy-health check (core pages
  load, primary flow renders) — never a substitute for the merge gate.
- **Post-deploy re-verification (mandatory, automatic):** immediately
  after deploy, re-run this platform's Bars against the live production
  environment, not staging — **non-destructively**. Read paths, auth and
  registry-boundary probes, unsigned-webhook rejection, and env-var
  liveness all run against production. Anything that writes, mutates or
  deletes real data — and any mutation test that deliberately breaks a
  guard to prove the test fails — runs pre-merge against the test
  harness, never against a live database with real customers behind it.
  A Bar that cannot be probed non-destructively is reported as
  unverified-in-production, never silently claimed as passed.
- **Auto-rollback:** any post-deploy check failing triggers immediate
  rollback to the prior commit, with a notification naming the specific
  failure.
- **Notification:** send Joel an email via Resend on both outcomes —
  clean deploy, or a rollback with specifics. Never a request to approve.
  The email states what was actually observed, per RULE 1 — the checks
  that ran, the ones that could not, and the commit deployed. If Resend
  is unreachable, the run says so in its final report rather than
  finishing silently; a notification that was never sent is never
  reported as sent.
- None of this authorizes touching another repo, weakening a Bar to pass
  the gate, or skipping any platform-specific verification requirement
  because the suite is green.

---

## STAGES (skeleton — each platform's GAUNTLET.md fills in specifics)

### Stage 0 — Audit + Derive
Audit the real codebase first. From that audit plus what Joel stated he
wants built this run, derive which STANDING BARS above actually apply and
the lane split for parallel building — a Level 1 decision, not something
that needs confirmation. Write the result directly into this platform's
own `UPGRADE-SPEC.md` and `GAUNTLET.md`. Only interrupt Joel here if
something is a genuine Level 2 case; if the audit resolves cleanly, there
is nothing to ask, and Stage 1 starts immediately.

### Stage 1 — Foundation (single-threaded, before any lane starts)
Build shared prerequisites the parallel lanes would otherwise race to
invent independently — schema additions, shared client/credential setup,
any skeleton a lane needs already wired before it starts.

### Stage 2 — Parallel Lanes
Fan out per the platform's own lane list. Each lane owns disjoint files.
If a lane needs to touch a file another lane owns, stop and flag it
rather than editing across the boundary. Loop per lane per the
STANDING BARS above, capped at 8 iterations.

### Stage 3 — Integration Check
A fresh agent, after every lane reports PASS, checks the merged state of
all lanes together — not just each lane in isolation.

### Stage 4 — Report, Merge, Deploy, Verify
One consolidated report. If the Definition of Done passes, merge and
deploy automatically per PRODUCTION SAFETY / GIT SAFETY, then run
mandatory post-deploy verification. Notify Joel either way. Write the run
into `Modus-Agent-OS/RUN_LOG.md` — what was observed live, what was found
and deliberately not fixed, what could not be verified — because the next
session's only memory of this one is the repo plus that file.

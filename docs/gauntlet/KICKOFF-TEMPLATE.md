# KICKOFF — the only thing that changes per system

Copy `GAUNTLET-CORE.md` into a repo once. Then, for any build/upgrade on
that platform, paste this — filling in only the bracketed line:

```
Read docs/gauntlet/GAUNTLET-CORE.md for the process this run follows.

What I want built/upgraded here: [DESCRIBE THE ACTUAL TASK]

Stage 0: audit this repo for real. Determine which of GAUNTLET-CORE.md's
Standing Bars actually apply here and the lane split for building this
in parallel — decide this yourself, don't wait for me to confirm it.
Write the result into docs/gauntlet/UPGRADE-SPEC.md and
docs/gauntlet/GAUNTLET.md. Only interrupt me if something is a genuine
Level 2 case per GAUNTLET-CORE.md; otherwise go straight into Stage 1.

Then run the rest of GAUNTLET-CORE.md's process autonomously: Foundation,
parallel lanes, Integration, then Report/Merge/Deploy/Verify per its
Production Safety section. Notify me on completion or rollback — don't
wait for approval to merge or deploy.

Work on a feature branch (or one per lane). Go.
```

That's the whole workflow. Paste it with the task filled in, and it runs
itself through to deploy — you only hear from it again if something
genuinely can't be resolved without you, or when it's done.

---
name: catchup
description: Start-of-session context rebuild. Use when resuming work in a repo after a gap, a /clear, or a machine switch — "where were we?" answered from recorded state (goal, session snapshot, decisions, recent commits) instead of assumptions.
---

# catchup — resume, don't re-assume

A fresh session that guesses the project's state re-burns every iteration the last one
already paid for. Everything essential is recorded; read it BEFORE acting.

## Do (in order, before any edit)
1. `.forge/state.md` — the last session's snapshot: goal/phase, done, next steps,
   gotchas, open assumptions. (The SessionStart hook injects a capped version; read the
   file for the rest.)
2. `forge decide` — the last ten recorded decisions. Do not contradict one silently;
   supersede it with a new `forge decide "<new choice> — <why the old one changed>"`.
3. `git log --oneline -10` and `git status --short` — what actually happened vs what
   the snapshot says. Trust code over prose, then fix the prose.
4. `forge anchor show` — the standing goal. If the new request conflicts with it,
   surface the conflict instead of quietly switching goals.
5. For in-progress files listed in the snapshot: read them AND their tests first.

## Then
State in one short block: current goal, what was last done, what you'll do next.
Only then start working.

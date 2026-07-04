---
description: Self-correction and learning-from-correction loop
globs: *
---

# Self-Correction Rules

- Close the loop yourself: after a change, run a check (tests/build/lint or a UI
  screenshot) and fix failures before handing back. Show the evidence.
- Fix root causes, not symptoms. Never suppress an error to make a check pass.
- Cap retries: after ~3 failed attempts on the same check, stop, summarize, and
  either restart with a sharper prompt or ask one specific question — don't keep
  patching (it pollutes context and degrades results).
- Learn from correction: if the user corrects the same point twice, or a fix
  relied on a non-obvious project gotcha, record it as a durable lesson (memory
  system, or a one-line rule in the repo's AGENTS.md/CLAUDE.md) so it isn't
  repeated next session. Keep lessons as rules, never store secrets.

---
name: self-improve
description: Self-correction and cross-session learning loop. Use when a check fails and needs iterating to green, when the user corrects the same thing more than once, or when a non-obvious fix/gotcha is worth remembering for next time.
---

# Self-improve

Honest scope: you can't reinforcement-learn a hosted model's weights in a config.
What works is **experiential learning** — correct within the session, persist
durable lessons for the next one. Two loops:

## Loop A — self-correct (within a session)
Close the loop yourself instead of waiting for the user to catch errors:
1. Run a check that returns pass/fail: tests, build, typecheck, lint, or a
   screenshot diff (UI).
2. On fail, read the actual error and diagnose the **root cause** — don't patch
   the symptom or suppress it. Record it: `forge diagnose "<error>" --file <f>`.
3. Fix, then re-run the same check. Show the evidence (command + result).
4. Cap it: `forge diagnose` counts recurrences — the 3rd identical failure
   signature mints a **diagnosis claim** in the team ledger and says STOP.
   Don't keep retrying: state the diagnosis (`forge ledger show <id>`), add what
   you tried, and escalate ONE model tier with the diagnosis at the head of the
   new prompt — never a bare "try again, but more expensive". Repeated failed
   patches pollute context and make it worse.
Use the `verifier` / `frontend-verifier` subagents for an independent check on
non-trivial diffs.

## Loop B — capture the lesson (across sessions)
When something was non-obvious — the user corrected you twice on the same point,
or a fix depended on a project gotcha — record it so it's not re-learned next time:
- Cortex captures recurring corrections on its own as you work; for explicit
  facts, `forge recall add "<name>" "<fact>"` (or a one-line entry in the repo's
  `AGENTS.md`).
- Keep it a rule, not a story: "In <project>, X fails unless Y — do Y first."
- Never store secrets/PII. Delete lessons that turn out wrong.
Lessons and facts land as claims in `.forge/ledger/` — confidence moves only when
independent oracles (tests, CI, human accept/revert) confirm or refute them, and
`forge ledger blame <id>` shows that history.

## What "self-evolving" honestly means here
Code knowledge stays current via the atlas (`forge atlas build`); behaviour
improves through Loop B, and the ledger demotes lessons that stop earning
confirmations. Anything promising weight-level RL from a local config is
overstating it — treat those claims with `tech-selector` skepticism.

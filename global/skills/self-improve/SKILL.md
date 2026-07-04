---
name: self-improve
description: Self-correction and cross-session learning loop. Use when a check fails and needs iterating to green, when the user corrects the same thing more than once, or when a non-obvious fix/gotcha is worth remembering for next time.
---

# Self-improve

Honest scope: you can't reinforcement-learn a hosted model's weights in a config.
What IS real and works here is **experiential (in-context) learning** — correct
within the session, and persist durable lessons so the next session starts better.
Two loops:

## Loop A — self-correct (within a session)
Close the loop yourself instead of waiting for the user to catch errors:
1. Run a check that returns pass/fail: tests, build, typecheck, lint, or a
   screenshot diff (UI). 
2. On fail, read the actual error and diagnose the **root cause** — don't patch
   the symptom or suppress it.
3. Fix, then re-run the same check. Show the evidence (command + result).
4. Cap it: after ~3 failed attempts on the same check, STOP looping. Summarize
   what you tried, and either `/clear` and restart with a sharper prompt or ask
   one specific question. Repeated failed patches pollute context and make it
   worse (Claude Code also force-stops a Stop-hook check after 8 blocks).
Use the `verifier` / `frontend-verifier` subagents for an independent check on
non-trivial diffs.

## Loop B — capture the lesson (across sessions)
When something was non-obvious — the user corrected you twice on the same point,
or a fix depended on a project gotcha — record it so it's not re-learned next time:
- Persist it with the installed memory stack (`remember` / episodic-memory) or, for
  project facts, a one-line entry in the repo's `AGENTS.md` / `CLAUDE.md`.
- Keep it a rule, not a story: "In <project>, X fails unless Y — do Y first."
- Never store secrets/PII. Delete lessons that turn out wrong.
On the next session, the memory system reloads these, so past mistakes don't repeat.

## What "self-evolving" honestly means here
- **Code knowledge** self-updates via Graphify's post-commit hook (`graphify hook
  install`) — the project graph stays current as you commit. That's a real,
  working self-evolving artifact.
- **Behaviour** improves through Loop B (captured lessons) + your `rules/` and
  `AGENTS.md`, which you refine when a correction recurs.
- Anything promising weight-level RL / self-training of Claude from a local config
  is overstating it — treat those claims with `tech-selector` skepticism.

## Note
An automated `continuous-learning` Stop hook is already installed but `skills/learned/`
is empty (it hasn't been producing lessons). This explicit skill is the reliable
path; the automated hook can be debugged separately if you want it too.

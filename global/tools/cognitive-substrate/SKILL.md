---
name: cognitive-substrate
description: >-
  Use before ambiguous, expensive, multi-file, or mutating coding work to run
  Forge's cognitive substrate: assumption gate, model routing, impact
  prediction, scope decomposition, memory/lesson lookup, minimality check, and
  verification planning. Trigger when a user asks to edit/refactor/fix/design
  production code, integrate features, choose model effort, inspect blast
  radius, or avoid agent assumptions.
---

# Cognitive Substrate

Wrap the frozen model in a pre-action check: gate assumptions, route model effort, predict
blast radius, decompose scope, surface past lessons, and plan verification — **before** editing.

## When to run it

Any ambiguous, expensive, multi-file, or mutating task. Skip one-line, well-specified fixes.
In Claude Code it fires automatically on every prompt (UserPromptSubmit hook); in other
agents run the CLI yourself, or call the MCP tool `substrate_check`.

## Run

```bash
forge substrate "<task>" --json     # full contract; use the fields below
```

## Act on the result

1. **`okToProceed: false`** → ask the returned `assumption.questions` before editing. Do not guess.
2. **`route.tier`** → start at that model tier (cheapest capable); escalate only after an external verifier fails.
3. **`impact.impactedFiles`** → read these before editing a named symbol/file (the blast radius).
4. **`scope.clusters`** → split independent groups into separate sessions; note coupled files you didn't name.
5. **`memory.advisory`** → context, not law; tests and human corrections override it.
6. **`verification.checklist`** → run it and show output before claiming done.

## Worked example

`forge substrate "make the auth better"` → `proceed: ASK FIRST` + clarify
questions: ask them instead of editing. A clear task returns `proceed: yes` plus
the impacted files — including importers you didn't name.

## Deeper single checks

`forge preflight "<task>"` (assumptions) · `forge route "<task>"` (model tier) ·
`forge impact <symbol|file>` (blast radius) · `forge scope <file…>` (decomposition) ·
`forge context "<task>"` (budgeted context assembly; *computes* what's missing) ·
`forge imagine "<task>" [--run]` (predicted breaks + minimal covering test suite;
`--run` dry-runs it in a sandboxed worktree) ·
`forge diagnose "<error>"` (doom-loop: 3× the same failure signature = stop retrying,
escalate one tier with the minted diagnosis claim at the head of the prompt).
MCP equivalents: `assumption_gate`, `route_task`, `predict_impact`, `scope_files`.

For the full guide (how it works, extending it, the honesty boundary) and the white paper,
see `docs/cognitive-substrate/README.md`. `references/capability-map.md` maps faculties to commands.

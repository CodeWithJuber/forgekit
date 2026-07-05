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

Trigger on any ambiguous, expensive, multi-file, or mutating task: edit/refactor/fix/design
production code, integrate a feature, choose model effort, inspect blast radius, or when a
request is vague. Skip it for one-line, well-specified fixes.

> In Claude Code this fires automatically on every prompt (UserPromptSubmit hook). In other
> agents, run it yourself with the CLI, or call the MCP tool `substrate_check`.

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

```console
$ forge substrate "make the auth better"
  proceed: ASK FIRST
  assumption: high risk · completeness 0.23
  clarify:
    - What exactly should this produce, and how will we know it is correct?
```

→ Under-specified. Ask the clarify question instead of editing.

```console
$ forge substrate "Change verifyToken in src/auth.js to require length > 20; update tests"
  proceed: yes
  impact: 3 file(s) predicted
    - src/auth.js
    - src/login.js      (importer you did not name)
    - src/session.js    (importer you did not name)
```

→ Cleared to proceed, but review the two coupled importers first.

## Single-mechanism commands

`forge preflight "<task>"` (assumptions) · `forge route "<task>"` (model tier) ·
`forge impact <symbol|file>` (blast radius) · `forge scope <file…>` (decomposition).
MCP equivalents: `assumption_gate`, `route_task`, `predict_impact`, `scope_files`.

For the full guide (how it works, extending it, the honesty boundary) and the white paper,
see `docs/cognitive-substrate/README.md`. `references/capability-map.md` maps faculties to commands.

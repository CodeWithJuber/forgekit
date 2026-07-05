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

Before acting on non-trivial or mutating code tasks, run:

```bash
forge substrate "<task>" --json
```

Use the result this way:

1. If `okToProceed` is false, ask the returned `assumption.questions` before editing.
2. Use `route.model` as the cheapest capable tier recommendation; do not escalate without a verifier failure.
3. Read `impact.impactedFiles` before editing a named symbol/file.
4. Use `scope.clusters` to split independent work into separate sessions.
5. Treat `memory.advisory` as context, not law; tests and human corrections override it.
6. Run the `verification.checklist` before claiming completion.

For details, read `references/capability-map.md` only when you need to explain how the paper's faculties map to Forge commands.

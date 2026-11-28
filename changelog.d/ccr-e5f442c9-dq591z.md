### Added

- **Jev agent memory, `forge memory`.** Each memory layer now has a decision, asked of Jev
  (TypeSafe System One) with a probability and reconciled with the rule already there:
  - **working**: which memory enters the context window (`forge context`, `substrate_check`);
  - **episodic**: which prior session the déjà-vu advisory replays;
  - **semantic**: whether a fact is durable, a duplicate or a contradiction, checked before
    `forge remember`, `forge know` and `forge_remember` store it (`--force` overrides);
  - **procedural**: which repeated, test-confirmed work becomes a skill under
    `.claude/skills/forge-learned-*`, gated by the held-out promotion rule and Jev, at most one
    per session and eight in all;
  - **forgetting**: what the Stop-hook prune archives.

  Each layer makes one batched call. A change to stored memory needs p ≥ 0.8, stays
  reversible, and is journaled in `.forge/jev-memory.jsonl`. Jev never raises a claim's
  validity.

  Jev is off by default: it needs `TYPESAFE_API_KEY` plus the decisions opt-in. Without it, or
  on a failed call, every layer behaves exactly as before.

  `forge memory` reports the layers, measured latency and overrides, and gives dry runs per
  layer (`admit`, `replay`, `verify`, `skills`, `forget`). New: the `FORGE_JEV_MEMORY` layer
  switch and the `forge_memory_decide` MCP tool.
- `pruneLedger` accepts an optional `judge` that may re-decide the retention plan.
  `context.assemble` accepts `measure` and reports full vs admitted memory tokens.

### Fixed

- With Jev's working layer on, the context assembler no longer packs the shortest facts
  regardless of topic. In a measured run the rule alone packed 3 off-topic facts; Jev packed
  10 on-topic items and 92% fewer memory tokens than packing every memory.

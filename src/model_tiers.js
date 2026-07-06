// forge model tiers — the routing target table. Cheapest capable model per complexity tier.
// Costs are per-million tokens (input/output) in PRICING_CURRENCY. The premise: a prime-number
// finder does not need Fable 5. Size the model to the task.

/** Currency for every inCost/outCost below. */
export const PRICING_CURRENCY = "USD";
/** Date the prices were last checked. `forge doctor` warns when this goes stale (re-verify via dev-radar). */
export const PRICING_VERIFIED = "2026-07-05";

export const MODELS = {
  haiku: {
    id: "claude-haiku-4-5-20251001",
    name: "Haiku 4.5",
    tier: "simple",
    inCost: 1,
    outCost: 5,
    use: "lint, formatting, docs, stubs, trivial well-defined edits",
  },
  sonnet: {
    id: "claude-sonnet-5",
    name: "Sonnet 5",
    tier: "medium",
    inCost: 3,
    outCost: 15,
    use: "refactoring, feature work, tests, code review (the default)",
  },
  opus: {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    tier: "complex",
    inCost: 5,
    outCost: 25,
    use: "architecture, cross-module refactor, novel algorithms, multi-layer debugging",
  },
  fable: {
    id: "claude-fable-5",
    name: "Fable 5",
    tier: "extreme",
    inCost: 10,
    outCost: 50,
    use: "only the hardest research-grade reasoning — rarely worth it",
  },
};

/** Cheap → expensive. */
export const TIER_ORDER = ["haiku", "sonnet", "opus", "fable"];

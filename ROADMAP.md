# Roadmap

Direction, not promises — shaped by the two field reports this project is grounded in
(the SDLC pain-point map and the ecosystem landscape). Open a Discussion to weigh in.

## Now (`master`, v0.5.0)
Cross-tool config for nine agents (Claude Code, Codex, Cursor, Gemini, Aider, Copilot,
Windsurf, Zed, Continue) plus MCP config for Roo & VS Code, verification layer
(`forge verify`), security gate (`forge scan`), portable memory (`forge brain`), cost
governor (`forge cost`, `--stages` for measured factors), spec-as-contract drift
(`forge spec`), goal-drift check (`forge anchor`), the cognitive-substrate pre-action
gate (`forge substrate`, `forge impact`) — **plus the whole Substrate v2 surface**:
`forge ledger` (proof-carrying team memory), `forge reuse` (verified-code cache),
`forge context` (budgeted assembly + completeness gate), `forge diagnose` (doom-loop),
`forge imagine [--run]` (consequence simulation + sandboxed dry-run), `forge uicheck`
v2 (fingerprints + design gate), and `forge dash`. The full paper and evidence bundle
live in [docs/cognitive-substrate/](./docs/cognitive-substrate/). See
[CHANGELOG.md](./CHANGELOG.md).

## Shipped — Substrate v2 (all phases P0–P8, v0.5.0)
The plan lives in [docs/plans/substrate-v2/](./docs/plans/substrate-v2/00-overview.md)
(phase dependency graph + acceptance gates, all marked done): every paper faculty and
mechanism mapped to an algorithm, unified by the **Proof-Carrying Memory (PCM)
protocol** (ADR-0006) — every stored thing is a claim that carries its evidence, earns
confidence only from independent oracles, and merges across teammates conflict-free
(git-native CRDT ledger).

## Next
- **Legacy store retirement** — the read-path flip has shipped: every read surface
  (cortex injection/status, the substrate advisory, routing, `recall list`, brain's
  AGENTS.md index) is now a merged view (legacy ∪ ledger) via `src/ledger_read.js`,
  so teammate knowledge from `forge ledger merge` reaches injection. The legacy
  formats (`lessons/*.md`, recall/brain fact files) are still written as the canonical
  local state; the remaining step is retiring them so the ledger is the only store.
- **Embeddings tier** — optional vector backend (ADR-0005 dependency tier, stdlib
  fallback kept) for Eq. 3 retrieval and `forge reuse` near-match, where MinHash is
  weak on short specs.
- **Playwright loop** — shipped as `forge uicheck visual` (rendered computed-style
  fingerprint through the design gate + 2-viewport screenshots, optional-tier
  playwright); still open: interaction checks and feeding verdicts back as oracle
  evidence on design claims.
- **Advisory → gated promotions** — outcome-calibrated routing weights, consolidation
  promotion (ʿilm→fahm), M6 hazard estimates: advisory today, become blocking only
  once fixtures measure them (overview §4 honesty register).

## Later / exploring
- `forge verify` independent-review wired into CI with provenance gating.
- Formal/semantic verification — documented as out-of-scope for now.
- Parametric learning channel (LoRA distillation) — deliberately out of scope (ADR-0006).

## Non-goals
Unbounded dependency growth — deps are selective, optional, and always backed by a
stdlib fallback path (ADR-0005). Reimplementing mature tools (skills installer,
subagent orchestration, SDD framework, SAST) — we wire the best existing ones. Bundling
a whole IDE. A hosted memory server — git *is* the sync (see 02-team-memory.md).

# Roadmap

Direction, not promises — shaped by the two field reports this project is grounded in
(the SDLC pain-point map and the ecosystem landscape). Open a Discussion to weigh in.

## Now (`master`)
Cross-tool config for nine agents (Claude Code, Codex, Cursor, Gemini, Aider, Copilot,
Windsurf, Zed, Continue) plus MCP config for Roo & VS Code, verification layer
(`forge verify`), security gate (`forge scan`), portable memory (`forge brain`), cost
governor (`forge cost`), spec-as-contract drift (`forge spec`), goal-drift check
(`forge anchor`), and the cognitive-substrate pre-action gate (`forge substrate`,
`forge impact`). The full paper and evidence bundle live in
[docs/cognitive-substrate/](./docs/cognitive-substrate/). See
[CHANGELOG.md](./CHANGELOG.md) `[Unreleased]`.

## Next — Substrate v2 (the whitepaper, completed)
The full plan lives in [docs/plans/substrate-v2/](./docs/plans/substrate-v2/00-overview.md):
every paper faculty and mechanism mapped to an algorithm, unified by the
**Proof-Carrying Memory (PCM) protocol** (ADR-0006) — every stored thing is a claim that
carries its evidence, earns confidence only from independent oracles, and merges across
teammates conflict-free (git-native CRDT ledger).

Phases (dependency-ordered; acceptance gates in the overview):
- **P1 Ledger core** — claim store, Beta-posterior confidence, Eq. 3 retrieval;
  cortex + recall migrate onto claim kinds.
- **P2 Team memory** — `.forge/ledger/` union-merge over git; `forge ledger`.
- **P3 Reuse cache** — proof-carrying artifact cache (`forge reuse`): verified code is
  served with its evidence, revalidated against the atlas, demoted by outcomes.
- **P4 Context assembly** — knapsack selection under a token budget + a set-cover
  completeness gate that *computes* what's missing (`forge context`).
- **P5 Loop closure** — outcome write-back band; doom-loop diagnosis + escalation;
  imagination dry-run (impacted-test set cover + worktree sandbox); AST-tier atlas with
  a mandatory impact gate; M3 partition planning, M4 CUSUM drift, M5 footprint metric,
  M6 checkpoint cadence; outcome-calibrated routing.
- **P6 UI quality gate** — design fingerprints, slop-distance + project-conformance
  scoring, scale/palette conformance checks (`forge uicheck` v2, machine-readable taste).
- **P7 `forge dash`** — local dashboard over the ledger, cost stages, cache, blast radius.
- **P8 Evaluation** — measured per-stage cost report (target ~90 % composed; only
  measured numbers get claimed — see [05-cost-model.md](./docs/plans/substrate-v2/05-cost-model.md)).

Carried forward from the previous roadmap into these phases: calibration fixtures (P8),
AST-backed impact (P5), Playwright testing (P6), MCP hygiene in `forge doctor` (P7).

## Later / exploring
- Optional embedding/vector backends for retrieval and cache near-match (ADR-0005 tier).
- `forge verify` independent-review wired into CI with provenance gating.
- Formal/semantic verification — documented as out-of-scope for now.
- Parametric learning channel (LoRA distillation) — deliberately out of scope (ADR-0006).

## Non-goals
Unbounded dependency growth — deps are selective, optional, and always backed by a
stdlib fallback path (ADR-0005). Reimplementing mature tools (skills installer,
subagent orchestration, SDD framework, SAST) — we wire the best existing ones. Bundling
a whole IDE. A hosted memory server — git *is* the sync (see 02-team-memory.md).

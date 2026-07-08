# Roadmap

Direction, not promises — shaped by the two field reports this project is grounded in
(the SDLC pain-point map and the ecosystem landscape). Open a Discussion to weigh in.

## Now (`master`, v0.6.0)
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

## Shipped — 0.6.0
- **Embeddings tier** — optional vector backend (`src/embed.js`, ADR-0005 dependency
  tier, stdlib fallback kept): `FORGE_EMBED=cmd:<command>` or
  `FORGE_EMBED=http:<url>` (OpenAI-compatible), disk-cached at
  `.forge/embed-cache.jsonl`; `forge reuse query` and `forge ledger query` replace the
  MinHash `rel` term with embedding cosine and print which backend served
  (`sim: minhash` / `sim: embed(cmd)`), degrading silently to MinHash on failure.
- **Public site redesign** — the landing page (`landing/index.html`) and generated
  status page (`scripts/build-pages.mjs` → `public/index.html`) are rebuilt on one
  8-color/4px design system and gated by `forge uicheck design` and the rendered
  `forge uicheck visual` gate; `.github/workflows/static.yml` builds and deploys an
  assembled `_site/` to GitHub Pages — landing at the site root, status page at
  `/status/`.

## Next
- **Legacy store retirement** — the read-path flip has shipped: every read surface
  (cortex injection/status, the substrate advisory, routing, `recall list`, brain's
  AGENTS.md index) is now a merged view (legacy ∪ ledger) via `src/ledger_read.js`,
  so teammate knowledge from `forge ledger merge` reaches injection. The legacy
  formats (`lessons/*.md`, recall/brain fact files) are still written as the canonical
  local state; the remaining step is retiring them so the ledger is the only store.
- **Playwright loop** — still open: interaction checks and feeding verdicts back as
  oracle evidence on design claims (fingerprinting itself shipped as
  `forge uicheck visual`).
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

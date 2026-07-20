# Roadmap

forgekit is one brain for every AI coding agent — the cognitive substrate (memory, foresight,
guardrails) that a stateless model is missing, authored once and delivered as native config to
every tool. This is where that brain is headed.

Direction, not promises — shaped by the two field reports this project is grounded in
(the SDLC pain-point map and the ecosystem landscape). Open a Discussion to weigh in.

## Now (`master`, v0.26.2)

The substrate is fully graded — decision math replaces every keyword heuristic: exemplar k-NN
routing, entropy secret detection, noisy-OR goal-drift over paths **and** the identifiers a file
defines, and a logistic specification-completeness gate. Around it: docs↔code drift gating
(`forge docs check`, in CI) that now also reconciles diagrams, model prices, benchmark numbers,
intra-repo links, and roadmap freshness; a completion gate (Stop hook); and auto-release on merge.
Gateway environments are supported end to end — `ANTHROPIC_AUTH_TOKEN` recognized everywhere,
`ANTHROPIC_MODEL`/`FORGE_MODEL` model override, LiteLLM-gateway auto-classification of
`ANTHROPIC_BASE_URL`, and direct-HTTP LLM calls when the `claude` CLI is absent (`src/llm.js`).
See [CHANGELOG.md](./CHANGELOG.md).

## Shipped — Substrate v2 (all phases P0–P8, v0.5.0)

The plan lives in [docs/plans/substrate-v2/](./docs/plans/substrate-v2/00-overview.md)
(phase dependency graph + acceptance gates, all marked done): every paper faculty and
mechanism mapped to an algorithm, unified by the **Proof-Carrying Memory (PCM)
protocol** (ADR-0006) — every stored thing is a claim that carries its evidence, earns
confidence only from independent oracles, and merges across teammates conflict-free
(git-native CRDT ledger).

## Shipped — 0.7.0

- **Zero-config provider auto-detection** — `autoDetectProvider()` probes env vars
  for LiteLLM (local + hosted gateway), OpenRouter, and Anthropic (key, auth token,
  or custom base URL); `forge init` reports what it found, no manual config needed.
  (OpenAI and Gemini detection shipped later as a low-configuration auto-detect fallback — see CHANGELOG.)
- **Hosted LiteLLM gateway** — `emitGatewayConfig()` writes a `litellm.config.yaml`
  exposing the complexity tiers as model aliases; point `ANTHROPIC_BASE_URL` at the
  proxy and every model call routes through it.
- **MCP server** — the cortex MCP server (`src/cortex_mcp.js`) exposes read-path
  tools for ledger, brain, atlas, recall, cost, substrate, and dashboard (19 MCP tools
  as of 0.8.x, including the write tools added in 0.8.0).
- **Cost dashboard** — `forge dash` serves a local HTML dashboard showing model spend,
  event timeline, and ledger health from `.forge/` data.

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
- **OpenAI + Gemini provider detection** — extend `autoDetectProvider()` beyond
  Anthropic/OpenRouter/LiteLLM (`OPENAI_API_KEY`, `GEMINI_API_KEY`) with the same
  guided, low-configuration auto-detect contract.
- **Playwright loop** — still open: interaction checks and feeding verdicts back as
  oracle evidence on design claims (fingerprinting itself shipped as
  `forge uicheck visual`).
- **Advisory → gated promotions** — the measured-promotion gate has shipped
  (`src/promote.js`, generalizing the risk predictor's kill-criteria): a candidate only
  replaces a baseline when it beats it on held-out data, never by assertion. First
  application: outcome-calibrated routing (`forge route calibrate`). Remaining
  applications of the same gate: consolidation promotion (ʿilm→fahm) and M6 hazard
  estimates.

## Later / exploring

- `forge verify` independent-review wired into CI with provenance gating.
- Formal/semantic verification — documented as out-of-scope for now.
- Parametric learning channel (LoRA distillation) — deliberately out of scope (ADR-0006).

## Non-goals

Unbounded dependency growth — deps are selective, optional, and always backed by a
stdlib fallback path (ADR-0005). Reimplementing mature tools (skills installer,
subagent orchestration, SDD framework, SAST) — we wire the best existing ones. Bundling
a whole IDE. A hosted memory server — git _is_ the sync (see 02-team-memory.md).

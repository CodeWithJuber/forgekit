# Cognitive Substrate Paper Bundle

This directory is the research-backed product map for Forge's cognitive-substrate system.
It keeps the full paper, evidence maps, and original prototype packages next to the
production Node implementation so users can install once and use the system from any
Forge-supported agent.

## Fastest Path

```bash
# one time, from this repo
bash install.sh

# one time, inside any project
forge init

# every day, before ambiguous or mutating work
forge substrate "Fix the checkout bug and add tests"
forge substrate "Refactor auth safely" --json
forge impact computeTax
```

For MCP-capable tools, call the same flow through:

- `substrate_check` — full pre-action gate.
- `assumption_gate` — ask/proceed decision and clarifying questions.
- `predict_impact` — blast-radius prediction for a symbol or file.

## Install Choices

| Path | Best For | Steps |
| --- | --- | --- |
| Claude/Codex plugin | Extension-style install | Install the plugin, then run `forge init` in each repo. |
| Git clone | Lowest friction local setup | `bash install.sh`, then `forge init`. |
| npm package | CI/devcontainer usage | `npx @codewithjuber/forgekit init`. |

After `forge init`, Forge emits native config for Claude Code, Codex, Cursor, Gemini,
Aider, Copilot/VS Code, Windsurf/Devin, Zed, Continue, and Roo where supported. Tools
without hooks receive advisory context plus MCP config; Forge does not pretend it can
force hooks into hosts that do not expose them.

## Included Artifacts

- [`cognitive_substrate_whitepaper.pdf`](./cognitive_substrate_whitepaper.pdf) — full paper.
- [`cognitive_substrate_whitepaper.html`](./cognitive_substrate_whitepaper.html) — browser-readable paper.
- [`deliverable-package.md`](./deliverable-package.md) — package overview and headline results.
- [`evidence_map.md`](./evidence_map.md) — source/status map for load-bearing evidence.
- [`ecosystem_map.md`](./ecosystem_map.md) — capability-vs-tooling map.
- [`impact_oracle_src.zip`](./impact_oracle_src.zip) — original Prototype I package.
- [`router_gate_src.zip`](./router_gate_src.zip) — original Prototype II package.
- [`../../research/python-prototypes/`](../../research/python-prototypes/) — unzipped prototype source preserved for auditability.

## Paper-To-Forge Map

| Paper capability | Production Forge surface | Status |
| --- | --- | --- |
| Memory | `forge recall`, `forge cortex` | File-backed and auditable; relevance is advisory. |
| Learning | `forge cortex` | Outcome-confirmed lessons; model weights do not change. |
| Imagination | `forge impact`, `forge substrate` | Static graph blast-radius simulation. |
| Self-correction | `forge verify`, doom-loop guard | External checks beat model claims. |
| Impact-awareness | `forge atlas`, `forge impact` | Known symbols/files and likely dependents surfaced. |
| M1 routing | `forge route`, `forge substrate` | Transparent cheapest-capable tier recommendation. |
| M2 assumption gate | `forge preflight`, `forge substrate` | Under-specified tasks return questions. |
| M3 decomposition | `forge scope`, `forge substrate` | Independent/coupled file clusters. |
| M4 goal anchoring | `forge substrate` | One pre-action objective/risk/verification summary. |
| M5 anti-over-engineering | `forge substrate`, `lean-guard` | Broad work gets minimality warnings. |
| M6 inline verification | `forge verify` | Checklist and external verification discipline. |

## Honest Boundary

Deterministic parts are asserted: repo symbol/file grounding, graph traversal, emitted
config, protected-file guards, and test/build commands. Research-edge judgments remain
advisory: memory relevance, model fit, scope minimality, and whether a verification
checklist is sufficient for a particular production environment.

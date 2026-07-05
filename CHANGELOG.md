# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-07-05

### Changed

- **Publish to GitHub Packages** instead of npmjs. Package renamed to the scoped
  `@codewithjuber/forgekit`; `publishConfig.registry` → `https://npm.pkg.github.com`. The
  release workflow now authenticates with the built-in `GITHUB_TOKEN` (`packages: write`) — no
  external `NPM_TOKEN` secret. A committed `.npmrc` maps the scope to the registry and sets
  `min-release-age=7` (supply-chain cooldown). Note: GitHub Packages requires consumers to
  authenticate even for public installs, so the `bash install.sh` clone path stays the
  friction-free primary channel.

## [0.3.0] - 2026-07-05

### Added

- **Forge Preflight** — a deterministic, math-first layer that runs BEFORE tokens are spent,
  on the premise that an LLM is a fixed-capacity stochastic predictor: size the task to the
  model, fill the context, detect assumptions. All advisory, never blocks.
  - **Assumption detector** (`forge preflight`, UserPromptSubmit hook): scans a task for code
    identifiers/files the repo doesn't define — what the model would otherwise ASSUME — and
    surfaces the known-unknowns so it asks instead of confabulating. The research whitespace.
  - **Complexity routing** (`forge route`): recommends the cheapest CAPABLE model
    (Haiku → Sonnet → Opus → Fable) from code-task signals (files, fan-out, churn, past-mistake
    density, ambiguity). `forge route gateway` emits a LiteLLM config for real auto-routing.
  - **Decomposition** (`forge scope`): a zero-dep import graph → connected components →
    independent clusters (run as separate sessions) + the coupled files you didn't name.
  - **Design-quality**: emitted AI-UX rules (anti-slop, WCAG, functional empty states, specific
    errors, confidence/transparency, pattern selection) + `forge uicheck` (exact WCAG contrast
    math) + a calibrated frontend-verifier that ASSERTS only the deterministic and keeps
    hierarchy/taste ADVISORY (the fix for hallucinated UI audits).
  - Cross-tool via `preflight_check` / `route_task` / `scope_files` MCP tools.

## [0.2.0] - 2026-07-05

### Added

- **Forge Cortex** — self-correcting project memory. Detects a genuine recurring mistake
  on this repo (test-fail→fix, revert, symbol thrash, explicit human undo), distills a
  structured lesson, and re-confirms it against independent outcomes — with an
  anti-self-reinforcement lifecycle (`Beta` confidence + decay; injection never confirms;
  a green build always wins) so a wrong lesson decays out instead of ossifying.
  `forge cortex`, `forge cortex why <symbol>`.
- Ambient hooks (fail-safe, never block): capture signals during a session, distill at
  `Stop`, inject learned lessons at `SessionStart`, and a `PreToolUse` advisory before a
  risky edit.
- Local error predictor (heuristic + a tiny logistic model) gated by an AUC-PR kill-switch
  — it only ships if it measurably beats the heuristic; otherwise it falls back or disables.
- Cross-tool: lessons inlined into `AGENTS.md` + a zero-dependency MCP server
  (`forge cortex-mcp`, registered in `source/mcp.json`).
- Optional LLM lesson distiller (`ENABLE_CORTEX_DISTILL=1`) — replaces the deterministic
  template with a real distilled lesson via `claude -p`.
- `forge doctor` reports Cortex lesson state; `forge catalog` lists Cortex.

## [0.1.0] - 2026-07-05

### Added

- Cross-tool config emitter (`forge sync`) — one source → each tool's native format; three
  install channels (Claude plugin + marketplace, installer, npm); `forge doctor`; code-graph
  (`atlas`); `lean` discipline; guard/skill/crew layers.
- Verification layer: `forge verify` (tests + hallucinated-symbol catch + provenance),
  doom-loop breaker guard, bias-safe `independent-reviewer` agent.
- Security gate: `forge scan` (skill-gate), `secret-redact` guard, structured
  `permissionDecision` in `protect-paths`, `forge harden` (gitleaks + sandbox).
- Cross-tool MCP emit; portable memory (`forge brain` / `forge remember`); design-taste
  menu (`forge taste`); `forge spec` spec-lock + OpenSpec wiring; MCP ~6-server hygiene
  check; coverage + type-checking (`tsc --checkJs`); 2026 production-standard rules;
  OWASP-LLM / NIST SSDF / SLSA control mapping.

[Unreleased]: https://github.com/CodeWithJuber/forgekit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CodeWithJuber/forgekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CodeWithJuber/forgekit/releases/tag/v0.1.0

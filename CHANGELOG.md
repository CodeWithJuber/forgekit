# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Verification layer: `forge verify` (tests + hallucinated-symbol catch + provenance),
  doom-loop breaker guard, and a bias-safe `independent-reviewer` agent.
- Security gate: `forge scan` (skill-gate), `secret-redact` guard, structured
  `permissionDecision` in `protect-paths`, and `forge harden` (gitleaks + sandbox).
- Cross-tool MCP emit: one `source/mcp.json` → each tool's real config format
  (mcpServers JSON, Zed `context_servers`, VS Code `servers`, Codex TOML, Continue YAML)
  plus a Continue rules emitter.
- Portable memory: `forge brain` / `forge remember`, inlined (capped) into AGENTS.md
  so every tool shares it.
- Design-taste menu (`forge taste`) with five directions.
- `forge spec` — spec-as-contract drift detection (spec-lock) + OpenSpec wiring.
- `forge doctor` MCP ~6-server hygiene check; `npm run coverage`; type-checking (`tsc --checkJs`).
- 2026 production-standard rules emitted via `forge sync`; OWASP-LLM / NIST SSDF / SLSA control mapping.

## [0.1.0] - 2026-07-05

### Added
- First release: cross-tool config emitter (`forge sync`), three install channels
  (Claude plugin + marketplace, installer, npm), `forge doctor`, code-graph (`atlas`),
  `lean` discipline, and the guard/skill/crew layers.

[Unreleased]: https://github.com/CodeWithJuber/forgekit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CodeWithJuber/forgekit/releases/tag/v0.1.0

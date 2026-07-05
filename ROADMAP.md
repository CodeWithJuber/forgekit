# Roadmap

Direction, not promises — shaped by the two field reports this project is grounded in
(the SDLC pain-point map and the ecosystem landscape). Open a Discussion to weigh in.

## Now (in `main`)
Cross-tool config + MCP emit (8 tools), verification layer (`forge verify`), security gate
(`forge scan`), portable memory (`forge brain`), cost governor (`forge cost`), and the
cognitive-substrate pre-action gate (`forge substrate`, `forge impact`). The full paper
and evidence bundle live in [docs/cognitive-substrate/](./docs/cognitive-substrate/).
See [CHANGELOG.md](./CHANGELOG.md) `[Unreleased]`.

## Next
- **Substrate calibration fixtures** — expand assumption/routing/impact fixtures beyond
  the original paper prototypes while keeping research-edge claims advisory.
- **spec-lock** — spec-as-contract drift detection, reusing the `atlas` index.
- **Testing** — Playwright MCP/agents opt-in + a coverage Stop-hook gate.
- **MCP hygiene** — enforce the ~6-server cap + a registry resolver in `forge doctor`.
- **VS Code / Windsurf MCP** — `.vscode/mcp.json` (`servers`) and Windsurf's global config.

## Later / exploring
- Optional vector-memory backend (Hindsight / Mem0) wiring.
- `forge verify` independent-review wired into CI with provenance gating.
- Formal/semantic verification — documented as out-of-scope for now.

## Non-goals
Adding runtime dependencies. Reimplementing mature tools (skills installer, memory engine,
SDD framework, SAST) — we wire the best existing ones. Bundling a whole IDE.

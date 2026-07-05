# ADR 0002: Adopt the SKILL.md open standard; don't invent a format

- Status: accepted
- Date: 2026-07-05

## Context
~40 tools (Claude Code, Codex, Cursor, Gemini, …) adopted the agentskills.io `SKILL.md`
standard. A Forge-proprietary skill format would break cross-tool portability — the opposite
of the project's goal.

## Decision
All Forge skills are spec-compliant `SKILL.md`. We wire `npx skills` as the install transport
rather than building our own, and emit rules to each tool's native file from one `AGENTS.md`
source.

## Consequences
- (+) A Forge skill runs unchanged on every SKILL.md-adopting tool.
- (−) We depend on an external standard's evolution; mitigated by it being community-governed.

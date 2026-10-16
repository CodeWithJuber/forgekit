# Stack notes

Starting candidates for a new stack choice, not gospel. They name tools, not versions:
versions go stale within weeks. Before adopting any of them, confirm the current release
and that it still fits with `tech-selector` / `dev-radar`, and cite the version and the
date you checked.

- **Next.js** (App Router): check the current stable line and any preview line on the
  registry (`npm view next dist-tags`) before choosing or upgrading.
- **UI**: shadcn/ui is the default React UI layer (copy-paste, you own the files —
  which is why AI tools generate it accurately). Radix primitives by default;
  **Base UI** is an opt-in alternative. Pull components via the shadcn MCP.
- **Vector DB**: pgvector (HNSW indexes, `halfvec` for smaller vectors); add
  **pgvectorscale** (StreamingDiskANN) only past ~1M vectors — else tune pgvector.
- **Testing**: Vitest (unit) + Playwright (e2e) for JS/TS; pytest for Python.
- **Python**: `uv` (env/deps) + `ruff` (lint+format) + `pydantic`.
- **AI coding**: multi-tool stacks are normal (Claude Code + Cursor/Codex). Keep
  shared rules in AGENTS.md; keep CLAUDE.md thin.

Update this file when a `/dev-radar` run changes a recommendation.

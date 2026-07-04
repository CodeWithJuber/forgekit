---
description: Verified current-stack baseline (dated). Candidates, not gospel — re-verify before adopting.
globs: *
---

# Stack Notes — verified 2026-07-04

Snapshot from a `dev-radar` run. These are CURRENT-as-of the date above; they go
stale. Before acting on any of them, confirm with `tech-selector` / `dev-radar`
and cite the version + date. Do not treat as permanent truth.

- **Next.js**: stable line 16.2.x (16.2.7); 16.3 in preview (much faster dev
  server; auto-writes an AGENTS.md pointer). Upgrade path for the Next projects.
- **UI**: shadcn/ui is the default React UI layer (copy-paste, you own the files —
  which is why AI tools generate it accurately). Radix primitives by default;
  **Base UI** is an opt-in alternative. Pull components via the shadcn MCP.
- **Vector DB**: pgvector 0.8 (faster HNSW builds, use `halfvec`); add
  **pgvectorscale** (StreamingDiskANN) only past ~1M vectors — else tune pgvector.
- **Testing**: Vitest (unit) + Playwright (e2e) for JS/TS; pytest for Python.
- **Python**: `uv` (env/deps) + `ruff` (lint+format) + `pydantic`.
- **AI coding**: multi-tool stacks are normal (Claude Code + Cursor/Codex). Keep
  shared rules in AGENTS.md; keep CLAUDE.md thin.

Refresh this file by re-running `/dev-radar` and updating the date.

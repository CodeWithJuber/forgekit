// OpenClaw reads the EXECUTION FOLDER's `AGENTS.md` natively: when a session runs from a
// repo (or a managed worktree), that folder's AGENTS.md is appended after the configured
// agent-workspace files as project context (OpenClaw docs, concepts/system-prompt.md). So the
// canonical source reaches OpenClaw with no second instruction file — same deal as Codex,
// Cursor and Copilot. Only `AGENTS.md` travels: OpenClaw deliberately does NOT load
// `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` or `BOOTSTRAP.md` from the execution
// folder, so anything Forge wants OpenClaw to see must be inside the canonical body.
//
// Two things this emitter must NOT claim:
//   - Ambient hooks. OpenClaw has its own hook system; Forge installs nothing into it. The
//     substrate reaches OpenClaw through AGENTS.md text and the MCP tools, nothing more.
//   - Live MCP. OpenClaw's server registry is `mcp.servers` in the USER's global
//     `~/.openclaw/openclaw.json`. Forge never writes there; the MCP emitter writes an
//     OpenClaw-shaped fragment to `.openclaw/mcp.json` and reports the one command that
//     registers it (see emit/mcp.js, OPENCLAW_TARGET).
//
// Legacy `AGENT.md` (singular) is not part of OpenClaw's project-context path, so unlike Zed
// there is no precedence list to police — the only real failure mode is a stale AGENTS.md,
// which the shared marker/hash already covers.
import { OPENCLAW_TARGET } from "./mcp.js";

export default {
  tool: "OpenClaw",
  emit(_ctx) {
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: `execution-folder AGENTS.md is project context (MCP: ${OPENCLAW_TARGET}, applied manually)`,
    };
  },
};

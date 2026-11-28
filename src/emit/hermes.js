// Hermes Agent (Nous Research) loads ONE kind of project context per session, the first one it
// finds: `.hermes.md` / `HERMES.md` (nearest, walking up to the git root), else the AGENTS.md
// chain from the git root down to the working directory (per directory `AGENTS.override.md`,
// then `AGENTS.md`, then `agents.md`), else `CLAUDE.md` in the working directory, else
// `.cursorrules` (agent/prompt_builder.py, build_context_files_prompt; docs
// user-guide/features/context-files). So the shared root AGENTS.md reaches Hermes natively and
// outranks the thin CLAUDE.md written for Claude Code, while a `.hermes.md`, `HERMES.md` or
// root `AGENTS.override.md` would hide it: this emitter warns while one exists.
//
// Two things this emitter must NOT claim:
//   - Project MCP. Hermes reads MCP servers only from `mcp_servers` in the profile's
//     `config.yaml` (`~/.hermes/`, or HERMES_HOME); no project file is consulted, and Forge never
//     writes a person's profile. The row names the one `hermes mcp add` command instead.
//   - Hooks. Hermes's shell hooks live in that profile `config.yaml` (`hooks:`), its gateway
//     hooks under the profile's `hooks/`, and project-local plugins are not loaded. A repository
//     has nothing to carry.
//
// `SOUL.md` is read from HERMES_HOME only, never from the project, so nothing is written for it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../brand.js";
import { readJsonSafe } from "../util.js";
import { hermesEnableHint } from "./mcp.js";

/** Root files Hermes prefers to AGENTS.md (it loads only the first context kind it finds). */
export const HERMES_SHADOWS = [".hermes.md", "HERMES.md", "AGENTS.override.md"];

/** The MCP step as one clause: the registry's servers, registered in the Hermes profile. */
function mcpNote() {
  const servers = readJsonSafe(join(BRAND.root, "source", "mcp.json"));
  const hint =
    servers && typeof servers === "object" && !Array.isArray(servers)
      ? hermesEnableHint(servers)
      : "";
  return `MCP is profile-level, applied manually${hint ? `: ${hint}` : ""}`;
}

export default {
  tool: "Hermes Agent",
  emit(ctx) {
    const shadow = HERMES_SHADOWS.filter((f) => existsSync(join(ctx.targetRoot, f)));
    if (shadow.length)
      return {
        tool: this.tool,
        target: "AGENTS.md",
        action: "warn",
        note: `shadowed by ${shadow.join(", ")} (Hermes loads only the first context file it finds)`,
      };
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: `reads the AGENTS.md chain from the git root (${mcpNote()})`,
    };
  },
};

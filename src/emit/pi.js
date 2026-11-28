// Pi (the pi coding agent, earendil-works/pi, formerly badlogic/pi-mono) reads context files
// from its agent directory, the working directory and every parent directory. Per directory
// it loads the FIRST of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
// `CLAUDE.MD` (packages/coding-agent/src/core/resource-loader.ts, loadContextFileFromDir;
// docs/configuration.md "Context files"). So the shared root AGENTS.md reaches Pi with no
// second instruction file, and the thin CLAUDE.md written for Claude Code is never loaded
// beside it. Context files load without project trust.
//
// The one file that hides it: a root `AGENTS.override.md` replaces AGENTS.md in that
// directory, so this emitter warns while one exists (the Zed precedence check, one name long).
//
// MCP: `.pi/mcp.json` (`mcpServers`, the Claude/Cursor shape) is Pi's project server file,
// written by the MCP emitter (emit/mcp.js, PI_TARGET). Pi reads it only after the person
// grants project trust (the startup prompt or `/trust`), and the row says so.
//
// Not claimed: lifecycle hooks. Pi has no declarative hook file; intercepting a tool call takes
// a TypeScript extension under `.pi/extensions/`, and Forge installs none.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PI_TARGET } from "./mcp.js";

/** Root files Pi prefers to AGENTS.md in the same directory. */
export const PI_SHADOWS = ["AGENTS.override.md"];

export default {
  tool: "Pi",
  emit(ctx) {
    const shadow = PI_SHADOWS.filter((f) => existsSync(join(ctx.targetRoot, f)));
    if (shadow.length)
      return {
        tool: this.tool,
        target: "AGENTS.md",
        action: "warn",
        note: `shadowed by ${shadow.join(", ")} (Pi loads one context file per directory)`,
      };
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: `reads AGENTS.md from the working directory up (MCP: ${PI_TARGET}, loaded after project trust)`,
    };
  },
};

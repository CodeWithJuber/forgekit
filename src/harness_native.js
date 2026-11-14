// Host hooks are a boundary only for actions the host reports. Supervised worktrees
// send these actions to the same MCP loop as CLI jobs, including reads and delegation.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOOK_TIMEOUT_S, hookCommand } from "./emit/hooks.js";
import { nativeHarnessPolicy } from "./harness_config.js";
import { recordHarnessNativeEvent } from "./harness_trace.js";

const TOOLS = ["forge_harness_run", "forge_harness_status"];
const DENY =
  "This workspace uses supervised ForgeKit. Call forge_harness_run on the forge-cortex MCP server to work, or forge_harness_status to inspect a run.";

function isHarnessTool(host, event, name, server) {
  if (server !== undefined && server !== "forge-cortex") return false;
  for (const tool of TOOLS) {
    if (name === `mcp__forge-cortex__${tool}`) return true;
    if (host === "claude" && name === `mcp__plugin_forgekit_forge-cortex__${tool}`) return true;
    if (host === "gemini" && name === `mcp_forge-cortex_${tool}`) return true;
    if (host === "copilot" && name === `forge-cortex-${tool}`) return true;
    if (
      host === "cursor" &&
      event === "beforeMCPExecution" &&
      server === "forge-cortex" &&
      name === tool
    )
      return true;
  }
  return false;
}

const SUPERVISED =
  "This worktree uses the supervised ForgeKit coding harness. For the requested task, call forge_harness_run on the forge-cortex MCP server with the task and its acceptance criteria. If the server is still starting, discover its tools when available. Follow a pending run with forge_harness_status and report its verification evidence. Direct host tools cannot perform this work.";
const INVALID =
  "The supervised workspace policy could not be validated. Inspect the harness configuration and its local trust record.";

/** Instructions come only from a locally activated worktree, never from retrieved content.
 * @param {any} [payload] @param {NodeJS.ProcessEnv} [env] */
function nativeBinding(payload = {}, env = process.env) {
  const projectVariables = [
    "CLAUDE_PROJECT_DIR",
    "CURSOR_PROJECT_DIR",
    "GEMINI_PROJECT_DIR",
    "DEVIN_PROJECT_DIR",
  ];
  const roots = [
    ...new Set(
      [
        ...(Array.isArray(payload?.workspace_roots) ? payload.workspace_roots : []),
        ...projectVariables.map((key) => env[key]),
        payload?.cwd,
        process.cwd(),
      ].filter((p) => typeof p === "string" && isAbsolute(p) && existsSync(p)),
    ),
  ];
  try {
    for (const root of roots) {
      const active = nativeHarnessPolicy(root);
      if (active?.policy.nativeMode === "supervised")
        return { root: active.root, instruction: SUPERVISED };
    }
    return null;
  } catch (error) {
    return { root: error.harnessRoot ?? null, instruction: INVALID };
  }
}

export function nativeHarnessInstruction(payload = {}, env = process.env) {
  return nativeBinding(payload, env)?.instruction ?? null;
}

// Cursor's generic event may identify MCP tools without a server. Defer only to the
// exact managed, fail-closed beforeMCPExecution callback that checks the server name.
function cursorMcpGate(root) {
  try {
    const file = join(root, ".cursor", "hooks.json");
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 262144 || realpathSync.native(file) !== file) return false;
    const entries = JSON.parse(readFileSync(file, "utf8")).hooks?.beforeMCPExecution;
    const cmd = hookCommand("cursor", "beforeMCPExecution");
    return (
      Array.isArray(entries) &&
      entries.some(
        (h) =>
          h.command === cmd &&
          h.failClosed === true &&
          h.timeout === HOOK_TIMEOUT_S.PreToolUse &&
          Object.keys(h).every((key) => ["command", "failClosed", "timeout"].includes(key)),
      )
    );
  } catch {
    return false;
  }
}

/** Returns a deny reason or null. The name and server must come from the host, never
 * tool arguments. A stale/corrupt pinned policy fails closed even for allowed names.
 * @param {{host:string,event:string,payload?:any,env?:NodeJS.ProcessEnv}} input */
export function nativeHarnessDenial({ host, event, payload = {}, env = process.env }) {
  const binding = nativeBinding(payload, env);
  if (!binding) return null;
  const tool = payload?.tool_name ?? payload?.toolName;
  const valid = binding.instruction !== INVALID;
  if (valid && isHarnessTool(host, event, tool, payload?.mcp_server_name)) return null;
  if (
    valid &&
    host === "cursor" &&
    event === "preToolUse" &&
    (tool === "MCP" || TOOLS.some((t) => tool === `MCP:${t}`)) &&
    cursorMcpGate(binding.root)
  )
    return null;
  const reason = valid ? DENY : INVALID;
  if (binding.root) {
    try {
      recordHarnessNativeEvent(binding.root, {
        host,
        event,
        tool: typeof tool === "string" ? tool : "unknown",
        reason,
        decision: "denied",
      });
    } catch {
      return `${reason} The local denial audit could not be written.`;
    }
  }
  return reason;
}

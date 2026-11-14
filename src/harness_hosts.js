// A client can run the supervised MCP tools without a project-specific hook adapter.
import { detectTools, KNOWN_TOOLS, parseTools, readForgeConfig } from "./repo_config.js";

export const GENERIC_HOST = "generic";

export function genericHarnessServer(root) {
  return { command: "forge", args: ["cortex-mcp"], env: { FORGE_ROOT: root } };
}

export function parseHarnessHosts(value) {
  const names = (Array.isArray(value) ? value : String(value).split(","))
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);
  const native = names.filter((name) => name !== GENERIC_HOST && name !== "all");
  const choice = parseTools(native);
  if (!names.length || choice.unknown.length)
    throw new Error(`Unknown coding hosts: ${choice.unknown.join(", ")}`);
  const hosts = names.includes("all") ? [...KNOWN_TOOLS] : choice.tools;
  return names.includes(GENERIC_HOST) ? [...hosts, GENERIC_HOST] : hosts;
}

export function detectHarnessHosts(root) {
  const cfg = readForgeConfig(root);
  if (cfg.corrupt) throw new Error("Invalid project host configuration");
  if (
    (typeof cfg.tools === "string" && cfg.tools.trim()) ||
    (Array.isArray(cfg.tools) && cfg.tools.length)
  )
    return parseHarnessHosts(cfg.tools);
  const hosts = detectTools(root);
  return hosts.length ? hosts : [GENERIC_HOST];
}

// forge integrations — opt-in third-party MCP servers. These are NOT installed by default
// (P0-06): `forge init` only wires forge's own server. Each entry here is added explicitly
// via `forge integrations add <name>`, which first shows the package, its network behaviour,
// and the files it will touch, then requires confirmation (--yes) before writing anything.
import { emitMcp } from "./emit/mcp.js";

/** The catalog of known optional integrations. Keep each entry honest about what running it
 *  actually does (network, third-party code execution). */
export const INTEGRATIONS = {
  context7: {
    server: { command: "npx", args: ["-y", "@upstash/context7-mcp@3.2.2"] },
    pkg: "@upstash/context7-mcp@3.2.2",
    network: "yes — `npx -y` downloads and executes the package on every session start",
    why: "live library-documentation lookup",
  },
};

export function listIntegrations() {
  return Object.entries(INTEGRATIONS).map(([name, m]) => ({
    name,
    pkg: m.pkg,
    network: m.network,
    why: m.why,
  }));
}

/** Describe what `add <name>` would do, without writing anything. */
export function planIntegration(name) {
  const m = INTEGRATIONS[name];
  if (!m) return { ok: false, reason: `unknown integration: ${name}` };
  return { ok: true, name, pkg: m.pkg, network: m.network, why: m.why };
}

/** Write the integration's server into each tool's MCP config (via the same emitter as sync). */
export function addIntegration(name, { targetRoot = process.cwd() } = {}) {
  const m = INTEGRATIONS[name];
  if (!m) return { ok: false, reason: `unknown integration: ${name}` };
  const rows = emitMcp({ targetRoot, servers: { [name]: m.server } });
  return { ok: true, name, rows };
}

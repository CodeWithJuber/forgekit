// forge integrations — opt-in third-party MCP servers. These are NOT installed by default
// (P0-06): `forge init` only wires forge's own server. Each entry here is added explicitly
// via `forge integrations add <name>`, which first shows the package, its network behaviour,
// and the files it will touch, then requires confirmation (--yes) before writing anything.
//
// Installed integrations are RECORDED in `.forge/forge.config.json` under
// `mcp.integrations` (RA-03): every emit — sync or add — computes the same full managed
// set (registry ∪ recorded integrations), so one command can no longer delete another's
// servers. `mcp.adopted` records the names forge may OVERWRITE when a same-name entry
// already exists (RA-21): adding over a user's own entry requires --adopt; a fresh add
// that forge itself creates is auto-adopted (forge owns what it wrote, so later catalog
// updates can refresh it).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { emitMcp, hasForeignEntry, removeMcp } from "./emit/mcp.js";
import { readForgeConfig, writeForgeConfig } from "./repo_config.js";

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

/** The `mcp` record from the repo config, shape-validated. */
function mcpRecord(cfg) {
  const raw = cfg.mcp && typeof cfg.mcp === "object" && !Array.isArray(cfg.mcp) ? cfg.mcp : {};
  const names = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "string") : []);
  return { integrations: names(raw.integrations), adopted: names(raw.adopted) };
}

/** The built-in server registry (source/mcp.json) — implicitly managed, always emitted. */
function registryServers() {
  const p = join(BRAND.root, "source", "mcp.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * The full managed MCP state for a repo — the ONE computation both `sync` and
 * `integrations add` share, so they can never oscillate (RA-03):
 *   servers = registry ∪ (recorded integrations that exist in the catalog)
 *   owned   = registry names ∪ recorded adopted names (what forge may overwrite)
 * A corrupt repo config is NEVER treated as "no integrations installed": the result
 * falls back to registry-only and says so, so no recorded server gets clobbered.
 * @param {string} targetRoot
 * @returns {{servers:Record<string, any>, owned:Set<string>, corrupt:boolean, warning?:string}}
 */
export function managedMcpState(targetRoot) {
  const registry = registryServers();
  const servers = { ...registry };
  const owned = new Set(Object.keys(registry));
  const cfg = readForgeConfig(targetRoot);
  if (cfg.corrupt) {
    return {
      servers,
      owned,
      corrupt: true,
      warning: `${cfg.path} is not valid JSON — MCP emitted registry-only; recorded integrations left untouched (fix or delete it)`,
    };
  }
  const rec = mcpRecord(cfg);
  for (const name of rec.integrations) {
    if (INTEGRATIONS[name]) servers[name] = INTEGRATIONS[name].server;
  }
  for (const name of rec.adopted) owned.add(name);
  return { servers, owned, corrupt: false };
}

/**
 * Install an integration: record it in `.forge/forge.config.json` FIRST (the persistent
 * managed set), then emit the FULL set so nothing previously installed is dropped.
 * `adopt: true` (--adopt) additionally claims a pre-existing same-name entry as
 * forge-owned; without it such an entry is preserved and reported.
 */
export function addIntegration(name, { targetRoot = process.cwd(), adopt = false } = {}) {
  const m = INTEGRATIONS[name];
  if (!m) return { ok: false, reason: `unknown integration: ${name}` };
  // Fresh create → forge owns it (auto-adopt). A pre-existing DIVERGENT same-name entry
  // is someone else's config: claiming it requires the explicit --adopt.
  const foreign = hasForeignEntry(targetRoot, name, m.server);
  const own = adopt || !foreign;
  const rec = writeForgeConfig(targetRoot, (cfg) => {
    const cur = mcpRecord(cfg);
    if (!cur.integrations.includes(name)) cur.integrations.push(name);
    if (own && !cur.adopted.includes(name)) cur.adopted.push(name);
    cfg.mcp = {
      ...(typeof cfg.mcp === "object" && cfg.mcp ? cfg.mcp : {}),
      ...cur,
    };
    return cfg;
  });
  // Corrupt config: refuse rather than emit an unrecorded (and therefore un-removable,
  // oscillation-prone) server. The config module already warned on stderr.
  if (rec.ok === false) return { ok: false, reason: rec.reason };
  const { servers, owned } = managedMcpState(targetRoot);
  const rows = emitMcp({ targetRoot, servers, owned });
  return { ok: true, name, adopted: own, rows };
}

/**
 * Reverse `add <name>`: drop it from the persistent record, then remove only what forge
 * owns — its per-server Continue file, its forge-marked Codex block, and JSON entries
 * that are adopted or byte-identical to forge's spec. A user's own divergent entry is
 * left in place and reported. Second remove is a no-op.
 */
export function removeIntegration(name, { targetRoot = process.cwd() } = {}) {
  const m = INTEGRATIONS[name];
  if (!m) return { ok: false, reason: `unknown integration: ${name}` };
  const cfg = readForgeConfig(targetRoot);
  if (cfg.corrupt)
    return {
      ok: false,
      reason: `${cfg.path} is not valid JSON — cannot update the managed-set record (fix or delete it)`,
    };
  const before = mcpRecord(cfg);
  const wasRecorded = before.integrations.includes(name) || before.adopted.includes(name);
  if (!wasRecorded) return { ok: true, name, removed: false, rows: [] };
  const rec = writeForgeConfig(targetRoot, (c) => {
    const cur = mcpRecord(c);
    cur.integrations = cur.integrations.filter((n) => n !== name);
    cur.adopted = cur.adopted.filter((n) => n !== name);
    c.mcp = { ...(typeof c.mcp === "object" && c.mcp ? c.mcp : {}), ...cur };
    return c;
  });
  if (rec.ok === false) return { ok: false, reason: rec.reason };
  const wasAdopted = before.adopted.includes(name);
  const rows = removeMcp({
    targetRoot,
    name,
    removeJsonEntry: (current) =>
      wasAdopted || JSON.stringify(current) === JSON.stringify(m.server),
  });
  return { ok: true, name, removed: true, rows };
}

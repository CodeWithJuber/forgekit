// forge integrations — opt-in third-party MCP servers. These are NOT installed by default
// (P0-06): `forge init` only wires forge's own server. Each entry here is added explicitly
// via `forge integrations add <name>`, which first shows the package, its network behaviour,
// and the files it will touch, then requires confirmation (--yes) before writing anything.
//
// Installed integrations are RECORDED in `.forge/forge.config.json` under `mcp.integrations`
// (RA-03): every emit — sync or add — computes the same full managed set (registry ∪
// recorded integrations), so one command can no longer delete another's servers. Ownership
// (what forge may OVERWRITE when a same-name entry already exists) is recorded PER TARGET in
// `mcp.adopted` as `{server, target}` pairs (ME-08): adopting a same-name entry for one
// tool's config never authorises overwriting another tool's same-name entry. Legacy bare
// names (`adopted: ["context7"]`) are still honoured — treated as "adopted for every
// target" — and migrated to per-target pairs on the next write. A fresh add that forge
// itself creates owns exactly the targets where it wrote (auto-adopt); a pre-existing
// DIVERGENT same-name entry needs an explicit --adopt for THAT target. Registry names carry
// no implicit ownership (ME-09): a divergent user entry named e.g. `forge-cortex` is
// preserved and reported like any other collision. Add/remove are ordered so disk and the
// record never drift silently (ME-10): add emits first and records only on success; remove
// cleans disk first and drops the record only when every target cleanup succeeded.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import {
  emitMcp,
  foreignTargets,
  MCP_TARGET_FILES,
  removeMcp,
  validateServerName,
} from "./emit/mcp.js";
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

/**
 * The `mcp` record from the repo config, shape-validated. `adopted` is returned as a mixed
 * list of legacy bare names (strings) and per-target `{server, target}` pairs — both are
 * honoured by `adoptionOwns`; `expandAdopted` migrates them to pairs on write.
 */
function mcpRecord(cfg) {
  const raw = cfg.mcp && typeof cfg.mcp === "object" && !Array.isArray(cfg.mcp) ? cfg.mcp : {};
  const integrations = Array.isArray(raw.integrations)
    ? raw.integrations.filter((n) => typeof n === "string")
    : [];
  const adopted = Array.isArray(raw.adopted)
    ? raw.adopted.filter(
        (a) =>
          typeof a === "string" ||
          (a &&
            typeof a === "object" &&
            typeof a.server === "string" &&
            typeof a.target === "string"),
      )
    : [];
  return { integrations, adopted };
}

/**
 * Build the per-target ownership predicate `owns(target, name)` from an adoption record.
 * A legacy bare name is a wildcard (adopted for every target); a `{server, target}` pair is
 * scoped to exactly that target — the crux of ME-08.
 */
function adoptionOwns(adopted) {
  const wildcard = new Set();
  const pairs = new Set();
  for (const a of adopted) {
    if (typeof a === "string") wildcard.add(a);
    else pairs.add(`${a.server}\t${a.target}`);
  }
  return (target, name) => wildcard.has(name) || pairs.has(`${name}\t${target}`);
}

/** Normalise an adoption record to deduped per-target pairs — migrating legacy bare names
 *  (expanded across every ownable target) to `{server, target}` on write (ME-08). */
function expandAdopted(adopted) {
  const out = [];
  const seen = new Set();
  const push = (server, target) => {
    const k = `${server}\t${target}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ server, target });
    }
  };
  for (const a of adopted) {
    if (typeof a === "string") for (const t of MCP_TARGET_FILES) push(a, t);
    else push(a.server, a.target);
  }
  return out;
}

/** The built-in server registry (source/mcp.json) — implicitly managed, always emitted. */
function registryServers() {
  const p = join(BRAND.root, "source", "mcp.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Registry ∪ recorded integrations (that exist in the catalog) — the full managed set. */
function managedServers(rec) {
  const servers = { ...registryServers() };
  for (const name of rec.integrations)
    if (INTEGRATIONS[name]) servers[name] = INTEGRATIONS[name].server;
  return servers;
}

/**
 * The full managed MCP state for a repo — the ONE computation both `sync` and
 * `integrations add` share, so they can never oscillate (RA-03):
 *   servers = registry ∪ (recorded integrations that exist in the catalog)
 *   owns    = adoptionOwns(recorded adopted) — PER TARGET (ME-08); registry names carry NO
 *             implicit ownership (ME-09), so a divergent same-name entry is preserved.
 * A corrupt repo config is NEVER treated as "no integrations installed": the result falls
 * back to registry-only, owns nothing implicitly, and says so, so nothing gets clobbered.
 * @param {string} targetRoot
 * @returns {{servers:Record<string, any>, owns:(target:string,name:string)=>boolean,
 *   corrupt:boolean, warning?:string}}
 */
export function managedMcpState(targetRoot) {
  const cfg = readForgeConfig(targetRoot);
  if (cfg.corrupt) {
    return {
      servers: { ...registryServers() },
      owns: () => false,
      corrupt: true,
      warning: `${cfg.path} is not valid JSON — MCP emitted registry-only; recorded integrations left untouched (fix or delete it)`,
    };
  }
  const rec = mcpRecord(cfg);
  return {
    servers: managedServers(rec),
    owns: adoptionOwns(rec.adopted),
    corrupt: false,
  };
}

/**
 * Install an integration. ME-10 order: emit the FULL managed set into every target FIRST,
 * then record the install in `.forge/forge.config.json` ONLY if every target emitted without
 * error — a partial write never leaves a fully-installed record behind. Ownership is decided
 * PER TARGET (ME-08): forge auto-adopts exactly the targets where it wrote a fresh/identical
 * entry; a pre-existing DIVERGENT same-name entry on a target is preserved and reported
 * unless `adopt: true` (--adopt) claims it. `res.adopted` reports whether pre-existing
 * divergent entries were claimed.
 */
export function addIntegration(name, { targetRoot = process.cwd(), adopt = false } = {}) {
  const m = INTEGRATIONS[name];
  if (!m) return { ok: false, reason: `unknown integration: ${name}` };
  try {
    validateServerName(name);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const cfg = readForgeConfig(targetRoot);
  // Corrupt config: refuse rather than emit an unrecorded (and therefore un-removable,
  // oscillation-prone) server. The config module already warned on stderr.
  if (cfg.corrupt)
    return {
      ok: false,
      reason: `${cfg.path} is not valid JSON — cannot update the managed-set record (fix or delete it)`,
    };
  const rec = mcpRecord(cfg);
  const servers = { ...managedServers(rec), [name]: m.server };
  // Per-target ownership: forge owns the targets where it writes fresh (or byte-identical);
  // a pre-existing divergent entry is owned only with --adopt.
  const foreign = foreignTargets(targetRoot, name, m.server);
  const anyForeign = foreign.size > 0;
  const newAdoptions = [];
  for (const t of MCP_TARGET_FILES)
    if (!foreign.has(t) || adopt) newAdoptions.push({ server: name, target: t });
  const owns = adoptionOwns([...rec.adopted, ...newAdoptions]);
  // Emit FIRST (ME-10). A per-target write failure surfaces as an `error` row.
  const rows = emitMcp({ targetRoot, servers, owns });
  const failed = rows.filter((r) => r.action === "error");
  if (failed.length)
    return {
      ok: false,
      incomplete: true,
      name,
      rows,
      reason: `incomplete: MCP emission failed for ${failed.map((r) => r.target).join(", ")} — install NOT recorded; fix and re-run \`${BRAND.cli} integrations add ${name} --yes\``,
    };
  // Record only after a fully successful emit.
  const w = writeForgeConfig(targetRoot, (c) => {
    const cur = mcpRecord(c);
    const integrations = cur.integrations.includes(name)
      ? cur.integrations
      : [...cur.integrations, name];
    const adopted = expandAdopted([...cur.adopted, ...newAdoptions]);
    c.mcp = {
      ...(typeof c.mcp === "object" && c.mcp ? c.mcp : {}),
      integrations,
      adopted,
    };
    return c;
  });
  if (w.ok === false) return { ok: false, reason: w.reason };
  return { ok: true, name, adopted: anyForeign ? adopt : true, rows };
}

/**
 * Reverse `add <name>`. ME-10 order: clean every target FIRST (per-server Continue file,
 * forge-marked Codex block, and JSON entries adopted for that target or byte-identical to
 * forge's spec), then drop it from the persistent record ONLY if every target cleanup
 * succeeded. If any target cleanup fails the record is KEPT and an incomplete transaction is
 * reported, so a later remove/sync can finish. A user's own divergent entry is left in place
 * and reported. Second remove is a no-op.
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
  const adoptedName = (a) => (typeof a === "string" ? a : a.server);
  const wasRecorded =
    before.integrations.includes(name) || before.adopted.some((a) => adoptedName(a) === name);
  if (!wasRecorded) return { ok: true, name, removed: false, rows: [] };
  const owns = adoptionOwns(before.adopted);
  // Clean disk FIRST (ME-10). A per-target cleanup failure surfaces as an `error` row.
  const rows = removeMcp({
    targetRoot,
    name,
    removeJsonEntry: (target, current) =>
      owns(target, name) || JSON.stringify(current) === JSON.stringify(m.server),
  });
  const failed = rows.filter((r) => r.action === "error");
  if (failed.length)
    return {
      ok: false,
      incomplete: true,
      name,
      removed: false,
      rows,
      reason: `incomplete: cleanup failed for ${failed.map((r) => r.target).join(", ")} — kept in the managed set; fix and re-run \`${BRAND.cli} integrations remove ${name}\` to finish`,
    };
  // Drop from the record only after a fully successful cleanup.
  const w = writeForgeConfig(targetRoot, (c) => {
    const cur = mcpRecord(c);
    const integrations = cur.integrations.filter((n) => n !== name);
    const adopted = expandAdopted(cur.adopted).filter((a) => a.server !== name);
    c.mcp = {
      ...(typeof c.mcp === "object" && c.mcp ? c.mcp : {}),
      integrations,
      adopted,
    };
    return c;
  });
  if (w.ok === false) return { ok: false, reason: w.reason };
  return { ok: true, name, removed: true, rows };
}

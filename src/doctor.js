// forge doctor — turn silent misconfiguration into an actionable pass/fail list
// (chezmoi-doctor pattern). Exits non-zero only on hard failures, not warnings.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { summary as cortexSummary } from "./cortex.js";
import { extractHash, hashContent } from "./emit/_shared.js";
import { canonical } from "./sync.js";

const ok = (label, note = "") => ({ status: "ok", label, note });
const warn = (label, note = "") => ({ status: "warn", label, note });
const fail = (label, note = "") => ({ status: "fail", label, note });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function checkNode(out) {
  const major = Number(process.versions.node.split(".")[0]);
  out.push(
    major >= 18
      ? ok("node", `v${process.versions.node}`)
      : fail("node", `v${process.versions.node} < 18`),
  );
}

function checkBrandConsistency(out) {
  try {
    const plugin = readJson(join(BRAND.root, ".claude-plugin/plugin.json"));
    out.push(
      plugin.name === BRAND.pkg
        ? ok("brand↔plugin", `${plugin.name} v${plugin.version}`)
        : warn("brand↔plugin", `plugin.json name "${plugin.name}" != brand pkg "${BRAND.pkg}"`),
    );
  } catch {
    out.push(warn("brand↔plugin", "plugin.json missing or invalid"));
  }
}

function checkLayers(out) {
  for (const layer of ["tools", "crew", "guards"]) {
    const dir = join(BRAND.root, "global", layer);
    if (!existsSync(dir)) {
      out.push(fail(layer, "missing"));
      continue;
    }
    out.push(ok(layer, `${readdirSync(dir).length} item(s)`));
  }
}

function checkInstall(out) {
  const forgeHome = join(homedir(), ".forge");
  out.push(
    existsSync(forgeHome)
      ? ok("~/.forge", "linked")
      : warn("~/.forge", "not installed — run install.sh or the plugin"),
  );
}

function checkDrift(out, targetRoot) {
  const agents = join(targetRoot, "AGENTS.md");
  if (!existsSync(agents)) {
    out.push(warn("AGENTS.md", "not emitted here — run `forge sync`"));
    return;
  }
  const current = hashContent(canonical(targetRoot));
  const onDisk = extractHash(readFileSync(agents, "utf8"));
  out.push(
    current === onDisk ? ok("AGENTS.md", "in sync") : warn("AGENTS.md", "stale — run `forge sync`"),
  );
}

// MCP hygiene: past ~6 servers, tool-selection accuracy drops and the context bloats.
function checkMcp(out, targetRoot) {
  const path = join(targetRoot, ".mcp.json");
  if (!existsSync(path)) return;
  let servers = {};
  try {
    servers = JSON.parse(readFileSync(path, "utf8")).mcpServers || {};
  } catch {
    return;
  }
  const n = Object.keys(servers).length;
  out.push(
    n > 6
      ? warn(
          "MCP servers",
          `${n} in .mcp.json — over ~6; tool-selection accuracy drops, trim or defer`,
        )
      : ok("MCP servers", `${n} in .mcp.json`),
  );
}

// Cortex: report the self-correcting memory's state for this repo (always informational).
function checkCortex(out, targetRoot) {
  const s = cortexSummary(targetRoot, Math.floor(Date.now() / 86400000));
  out.push(
    s.total === 0
      ? ok("cortex", "no lessons yet — learns from corrections as you work")
      : ok(
          "cortex",
          `${s.active} active · ${s.candidate} candidate · ${s.quarantined} quarantined · ${s.retired} retired`,
        ),
  );
}

export function doctor({ targetRoot = process.cwd() } = {}) {
  const results = [];
  checkNode(results);
  checkBrandConsistency(results);
  checkLayers(results);
  checkInstall(results);
  checkDrift(results, targetRoot);
  checkMcp(results, targetRoot);
  checkCortex(results, targetRoot);
  return { results, failed: results.filter((r) => r.status === "fail").length };
}

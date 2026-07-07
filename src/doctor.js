// forge doctor — turn silent misconfiguration into an actionable pass/fail list
// (chezmoi-doctor pattern). Exits non-zero only on hard failures, not warnings.
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isStale, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { summary as cortexSummary } from "./cortex.js";
import { extractHash, hashContent } from "./emit/_shared.js";
import { PRICING_VERIFIED } from "./model_tiers.js";
import { canonical } from "./sync.js";

const ok = (label, note = "") => ({ status: "ok", label, note });
const warn = (label, note = "") => ({ status: "warn", label, note });
const fail = (label, note = "") => ({ status: "fail", label, note });

import { hasBin } from "./util.js";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// External tools the guards/commands depend on. jq is the important one — several guards
// (secret-redact, protect-paths) degrade to a naive parse or a no-op without it.
function checkTooling(out) {
  out.push(
    hasBin("jq")
      ? ok("jq", "found — guards parse hook JSON safely")
      : warn("jq", "not found — secret-redact/protect-paths degrade without it; install jq"),
  );
  out.push(
    hasBin("git") ? ok("git", "found") : warn("git", "not found — churn/impact/anchor need it"),
  );
}

// Every guard the manifests reference must exist and be executable, or a hook silently no-ops.
function checkGuardsExecutable(out) {
  const dir = join(BRAND.root, "global", "guards");
  if (!existsSync(dir)) return; // absence is already reported by checkLayers
  const scripts = readdirSync(dir).filter((f) => f.endsWith(".sh"));
  const notExec = scripts.filter((f) => {
    try {
      accessSync(join(dir, f), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
  out.push(
    notExec.length
      ? warn(
          "guards exec",
          `${notExec.length} not executable (chmod +x): ${notExec.slice(0, 3).join(", ")}`,
        )
      : ok("guards exec", `${scripts.length} guard(s) executable`),
  );
}

// Model prices drift; a stale table quietly misinforms the cost/route commands.
function checkPricing(out) {
  const days = Math.floor((Date.now() - Date.parse(`${PRICING_VERIFIED}T00:00:00Z`)) / 86400000);
  out.push(
    Number.isFinite(days) && days > 90
      ? warn(
          "model pricing",
          `verified ${PRICING_VERIFIED} (${days}d ago) — re-verify via dev-radar`,
        )
      : ok("model pricing", `verified ${PRICING_VERIFIED}`),
  );
}

// The atlas backs impact/verify. A missing or STALE graph gives wrong blast-radius / hallucination
// results silently — surface it so the user rebuilds.
function checkAtlas(out, targetRoot) {
  const atlas = loadAtlas(targetRoot);
  if (!atlas) {
    out.push(ok("atlas", "not built — run `forge atlas build` for impact/verify"));
    return;
  }
  out.push(
    isStale(targetRoot, atlas)
      ? warn("atlas", "stale (files changed since build) — run `forge atlas build`")
      : ok("atlas", `${atlas.symbols?.length ?? 0} symbols, fresh`),
  );
}

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
  checkGuardsExecutable(results);
  checkTooling(results);
  checkInstall(results);
  checkDrift(results, targetRoot);
  checkAtlas(results, targetRoot);
  checkPricing(results);
  checkMcp(results, targetRoot);
  checkCortex(results, targetRoot);
  return { results, failed: results.filter((r) => r.status === "fail").length };
}

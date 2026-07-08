// forge doctor — turn silent misconfiguration into an actionable pass/fail list
// (chezmoi-doctor pattern). Exits non-zero only on hard failures, not warnings.
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isStale, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { summary as cortexSummary } from "./cortex.js";
import { extractHash, hashContent } from "./emit/_shared.js";
import { verify as ledgerVerify, repoLedger } from "./ledger_store.js";
import { PRICING_VERIFIED } from "./model_tiers.js";
import { activeProvider } from "./providers.js";
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

function commandScriptFromPluginRoot(command) {
  const marker = '"$' + '{CLAUDE_PLUGIN_ROOT}"/';
  const i = command.indexOf(marker);
  if (i === -1) return null;
  const rest = command.slice(i + marker.length);
  const script = rest.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  return script || null;
}

// Plugin/hook compatibility: Forge should be additive and self-contained. Claude Code
// composes plugin hook arrays, so the main risk is a stale manifest path or a hook command
// that references a missing/non-executable guard and silently degrades beside other plugins.
function checkPluginCompatibility(out) {
  try {
    const plugin = readJson(join(BRAND.root, ".claude-plugin", "plugin.json"));
    const hookRel = plugin.hooks;
    const hookPath = hookRel ? join(BRAND.root, hookRel) : "";
    if (!hookRel || !existsSync(hookPath)) {
      out.push(warn("Claude plugin hooks", "manifest hooks path missing or invalid"));
    } else {
      const manifest = readJson(hookPath);
      const hooks = manifest.hooks && typeof manifest.hooks === "object" ? manifest.hooks : {};
      const commands = Object.values(hooks)
        .flatMap((entries) => (Array.isArray(entries) ? entries : []))
        .flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
        .map((h) => h.command)
        .filter(Boolean);
      const missing = [];
      const notExec = [];
      for (const command of commands) {
        const rel = commandScriptFromPluginRoot(command);
        if (!rel) continue;
        const abs = join(BRAND.root, rel);
        if (!existsSync(abs)) {
          missing.push(rel);
          continue;
        }
        try {
          accessSync(abs, constants.X_OK);
        } catch {
          notExec.push(rel);
        }
      }
      if (missing.length || notExec.length) {
        out.push(
          warn(
            "Claude plugin hooks",
            `${missing.length} missing, ${notExec.length} not executable — other plugins may still load but Forge hooks degrade`,
          ),
        );
      } else {
        out.push(
          ok(
            "Claude plugin hooks",
            `${commands.length} additive hook command(s), all local/executable`,
          ),
        );
      }
    }
  } catch {
    out.push(warn("Claude plugin hooks", "plugin or hooks manifest missing/invalid"));
  }

  try {
    const codex = readJson(join(BRAND.root, ".codex-plugin", "plugin.json"));
    const skillsPath = codex.skills ? join(BRAND.root, codex.skills) : "";
    const mcpPath = codex.mcpServers ? join(BRAND.root, codex.mcpServers) : "";
    const issues = [];
    if (!codex.name) issues.push("missing name");
    if (!skillsPath || !existsSync(skillsPath)) issues.push("skills path missing");
    if (!mcpPath || !existsSync(mcpPath)) issues.push("mcpServers path missing");
    out.push(
      issues.length
        ? warn(
            "Codex plugin",
            `${issues.join("; ")} — plugin may not install cleanly beside others`,
          )
        : ok("Codex plugin", "manifest paths resolve; no repo-level hook takeover"),
    );
  } catch {
    out.push(warn("Codex plugin", "plugin manifest missing/invalid"));
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

// PCM ledger: a populated ledger with no union-merge driver WILL conflict the first
// time two teammates append to the same evidence log — the exact failure the ledger's
// design promises away. Also surface normal-form issues (forged/corrupt records).
function checkLedger(out, targetRoot) {
  const dir = repoLedger(targetRoot);
  if (!existsSync(join(dir, "claims"))) {
    out.push(ok("ledger", "empty — claims appear as cortex/recall learn (`forge ledger`)"));
    return;
  }
  const attrs = join(targetRoot, ".gitattributes");
  const hasRule = existsSync(attrs) && readFileSync(attrs, "utf8").includes(".forge/ledger/");
  out.push(
    hasRule
      ? ok("ledger merge", "union-merge driver present in .gitattributes")
      : warn(
          "ledger merge",
          "no union-merge rule — run `forge init` or teammate merges will conflict",
        ),
  );
  const v = ledgerVerify(dir);
  out.push(
    v.ok
      ? ok("ledger", `${v.claims} claim(s), ${v.outcomes} outcome(s) — normal form`)
      : warn("ledger", `${v.issues.length} issue(s) — run \`forge ledger verify\` to list them`),
  );
}

function checkProvider(out, targetRoot) {
  const prov = activeProvider(targetRoot);
  if (prov._autoDetected) {
    out.push(ok("provider", `${prov.name} (auto-detected from ${prov._source})`));
  } else if (prov.envKey && !process.env[prov.envKey]) {
    out.push(warn("provider", `${prov.name} — ${prov.envKey} is NOT set`));
  } else {
    out.push(ok("provider", `${prov.name} (configured)`));
  }
}

export function doctor({ targetRoot = process.cwd() } = {}) {
  const results = [];
  checkNode(results);
  checkProvider(results, targetRoot);
  checkBrandConsistency(results);
  checkLayers(results);
  checkGuardsExecutable(results);
  checkPluginCompatibility(results);
  checkTooling(results);
  checkInstall(results);
  checkDrift(results, targetRoot);
  checkAtlas(results, targetRoot);
  checkPricing(results);
  checkMcp(results, targetRoot);
  checkCortex(results, targetRoot);
  checkLedger(results, targetRoot);
  return { results, failed: results.filter((r) => r.status === "fail").length };
}

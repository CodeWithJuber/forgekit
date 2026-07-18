// forge doctor — turn silent misconfiguration into an actionable pass/fail list
// (chezmoi-doctor pattern). Exits non-zero only on hard failures, not warnings.
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isStale, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { summary as cortexSummary } from "./cortex.js";
import { docsCheck } from "./docs_check.js";
import { hashContent, mdHeader } from "./emit/_shared.js";
import { gatewayBase, gatewayModelMap } from "./gateway_model_map.js";
import { ensureLedgerGitattributes, mergeSettings } from "./init.js";
import { verify as ledgerVerify, repoLedger } from "./ledger_store.js";
import { PRICING_VERIFIED } from "./model_tiers.js";
import { activeProvider, envModelOverride } from "./providers.js";
import { canonical, sync } from "./sync.js";
import { updateStatus } from "./update.js";

const ok = (label, note = "") => ({ status: "ok", label, note });
const warn = (label, note = "") => ({ status: "warn", label, note });
const fail = (label, note = "") => ({ status: "fail", label, note });
// Not applicable / not built: a subsystem that simply is not there. Neither healthy nor
// failing — it must not render as ACTIVE (RA-19) and never counts toward failed totals.
const na = (label, note = "") => ({ status: "na", label, note });

import { hasBin } from "./util.js";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readJsonSafe = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

// The user's ~/.claude/settings.json must carry Forge's hooks + permissions or none of the
// session-start rehydrate / advisory hooks fire — the silent-onboarding failure. Fixable by
// re-running the same idempotent merge init uses (mergeSettings), marker-guarded so it never
// clobbers hand-written entries.
function checkSettings(out, settingsPath) {
  const path = settingsPath || join(homedir(), ".claude", "settings.json");
  const data = readJsonSafe(path);
  const managed = !!data?._forge;
  const hasHooks = !!(data?.hooks && Object.keys(data.hooks).length);
  if (managed && hasHooks) {
    out.push(ok("settings", "forge-managed hooks + permissions present"));
    return;
  }
  const note = data
    ? "not forge-managed — hooks/permissions missing; run `forge doctor --fix` or `forge init`"
    : "missing — run `forge doctor --fix` or `forge init`";
  out.push({
    ...warn("settings", note),
    fix: {
      id: "settings",
      label: "merge forge hooks + permissions into settings.json",
      run: () => mergeSettings({ settingsPath }),
    },
  });
}

// External tools the guards/commands depend on. secret-redact now runs in Node (no jq),
// so node is the security-critical dependency; jq only helps protect-paths parse more
// precisely (it has a grep fallback either way).
function checkTooling(out) {
  // node powers secret redaction — its absence means tool output is NOT scanned for secrets.
  out.push(
    hasBin("node")
      ? ok("node", "found — secret-redact scans tool output")
      : fail(
          "node",
          "not found — secret-redact CANNOT run; tool output is NOT scanned for secrets",
        ),
  );
  out.push(
    hasBin("jq")
      ? ok("jq", "found — protect-paths parses hook JSON precisely")
      : warn("jq", "not found — protect-paths falls back to grep parsing (still enforced)"),
  );
  out.push(
    hasBin("git") ? ok("git", "found") : warn("git", "not found — churn/impact/anchor need it"),
  );
  out.push(
    hasBin("claude")
      ? ok("claude CLI", "found — LLM proposer uses it (FORGE_LLM=1)")
      : warn(
          "claude CLI",
          "not found — LLM proposer falls back to direct HTTP (needs ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY)",
        ),
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
  if (notExec.length) {
    out.push({
      ...warn(
        "guards exec",
        `${notExec.length} not executable (chmod +x): ${notExec.slice(0, 3).join(", ")}`,
      ),
      fix: {
        id: "guards",
        label: `chmod +x ${notExec.length} guard(s)`,
        run: () => {
          for (const f of notExec) {
            const p = join(dir, f);
            chmodSync(p, statSync(p).mode | 0o111);
          }
          return { chmodded: notExec.length };
        },
      },
    });
  } else {
    out.push(ok("guards exec", `${scripts.length} guard(s) executable`));
  }
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
    // "na", not "ok": a missing atlas means impact/verify are UNAVAILABLE, and reporting
    // it green would surface as an ACTIVE subsystem in the health line (RA-19).
    out.push(na("atlas", "not built — run `forge atlas build` for impact/verify"));
    return;
  }
  out.push(
    isStale(targetRoot, atlas)
      ? warn("atlas", "stale (files changed since build) — run `forge atlas build`")
      : ok("atlas", `${atlas.symbols?.length ?? 0} symbols, fresh`),
  );
}

// Reconciled with package.json `engines` (>=20): >=20 ok, 18–19 warn (works, upgrade
// recommended), <18 hard fail. Ends the old 18-vs-20 threshold mismatch. No auto-fix — the
// runtime can't upgrade itself.
function checkNode(out) {
  const major = Number(process.versions.node.split(".")[0]);
  out.push(
    major >= 20
      ? ok("node", `v${process.versions.node}`)
      : major >= 18
        ? warn(
            "node",
            `v${process.versions.node} — Forge targets Node >=20 (package.json engines); 18–19 works but upgrade recommended`,
          )
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
  const syncFix = {
    id: "agents",
    label: "emit/refresh AGENTS.md (forge sync)",
    run: () => sync({ targetRoot }),
  };
  const agents = join(targetRoot, "AGENTS.md");
  if (!existsSync(agents)) {
    out.push({
      ...warn("AGENTS.md", "not emitted here — run `forge sync`"),
      fix: syncFix,
    });
    return;
  }
  // Compare the actual file to the full expected content, not just the embedded marker —
  // a hand-edited body with an intact marker would otherwise report "in sync" (P0-08).
  const body = canonical(targetRoot);
  const expected = `${mdHeader(hashContent(body))}\n${body}\n`;
  const actual = readFileSync(agents, "utf8");
  out.push(
    actual === expected
      ? ok("AGENTS.md", "in sync")
      : {
          ...warn("AGENTS.md", "stale or hand-edited — run `forge sync`"),
          fix: syncFix,
        },
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
      : {
          ...warn(
            "ledger merge",
            "no union-merge rule — run `forge init` or teammate merges will conflict",
          ),
          fix: {
            id: "gitattributes",
            label: "add ledger union-merge rule to .gitattributes",
            run: () => ensureLedgerGitattributes(targetRoot),
          },
        },
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
  const override = envModelOverride();
  if (override) {
    out.push(ok("model override", `${override} (all tiers resolve to this model)`));
  }
}

// Custom-gateway model mapping: stock Anthropic ids can 404 on a self-hosted gateway that
// serves its own names. Surface the tier→gateway-model remap so the user can VERIFY it (and
// pin explicit ids if a family scored wrong). Only speaks for a non-default gateway base URL —
// direct api.anthropic.com sessions never probe, so this stays silent and network-free there.
function checkGateway(out) {
  const base = gatewayBase();
  if (!base) return; // direct Anthropic or no gateway configured — nothing to remap
  let m;
  try {
    m = gatewayModelMap({ base });
  } catch {
    m = null;
  }
  if (!m || m.reachable === false) {
    out.push(
      warn(
        "gateway models",
        `${base} — /v1/models unreachable; using stock IDs (may 404 if this gateway renames models)`,
      ),
    );
    return;
  }
  const entries = Object.entries(m.models);
  if (!entries.length) {
    out.push(
      warn(
        "gateway models",
        `${base} serves ${m.catalog.length} model(s) but none matched a tier family — set explicit IDs via \`${BRAND.cli} config provider add\``,
      ),
    );
    return;
  }
  const summary = entries.map(([tier, v]) => `${tier}→${v.id}`).join(", ");
  out.push(ok("gateway models", `${base}: ${summary}`));
}

// Docs↔code drift — a self-check of the forge package's own docs, so it only runs
// when doctor is pointed at the forge repo itself (contributors + CI), never at a
// host project whose README rightly says nothing about forge commands.
function checkDocs(out, targetRoot) {
  try {
    if (readJson(join(targetRoot, "package.json")).name !== BRAND.pkg) return;
    const r = docsCheck({ root: targetRoot });
    out.push(
      r.ok
        ? ok("docs↔code", `${r.checked.join(", ")} all agree`)
        : warn("docs↔code", `${r.issues.length} drift issue(s) — run \`${BRAND.cli} docs check\``),
    );
  } catch {}
}

// Best-effort freshness notice — never a hard failure, only speaks when genuinely behind.
// Cached fetch (updateStatus) keeps it cheap; FORGE_NO_UPDATE_CHECK=1 silences it entirely.
function checkUpdate(out) {
  if (process.env.FORGE_NO_UPDATE_CHECK === "1") return;
  try {
    // fetch:false — doctor never initiates network; it reports on the LAST cached fetch
    // (a prior `forge update`/`update --check`). Keeps the health check fast and offline-safe.
    const s = updateStatus({ fetch: false });
    if (s.behind > 0)
      out.push(warn("update", `${s.behind} commit(s) behind — run \`${BRAND.cli} update\``));
    else if (!s.unknown) out.push(ok("update", `up to date (v${s.current})`));
  } catch {}
}

// The important subsystems and the check label each derives its health from.
const HEALTH_SUBSYSTEMS = {
  "secret-redaction": "node", // secret-redact runs the JS redactor; no node → FAILED
  guards: "guards exec",
  atlas: "atlas",
  "managed-config": "AGENTS.md",
  pricing: "model pricing",
};

/**
 * Standard subsystem-health vocabulary (P1-06): ACTIVE | DEGRADED | UNAVAILABLE | FAILED,
 * derived from the SAME checks the report uses (no parallel source), so a degraded security
 * or verification control is never invisible behind a green overall status.
 * @param {Array<{status:string,label:string}>} results
 */
export function subsystemHealth(results) {
  const state = (label) => {
    const r = results.find((x) => x.label === label);
    if (!r) return "UNAVAILABLE";
    if (r.status === "fail") return "FAILED";
    if (r.status === "warn") return "DEGRADED";
    if (r.status === "na") return "UNAVAILABLE"; // not built/applicable ≠ ACTIVE (RA-19)
    return "ACTIVE";
  };
  const health = {};
  for (const [subsystem, label] of Object.entries(HEALTH_SUBSYSTEMS)) {
    health[subsystem] = state(label);
  }
  return health;
}

function runChecks(targetRoot, settingsPath) {
  const results = [];
  checkNode(results);
  checkSettings(results, settingsPath);
  checkProvider(results, targetRoot);
  checkGateway(results);
  checkBrandConsistency(results);
  checkLayers(results);
  checkGuardsExecutable(results);
  checkPluginCompatibility(results);
  checkTooling(results);
  checkInstall(results);
  checkDrift(results, targetRoot);
  checkDocs(results, targetRoot);
  checkAtlas(results, targetRoot);
  checkPricing(results);
  checkMcp(results, targetRoot);
  checkCortex(results, targetRoot);
  checkLedger(results, targetRoot);
  checkUpdate(results);
  return results;
}

/**
 * Health-check this repo + the user's config. With `fix:true`, each warn/fail result carrying
 * a `{id,label,run}` descriptor has its idempotent repair run (mergeSettings / ensureLedger-
 * gitattributes / sync / chmod — all safe, no-op if already applied), then every check re-runs
 * so the returned `results` reflect the repaired state. Unsafe findings (provider keys, MCP,
 * pricing, gateway) carry no descriptor and stay report-only.
 * @param {{targetRoot?: string, fix?: boolean, settingsPath?: string}} [opts]
 */
export function doctor({ targetRoot = process.cwd(), fix = false, settingsPath } = {}) {
  let results = runChecks(targetRoot, settingsPath);
  const repairs = [];
  if (fix) {
    for (const r of results) {
      if ((r.status === "warn" || r.status === "fail") && r.fix) {
        try {
          const detail = r.fix.run();
          // Repairs like mergeSettings report failure as a RETURNED {action:"error", reason}
          // instead of throwing — an errored result must not be recorded as ok (RA-20).
          const errored = detail && typeof detail === "object" && detail.action === "error";
          repairs.push({
            id: r.fix.id,
            label: r.fix.label,
            ok: !errored,
            error: errored ? detail.reason : undefined,
            detail: errored ? undefined : detail,
          });
        } catch (err) {
          repairs.push({
            id: r.fix.id,
            label: r.fix.label,
            ok: false,
            error: err.message,
          });
        }
      }
    }
    results = runChecks(targetRoot, settingsPath);
  }
  return {
    results,
    failed: results.filter((r) => r.status === "fail").length,
    repairs,
    health: subsystemHealth(results),
  };
}

#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// forge — zero-dependency dispatcher. Works identically whether installed via the
// npm bin, the hardened install.sh symlink, or the Claude Code plugin.
import { BRAND } from "./brand.js";
// Domain command handlers live in their own modules (review A03); the presentation helpers
// every handler shares are defined once in ./cli/shared.js.
import memoryHandlers from "./cli/memory.js";
import routingHandlers from "./cli/routing.js";
import { bar, heading, paint, table } from "./cli/shared.js";
import verificationHandlers from "./cli/verification.js";
// The command surface lives in commands.js as data — docs_check.js reconciles the
// README/GUIDE tables against the same table this help is rendered from.
import { COMMANDS, commandSummary, GROUPS } from "./commands.js";
import { printCommandHelp } from "./help.js";
import { suggest } from "./math.js";

const printVersion = () => console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

// Commands that are themselves the onboarding path — nudging on them would be circular.
const HINT_SKIP = new Set(["init", "help", "version"]);

/** First-run nudge: if the user has never run `forge init` (no forge-managed marker in
 *  ~/.claude/settings.json) and is invoking a real command, print ONE tip line to stderr.
 *  Stateless — zero writes — and self-silences the moment `init` (or install.sh) writes the
 *  marker. FORGE_NO_HINT=1 mutes it. Never throws; a missing/garbage settings file just
 *  means "not yet managed". */
function maybeFirstRunHint(cmd) {
  if (process.env.FORGE_NO_HINT === "1") return;
  if (!(cmd in COMMANDS) || HINT_SKIP.has(cmd)) return;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    if (settings?._forge === "forge-managed") return;
  } catch {
    // missing or unparseable → not managed → fall through and hint
  }
  console.error(
    `Tip: run \`${BRAND.cli} init\` to wire hooks/permissions, or \`${BRAND.cli} doctor --fix\`. Silence: FORGE_NO_HINT=1.`,
  );
}

function printHelp() {
  printVersion();
  console.log(`\n${BRAND.tagline}\n`);
  console.log(`Usage: ${BRAND.cli} <command> [options]\n`);
  for (const [group, cmds] of Object.entries(GROUPS)) {
    console.log(`${group}:`);
    for (const name of cmds) {
      if (COMMANDS[name]) console.log(`  ${name.padEnd(12)} ${commandSummary(name)}`);
    }
    console.log();
  }
  console.log(`Start here: \`${BRAND.cli} catalog\``);
  console.log(`Run \`${BRAND.cli} <command> --help\` for details.`);
}

// Command dispatch table: name → async handler `(argv, cmd) => …`. Populated at module
// load by the per-command handler declarations below. run() looks a command up here.
/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = { ...memoryHandlers, ...verificationHandlers, ...routingHandlers };

async function run(argv) {
  const [cmd] = argv;
  // Top-level help/version — flag AND word forms (`forge help`, `forge version`).
  if (!cmd || cmd === "-h" || cmd === "--help" || (cmd === "help" && !argv[1])) return printHelp();
  if (cmd === "-v" || cmd === "--version" || cmd === "version") return printVersion();
  // Per-command help by word form: `forge help <cmd>`.
  if (cmd === "help") {
    process.exitCode = printCommandHelp(argv[1]);
    return;
  }
  // Central interception: `forge <cmd> --help|-h` for ANY real command, BEFORE dispatch,
  // so every command gets uniform help without each branch parsing its own flag (the
  // gap the old banner advertised but never delivered). cortex-mcp is exempt (a server).
  if (
    cmd !== "cortex-mcp" &&
    cmd in COMMANDS &&
    argv.slice(1).some((a) => a === "--help" || a === "-h")
  ) {
    process.exitCode = printCommandHelp(cmd);
    return;
  }
  maybeFirstRunHint(cmd);
  if (cmd === "cortex-mcp") {
    const { serve } = await import("./cortex_mcp.js"); // stdio MCP server for other tools
    serve();
    return;
  }
  // Dispatch table: migrated commands resolve here; run() is the thin dispatcher.
  const handler = HANDLERS[cmd];
  if (handler) return handler(argv, cmd);
  if (!(cmd in COMMANDS)) {
    const near = suggest(cmd, Object.keys(COMMANDS));
    console.error(
      `Unknown command: ${cmd}${near ? ` — did you mean \`${BRAND.cli} ${near}\`?` : ""}\n` +
        `Run \`${BRAND.cli} --help\` to see commands.`,
    );
    process.exitCode = 1;
    return;
  }
  // A command is registered in COMMANDS but has no handler wired yet. Exit non-zero
  // so scripts (and CI) treat "recognized but unimplemented" as a failure, not success.
  console.error(`${BRAND.cli} ${cmd}: not wired yet — coming in a later build phase.`);
  process.exitCode = 1;
}

// ─────────────────────────── command handlers ───────────────────────────────
// One async function per command, registered into HANDLERS above; run() dispatches
// to them. Each is independently navigable and mergeable (was one 2.4k-line run()).

HANDLERS.brand = async () => {
  const { brand, cli, pkg, version, layers } = BRAND;
  return console.log(JSON.stringify({ brand, cli, pkg, version, layers }, null, 2));
};
HANDLERS.init = async (argv) => {
  const { init } = await import("./init.js");
  const noSettings = argv.includes("--no-settings");
  // Test/plumbing override of the merge target — not user-facing surface.
  const settingsPath = process.env.FORGE_SETTINGS_PATH || undefined;
  // RA-11: the settings merge touches GLOBAL state — say so before reporting it,
  // on merged AND unchanged runs, with the opt-out and the reversal path.
  const consentLine = (path) =>
    console.log(
      `  settings: merging ${BRAND.brand} hooks into ${path} (GLOBAL — affects all repos). ` +
        `Skip with --no-settings; reverse with \`${BRAND.cli} init --remove-settings\`.`,
    );
  // --remove-settings: reverse the merge (RA-17) — strip every template-shaped hook,
  // permission, statusline, and the _forge marker; user-owned entries stay untouched.
  if (argv.includes("--remove-settings")) {
    const { removeForgeSettings } = await import("./init.js");
    const r = removeForgeSettings({ settingsPath });
    heading(`${BRAND.brand} init — remove managed settings\n`);
    if (r.action === "removed") {
      console.log(`  settings: removed ${r.removed.join(", ")} from ${r.path}`);
      console.log(`            backup: ${r.backup}`);
    } else if (r.action === "noop") {
      console.log(`  settings: nothing to remove (${r.reason})`);
    } else {
      console.error(`  settings: NOT modified — ${r.path}: ${r.reason}`);
      process.exitCode = 1;
    }
    return;
  }
  // --settings-only: wire hooks + permissions into ~/.claude/settings.json ONLY (the
  // idempotent, marker-guarded merge install.sh calls) — no repo emit, no AGENTS.md.
  if (argv.includes("--settings-only")) {
    // ME-22: heading + disclosure precede the merge — onSettingsNotice fires inside init
    // BEFORE mergeSettings touches the file, never after.
    heading(`${BRAND.brand} init — settings merge only\n`);
    const { settings } = init({
      settingsOnly: true,
      noSettings,
      settingsPath,
      onSettingsNotice: consentLine,
    });
    if ((settings?.action === "merged" || settings?.action === "created") && "added" in settings) {
      const verb = settings.action === "created" ? "created" : "merged";
      const what = settings.added.length ? settings.added.join(", ") : "defaults";
      console.log(`  settings: ${verb} ${what} into ${settings.path}`);
    } else if (settings?.action === "unchanged" && "path" in settings) {
      console.log(`  settings: already up to date (${settings.path})`);
    } else if (settings?.action === "skipped") {
      console.log("  settings: skipped (--no-settings)");
    } else if (settings?.action === "error") {
      // RA-04: a refused/failed merge must FAIL the command, not silently exit 0 —
      // install.sh keys its "install incomplete" path off this exit code.
      console.error(`  settings: FAILED — ${settings.path}: ${settings.reason}`);
      process.exitCode = 1;
    }
    if (settings && "hooksVia" in settings && settings.hooksVia === "plugin")
      console.log(
        `            hooks: wired by the ${BRAND.pkg} plugin — not duplicated in settings.json`,
      );
    return;
  }
  const profileIdx = argv.indexOf("--profile");
  const profile = profileIdx >= 0 ? argv[profileIdx + 1] : undefined;
  // --tools <list> (or --tools=<list>): the agent tools to emit config for. Omitted = the set an
  // earlier init recorded, else Claude plus the tools this repo already uses.
  const toolsEq = argv.find((a) => a.startsWith("--tools="));
  const toolsIdx = argv.indexOf("--tools");
  const tools = toolsEq
    ? toolsEq.slice("--tools=".length)
    : toolsIdx >= 0
      ? (argv[toolsIdx + 1] ?? "")
      : undefined;
  // ME-22: emit the GLOBAL-settings disclosure BEFORE the merge mutates the file. init
  // forwards `onSettingsNotice` to mergeSettings, which fires it right before touching
  // ~/.claude/settings.json — so the notice always precedes the mutation it describes.
  heading(`${BRAND.brand} init — one source for every AI tool this repo uses.\n`);
  const {
    report,
    bytes,
    settings,
    detected,
    warnings,
    profile: profileResult,
    tools: toolsResult,
  } = /** @type {any} */ (
    init({
      targetRoot: process.cwd(),
      noSettings,
      profile,
      settingsPath,
      onSettingsNotice: consentLine,
      tools,
    })
  );
  if (profileResult?.error || toolsResult?.error) {
    console.error(`  ${profileResult?.error ?? toolsResult.error}`);
    process.exitCode = 1;
    return;
  }
  const wrote = report.filter((r) => r.action === "written").map((r) => r.target);
  console.log(`  emitted:  ${wrote.length ? wrote.join(", ") : "(all up to date)"}`);
  const toolOrigin = {
    "--tools": "from --tools",
    config: "recorded in .forge/forge.config.json",
    detected: "Claude + tools found in this repo",
  }[toolsResult.source];
  console.log(
    `  tools:    ${toolsResult.tools === null ? "all" : toolsResult.tools.join(", ")} (${toolOrigin}) — change with \`${BRAND.cli} init --tools <list|all>\``,
  );
  console.log(
    `  source:   AGENTS.md (${bytes} B) — forge owns only the block between <!-- forge:begin --> and <!-- forge:end -->; edit rules in source/, re-run \`${BRAND.cli} sync\``,
  );
  for (const w of [...(warnings ?? []), ...(toolsResult.warning ? [toolsResult.warning] : [])])
    console.warn(`  ! ${w}`);
  // ME-19: sync is non-transactional — if a target failed mid-emit, say so instead of
  // implying every tool is ready, and fail the command.
  const failedTargets = report.filter((r) => r.action === "error");
  if (failedTargets.length) {
    console.error(
      `  status:   PARTIAL — ${failedTargets.length} target(s) failed: ${failedTargets
        .map((r) => r.tool)
        .join(", ")} (re-run \`${BRAND.cli} sync\` after fixing)`,
    );
    process.exitCode = 1;
  }
  if (profileResult?.profile) {
    console.log(`  profile:  ${profileResult.profile} → .forge/forge.config.json`);
    if (profileResult.deprecated) {
      console.error(
        `  warning:  profile "${profileResult.deprecated}" is deprecated — treated as "${profileResult.profile}"`,
      );
    }
  }
  if ((settings?.action === "merged" || settings?.action === "created") && "added" in settings) {
    const verb = settings.action === "created" ? "created" : "merged";
    const what = settings.added.length ? settings.added.join(", ") : "defaults";
    console.log(`  settings: ${verb} ${what} into ${settings.path}`);
    if ("backup" in settings && settings.backup)
      console.log(`            backup: ${settings.backup}`);
  } else if (settings?.action === "unchanged" && "path" in settings) {
    console.log(`  settings: already up to date (${settings.path})`);
  } else if (settings?.action === "skipped") {
    console.log("  settings: skipped (--no-settings)");
  } else if (settings?.action === "error") {
    // RA-04: repo files above were still emitted, but the settings merge FAILED —
    // surface it on stderr and fail the command instead of a quiet exit 0.
    console.error(`  settings: FAILED — ${settings.reason} (repo files were still emitted)`);
    process.exitCode = 1;
  }
  if (settings && "hooksVia" in settings && settings.hooksVia === "plugin")
    console.log(
      `            hooks: wired by the ${BRAND.pkg} plugin — not duplicated in settings.json`,
    );
  if (detected) {
    console.log(`  provider: auto-detected ${detected.name} from ${detected.source}`);
  } else {
    console.log(
      `  provider: none detected — set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or LITELLM_BASE_URL`,
    );
  }
  console.log(`  active:   tools · crew · guards  →  \`${BRAND.cli} catalog\``);
  console.log(`  verify:   \`${BRAND.cli} doctor\``);
  return;
};
HANDLERS.update = async (argv) => {
  const { applyUpdate, applyUpdateTo, updateStatus } = await import("./update.js");
  const json = argv.includes("--json");
  const toIdx = argv.indexOf("--to");
  if (toIdx !== -1) {
    const r = applyUpdateTo(argv[toIdx + 1], {});
    if (json) return console.log(JSON.stringify(r, null, 2));
    heading(`${BRAND.brand} update — pin\n`);
    if (r.ok)
      console.log(
        r.changed
          ? `  pinned ${r.before} → ${r.after} (${r.tag}). ${r.note}`
          : `  already at ${r.tag}. ${r.note}`,
      );
    else if (r.instruction) console.log(`  ${r.reason}:\n    ${r.instruction}`);
    else {
      console.log(`  ${r.reason}`);
      process.exitCode = 1;
    }
    return;
  }
  if (argv.includes("--check")) {
    const s = updateStatus({});
    if (json) return console.log(JSON.stringify(s, null, 2));
    heading(`${BRAND.brand} update — check\n`);
    if (s.unknown)
      console.log(
        `  on v${s.current} (${s.mode}) — can't compare to upstream${s.network === "offline" ? " (offline)" : ""}; update with your installer.`,
      );
    else if (s.behind > 0)
      console.log(`  ${s.behind} commit(s) behind ${s.upstream} — run \`${BRAND.cli} update\`.`);
    else console.log(`  up to date (v${s.current}).`);
    return;
  }
  const r = applyUpdate({});
  if (json) return console.log(JSON.stringify(r, null, 2));
  heading(`${BRAND.brand} update\n`);
  if (r.ok)
    console.log(
      r.changed
        ? `  updated ${r.before} → ${r.after}. ${r.note}`
        : `  already up to date (v${BRAND.version}).`,
    );
  else if (r.instruction) console.log(`  ${r.reason}:\n    ${r.instruction}`);
  else {
    console.log(`  ${r.reason}`);
    process.exitCode = 1;
  }
  return;
};
HANDLERS.stack = async (argv) => {
  // Dynamic: read THIS repo's manifests and report its real stack (not a static menu).
  const { detectStack } = await import("./stack.js");
  const s = detectStack(process.cwd());
  if (argv.includes("--json")) return console.log(JSON.stringify(s, null, 2));
  heading(`${BRAND.brand} stack — detected from this repo's manifests\n`);
  const row = (label, arr) =>
    arr.length ? console.log(`  ${`${label}:`.padEnd(11)} ${arr.join(", ")}`) : undefined;
  if (!s.languages.length) {
    console.log("  no known stack detected (no package.json/go.mod/Cargo.toml/… found).");
    return;
  }
  row("languages", s.languages);
  row("frameworks", s.frameworks);
  row("pkg mgrs", s.packageManagers);
  row("test", s.testCommands);
  // Runners that are only installed (a devDependency) are inventory, never a required suite.
  row(
    "available",
    (s.testInventory ?? []).filter((c) => !s.testCommands.includes(c)),
  );
  row("tools", s.tools);
  row("notes", s.notes);
  console.log(`  ${"evidence:".padEnd(11)} ${s.evidence.join(", ")}`);
  return;
};
HANDLERS.radar = async (argv) => {
  // Dependency-currency rings from live registry evidence (mizan — every ring ships its
  // evidence; missing evidence never upgrades a dep). Injectable/cached/offline-honest.
  const { radarScan } = await import("./radar.js");
  const offline = argv.includes("--offline");
  const refresh = argv.includes("--refresh");
  const r = await radarScan(process.cwd(), { offline, refresh });
  if (argv.includes("--json")) return console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.log(`${BRAND.brand} radar — ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  heading(`${BRAND.brand} radar — dependency currency (rings from registry evidence)\n`);
  const deps = r.deps ?? {};
  const names = Object.keys(deps);
  if (!names.length) {
    console.log("  no Node dependencies to probe (no package.json deps found).");
  } else {
    const roleFor = (ring) =>
      ring === "adopt" ? "ok" : ring === "trial" ? "accent" : ring === "hold" ? "err" : "warn";
    // Order by ring severity, then by usage (stakes), then name — the risky, load-bearing first.
    const rank = { hold: 0, assess: 1, trial: 2, adopt: 3 };
    names.sort(
      (a, b) =>
        (rank[deps[a].ring] ?? 9) - (rank[deps[b].ring] ?? 9) ||
        (deps[b].usage ?? 0) - (deps[a].usage ?? 0) ||
        (a < b ? -1 : 1),
    );
    const rows = names.map((n) => {
      const d = deps[n];
      return [
        paint(d.ring, roleFor(d.ring)),
        n,
        `${d.installed ?? "?"}→${d.latest ?? "?"}`,
        bar(d.score ?? 0),
        (d.reasons ?? []).slice(0, 2).join("; ") || paint("no risk signals", "dim"),
      ];
    });
    console.log(table(rows));
  }
  if (r.stale)
    console.log(
      `\n  ${paint(`served from cache (${Math.round(r.ageH)}h old) — ${offline ? "--offline" : "registry unreachable"}`, "dim")}`,
    );
  else if (r.source === "cache")
    console.log(`\n  ${paint("served from cache (within TTL)", "dim")}`);
  for (const s of r.skipped ?? []) console.log(`  ${paint(`${s.language}: ${s.reason}`, "dim")}`);
  return;
};
HANDLERS.catalog = async () => {
  const { catalog } = await import("./init.js");
  const c = catalog();
  heading(`${BRAND.brand} catalog — Start Here\n`);
  console.log("  TOOLS (model-invoked skills)");
  for (const t of c.tools) console.log(`    ${t.name.padEnd(18)} ${t.why.slice(0, 66)}`);
  console.log(`\n  CREW (isolated sub-agents)   ${c.crew.join(" · ")}`);
  console.log(`  GUARDS (enforced hooks)      ${c.guards.join(" · ")}`);
  if (c.taste?.length)
    console.log(
      `  TASTE (design directions)    ${c.taste.join(" · ")}  →  \`${BRAND.cli} taste <style>\``,
    );
  if (c.cortex) console.log(`\n  CORTEX (self-correcting memory)  ${c.cortex}`);
  if (c.preflight) console.log(`  PREFLIGHT (before you spend tokens)  ${c.preflight}`);
  console.log(`\n  Full detail: ARCHITECTURE.md · per-tool config: \`${BRAND.cli} sync\``);
  return;
};
HANDLERS.taste = async (argv) => {
  const t = await import("./taste.js");
  const style = argv[1];
  if (!style) {
    console.log(
      `${BRAND.brand} taste — pick ONE visual direction per repo (every tool then follows it):\n`,
    );
    for (const s of t.list()) console.log(`  ${s}`);
    console.log(`\n  apply: \`${BRAND.cli} taste <style>\`  (writes a managed DESIGN.md)`);
    return;
  }
  const res = t.apply(style, process.cwd());
  if (res.ok) {
    console.log(
      `  DESIGN.md ${res.action} → taste: ${res.style}. Every AI tool now builds in this direction.`,
    );
  } else {
    console.error(`  ${res.reason}`);
    process.exitCode = 1;
  }
  return;
};
HANDLERS.sync = async () => {
  const { sync } = await import("./sync.js");
  const { report, warnings, bytes, partial, status, tools } = sync({
    targetRoot: process.cwd(),
  });
  heading(`${BRAND.brand} sync — one source → every tool\n`);
  if (tools !== null)
    console.log(
      `  tools: ${tools.length ? tools.join(", ") : "none"} + AGENTS.md (recorded by \`${BRAND.cli} init\`; change with \`${BRAND.cli} init --tools <list|all>\`)\n`,
    );
  for (const r of report) {
    console.log(
      `  ${r.action.padEnd(16)} ${String(r.target).padEnd(22)} ${r.tool}${r.note ? `  · ${r.note}` : ""}`,
    );
  }
  for (const w of warnings) console.warn(`  ! ${w}`);
  const written = report.filter((r) => r.action === "written").length;
  console.log(`\n${written} file(s) written · canonical ${bytes} B · status: ${status}`);
  // ME-19: a mid-way target failure must NOT exit 0 as if every tool were configured.
  if (partial) {
    const failed = report.filter((r) => r.action === "error");
    console.error(
      `  ! PARTIAL sync — ${failed.length} target(s) failed: ${failed.map((r) => r.tool).join(", ")}`,
    );
    process.exitCode = 1;
  }
  return;
};
HANDLERS.doctor = async (argv) => {
  const { doctor } = await import("./doctor.js");
  const fix = argv.includes("--fix");
  const { results, failed, repairs, health } = doctor({
    targetRoot: process.cwd(),
    fix,
  });
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ results, failed, repairs, health }, null, 2));
    if (failed) process.exitCode = 1;
    return;
  }
  const icon = {
    ok: paint("✓", "ok"),
    warn: paint("!", "warn"),
    fail: paint("✗", "err"),
    na: paint("–", "dim"), // not built/applicable — neutral, never a failure
  };
  heading(`${BRAND.brand} doctor\n`);
  if (fix) {
    if (repairs.length) {
      console.log("  repairs:");
      for (const rep of repairs)
        console.log(
          `  ${rep.ok ? paint("✓", "ok") : paint("✗", "err")} ${rep.label}${rep.ok ? "" : ` — ${rep.error}`}`,
        );
      console.log("");
    } else {
      console.log(`  ${paint("✓", "ok")} nothing to repair\n`);
    }
  }
  for (const r of results) console.log(`  ${icon[r.status]} ${r.label.padEnd(16)} ${r.note}`);
  // Subsystem health in the standard vocabulary (P1-06) — a degraded control stays visible.
  const healthLine = Object.entries(health)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
  console.log(`\n  health: ${healthLine}`);
  console.log(
    `\n${failed === 0 ? paint("all clear", "ok") : paint(`${failed} problem(s)`, "err")}`,
  );
  if (failed) process.exitCode = 1;
  return;
};
HANDLERS.docs = async (argv) => {
  const json = argv.includes("--json");
  const sub = argv.slice(1).filter((a) => !a.startsWith("--"))[0] || "check";
  // `sync` sweeps THIS repo's diff for stale doc mentions (advisory by default —
  // it runs mid-repair from the completion gate's checklist; --strict for CI).
  if (sub === "sync") {
    const { docsSyncReport, renderDocsSync } = await import("./docs_sync.js");
    const baseIdx = argv.indexOf("--base");
    const r = docsSyncReport(process.cwd(), {
      base: baseIdx >= 0 ? argv[baseIdx + 1] : undefined,
    });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(renderDocsSync(r));
    if (r.error || (argv.includes("--strict") && r.stale.length)) process.exitCode = 1;
    return;
  }
  // `impact` — reusable documentation-impact graph: which documented surfaces
  // reference the entities THIS diff changed (advisory; --strict exits 1).
  if (sub === "impact") {
    const { docsImpact, renderDocsImpact } = await import("./docs_impact.js");
    const { newestBaseline } = await import("./docs_sync.js");
    const staged = argv.includes("--staged");
    const sinceIdx = argv.indexOf("--since");
    const base = sinceIdx >= 0 ? argv[sinceIdx + 1] : newestBaseline(process.cwd()) || undefined;
    const mcIdx = argv.indexOf("--min-confidence");
    const minConfidence = mcIdx >= 0 ? Number(argv[mcIdx + 1]) : 0;
    const r = docsImpact(process.cwd(), { base, staged, minConfidence });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(renderDocsImpact(r));
    if (argv.includes("--strict") && r.impacted.length) process.exitCode = 1;
    return;
  }
  // `render` — regenerate the machine-owned doc surfaces (command tables, MCP tool
  // table, count phrases, mermaid theme, repo map) from the registries. The write-side
  // twin of `check`: check tells you docs drifted, render is the one-command repair.
  if (sub === "render") {
    const { renderDocs } = await import("./docs_render.js");
    const check = argv.includes("--check");
    const r = renderDocs(undefined, { write: !check });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      if (check && !r.ok) process.exitCode = 1;
      return;
    }
    for (const f of r.files)
      console.log(
        `  ${check ? "stale" : "rendered"}: ${f.file}  ${paint(`(${f.why.join(", ")})`, "dim")}`,
      );
    for (const m of r.missing)
      console.error(`  ${paint(`missing markers for block ${m.name} in ${m.file}`, "err")}`);
    if (!r.files.length && !r.missing.length) console.log("  all generated doc surfaces current");
    if (check && !r.ok) process.exitCode = 1;
    return;
  }
  // `check` — self-check of the forge package's own docs against its code (commands
  // table, env reads, MCP registry, CHANGELOG).
  const { docsCheck } = await import("./docs_check.js");
  const r = docsCheck();
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  heading(`${BRAND.brand} docs check — docs↔code drift\n`);
  if (!r.issues.length) console.log(`  ✓ docs and code agree (${r.checked.join(", ")})`);
  for (const i of r.issues)
    console.log(`  ${i.severity === "error" ? "✗" : "!"} [${i.check}] ${i.detail}`);
  if (!r.ok) {
    console.log(`\n${r.issues.filter((i) => i.severity === "error").length} problem(s)`);
    process.exitCode = 1;
  }
  // Advisory: if the working tree changed a documented entity, point at the impacted
  // prose. Never fails the check (fail-open); best-effort, so a git-less tree is silent.
  try {
    const { docsImpact } = await import("./docs_impact.js");
    const imp = docsImpact(process.cwd());
    if (imp.impacted.length)
      console.log(
        `\n  ! ${imp.summary.impactedFiles} doc file(s) may be stale from this diff — run \`${BRAND.cli} docs impact\` to review`,
      );
  } catch {}
  return;
};
HANDLERS.integrations = async (argv) => {
  const { listIntegrations, planIntegration, addIntegration, removeIntegration } = await import(
    "./integrations.js"
  );
  const sub = argv[1];
  if (sub === "add") {
    const name = argv[2];
    const plan = planIntegration(name, { targetRoot: process.cwd() });
    if (!plan.ok) {
      console.error(plan.reason);
      process.exitCode = 1;
      return;
    }
    if (!argv.includes("--yes")) {
      heading(`${BRAND.brand} integrations — add ${name}\n`);
      console.log(`  This adds a THIRD-PARTY MCP server to the MCP config of this repo's tools:`);
      console.log(`    package: ${plan.pkg}`);
      console.log(`    network: ${plan.network}`);
      console.log(`    purpose: ${plan.why}`);
      console.log(`    writes:  ${plan.writes.join(", ")}`);
      console.log(`    records: .forge/forge.config.json (mcp.integrations — the managed set)`);
      console.log(
        `\n  Not installed. Re-run with --yes to apply:  ${BRAND.cli} integrations add ${name} --yes`,
      );
      console.log(
        `  A same-name server you configured yourself is never overwritten unless you also pass --adopt.`,
      );
      return;
    }
    const res = addIntegration(name, {
      targetRoot: process.cwd(),
      adopt: argv.includes("--adopt"),
    });
    heading(`${BRAND.brand} integrations — add ${name}\n`);
    if (res.ok === false) {
      console.error(`  ${res.reason}`);
      process.exitCode = 1;
      return;
    }
    const wrote = res.rows.filter((x) => x.action === "written").map((x) => x.target);
    console.log(`  added ${name} → ${wrote.length ? wrote.join(", ") : "(all up to date)"}`);
    for (const r of res.rows.filter((x) => x.action === "skipped"))
      console.log(`  ! ${r.target}: ${r.note}`);
    return;
  }
  if (sub === "remove") {
    const name = argv[2];
    const res = removeIntegration(name, { targetRoot: process.cwd() });
    heading(`${BRAND.brand} integrations — remove ${name}\n`);
    if (res.ok === false) {
      console.error(`  ${res.reason}`);
      process.exitCode = 1;
      return;
    }
    if (!res.removed) {
      console.log(`  ${name} is not installed — nothing to remove`);
      return;
    }
    const wrote = res.rows.filter((x) => x.action === "written").map((x) => x.target);
    console.log(`  removed ${name} → ${wrote.length ? wrote.join(", ") : "(nothing on disk)"}`);
    for (const r of res.rows.filter((x) => x.action === "skipped"))
      console.log(`  ! ${r.target}: ${r.note}`);
    return;
  }
  // Default: list what's available.
  heading(`${BRAND.brand} integrations — opt-in third-party MCP servers\n`);
  for (const it of listIntegrations()) {
    console.log(`  ${it.name.padEnd(12)} ${it.why}  (${it.pkg})`);
  }
  console.log(`\n  Add one with:     ${BRAND.cli} integrations add <name>`);
  console.log(`  Remove one with:  ${BRAND.cli} integrations remove <name>`);
  return;
};
HANDLERS.recall = async (argv) => {
  const r = await import("./recall.js");
  const store = r.defaultStore();
  const sub = argv[1] || "list";
  if (sub === "list") {
    const items = r.list(store);
    console.log(items.length ? items.map((s) => `  - ${s}`).join("\n") : "  (no memories yet)");
  } else if (sub === "add") {
    const name = argv[2];
    const body = argv.slice(3).join(" ");
    if (!name || !body) {
      console.error('usage: forge recall add "<name>" "<fact>"');
      process.exitCode = 1;
      return;
    }
    const res = r.add(store, name, body);
    if (res.ok) {
      // Shadow the fact into the PERSONAL ledger beside the global store (repo
      // promotion stays an explicit act — docs/plans/substrate-v2/02-team-memory.md §3).
      // Best-effort INCLUDING the imports: a broken bridge module must never turn an
      // already-persisted fact into a CLI failure.
      try {
        const { join } = await import("node:path");
        const { shadowFact } = await import("./ledger_bridge.js");
        shadowFact(join(store, "ledger"), name, body);
      } catch {}
      // Re-index after the shadow so a ledger-only store's MEMORY.md includes the fact
      // (its only copy now lives in the ledger, written just above).
      r.reindex(store);
    }
    console.log(res.ok ? `  saved: ${res.slug}` : `  ${res.reason}`);
    if (!res.ok) process.exitCode = 1;
  } else if (sub === "consolidate") {
    const { removed, kept } = r.consolidate(store);
    try {
      // Deleted duplicates must not survive as live claims in the shadow ledger.
      const { join } = await import("node:path");
      const { reconcileFacts } = await import("./ledger_bridge.js");
      reconcileFacts(store, join(store, "ledger"));
    } catch {}
    console.log(`  consolidated: ${removed} duplicate(s) removed, ${kept} kept`);
  } else {
    console.error(`recall: unknown subcommand "${sub}" (list | add | consolidate)`);
    process.exitCode = 1;
  }
  return;
};
HANDLERS.atlas = async (argv) => {
  const a = await import("./atlas.js");
  const sub = argv[1] || "build";
  const need = () => {
    if (a.load()) return a.load();
    console.error("  no index — run `forge atlas build` first");
    process.exitCode = 1;
    return null;
  };
  if (sub === "build") {
    const at = a.build({ root: process.cwd() });
    console.log(
      `  indexed ${at.symbols.length} symbols in ${at.files} files → .forge/atlas.json${at.capped ? " (capped)" : ""}`,
    );
  } else if (sub === "query") {
    const at = need();
    if (!at) return;
    // Ranked: exact definitions first, path-only (qname) matches last.
    const hits = a.query(at, argv.slice(2).join(" "));
    console.log(
      hits.length
        ? hits
            .slice(0, 30)
            .map((s) => `  ${s.file}:${s.line}  ${s.kind} ${s.name}`)
            .join("\n") + (hits.length > 30 ? `\n  … ${hits.length - 30} more` : "")
        : "  no match",
    );
  } else if (sub === "has") {
    const at = need();
    if (!at) return;
    const name = argv[2];
    const yes = a.has(at, name);
    console.log(`  ${yes ? "✓ defined" : "✗ not found (possible hallucinated symbol)"}: ${name}`);
    if (!yes) process.exitCode = 1;
  } else {
    console.error(`atlas: unknown subcommand "${sub}" (build | query | has)`);
    process.exitCode = 1;
  }
  return;
};
HANDLERS.collide = async (argv) => {
  const { collideReport } = await import("./collide.js");
  const json = argv.includes("--json");
  const files = argv.slice(1).filter((a) => !a.startsWith("--"));
  const r = collideReport(process.cwd(), { files });
  if (json) return console.log(JSON.stringify(r, null, 2));
  heading(`${BRAND.brand} collide — parallel-session conflict radar\n`);
  if (!r.mine.length) return console.log("  working tree clean — nothing to collide with");
  console.log(paint(`  checking ${r.mine.length} file(s) in play`, "dim"));
  if (!r.sessions.length)
    return console.log("  no recent foreign session touched these files or their import neighbors");
  console.log(`  collision risk ${bar(r.risk, 8)} ${r.risk.toFixed(2)}\n`);
  for (const s of r.sessions.slice(0, 8)) {
    console.log(
      `  ${paint(s.author || "(unknown)", "accent")}  day ${s.day}  ${paint(`rec ${s.rec.toFixed(2)}`, "dim")}`,
    );
    for (const f of s.direct) console.log(`    ${paint("direct ", "warn")} ${f}`);
    for (const f of s.coupled) console.log(`    ${paint("coupled", "dim")} ${f}`);
  }
  console.log(
    paint("\n  advisory — coordinate or pull their ledger before editing the shared files", "dim"),
  );
  return;
};
HANDLERS.rank = async (argv) => {
  const { rankReport } = await import("./rank.js");
  const json = argv.includes("--json");
  const ti = argv.indexOf("--top");
  const top = ti >= 0 ? Math.max(1, Number(argv[ti + 1]) || 15) : 15;
  const r = rankReport(process.cwd(), { top });
  if (!r.built) {
    console.error(`  no index — run \`${BRAND.cli} atlas build\` first`);
    process.exitCode = 1;
    return;
  }
  if (json) return console.log(JSON.stringify(r, null, 2));
  heading(`${BRAND.brand} rank — load-bearing code\n`);
  console.log(paint(`  graph: ${r.nodes} nodes, ${r.edges} edges`, "dim"));
  console.log(paint("\n  files (hazard = centrality × 1+history):", "accent"));
  const maxHazard = r.topFiles[0]?.hazard || 1;
  for (const f of r.topFiles)
    console.log(
      `  ${bar(f.hazard / maxHazard, 8)} ${f.hazard.toFixed(3)}  ${f.file}${
        f.incidents ? paint(`  (${f.incidents} past incident(s))`, "warn") : ""
      }`,
    );
  console.log(paint("\n  symbols (centrality):", "accent"));
  for (const s of r.topSymbols)
    console.log(`  ${s.score.toFixed(6)}  ${s.name}  ${paint(s.file, "dim")}`);
  if (r.cycles.length) {
    console.log(paint(`\n  circular imports: ${r.cycles.length} cluster(s)`, "warn"));
    for (const c of r.cycles.slice(0, 5)) console.log(`    [${c.length}] ${c.join(" ⇄ ")}`);
  } else {
    console.log(paint("\n  circular imports: none", "dim"));
  }
  if (r.chokepoints.length) {
    console.log(paint("\n  chokepoints (removal splits the import graph):", "accent"));
    for (const c of r.chokepoints.slice(0, 10))
      console.log(`    ${c.file}  ${paint(`splits off ${c.splits} subtree(s)`, "dim")}`);
  }
  return;
};
HANDLERS.scan = async (argv) => {
  const { scan } = await import("./skillgate.js");
  const target = argv[1];
  if (!target) {
    console.error("usage: forge scan <SKILL.md | .mcp.json | path>");
    process.exitCode = 1;
    return;
  }
  const r = scan(target);
  heading(`${BRAND.brand} scan — skill-gate (${r.scanner})\n`);
  if (r.findings?.length) {
    for (const f of r.findings) console.log(`  [${f.sev}] ${f.msg}`);
  } else if (r.raw) {
    console.log(`  ${r.raw.trim().split("\n").slice(-6).join("\n  ")}`);
  } else {
    console.log("  no obvious red flags");
  }
  console.log(
    `\n  ${r.verdict || (r.critical ? "BLOCKED — critical finding" : "no critical signature detected — not a safety certification")}`,
  );
  if (r.critical) process.exitCode = 1;
  return;
};
HANDLERS.remember = async (argv) => {
  const b = await import("./brain.js");
  const name = argv[1];
  const body = argv.slice(2).join(" ");
  if (!name || !body) {
    console.error('usage: forge remember "<name>" "<fact>"');
    process.exitCode = 1;
    return;
  }
  const res = b.remember(b.brainStore(process.cwd()), name, body);
  if (res.ok) {
    // Brain is repo-scoped and git-committable → shadow into the REPO ledger.
    try {
      const { shadowFact } = await import("./ledger_bridge.js");
      const { repoLedger } = await import("./ledger_store.js");
      shadowFact(repoLedger(process.cwd()), name, body);
    } catch {}
    // Rebuild the inlined index after the shadow so a ledger-only brain's
    // AGENTS.brain.md includes the fact (its only copy now lives in the ledger).
    b.buildIndex(b.brainStore(process.cwd()));
  }
  console.log(
    res.ok
      ? `  remembered: ${res.slug} — run \`forge sync\` to inline it into every tool`
      : `  ${res.reason}`,
  );
  if (!res.ok) process.exitCode = 1;
  return;
};
HANDLERS.brain = async () => {
  const b = await import("./brain.js");
  const store = b.brainStore(process.cwd());
  const idx = b.buildIndex(store);
  const items = b.list(store);
  heading(`${BRAND.brand} brain — portable project memory\n`);
  console.log(
    items.length
      ? items.map((s) => `  - ${s}`).join("\n")
      : '  (no facts yet — forge remember "<name>" "<fact>")',
  );
  console.log(
    `\n  ${idx.indexed} inlined into AGENTS.md${idx.overflow ? `, ${idx.overflow} in overflow` : ""} · stored in .forge/brain/`,
  );
  return;
};
HANDLERS.spec = async (argv) => {
  const s = await import("./speclock.js");
  const sub = argv[1] || "check";
  if (sub === "init") {
    const { execFileSync } = await import("node:child_process");
    try {
      // Pinned (verified 2026-07-05) — never @latest for code we execute; re-verify via dev-radar.
      execFileSync("npx", ["-y", "@fission-ai/openspec@1.5.0", "init"], {
        stdio: "inherit",
      });
    } catch {
      console.log(
        "  OpenSpec not run. Scaffold spec-driven dev:\n    npx -y @fission-ai/openspec init   # lightweight (default)\n    # or GitHub Spec Kit for heavier/governed projects",
      );
    }
    return;
  }
  if (sub === "lock") {
    const { count } = s.snapshot(process.cwd());
    console.log(`  spec-lock: snapshotted ${count} spec(s) → .forge/spec-lock.json`);
    return;
  }
  const r = s.check(process.cwd());
  heading(`${BRAND.brand} spec check\n`);
  if (r.note) console.log(`  ${r.note}`);
  else if (r.drift.length) {
    for (const d of r.drift) {
      console.log(`  ✗ ${d.spec} claims \`${d.symbol}\` — no longer defined in the code`);
    }
  } else console.log("  ✓ no drift — every claimed symbol still exists");
  console.log(`\n  ${r.ok ? "PASS" : "DRIFT — update the spec or restore the symbol"}`);
  if (!r.ok) process.exitCode = 1;
  return;
};
HANDLERS.harden = async () => {
  const { harden } = await import("./harden.js");
  const r = harden({ targetRoot: process.cwd() });
  heading(`${BRAND.brand} harden\n`);
  console.log(`  gitleaks:            ${r.gitleaks}`);
  console.log(`  pre-commit gate:     ${r.precommit}`);
  console.log(
    `  sandbox settings:    ${r.sandbox} — merge into ~/.claude/settings.json to enable (84% fewer prompts)`,
  );
  return;
};
HANDLERS.precommit = async (argv) => {
  // The commit-level rung of the gate lattice (turn ⊂ commit ⊂ PR): the harden-installed
  // pre-commit hook execs this, and it can be run by hand before committing. Exit code
  // carries the decision (1 = refuse the commit); fail-open inside commitGate.
  const { commitGate, renderCommitGate } = await import("./commit_gate.js");
  const r = commitGate(process.cwd());
  if (argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.allow) process.exitCode = 1;
    return;
  }
  heading(`${BRAND.brand} precommit — commit-level completeness + secret gate\n`);
  console.log(renderCommitGate(r));
  if (!r.allow) process.exitCode = 1;
  return;
};
HANDLERS.cortex = async (argv) => {
  const c = await import("./cortex.js");
  const root = process.cwd();
  const nowDay = Math.floor(Date.now() / 86400000);
  const sub = argv[1] || "status";
  if (sub === "why") {
    const key = argv[2];
    if (!key) {
      console.error("usage: forge cortex why <symbol|file>");
      process.exitCode = 1;
      return;
    }
    const { block, selected } = c.lessonsForContext(
      root,
      { symbols: [key], files: [key], keywords: [key] },
      { nowDay },
    );
    console.log(selected.length ? block : `  no lessons for ${key} yet`);
    return;
  }
  const s = c.summary(root, nowDay);
  heading(`${BRAND.brand} cortex — self-correcting project memory\n`);
  console.log(
    `  lessons: ${s.total}  (active ${s.active} · candidate ${s.candidate} · quarantined ${s.quarantined} · retired ${s.retired})`,
  );
  if (s.topActive.length) {
    console.log("\n  top active (by confidence):");
    for (const t of s.topActive)
      console.log(`    ${bar(t.confidence, 8)} ${t.confidence.toFixed(2)}  ${t.id}`);
  } else {
    console.log("\n  (no active lessons yet — Cortex learns from corrections as you work)");
  }
  console.log(paint("\n  stored in .forge/lessons/ (git-committable, auditable)", "dim"));
  return;
};
HANDLERS.deja = async (argv) => {
  const { dejaFromLedger } = await import("./deja.js");
  const { claimText, val } = await import("./ledger.js");
  const { epochDay } = await import("./util.js");
  const json = argv.includes("--json");
  const task = argv
    .slice(1)
    .filter((a) => a !== "--json")
    .join(" ");
  if (!task) {
    console.error('usage: forge deja "<task you are about to start>" [--json]');
    process.exitCode = 1;
    return;
  }
  const nowDay = epochDay();
  const hits = dejaFromLedger(process.cwd(), task, { nowDay, budget: 8 });
  if (json)
    return console.log(
      JSON.stringify(
        hits.map((h) => ({
          id: h.claim.id,
          kind: h.claim.kind,
          score: h.score,
          verified: val(h.claim, nowDay) > 0.5,
          day: h.claim.provenance?.t ?? 0,
          gist: claimText(h.claim).slice(0, 120),
        })),
        null,
        2,
      ),
    );
  heading(`${BRAND.brand} déjà vu — have you done this before?\n`);
  if (!hits.length) return console.log("  no similar prior task in memory — this looks new.");
  for (const h of hits) {
    const verified = val(h.claim, nowDay) > 0.5;
    console.log(
      `  ${bar(h.score, 8)} ${h.score.toFixed(3)}  ${paint(h.claim.kind.padEnd(9), "accent")} ${verified ? paint("verified", "ok") : paint("attempted", "warn")}  day ${h.claim.provenance?.t ?? 0}  ${claimText(h.claim).replace(/\s+/g, " ").trim().slice(0, 80)}`,
    );
  }
  return;
};
HANDLERS.preflight = async (argv) => {
  const { preflightRepo, clarifyBlock } = await import("./preflight.js");
  const json = argv.includes("--json");
  const task = argv
    .slice(1)
    .filter((a) => a !== "--json")
    .join(" ");
  if (!task) {
    console.error('usage: forge preflight "<task description>" [--json]');
    process.exitCode = 1;
    return;
  }
  const r = preflightRepo(process.cwd(), task);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  heading(`${BRAND.brand} preflight — assumption check\n`);
  console.log(
    `  info-gap: ${r.gap.toFixed(2)}  · completeness ${r.assumption.completeness.toFixed(2)}  (referenced ${r.entities.symbols.length} symbol(s), ${r.entities.files.length} file(s))`,
  );
  const block = clarifyBlock(r);
  console.log(
    block ? `\n${block}` : "\n  ✓ everything this task names is grounded in the codebase.",
  );
  return;
};
HANDLERS.impact = async (argv) => {
  const { predictImpact } = await import("./substrate.js");
  const json = argv.includes("--json");
  const basic = argv.includes("--basic");
  // Default is the focused reverse walk. --all-relations adds the paper's sibling/forward
  // rules: recall 1.00, but on this repo the median answer goes from 15 files to 78.
  const all = argv.includes("--all-relations");
  const FLAGS = new Set(["--json", "--basic", "--all-relations"]);
  const target = argv
    .slice(1)
    .filter((a) => !FLAGS.has(a))
    .join(" ");
  if (!target) {
    console.error("usage: forge impact <symbol|file> [--json] [--basic] [--all-relations]");
    process.exitCode = 1;
    return;
  }
  const { IMPACT_RELATIONS } = await import("./atlas.js");
  const r = predictImpact(process.cwd(), target, {
    basic,
    ...(all ? { relations: IMPACT_RELATIONS } : {}),
  });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  heading(`${BRAND.brand} impact — blast radius${basic ? "" : " (hazard-aware)"}\n`);
  console.log(`  target: ${target}  ${r.found ? "✓ found" : "not found"}`);
  const rel = r.relations || {};
  const parts = ["reverse", "sibling", "forward", "llm-verified"]
    .filter((k) => rel[k])
    .map((k) => `${k} ${rel[k]}`);
  console.log(
    `  impacted files: ${r.impactedFiles.length}${parts.length ? `  (nodes: ${parts.join(" · ")})` : ""}`,
  );
  for (const file of r.impactedFiles.slice(0, 20)) console.log(`    - ${file}`);
  if (r.impactedFiles.length > 20) console.log(`    … ${r.impactedFiles.length - 20} more`);
  // Completeness: a blast radius is only as good as the graph under it — say when it isn't.
  if (r.capped)
    console.log(
      paint(
        `  ! graph capped: ${r.skippedFiles} file(s) not indexed — this list may be incomplete`,
        "warn",
      ),
    );
  if (r.ambiguousRefs)
    console.log(
      paint(
        `  ! ${r.ambiguousRefs} reference(s) to this target's name(s) matched more than one definition and were not linked`,
        "warn",
      ),
    );
  if (r.unresolvedImports)
    console.log(
      paint(
        `  · ${r.unresolvedImports} local import(s) in the repo did not resolve to a file`,
        "dim",
      ),
    );
  return;
};
HANDLERS.substrate = async (argv) => {
  const { renderSubstrate, substrateCheck } = await import("./substrate.js");
  const json = argv.includes("--json");
  const task = argv
    .slice(1)
    .filter((a) => a !== "--json")
    .join(" ");
  if (!task) {
    console.error('usage: forge substrate "<task>" [--json]');
    process.exitCode = 1;
    return;
  }
  const r = substrateCheck(process.cwd(), task);
  console.log(json ? JSON.stringify(r, null, 2) : renderSubstrate(r));
  return;
};
HANDLERS.config = async (argv) => {
  const sub = argv[1] || "show";
  const { loadProviders, activeProvider, setProvider, addProvider, listProviders, applyRoute } =
    await import("./providers.js");
  const json = argv.includes("--json");
  if (sub === "show") {
    const prov = activeProvider(process.cwd());
    const config = loadProviders(process.cwd());
    if (json)
      return console.log(JSON.stringify({ active: config.active, provider: prov }, null, 2));
    heading(`${BRAND.brand} config\n`);
    console.log(`  provider:  ${prov.name} (${prov.label || prov.name})`);
    if (prov._autoDetected) console.log(`  detected:  auto (from ${prov._source})`);
    console.log(`  base URL:  ${prov.baseUrl}`);
    console.log(
      `  env key:   ${prov.envKey || "(none)"}${prov.envKey ? (process.env[prov.envKey] ? " ✓ set" : " ✗ not set") : ""}`,
    );
    console.log(`  models:`);
    for (const [tier, id] of Object.entries(prov.models || {}))
      console.log(`    ${tier.padEnd(8)} ${id}`);
    return;
  }
  if (sub === "providers") {
    const list = listProviders(process.cwd());
    if (json) return console.log(JSON.stringify(list, null, 2));
    heading(`${BRAND.brand} config providers\n`);
    for (const p of list)
      console.log(
        `  ${p.active ? "▸" : " "} ${p.name.padEnd(14)} ${p.label.padEnd(20)} ${p.envKey ? (p.hasKey ? "✓ key set" : "✗ key missing") : ""}`,
      );
    console.log(`\n  switch: \`${BRAND.cli} config provider <name>\``);
    return;
  }
  if (sub === "provider") {
    const name = argv[2];
    if (!name) {
      console.error(
        `usage: ${BRAND.cli} config provider <name>   |   ${BRAND.cli} config provider add <name> --base-url <url> [--key-env <VAR>]`,
      );
      process.exitCode = 1;
      return;
    }
    if (name === "add") {
      const addName = argv[3];
      const flagVal = (f) => {
        const i = argv.indexOf(f);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const baseUrl = flagVal("--base-url");
      const envKey = flagVal("--key-env");
      const label = flagVal("--label");
      const r = addProvider(process.cwd(), addName, {
        baseUrl,
        envKey,
        label,
      });
      if (!r.ok) {
        console.error(`  ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  added provider "${addName}" → ${r.provider.baseUrl}`);
      return;
    }
    const r = setProvider(process.cwd(), name);
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  switched to provider "${name}" (${r.provider.label || name})`);
    return;
  }
  if (sub === "model") {
    const tier = argv[2];
    if (!tier) {
      console.error(`usage: ${BRAND.cli} config model <haiku|sonnet|opus|fable>`);
      process.exitCode = 1;
      return;
    }
    const r = applyRoute(tier);
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  model set to ${r.model} (${r.modelId})${r.prev ? ` — was: ${r.prev}` : ""}`);
    console.log(`  written to ${r.path}`);
    return;
  }
  if (sub === "gateway") {
    const { emitGatewayConfig } = await import("./route.js");
    const result = emitGatewayConfig(process.cwd());
    if (typeof result === "object" && !result.ok) {
      console.log(`  ${result.reason}`);
      return;
    }
    console.log(`  wrote ${result}`);
    console.log(`\n  setup LiteLLM gateway:`);
    console.log(`    1. pip install "litellm[proxy]"    # pin an exact verified version`);
    console.log(`    2. litellm --config litellm.config.yaml`);
    console.log(`    3. export ANTHROPIC_BASE_URL=http://localhost:4000`);
    console.log(`\n  then switch to the gateway provider:`);
    console.log(`    ${BRAND.cli} config provider litellm`);
    console.log(`\n  routing flows through: forge route → tier alias → LiteLLM → model`);
    return;
  }
  if (sub === "setup") {
    const { providerStatus, listDetectedProviders } = await import("./providers.js");
    const prov = activeProvider(process.cwd());
    const status = providerStatus(process.cwd());
    const detected = listDetectedProviders();
    heading(`${BRAND.brand} config setup\n`);
    console.log(`  active provider: ${prov.name} (${prov.label || prov.name})`);
    if (prov._autoDetected) console.log(`  source: auto-detected from ${prov._source}`);
    console.log();
    for (const c of status.checks) {
      console.log(`  ${c.ok ? "✓" : "✗"} ${c.detail}`);
    }
    console.log(`\n  environment:`);
    for (const e of status.envScan) {
      console.log(`  ${e.set ? "✓" : "·"} ${e.key}${e.set ? " (set)" : ""}`);
    }
    if (detected.length) {
      console.log(`\n  available providers (auto-detected):`);
      for (const d of detected) {
        console.log(`    ${d.name.padEnd(18)} ${d.label.padEnd(24)} via ${d.source}`);
      }
    }
    console.log(`\n  Anthropic Console API key:`);
    console.log(`    1. Go to console.anthropic.com/settings/keys`);
    console.log(`    2. Create a key, then:  export ANTHROPIC_API_KEY=sk-ant-...`);
    console.log(`\n  OpenRouter API key:`);
    console.log(`    1. Go to openrouter.ai/keys`);
    console.log(`    2. Create a key, then:  export OPENROUTER_API_KEY=sk-or-...`);
    console.log(`\n  LiteLLM hosted gateway (no admin access needed):`);
    console.log(`    export LITELLM_BASE_URL=https://your-gateway.example.com`);
    console.log(`    export LITELLM_API_KEY=sk-...    # or uses ANTHROPIC_API_KEY`);
    console.log(`\n  LiteLLM self-hosted gateway:`);
    console.log(`    ${BRAND.cli} config gateway    # emit litellm.config.yaml`);
    console.log(`    ${BRAND.cli} config provider litellm`);
    console.log(`\n  quick start:`);
    console.log(`    ${BRAND.cli} config provider anthropic     # direct Anthropic API`);
    console.log(`    ${BRAND.cli} config provider openrouter    # OpenRouter multi-model`);
    console.log(`    ${BRAND.cli} config provider litellm       # LiteLLM self-hosted`);
    console.log(`    ${BRAND.cli} config model sonnet           # set default model tier`);
    console.log(`    ${BRAND.cli} route "<task>" --apply        # route + apply model`);
    return;
  }
  console.error(
    `config: unknown subcommand "${sub}" (show | providers | provider <name> | model <tier> | gateway | setup)`,
  );
  process.exitCode = 1;
  return;
};
HANDLERS.anchor = async (argv) => {
  const { goalDrift, renderAnchor } = await import("./anchor.js");
  const { clearGoal, getGoal, setGoal } = await import("./goal.js");
  const json = argv.includes("--json");
  const args = argv.slice(1).filter((a) => a !== "--json");
  const sub = args[0];
  // Persistent goal management: `set` stores it, SessionStart re-injects it, and a
  // bare `forge anchor` checks against it — the goal survives the session that set it.
  if (sub === "set") {
    const r = setGoal(process.cwd(), args.slice(1).join(" "));
    if (!r.ok) {
      console.error(`${BRAND.cli} anchor set: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `goal set: ${r.goal}\n(injected each session start; \`forge anchor\` checks against it)`,
    );
    return;
  }
  if (sub === "show") {
    const g = getGoal(process.cwd());
    console.log(g ? `active goal: ${g}` : 'no active goal — set one: forge anchor set "<goal>"');
    return;
  }
  if (sub === "clear") {
    clearGoal(process.cwd());
    console.log("goal cleared.");
    return;
  }
  const goal = args.join(" ") || getGoal(process.cwd());
  if (!goal) {
    console.error(
      `usage: ${BRAND.cli} anchor "<original goal>" [--json]\n       ${BRAND.cli} anchor set|show|clear — persist the goal across sessions`,
    );
    process.exitCode = 1;
    return;
  }
  // Session-scoped like `forge lean`: drift is judged on this session's own changes.
  const { currentSessionId, sessionChanges } = await import("./session.js");
  const { workFiles } = await import("./anchor.js");
  const s = sessionChanges(process.cwd(), currentSessionId());
  const r = goalDrift(process.cwd(), goal, s ? { changed: workFiles(s.changed) } : {});
  console.log(json ? JSON.stringify(r, null, 2) : renderAnchor(r));
  return; // advisory — never fails the process
};
HANDLERS.handoff = async (argv) => {
  const { writeState } = await import("./handoff.js");
  const json = argv.includes("--json");
  const args = argv.slice(1).filter((a) => a !== "--json");
  // Repeatable flags collect rows; positionals are "done" rows. Piped stdin (one row
  // per line) covers agents that assemble the summary programmatically.
  const fields = { done: [], next: [], gotchas: [], criteria: [] };
  const FLAG = {
    "--next": "next",
    "--gotcha": "gotchas",
    "--criteria": "criteria",
  };
  for (let i = 0; i < args.length; i += 1) {
    if (FLAG[args[i]]) fields[FLAG[args[i]]].push(args[++i] ?? "");
    else if (args[i] === "--phase") fields.phase = args[++i] ?? "";
    else fields.done.push(args[i]);
  }
  if (!fields.done.length && !process.stdin.isTTY) {
    try {
      const { readFileSync } = await import("node:fs");
      fields.done = readFileSync(0, "utf8").split("\n");
    } catch {}
  }
  const r = writeState(process.cwd(), fields);
  if (json) return console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.error(
      `${BRAND.cli} handoff: ${r.reason}\nusage: ${BRAND.cli} handoff "<done>" [--next "<step>"] [--gotcha "<trap>"] [--criteria "<check>"] [--phase <p>]`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `  state written: ${r.path} (${r.lines} lines)\n  (re-injected at every session start — the next session resumes instead of re-assuming)`,
  );
  return;
};
HANDLERS.decide = async (argv) => {
  const { appendDecision, listDecisions } = await import("./decide.js");
  const json = argv.includes("--json");
  const text = argv
    .slice(1)
    .filter((a) => a !== "--json")
    .join(" ");
  if (!text) {
    const rows = listDecisions(process.cwd(), { limit: 10 });
    if (json) return console.log(JSON.stringify(rows, null, 2));
    console.log(
      rows.length
        ? rows.map((d) => `  ${d.id} (${d.date}): ${d.text}`).join("\n")
        : `  no decisions recorded — ${BRAND.cli} decide "<what was decided — why>"`,
    );
    return;
  }
  const r = appendDecision(process.cwd(), text);
  if (json) return console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.error(`${BRAND.cli} decide: ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  recorded ${r.id}: ${r.text}`);
  return;
};
HANDLERS.know = async (argv) => {
  // A7 knowledge-router: total routing (T6) of a fact to its storage home — an unsure
  // fact still lands (ledger fallback), it is never dropped.
  const { HOMES, routeFact, storeFact } = await import("./knowledge_router.js");
  const json = argv.includes("--json");
  const dry = argv.includes("--dry-run");
  const text = argv
    .slice(1)
    .filter((a) => a !== "--json" && a !== "--dry-run")
    .join(" ");
  if (!text) {
    console.error(`usage: ${BRAND.cli} know "<fact>" [--dry-run] [--json]`);
    process.exitCode = 1;
    return;
  }
  const route = routeFact(text);
  const r = storeFact(process.cwd(), text, {
    mode: dry ? "advise" : "auto",
    route,
  });
  if (json) return console.log(JSON.stringify({ ...route, ...r, dryRun: dry }, null, 2));
  heading(`${BRAND.brand} know — knowledge routing (A7)\n`);
  const why =
    route.provenance === "fallback"
      ? "fallback — resembles no exemplar; the ledger absorbs unsure placements"
      : `confidence ${route.confidence}`;
  console.log(`  home:     ${route.home} (${why}) → ${HOMES[route.home].where}`);
  const near = route.neighbors[0];
  if (near) console.log(`  nearest:  "${near.text}" (${near.sim.toFixed(3)})`);
  if (!r.ok) {
    console.error(`  ${r.reason}`);
    process.exitCode = 1;
    return;
  }
  if (r.stored) console.log(`  stored:   ${r.ref}`);
  else if (dry) console.log("  (dry-run — nothing written)");
  if (r.advice) console.log(`  advice:   ${r.advice}`);
  return;
};
HANDLERS.diagnose = async (argv) => {
  const { diagnose, THRASH_K } = await import("./diagnose.js");
  const json = argv.includes("--json");
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const VALUE_FLAGS = ["--file", "--symbol", "--task"];
  const args = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1]));
  const errorText = args.slice(1).join(" ");
  if (!errorText) {
    console.error(
      'usage: forge diagnose "<error text>" [--file f] [--symbol s] [--task "<task>"] [--json]',
    );
    process.exitCode = 1;
    return;
  }
  const r = diagnose(process.cwd(), {
    errorText,
    file: flagVal("--file"),
    symbol: flagVal("--symbol"),
    // The task this failure came out of — the same text `forge route` was given. When a
    // routing decision for it is on record, the escalation directive names that decision's
    // tier instead of "one tier". Omitted → unchanged behaviour.
    task: flagVal("--task"),
  });
  if (json) return console.log(JSON.stringify(r, null, 2));
  heading(`${BRAND.brand} diagnose — doom-loop check\n`);
  console.log(
    `  signature: ${r.signature.slice(0, 12)} · seen ${r.count}× in the recent failure window`,
  );
  if (r.thrash) {
    if (r.claimId)
      console.log(
        `  diagnosis claim: ${r.claimId.slice(0, 12)}  (\`forge ledger show ${r.claimId.slice(0, 8)}\`)`,
      );
    console.log(`\n  ${r.escalate ?? r.reason}`);
  } else {
    console.log(`  below the thrash threshold (${THRASH_K}) — recorded; keep going.`);
  }
  return; // advisory — halting the retry loop is the AGENT's move, not an exit code
};
HANDLERS.lean = async (argv) => {
  const { leanRepo, renderLean } = await import("./lean.js");
  const json = argv.includes("--json");
  const task = argv
    .slice(1)
    .filter((a) => a !== "--json")
    .join(" ");
  if (!task) {
    console.error('usage: forge lean "<task>" [--json]   (measures the working diff vs the task)');
    process.exitCode = 1;
    return;
  }
  // Inside an agent session, measure only what THAT session changed (not other agents'
  // work or pre-session dirt); outside one, the whole working diff as before.
  const { currentSessionId, sessionChanges } = await import("./session.js");
  const s = sessionChanges(process.cwd(), currentSessionId());
  const r = s
    ? leanRepo(process.cwd(), task, { base: s.base ?? "HEAD", files: s.changed })
    : leanRepo(process.cwd(), task);
  console.log(json ? JSON.stringify(r, null, 2) : renderLean(r));
  return; // advisory — never fails the process
};
HANDLERS.scope = async (argv) => {
  const { decompose } = await import("./scope.js");
  const json = argv.includes("--json");
  const files = argv.slice(1).filter((a) => a !== "--json");
  if (!files.length) {
    console.error("usage: forge scope <file> [file...] [--json]");
    process.exitCode = 1;
    return;
  }
  const d = decompose(process.cwd(), files);
  if (json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  heading(`${BRAND.brand} scope — task decomposition\n`);
  if (d.independentGroups > 1) {
    console.log(
      `  ${d.independentGroups} independent groups → consider a separate session per group:\n`,
    );
  }
  d.clusters.forEach((c, i) => {
    console.log(`  [${i + 1}] ${c.touched.join(", ")}`);
    if (c.coupled.length) {
      const shown = c.coupled.slice(0, 8).join(", ");
      console.log(
        `      ! also coupled (you didn't name): ${shown}${c.coupled.length > 8 ? " …" : ""}`,
      );
    }
  });
  if (d.independentGroups === 1) console.log("\n  all coupled — keep as one change.");
  return;
};
/** The last line of a `uicheck design|visual` run, per overall verdict. */
HANDLERS.report = async (argv) => {
  // Static twin of `dash`: emit ONE self-contained HTML file (no server, opens
  // offline) instead of serving a live localhost lens. `--out <path>` overrides the
  // default `.forge/report.html`.
  const { renderReport, writeReport } = await import("./report.js");
  const oi = argv.indexOf("--out");
  heading(`${BRAND.brand} report — static snapshot of .forge/\n`);
  if (oi >= 0) {
    const out = argv[oi + 1];
    if (!out) {
      console.error("usage: forge report [--out <path>]");
      process.exitCode = 1;
      return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, renderReport(process.cwd()));
    console.log(`  wrote ${out}`);
    return;
  }
  const path = writeReport(process.cwd());
  console.log(`  wrote ${path}`);
  console.log("  open it in a browser — fully offline, no server needed.");
  return;
};
HANDLERS.dash = async (argv) => {
  const { serve } = await import("./dash.js");
  const i = argv.indexOf("--port");
  const port = i >= 0 ? Number(argv[i + 1]) : 4242;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: forge dash [--port N]");
    process.exitCode = 1;
    return;
  }
  const server = serve(process.cwd(), { port });
  server.on("listening", () => {
    const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
    heading(`${BRAND.brand} dash — read-only lens on .forge/\n`);
    console.log(`  http://127.0.0.1:${addr.port}  (localhost-only · Ctrl-C to stop)`);
  });
  server.on("error", (err) => {
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  });
  return; // the process stays alive serving — that's the command
};
HANDLERS.tools = async (argv) => {
  const { resolvePrimaryTool, applyPrimaryTool, clearRepoConfig, KNOWN_TOOLS } = await import(
    "./repo_config.js"
  );
  const { removeGitignoreBlock, readGitignoreBlock } = await import("./gitignore.js");
  const root = process.cwd();
  const json = argv.includes("--json");

  if (argv.includes("--reset")) {
    const cleared = clearRepoConfig(root);
    const gi = removeGitignoreBlock(root);
    if (json)
      return console.log(
        JSON.stringify({ reset: true, config: cleared.cleared, gitignore: gi.action }, null, 2),
      );
    heading(`${BRAND.brand} tools — reset\n`);
    console.log(
      `  primary-tool config ${cleared.cleared ? "cleared" : "was unset"} · .gitignore block ${gi.action}`,
    );
    return;
  }

  const name = argv.slice(1).find((a) => !a.startsWith("--"));
  if (name) {
    if (!KNOWN_TOOLS.includes(name)) {
      console.error(`Unknown tool: ${name}\nKnown tools: ${KNOWN_TOOLS.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    // Inject the sync runner from here (the orchestration layer) so repo_config —
    // a config-leaf module — no longer reaches back into the sync compiler.
    const { sync } = await import("./sync.js");
    const { claimEmittedIntegrations } = await import("./integrations.js");
    const r = await applyPrimaryTool(root, name, {
      syncFn: (r2) => {
        const out = sync({ targetRoot: r2 });
        // The tool may have just joined the recorded set: own its integration copies too.
        claimEmittedIntegrations(r2);
        return out;
      },
    });
    if (json) return console.log(JSON.stringify(r, null, 2));
    heading(`${BRAND.brand} tools — primary set\n`);
    console.log(`  primary tool   ${paint(r.primaryTool, "ok")}`);
    if (r.addedTool)
      console.log(
        `  tool set       ${name} added to the tools \`${BRAND.cli} init\` recorded, so sync now emits its config`,
      );
    console.log(
      `  gitignored     ${r.targets.length ? r.targets.join(", ") : "none"}  (block ${r.gitignore})`,
    );
    console.log(`\n  ${BRAND.cli} tools --reset  to undo`);
    return;
  }

  const { tool, source } = resolvePrimaryTool(root);
  const ignored = readGitignoreBlock(root);
  if (json)
    return console.log(JSON.stringify({ primaryTool: tool, source, gitignored: ignored }, null, 2));
  const origin =
    source === "config"
      ? "from config"
      : source === "auto-detect"
        ? "auto-detected"
        : "unset — emitting all tools";
  heading(`${BRAND.brand} tools — agent-tool config\n`);
  console.log(`  primary tool   ${tool ? paint(tool, "ok") : "none"} (${origin})`);
  console.log(`  gitignored     ${ignored.length ? ignored.join(", ") : "none"}`);
  console.log(`\n  Set primary:   ${BRAND.cli} tools <name>   (${KNOWN_TOOLS.join(" | ")})`);
  console.log(`  Clear:         ${BRAND.cli} tools --reset`);
  return;
};

// Auto-run only as the CLI entry (npm/global bin, install.sh symlink, `node src/cli.js`).
// realpathSync resolves the bin symlink so the global `forge` still runs; importing the
// package root must NOT execute the CLI (package.json marks this file's side effect).
const entryPath = (() => {
  const invoked = process.argv[1];
  if (!invoked) return "";
  try {
    return realpathSync(invoked);
  } catch {
    return invoked;
  }
})();
if (entryPath && entryPath === realpathSync(fileURLToPath(import.meta.url))) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export { run };

// forge CLI — `advisor status|set|off|reset|rule|pairings|check`: Claude Code's advisor tool
// (a stronger second model consulted at decision points), configured once in Forge's config
// and emitted into Claude Code's settings, with the main/advisor pairing checked before Claude
// Code has to refuse it. Dispatch and presentation here; resolution, validation and writes live
// in ../advisor.js. cli.js registers these into its dispatch table; nothing runs at import time.
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

const USAGE = [
  `usage: ${BRAND.cli} advisor [status] [--json]`,
  `       ${BRAND.cli} advisor set <model|off> [--global]`,
  `       ${BRAND.cli} advisor off | reset [--global]`,
  `       ${BRAND.cli} advisor rule on|off <rule-id|all> [--global]`,
  `       ${BRAND.cli} advisor pairings [<main-model>] [--json]`,
  `       ${BRAND.cli} advisor check <main-model> <advisor-model> [--json]`,
].join("\n");

const fail = (msg) => {
  console.error(`  ${BRAND.cli} advisor: ${msg}`);
  console.error(paint(USAGE, "dim"));
  process.exitCode = 1;
};

const verdict = (pairing) =>
  pairing.ok === true
    ? paint("ok", "ok")
    : pairing.ok === false
      ? paint("refused", "err")
      : paint("unverified", "warn");

const SOURCE_LABEL = {
  project: ".forge/forge.config.json",
  global: "the user-level forge.config.json",
  "claude-local": ".claude/settings.local.json",
  "claude-project": ".claude/settings.json",
  "claude-user": "~/.claude/settings.json",
  env: "ANTHROPIC_MODEL",
  "env-default": "ANTHROPIC_DEFAULT_MODEL",
  default: "the account default",
  none: "none",
};

async function status(root, json, settingsPath) {
  const { resolveAdvisor, suggestAdvisor, loadAdvisorPack } = await import("../advisor.js");
  const { userConfigPath } = await import("../repo_config.js");
  const state = resolveAdvisor(root, { settingsPath });
  if (json)
    return console.log(
      JSON.stringify({ ...state, configs: { global: userConfigPath() } }, null, 2),
    );
  heading(`${BRAND.brand} advisor — a stronger second model at decision points\n`);
  if (state.model) {
    console.log(
      `  advisor: ${state.model} ${paint(`(${SOURCE_LABEL[state.source] ?? state.source})`, "dim")}`,
    );
  } else if (state.forgeConfigured) {
    console.log(
      `  advisor: off ${paint(`(${SOURCE_LABEL[state.source] ?? state.source})`, "dim")}`,
    );
  } else {
    console.log("  advisor: not configured");
    const hint = suggestAdvisor(state.main.model) ?? "opus";
    console.log(
      paint(
        `  \`${BRAND.cli} advisor set ${hint}\` pairs ${hint} with this repo's sessions; Claude Code's own \`/advisor\` saves a personal pick instead.`,
        "dim",
      ),
    );
  }
  console.log(
    `  main model: ${state.main.model ?? "account default"} ${paint(`(${SOURCE_LABEL[state.main.source] ?? state.main.source})`, "dim")}`,
  );
  if (state.pairing) console.log(`  pairing: ${verdict(state.pairing)} — ${state.pairing.reason}`);
  if (state.disabled) console.log(`  ${paint("!", "warn")} ${state.disabled.reason}`);
  if (state.model && !state.forgeConfigured)
    console.log(
      paint(
        `  (personal pick from Claude Code's settings — \`${BRAND.cli} advisor set ${state.model}\` makes it this repo's and emits the Advisor rules into AGENTS.md)`,
        "dim",
      ),
    );
  console.log(
    `\n  rules (${loadAdvisorPack().title} section in AGENTS.md${state.forgeConfigured && state.model ? "" : " — emitted once an advisor is set here"}):`,
  );
  for (const r of state.rules) {
    console.log(
      `  ${r.enabled ? "on " : "off"}  ${r.id.padEnd(24)} ${paint(`(${r.source})`, "dim")}`,
    );
    console.log(`       ${r.text}`);
    console.log(paint(`       why: ${r.rationale}`, "dim"));
  }
  console.log(
    paint(
      `\n  project: .forge/forge.config.json → .claude/settings.json on \`${BRAND.cli} sync\` · global: ${userConfigPath()} → ~/.claude/settings.json · project wins.`,
      "dim",
    ),
  );
}

async function pairings(main, json) {
  const { acceptedAdvisors, loadAdvisorPack, rankModel, suggestAdvisor } = await import(
    "../advisor.js"
  );
  const pack = loadAdvisorPack();
  if (main) {
    const m = rankModel(main);
    const { rows, aliases } = acceptedAdvisors(main);
    if (json)
      return console.log(
        JSON.stringify(
          { main: m, accepted: rows, aliases, suggest: suggestAdvisor(main) },
          null,
          2,
        ),
      );
    console.log(`  main model: ${m.label}${m.note ? paint(` — ${m.note}`, "dim") : ""}`);
    if (m.status === "older" || m.status === "unknown")
      return console.log(
        `  ${paint("!", "warn")} ${m.note ?? `${m.raw} is not a Claude model ${BRAND.brand} recognises`}`,
      );
    console.log(`  accepted advisors: ${rows.map((r) => r.label).join(", ")}`);
    console.log(`  aliases that work: ${aliases.join(", ") || "(none)"}`);
    const s = suggestAdvisor(main);
    if (s) console.log(`  suggested: ${s}`);
    return;
  }
  const table = pack.ranking.rows
    .filter((r) => r.advises !== false || r.family === "haiku")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({
      main: r.label,
      accepted: acceptedAdvisors(`${r.family}-${r.version}`).rows.map((x) => x.label),
    }));
  if (json)
    return console.log(
      JSON.stringify(
        { verified: pack.ranking.verified, source: pack.ranking.source, pairings: table },
        null,
        2,
      ),
    );
  heading(`${BRAND.brand} advisor — accepted pairings (verified ${pack.ranking.verified})\n`);
  for (const row of table) console.log(`  ${row.main.padEnd(12)} ← ${row.accepted.join(", ")}`);
  console.log(
    paint(
      `\n  an advisor must rank at or above the main model; haiku never advises. ${pack.ranking.source}`,
      "dim",
    ),
  );
}

HANDLERS.advisor = async (argv) => {
  const root = process.cwd();
  const global = argv.includes("--global");
  const json = argv.includes("--json");
  const args = argv.slice(1).filter((a) => a !== "--global" && a !== "--json");
  const [sub = "status", ...rest] = args;
  // Test/plumbing override of the user settings file — the same seam `forge init` uses.
  const settingsPath = process.env.FORGE_SETTINGS_PATH || undefined;
  if (sub === "status" || sub === "list" || sub === "show") return status(root, json, settingsPath);
  if (sub === "pairings") return pairings(rest[0], json);
  if (sub === "check") {
    const [main, advisor] = rest;
    if (!main || !advisor) return fail("check needs <main-model> <advisor-model>");
    const { checkPairing } = await import("../advisor.js");
    const r = checkPairing(main, advisor);
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`  ${verdict(r)} — ${r.reason}`);
    if (r.ok === false) process.exitCode = 1;
    return;
  }
  const scope = global ? "global" : "project";
  if (sub === "set" || sub === "off") {
    const raw = sub === "off" ? "off" : rest[0];
    if (!raw) return fail("set needs <model|off>");
    const { resolveAdvisor, setAdvisorModel, writeAdvisorSetting } = await import("../advisor.js");
    const res = setAdvisorModel(root, raw, { global });
    if (res.ok === false) return fail(res.reason);
    console.log(`  advisor = ${res.model ?? "off"} (${scope}) — written to ${res.path}`);
    if (res.note) console.log(`  ${paint("!", "warn")} ${res.note}`);
    const state = resolveAdvisor(root, { settingsPath });
    if (res.model && state.pairing && state.pairing.ok === false)
      console.log(
        `  ${paint("!", "warn")} ${state.pairing.reason} — saved anyway; it activates once the main model allows it`,
      );
    if (state.disabled) console.log(`  ${paint("!", "warn")} ${state.disabled.reason}`);
    if (global) {
      // The user file is what `/advisor` itself writes; say it is GLOBAL before touching it, as init does.
      const target = settingsPath || join(homedir(), ".claude", "settings.json");
      console.log(`  settings: writing advisorModel to ${target} (GLOBAL — affects all repos)`);
      const w = writeAdvisorSetting(target, res.model);
      if (w.action === "error") {
        console.error(`  settings: FAILED — ${w.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  settings: ${w.action}`);
      console.log(
        paint(
          `  repos pick up the Advisor rules on their next \`${BRAND.cli} sync\` (or the Stop-hook auto-sync)`,
          "dim",
        ),
      );
      return;
    }
    const { sync } = await import("../sync.js");
    const r = sync({ targetRoot: root });
    for (const row of r.report.filter(
      (x) => x.tool === "shared source" || x.target === ".claude/settings.json",
    ))
      console.log(`  ${row.target.padEnd(22)} ${row.action.padEnd(10)} ${row.note}`);

    for (const w of r.warnings) console.log(`  ${paint("!", "warn")} ${w}`);
    return;
  }
  if (sub === "reset") {
    const { resetAdvisorModel } = await import("../advisor.js");
    const res = resetAdvisorModel(root, { global });
    if (res.ok === false) return fail(res.reason);
    console.log(
      res.had
        ? `  advisor: ${BRAND.brand}'s choice removed (${scope}) — ${res.path}; Claude Code's own settings decide again`
        : `  advisor: nothing to reset (${scope}) — ${res.path}`,
    );
    console.log(
      paint(
        `  the ${scope === "global" ? "user" : "project"} settings file keeps its advisorModel until \`${BRAND.cli} advisor off\` or \`/advisor off\``,
        "dim",
      ),
    );
    return;
  }
  if (sub === "rule") {
    const [onOff, id] = rest;
    if (onOff !== "on" && onOff !== "off") return fail("rule needs on|off <rule-id|all>");
    if (!id) return fail(`rule ${onOff} needs a rule id (or all)`);
    const { setAdvisorRule } = await import("../advisor.js");
    const res = setAdvisorRule(root, id, onOff === "on", { global });
    if (res.ok === false) return fail(res.reason);
    console.log(`  ${res.ids.join(", ")}: ${onOff} (${scope}) — written to ${res.path}`);
    console.log(paint(`  run \`${BRAND.cli} sync\` to re-emit the rules`, "dim"));
    return;
  }
  return fail(`unknown subcommand: ${sub} — status | set | off | reset | rule | pairings | check`);
};

export default HANDLERS;

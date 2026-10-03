// forge CLI — `orchestration list|on|off|set`: view and switch the agent-orchestration rule pack
// and the routing policy for unattended agents. Dispatch and presentation here; resolution and
// writes live in ../orchestration.js. cli.js registers these into its dispatch table; nothing
// here runs at import time.
import { BRAND, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

const USAGE = [
  `usage: ${BRAND.cli} orchestration [list] [--json]`,
  `       ${BRAND.cli} orchestration on|off <rule-id|all|pack> [--global]`,
  `       ${BRAND.cli} orchestration set <key> <value> [--global]`,
].join("\n");

const fail = (msg) => {
  console.error(`  ${BRAND.cli} orchestration: ${msg}`);
  console.error(paint(USAGE, "dim"));
  process.exitCode = 1;
};

async function list(root, json) {
  const { loadPack, resolveOrchestration, resolveRoutePolicy } = await import(
    "../orchestration.js"
  );
  const { userConfigPath } = await import("../repo_config.js");
  const state = resolveOrchestration(root);
  const route = resolveRoutePolicy(root);
  if (json)
    return console.log(
      JSON.stringify({ ...state, route, configs: { global: userConfigPath() } }, null, 2),
    );
  heading(`${BRAND.brand} orchestration — agent rules and unattended routing\n`);
  console.log(`  ${loadPack().intro}\n`);
  console.log(
    `  pack: ${state.enabled ? "on" : "off"} (${state.enabledSource}) · parallel cap: ${state.parallelCap} (${state.parallelCapSource})`,
  );
  for (const r of state.rules) {
    const mark = state.enabled && r.enabled ? "on " : "off";
    console.log(`  ${mark}  ${r.id.padEnd(22)} ${paint(`(${r.source})`, "dim")}`);
    console.log(`       ${r.text}`);
    console.log(paint(`       why: ${r.rationale}`, "dim"));
  }
  const src = (k) => paint(`(${route.sources[k] ?? "default"})`, "dim");
  console.log(`\n  routing (${BRAND.cli} route):`);
  console.log(`    route.mode             ${route.mode} ${src("mode")}`);
  console.log(`    route.topTier          ${route.topTier} ${src("topTier")}`);
  console.log(`    route.raiseConfidence  ${route.raiseConfidence} ${src("raiseConfidence")}`);
  console.log(`    route.midConfidence    ${route.midConfidence} ${src("midConfidence")}`);
  console.log(
    `    route.writesCodeFloor  ${route.writesCodeFloor ? "on" : "off"} ${src("writesCodeFloor")}`,
  );
  console.log(`    route.riskFloor        ${route.riskFloor ? "on" : "off"} ${src("riskFloor")}`);
  const cats = Object.entries(route.riskCategories)
    .filter(([, words]) => words.length)
    .map(([c]) => c);
  console.log(`    risk categories        ${cats.join(", ") || "(none)"} ${src("riskCategories")}`);
  console.log(
    paint(
      `\n  project: .forge/forge.config.json · global: ${userConfigPath()} · project wins.\n  Switched rules leave AGENTS.md on the next \`${BRAND.cli} sync\`.`,
      "dim",
    ),
  );
}

HANDLERS.orchestration = async (argv) => {
  const root = process.cwd();
  const global = argv.includes("--global");
  const args = argv.slice(1).filter((a) => a !== "--global" && a !== "--json");
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "show") return list(root, argv.includes("--json"));
  const { setRule, setSetting } = await import("../orchestration.js");
  const scope = global ? "global" : "project";
  if (sub === "on" || sub === "off") {
    const [id] = rest;
    if (!id) return fail(`${sub} needs a rule id (or all, or pack)`);
    const res = setRule(root, id, sub === "on", { global });
    if (res.ok === false) return fail(res.reason);
    const what = id === "pack" ? "the orchestration pack" : res.ids.join(", ");
    console.log(`  ${what}: ${sub} (${scope}) — written to ${res.path}`);
    console.log(paint(`  run \`${BRAND.cli} sync\` to re-emit the rules`, "dim"));
    return;
  }
  if (sub === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) return fail("set needs <key> <value>");
    const res = setSetting(root, key, value, { global });
    if (res.ok === false) return fail(res.reason);
    console.log(`  ${key} = ${JSON.stringify(res.value)} (${scope}) — written to ${res.path}`);
    if (key === "parallelCap")
      console.log(paint(`  run \`${BRAND.cli} sync\` to re-emit the rules`, "dim"));
    return;
  }
  return fail(`unknown subcommand: ${sub} — list | on | off | set`);
};

export default HANDLERS;

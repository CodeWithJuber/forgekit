#!/usr/bin/env node
// forge — zero-dependency dispatcher. Works identically whether installed via the
// npm bin, the hardened install.sh symlink, or the Claude Code plugin.
import { BRAND } from "./brand.js";

const COMMANDS = {
  init: "scaffold this repo's config — emits every tool from one shared source",
  sync: "recompile the canonical source into each tool's native config files",
  doctor: "health-check installed tools, guards, MCP auth, and config drift",
  taste: "enable one UI-taste tool for this repo (no arg = list)",
  atlas: "build / query the code-graph (what-calls-X, where-is-Y)",
  recall: "manage cross-session memory (list / consolidate)",
  brand: "print the active brand token map",
};

const printVersion = () =>
  console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

function printHelp() {
  printVersion();
  console.log(`\n${BRAND.tagline}\n`);
  console.log(`Usage: ${BRAND.cli} <command> [options]\n`);
  console.log("Commands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log(`\nRun \`${BRAND.cli} <command> --help\` for details.`);
}

async function run(argv) {
  const [cmd] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return printHelp();
  if (cmd === "-v" || cmd === "--version") return printVersion();
  if (cmd === "brand") {
    const { brand, cli, pkg, version, layers } = BRAND;
    return console.log(
      JSON.stringify({ brand, cli, pkg, version, layers }, null, 2),
    );
  }
  if (cmd === "sync") {
    const { sync } = await import("./sync.js");
    const { report, warnings, bytes } = sync({ targetRoot: process.cwd() });
    console.log(`${BRAND.brand} sync — one source → every tool\n`);
    for (const r of report) {
      console.log(
        `  ${r.action.padEnd(16)} ${String(r.target).padEnd(22)} ${r.tool}${r.note ? "  · " + r.note : ""}`,
      );
    }
    for (const w of warnings) console.warn(`  ! ${w}`);
    const written = report.filter((r) => r.action === "written").length;
    console.log(`\n${written} file(s) written · canonical ${bytes} B`);
    return;
  }
  if (cmd === "doctor") {
    const { doctor } = await import("./doctor.js");
    const { results, failed } = doctor({ targetRoot: process.cwd() });
    const icon = { ok: "✓", warn: "!", fail: "✗" };
    console.log(`${BRAND.brand} doctor\n`);
    for (const r of results)
      console.log(`  ${icon[r.status]} ${r.label.padEnd(16)} ${r.note}`);
    console.log(`\n${failed === 0 ? "all clear" : failed + " problem(s)"}`);
    if (failed) process.exitCode = 1;
    return;
  }
  if (!(cmd in COMMANDS)) {
    console.error(
      `Unknown command: ${cmd}\nRun \`${BRAND.cli} --help\` to see commands.`,
    );
    process.exitCode = 1;
    return;
  }
  // ponytail: remaining subcommands land in their build phases; the stub keeps the
  // command surface honest and testable now.
  console.log(
    `${BRAND.cli} ${cmd}: not wired yet — coming in a later build phase.`,
  );
}

run(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

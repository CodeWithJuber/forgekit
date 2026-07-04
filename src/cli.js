#!/usr/bin/env node
// forge — zero-dependency dispatcher. Works identically whether installed via the
// npm bin, the hardened install.sh symlink, or the Claude Code plugin.
import { BRAND } from './brand.js';

const COMMANDS = {
  init: "scaffold this repo's config — emits every tool from one shared source",
  sync: "recompile the canonical source into each tool's native config files",
  doctor: 'health-check installed tools, guards, MCP auth, and config drift',
  taste: 'enable one UI-taste tool for this repo (no arg = list)',
  atlas: 'build / query the code-graph (what-calls-X, where-is-Y)',
  recall: 'manage cross-session memory (list / consolidate)',
  brand: 'print the active brand token map',
};

const printVersion = () => console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

function printHelp() {
  printVersion();
  console.log(`\n${BRAND.tagline}\n`);
  console.log(`Usage: ${BRAND.cli} <command> [options]\n`);
  console.log('Commands:');
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log(`\nRun \`${BRAND.cli} <command> --help\` for details.`);
}

function run(argv) {
  const [cmd] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') return printHelp();
  if (cmd === '-v' || cmd === '--version') return printVersion();
  if (cmd === 'brand') {
    const { brand, cli, pkg, version, layers } = BRAND;
    return console.log(JSON.stringify({ brand, cli, pkg, version, layers }, null, 2));
  }
  if (!(cmd in COMMANDS)) {
    console.error(`Unknown command: ${cmd}\nRun \`${BRAND.cli} --help\` to see commands.`);
    process.exitCode = 1;
    return;
  }
  // ponytail: real subcommands land in their build phases; the stub keeps the
  // command surface honest and testable now.
  console.log(`${BRAND.cli} ${cmd}: not wired yet — coming in a later build phase.`);
}

run(process.argv.slice(2));

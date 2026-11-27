import assert from "node:assert/strict";
import { test } from "node:test";
import { HANDLER_NAMES } from "../src/cli.js";
import { COMMANDS, commandHelp, GROUPS, HIDDEN_COMMANDS } from "../src/commands.js";

test("every command appears in exactly one help group (P1-01 grouping stays complete)", () => {
  const cmds = Object.keys(COMMANDS);
  const grouped = Object.values(GROUPS).flat();
  const missing = cmds.filter((c) => !grouped.includes(c));
  const dupes = grouped.filter((c, i) => grouped.indexOf(c) !== i);
  const phantom = grouped.filter((c) => !cmds.includes(c) && !HIDDEN_COMMANDS.includes(c));
  assert.deepEqual(missing, [], "commands missing from any group");
  assert.deepEqual(dupes, [], "commands listed in more than one group");
  assert.deepEqual(phantom, [], "group lists a non-existent command");
});

test("Labs group exists and holds experimental commands (not the core loop)", () => {
  const labs = GROUPS["Labs (experimental)"] || [];
  assert.ok(!labs.includes("verify") && !labs.includes("substrate"), "core loop is not in labs");
  // A command leaves Labs once it meets docs/CLI-CONTRACTS.md: strict, complete help.
  for (const name of labs) assert.equal(commandHelp(name)?.strict, false, `${name} is still Labs`);
  for (const graduated of ["taste", "imagine", "uicheck", "reuse"]) {
    assert.ok(!labs.includes(graduated), `${graduated} has left Labs`);
    assert.equal(commandHelp(graduated)?.strict, true, `${graduated} is strict`);
  }
});

test("registry ↔ dispatch stay in sync: every COMMANDS entry has a handler, no phantom handlers (item 38)", () => {
  const cmds = new Set(Object.keys(COMMANDS));
  const handlers = new Set(HANDLER_NAMES);
  // cortex-mcp is dispatched specially in run() (an MCP server, not a CLI command)
  // and is deliberately absent from both tables — it is not a sync failure.
  const noHandler = [...cmds].filter((c) => !handlers.has(c));
  const noCommand = [...handlers].filter((c) => !cmds.has(c) && !HIDDEN_COMMANDS.includes(c));
  assert.deepEqual(noHandler, [], "commands registered without a dispatch handler");
  assert.deepEqual(noCommand, [], "handlers wired with no COMMANDS registration");
});

test("bare --help leads with the Start-here commands and still names every command", async () => {
  const { execFileSync } = await import("node:child_process");
  const { START_HERE, commandSummary } = await import("../src/commands.js");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = { ...process.env, FORGE_NO_HINT: "1" };
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
  const names = START_HERE.map((c) => c.name);
  assert.ok(names.length >= 6 && names.length <= 8, "a short first step, not the whole surface");
  assert.equal(new Set(names).size, names.length, "no command listed twice");
  const grouped = Object.values(GROUPS).flat();
  for (const { name, why } of START_HERE) {
    assert.ok(grouped.includes(name), `${name} is a real, grouped command`);
    assert.ok(help.includes(`  ${name.padEnd(12)} ${why}`), `${name} shows its plain why`);
  }
  const start = help.indexOf("Start here:");
  const more = help.indexOf("More commands:");
  assert.ok(start > 0 && more > start, "Start here comes before the rest");
  // Nothing is hidden: every advertised command is named somewhere on the short screen.
  for (const name of grouped) assert.match(help, new RegExp(`\\b${name}\\b`), `${name} is named`);
  assert.ok(help.includes("--help --all"), "points to the full list");
  for (const line of help.split("\n")) assert.ok(line.length <= 80, `fits 80 columns: ${line}`);
  // The full list keeps today's grouped summaries, and `forge help --all` is the same screen.
  const all = execFileSync(process.execPath, [cli, "--help", "--all"], { encoding: "utf8", env });
  for (const [group, cmds] of Object.entries(GROUPS)) {
    assert.ok(all.includes(`${group}:`), `${group} group in --all`);
    for (const name of cmds)
      assert.ok(all.includes(`  ${name.padEnd(12)} ${commandSummary(name)}`));
  }
  assert.ok(!all.includes("Start here:"), "--all is the reference list");
  const word = execFileSync(process.execPath, [cli, "help", "--all"], { encoding: "utf8", env });
  assert.equal(word, all);
});

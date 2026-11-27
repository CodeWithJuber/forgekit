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

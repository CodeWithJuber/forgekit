import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, GROUPS, HIDDEN_COMMANDS } from "../src/commands.js";

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
  assert.ok(labs.includes("taste") && labs.includes("imagine"), "labs holds experiments");
  assert.ok(!labs.includes("verify") && !labs.includes("substrate"), "core loop is not in labs");
});

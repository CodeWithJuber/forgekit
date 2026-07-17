import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, commandHelp, commandSummary } from "../src/commands.js";
import { suggest } from "../src/math.js";

test("commandSummary: works for both string and object entries", () => {
  // doctor is a migrated object entry; brand is still a plain string.
  assert.match(commandSummary("doctor"), /health-check/);
  assert.match(commandSummary("brand"), /brand token map/);
  assert.equal(commandSummary("nope"), "", "unknown → empty string");
});

test("commandSummary: every COMMANDS value yields a non-empty summary", () => {
  // Guards future entries: whatever shape a command is authored in, --help can render it.
  for (const name of Object.keys(COMMANDS)) {
    const s = commandSummary(name);
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0, `${name} has a summary`);
  }
});

test("commandHelp: normalizes string entries to the full shape", () => {
  const h = commandHelp("brand"); // string entry
  assert.equal(typeof h.summary, "string");
  assert.deepEqual(h.flags, []);
  assert.deepEqual(h.examples, []);
  assert.deepEqual(h.env, []);
  assert.equal(h.usage, "");
});

test("commandHelp: surfaces rich detail from object entries", () => {
  const h = commandHelp("update");
  assert.match(h.usage, /forge update/);
  assert.ok(
    h.flags.some((f) => f.flag.includes("--to")),
    "update documents --to",
  );
  assert.ok(h.examples.length >= 1);
});

test("commandHelp: unknown command → null", () => {
  assert.equal(commandHelp("definitely-not-a-command"), null);
});

test("suggest: finds the nearest command and abstains below the floor", () => {
  const names = Object.keys(COMMANDS);
  assert.ok(
    ["docs", "doctor"].includes(suggest("docto", names)),
    "close typo → a real command",
  );
  assert.equal(suggest("verifyy", names), "verify", "trailing typo → verify");
  assert.equal(suggest("zzzzzzzzz", names), null, "nothing close → null");
  assert.equal(suggest("", names), null, "empty → null");
});

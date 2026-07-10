import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordMistake } from "../src/cortex.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args, cwd) =>
  spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

test("forge cortex: empty repo reports zero lessons, no crash", () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-cli-"));
  const { status, stdout } = runCli(["cortex"], cwd);
  assert.equal(status, 0);
  assert.match(stdout, /lessons: 0/);
});

test("forge cortex why <symbol>: surfaces a learned active lesson", () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-cli-"));
  const ctx = { symbols: ["computeTax"], files: ["src/tax.ts"], keywords: [] };
  recordMistake(cwd, {
    signals: [{ signal: "S1" }, { signal: "S6" }],
    context: ctx,
    nowDay: 1,
    episodeId: "e1",
  });
  recordMistake(cwd, {
    signals: [{ signal: "S1" }, { signal: "S6" }],
    context: ctx,
    nowDay: 2,
    episodeId: "e2",
  });
  const { status, stdout } = runCli(["cortex", "why", "computeTax"], cwd);
  assert.equal(status, 0);
  assert.match(stdout, /computeTax/);
  assert.match(stdout, /Lessons for the files in play/);
});

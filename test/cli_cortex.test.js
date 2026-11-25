import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordMistake } from "../src/cortex.js";
import { epochDay } from "../src/util.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args, cwd) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

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
    nowDay: epochDay() - 1,
    episodeId: "e1",
  });
  recordMistake(cwd, {
    signals: [{ signal: "S1" }, { signal: "S6" }],
    context: ctx,
    nowDay: epochDay(),
    episodeId: "e2",
  });
  const { status, stdout } = runCli(["cortex", "why", "computeTax"], cwd);
  assert.equal(status, 0);
  assert.match(stdout, /computeTax/);
  assert.match(stdout, /Lessons for the files in play/);
});

test("forge cortex review shows the private observation and confirm publishes the reviewed lesson", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-cli-"));
  const r = recordMistake(root, {
    signals: [{ signal: "S6" }],
    context: { files: ["invoice.js"] },
    nowDay: epochDay(),
    episodeId: "explicit-report",
  });
  const review = runCli(["cortex", "review", "--json"], root);
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout)[0].id, r.id);
  assert.equal(JSON.parse(review.stdout)[0].review.episodes, 1);
  assert.doesNotMatch(
    runCli(["cortex", "why", "invoice.js"], root).stdout,
    /Lessons for the files/,
  );
  const confirm = runCli(["cortex", "confirm", r.id, "--json"], root);
  assert.equal(confirm.status, 0, confirm.stderr);
  assert.equal(JSON.parse(confirm.stdout).status, "active");
  assert.match(runCli(["cortex", "why", "invoice.js"], root).stdout, /Lessons for the files/);
  assert.deepEqual(JSON.parse(runCli(["cortex", "review", "--json"], root).stdout), []);
});

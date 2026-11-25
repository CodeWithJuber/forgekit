import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../src/brand.js";

const hasPython =
  spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-c", "import csv"])
    .status === 0;
test("the public workshop demo verifies demand, keeps proof and invalidates stale results without touching the caller", {
  skip: !hasPython && "Requires Python 3 CSV reader",
}, (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-workshop-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [join(BRAND.root, "src/cli.js"), "demo", "workshop", "--json"],
    { cwd, env: { ...process.env, FORGE_NO_HINT: "1" }, encoding: "utf8", timeout: 90000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.roles, ["researcher", "planner"]);
  assert.equal(report.workersStarted, 0);
  assert.equal(report.chosen, "Morning");
  assert.equal(report.reuse.match, "exact");
  assert.equal(report.reuse.changedSourceAction, "recompute");
  assert.equal(report.reuse.afterReportChanged, "miss");
  assert.deepEqual(readdirSync(cwd), []);
});

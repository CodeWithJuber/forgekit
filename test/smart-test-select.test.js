import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "smart-test-select.mjs");

test("CI defaults to the full suite without a trusted dependency graph for its environment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-smart-select-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  for (const files of [
    "docs/GUIDE.md,README.md",
    "test/atlas.test.js",
    "src/cli.js",
    "",
    "src/foo.py,doc/schema.xsd",
  ]) {
    const plan = JSON.parse(
      execFileSync(process.execPath, [script, "--changed", files], { encoding: "utf8", cwd: root }),
    );
    assert.equal(plan.tier, "high", files);
    assert.equal(plan.fullSuite, true);
    assert.equal(plan.typecheck, true);
    assert.deepEqual(plan.tests, []);
    assert.ok(plan.reason);
  }
});

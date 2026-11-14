import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { developmentPlan } from "../src/development.js";
import { mapToTests, resolveChangedFiles } from "../src/test_select.js";

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-development-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  return root;
}
test("focused documentation change needs only a focused plan, edit and check", (t) => {
  const root = repo(t);
  const r = developmentPlan("Correct the spelling in README.md", {
    root,
    changedFiles: ["README.md"],
  });
  assert.equal(r.mode, "focused");
  assert.deepEqual(
    r.stages.map((s) => s.id),
    ["plan", "implement", "test"],
  );
  assert.ok(r.stages.every((s) => s.status === "planned"));
  assert.equal(r.testing.tier, "cosmetic");
});
test("repair plan ties actual working tree risks, test and reuse evidence to actions", (t) => {
  const root = repo(t);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "paymentAuth.js"), "");
  writeFileSync(join(root, "test", "paymentAuth.test.js"), "");
  const r = developmentPlan("Investigate a failing request", {
    root,
    evidence: { symbols: [{ file: "src/client.js", line: 8, name: "submit" }] },
  });
  assert.equal(r.mode, "repair");
  assert.equal(r.changeInspection, "git");
  assert.ok(r.security.some((s) => s.category === "money"));
  assert.ok(r.security.some((s) => s.category === "auth"));
  assert.ok(r.stages.find((s) => s.id === "reuse").refs.includes("src/client.js:8 submit"));
  assert.ok(r.testing.tests.includes("test/paymentAuth.test.js"));
  assert.ok(r.stages.some((s) => s.id === "review"));
  assert.ok(r.repair.action.includes("rerun"));
  assert.equal(
    r.stages.every((s) => s.status === "planned"),
    true,
  );
});
test("hook never asks Git for changes and a dependency risk keeps substantive steps", (t) => {
  const root = repo(t);
  writeFileSync(join(root, "package.json"), "{}");
  const r = developmentPlan("Fix a formatting typo", { root, hook: true });
  assert.equal(r.changeInspection, "deferred");
  assert.deepEqual(r.changedFiles, []);
  const withFiles = developmentPlan("Correct spelling", {
    root,
    hook: true,
    changedFiles: ["package.json", "../escape.js"],
  });
  assert.ok(withFiles.security.some((s) => s.category === "dependencies"));
  assert.notEqual(withFiles.mode, "focused");
  assert.deepEqual(withFiles.changedFiles, ["package.json"]);
  assert.deepEqual(withFiles.testing.tests, []);
});
test("module names and git refs are literal data during selection", (t) => {
  const root = repo(t);
  mkdirSync(join(root, "test"));
  const name = "module$(touch sentinel)";
  writeFileSync(join(root, "test", "related.test.js"), `import "${name}"`);
  assert.deepEqual(mapToTests(root, [`src/${name}.js`]), ["test/related.test.js"]);
  resolveChangedFiles(root, { base: "HEAD$(touch sentinel)", head: "HEAD" });
  assert.equal(existsSync(join(root, "sentinel")), false);
});

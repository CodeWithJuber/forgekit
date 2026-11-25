import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dependencyState, registerDependencies } from "../src/test_dependencies.js";
import {
  blastRadius,
  classifyDeterministic,
  mapToTests,
  resolveChangedFiles,
  selectTests,
} from "../src/test_select.js";

const rootDir = join(import.meta.dirname, "..");
const cli = join(rootDir, "src", "cli.js");
const script = join(rootDir, "scripts", "smart-test-select.mjs");
const fixtures = [
  "case-a.mjs",
  "case-b.mjs",
  "bridge.rs",
  "rates.py",
  "contract.md",
  "lookup.yaml",
  "orphan.js",
];
function fixture(t) {
  const prior = process.env.FORGE_TEST_ENVIRONMENT;
  process.env.FORGE_TEST_ENVIRONMENT = "fixture build environment";
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_TEST_ENVIRONMENT;
    else process.env.FORGE_TEST_ENVIRONMENT = prior;
  });
  const outer = mkdtempSync(join(tmpdir(), "forge-selection-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const root = join(outer, "repo"),
    evidence = join(outer, "observation.json");
  mkdirSync(root);
  function git(...args) {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  git("init", "-q");
  for (const f of fixtures) writeFileSync(join(root, f), "\n");
  git("add", "--all");
  git("-c", "user.name=Forge", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture");
  const receipt = {
    schemaVersion: 1,
    checkout: dependencyState(root),
    producer: "fixture build and trace",
    runner: "node:test",
    complete: true,
    unresolved: [],
    tests: ["case-b.mjs", "case-a.mjs"],
    dependencies: [
      ["case-a.mjs", "bridge.rs"],
      ["bridge.rs", "rates.py"],
      ["rates.py", "bridge.rs"],
      ["case-b.mjs", "lookup.yaml"],
    ],
  };
  const store = () => writeFileSync(evidence, JSON.stringify(receipt));
  store();
  const node = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, FORGE_HOME: join(outer, "private") },
      }),
    );
  return { root, evidence, receipt, store, git, node };
}

test("filenames alone never authorize a reduction, including renamed tests and documentation", async (t) => {
  const { root } = fixture(t);
  for (const files of [
    [],
    ["docs/README.md"],
    ["src/cli.js"],
    ["test/a.test.js"],
    ["*.json"],
    ["a.py", "b.rs"],
  ]) {
    assert.equal(classifyDeterministic(files).fullSuite, true);
    const r = await selectTests({ root, files });
    assert.equal(r.fullSuite, true);
    assert.equal(r.typecheck, true);
  }
  assert.deepEqual(mapToTests(root, ["rates.py"]), []);
  assert.equal(await blastRadius(root, ["rates.py"]), null);
});

test("CLI enrolls a private checkout-bound graph; Node CI and CLI follow cross-language cycles", async (t) => {
  const { root, evidence, receipt, node } = fixture(t);
  assert.deepEqual(node(cli, "test-select", "--state", "--json"), receipt.checkout);
  assert.equal(node(cli, "test-select", "--json").tier, "none");
  assert.equal(node(cli, "test-select", "--register", evidence).tests, 2);
  const result = node(cli, "test-select", "--changed", "rates.py", "--json");
  assert.deepEqual(result.tests, ["case-a.mjs"]);
  assert.equal(result.testUniverse, 2);
  assert.equal(result.affectedCount, 3);
  assert.equal(result.fullSuite, false);
  const ci = node(script, "--changed", "rates.py", "--evidence", evidence);
  assert.deepEqual(ci.tests, result.tests);
  assert.deepEqual(ci.checkout, result.checkout);
  assert.deepEqual((await selectTests({ root, files: ["case-b.mjs"], evidence })).tests, [
    "case-b.mjs",
  ]);
  assert.equal(
    node(cli, "test-select", "--changed", "rates.py,orphan.js", "--json").fullSuite,
    true,
  );
  assert.equal(
    node(cli, "test-select", "--changed", "rates.py,lookup.yaml", "--json").fullSuite,
    true,
  );
});

test("named LCOV records add observed language-independent edges and preserve unknowns", async (t) => {
  const { root, evidence, receipt, store } = fixture(t);
  receipt.lcov =
    "TN:case-b.mjs\nSF:contract.md\nDA:1,1\nend_of_record\nTN:case-a.mjs\nSF:contract.md\nDA:1,0\nend_of_record\n";
  store();
  const plan = () => selectTests({ root, evidence, files: ["contract.md"] });
  assert.deepEqual((await plan()).tests, ["case-b.mjs"]);
  for (const broken of [
    receipt.lcov.replace("TN:case-b.mjs", "TN:"),
    receipt.lcov.replace("end_of_record", ""),
    "TN:case-b.mjs\nSF:contract.md\nDA:1,0\nend_of_record\n",
    "aggregate coverage",
  ]) {
    receipt.lcov = broken;
    store();
    assert.equal((await plan()).fullSuite, true);
  }
});

test("partial discovery, unresolved dynamic input, foreign runner and checkout drift retain full verification", async (t) => {
  const { root, evidence, receipt, store, node, git } = fixture(t);
  const plan = () => selectTests({ root, evidence, files: ["rates.py"] });
  const profile = process.env.FORGE_TEST_ENVIRONMENT;
  delete process.env.FORGE_TEST_ENVIRONMENT;
  assert.match((await plan()).reason, /environment/);
  process.env.FORGE_TEST_ENVIRONMENT = profile;
  receipt.complete = false;
  store();
  assert.equal((await plan()).fullSuite, true);
  receipt.complete = true;
  receipt.unresolved = ["plugin chosen by runtime environment"];
  store();
  assert.equal((await plan()).fullSuite, true);
  receipt.unresolved = [];
  receipt.runner = "workspace-integration";
  store();
  assert.equal(node(script, "--changed", "rates.py", "--evidence", evidence).fullSuite, true);
  receipt.runner = "node:test";
  receipt.checkout.node += "-other";
  store();
  assert.match((await plan()).reason, /stale|environment/);
  receipt.checkout = dependencyState(root);
  store();
  assert.equal((await plan()).fullSuite, false);
  writeFileSync(join(root, "orphan.js"), "dirty content\n");
  assert.match((await plan()).reason, /stale/);
  writeFileSync(join(root, "orphan.js"), "\n");
  git(
    "-c",
    "user.name=Forge",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "new revision",
  );
  assert.match((await plan()).reason, /stale/);
  receipt.checkout = dependencyState(root);
  store();
  assert.equal(
    (await selectTests({ root, evidence, files: ["rates.py"], head: "HEAD^" })).fullSuite,
    true,
  );
});

test("an in-project manifest and references outside the tracked file set cannot authorize reduction", async (t) => {
  const { root, evidence, receipt, store } = fixture(t);
  const local = join(root, "receipt.json");
  writeFileSync(local, JSON.stringify(receipt));
  assert.throws(() => registerDependencies(root, local), /outside/);
  assert.equal((await selectTests({ root, evidence: local, files: ["rates.py"] })).fullSuite, true);
  rmSync(local);
  receipt.dependencies.push(["case-a.mjs", "../outside.py"]);
  store();
  assert.equal((await selectTests({ root, evidence, files: ["rates.py"] })).fullSuite, true);
  receipt.dependencies.pop();
  receipt.tests.push("case-a.mjs");
  store();
  assert.equal((await selectTests({ root, evidence, files: ["rates.py"] })).fullSuite, true);
});

test("Git changes include both sides of a rename and NUL-delimited paths", (t) => {
  const { root, git } = fixture(t);
  assert.equal(resolveChangedFiles(root), null);
  renameSync(join(root, "rates.py"), join(root, "new rates.py"));
  git("add", "--all");
  assert.deepEqual(resolveChangedFiles(root), ["new rates.py", "rates.py"]);
  git("-c", "user.name=Forge", "-c", "user.email=fixture@example.com", "commit", "-qm", "rename");
  assert.deepEqual(resolveChangedFiles(root, { base: "HEAD^", head: "HEAD" }), [
    "new rates.py",
    "rates.py",
  ]);
  writeFileSync(join(root, "pending.rb"), "");
  assert.deepEqual(resolveChangedFiles(root, { base: "HEAD^", head: "HEAD" }), [
    "new rates.py",
    "pending.rb",
    "rates.py",
  ]);
  assert.deepEqual(resolveChangedFiles(root, { base: "invalid-ref" }), []);
});

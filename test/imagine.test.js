import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/atlas.js";
import {
  dryRun,
  imagineTask,
  renderImagine,
  selectTests,
  selectTestsReport,
} from "../src/imagine.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-imagine-"));

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// ---------------------------------------------------------------------------
// selectTests — weighted greedy set cover (weight = file size).
// ---------------------------------------------------------------------------

test("selectTests covers every impacted source via its cheapest covering test", () => {
  const root = fixture();
  put(root, "src/a.js", "export function a() {}\n");
  put(root, "src/b.js", "export function b() {}\n");
  // src/a.js has TWO covering candidates; the smaller one must win the cover.
  put(root, "src/a.test.js", "// tiny\n");
  put(root, "test/a.js", `// huge duration proxy\n${"x".repeat(4000)}\n`);
  put(root, "src/b.test.js", "// b test\n");
  const tests = selectTests(root, ["src/a.js", "src/b.js"]);
  assert.ok(tests.includes("src/a.test.js"), "cheapest cover for src/a.js chosen");
  assert.ok(!tests.includes("test/a.js"), "redundant heavier test dropped");
  assert.ok(tests.includes("src/b.test.js"));
  assert.equal(tests.length, 2, "minimal: one test per otherwise-uncovered source");
});

test("selectTests orders the suite best-value-first (greedy pick order)", () => {
  const root = fixture();
  put(root, "src/a.js", "export function a() {}\n");
  put(root, "src/b.js", "export function b() {}\n");
  put(root, "src/a.test.js", "// tiny a test\n");
  put(root, "src/b.test.js", `// expensive b test\n${"y".repeat(4000)}\n`);
  const tests = selectTests(root, ["src/a.js", "src/b.js"]);
  assert.deepEqual(tests, ["src/a.test.js", "src/b.test.js"], "cheapest per covered file first");
});

test("selectTests includes an impacted test file (it covers itself)", () => {
  const root = fixture();
  put(root, "src/a.js", "export function a() {}\n");
  put(root, "src/a.test.js", "// a test\n");
  put(root, "test/util.js", "// an impacted test file\n");
  const tests = selectTests(root, ["src/a.js", "test/util.js"]);
  assert.ok(tests.includes("test/util.js"), "predicted-to-break test is part of the suite");
  assert.ok(tests.includes("src/a.test.js"));
});

test("selectTestsReport names the sources no known test covers, without blocking", () => {
  const root = fixture();
  put(root, "src/a.js", "export function a() {}\n");
  put(root, "src/a.test.js", "// a test\n");
  put(root, "src/orphan.js", "export function orphan() {}\n");
  const { tests, uncovered } = selectTestsReport(root, ["src/a.js", "src/orphan.js"]);
  assert.deepEqual(tests, ["src/a.test.js"]);
  assert.deepEqual(uncovered, ["src/orphan.js"], "the gap is surfaced, not silently dropped");
});

test("selectTests on nothing impacted is an empty suite", () => {
  assert.deepEqual(selectTests(fixture(), []), []);
});

// ---------------------------------------------------------------------------
// imagineTask — entities → impact → predicted breaks + dry-run suite + risk.
// ---------------------------------------------------------------------------

function appFixture() {
  const root = fixture();
  put(root, "src/util.js", "export function helper(x) {\n  return x * 2;\n}\n");
  put(
    root,
    "src/app.js",
    'import { helper } from "./util.js";\nexport function runApp() {\n  return helper(1);\n}\n',
  );
  put(root, "src/app.test.js", 'import { runApp } from "./app.js";\nrunApp();\n');
  return { root, atlas: build({ root }) };
}

test("imagineTask predicts breaks with confidence and selects the minimal dry-run suite", () => {
  const { root, atlas } = appFixture();
  const r = imagineTask(root, "update `helper` in src/util.js", { atlas });
  assert.equal(r.found, true);
  assert.ok(r.targets.includes("helper"));
  const files = r.predictedBreaks.map((b) => b.file);
  assert.ok(files.includes("src/app.js"), "the caller of helper is a predicted break");
  for (const b of r.predictedBreaks) {
    assert.ok(b.confidence > 0 && b.confidence <= 1, `confidence in (0,1]: ${b.confidence}`);
  }
  assert.ok(r.tests.includes("src/app.test.js"), "the impacted caller's test is in the suite");
  const sum = r.predictedBreaks.reduce((s, b) => s + b.confidence, 0);
  assert.ok(Math.abs(r.riskScore - sum) < 1e-9, "riskScore = Σ confidence");
  assert.ok(r.riskScore > 0);
});

test("imagineTask predictedBreaks are sorted by confidence, descending", () => {
  const { root, atlas } = appFixture();
  const r = imagineTask(root, "update `helper` in src/util.js", { atlas });
  for (let i = 1; i < r.predictedBreaks.length; i++) {
    assert.ok(r.predictedBreaks[i - 1].confidence >= r.predictedBreaks[i].confidence);
  }
});

test("imagineTask on a task naming nothing in the graph predicts nothing", () => {
  const { root, atlas } = appFixture();
  const r = imagineTask(root, "polish `totallyUnknownThing` please", { atlas });
  assert.equal(r.found, false);
  assert.deepEqual(r.predictedBreaks, []);
  assert.deepEqual(r.tests, []);
  assert.equal(r.riskScore, 0);
  assert.match(renderImagine(r), /nothing in the code graph/);
});

test("renderImagine prints breaks, the suite, and the sandbox follow-up note", () => {
  const { root, atlas } = appFixture();
  const out = renderImagine(imagineTask(root, "update `helper` in src/util.js", { atlas }));
  assert.match(out, /predicted breaks/);
  assert.match(out, /minimal dry-run suite/);
  assert.match(out, /src\/app\.test\.js/);
  assert.match(out, /risk score/);
  assert.match(out, /--run/, "footer points at the sandboxed dry-run flag");
});

// ---------------------------------------------------------------------------
// dryRun — the sandboxed worktree runner (spec §2.2). One tiny fixture repo,
// ONE commit: the sandbox is a worktree of HEAD, so everything must be committed.
// ---------------------------------------------------------------------------

function gitFixture() {
  const root = fixture();
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  // type:module so `import` in .js is unambiguous across node versions (no reliance
  // on syntax detection); no test script → dryRun reports the default runner.
  put(root, "package.json", '{ "name": "fx", "type": "module" }\n');
  put(root, "src/val.js", "export const val = 1;\n");
  put(
    root,
    "test/pass.test.js",
    'import assert from "node:assert/strict";\n' +
      'import { test } from "node:test";\n' +
      'import { val } from "../src/val.js";\n' +
      'test("val is 1", () => assert.equal(val, 1));\n',
  );
  put(
    root,
    "test/fail.test.js",
    'import assert from "node:assert/strict";\n' +
      'import { test } from "node:test";\n' +
      'import { val } from "../src/val.js";\n' +
      'test("val is 2", () => assert.equal(val, 2));\n',
  );
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

const dryrunTmpEntries = () =>
  new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("forge-dryrun-")));

test("dryRun executes the suite in an ephemeral worktree and removes it (pass + fail)", () => {
  const { root, git } = gitFixture();
  const before = dryrunTmpEntries();

  const green = dryRun(root, { tests: ["test/pass.test.js"] });
  assert.equal(green.ok, true, `dry-run should produce a verdict: ${green.reason ?? ""}`);
  assert.equal(green.failed, 0);
  assert.ok(green.passed >= 1, "the passing test actually ran");
  assert.match(green.runner, /^node --test/);
  assert.equal(green.worktree, "removed");
  assert.ok(Number.isFinite(green.durationMs));
  assert.deepEqual(green.perFile, { "test/pass.test.js": "pass" });

  // ok:true with failed>0 is deliberate: the RUN succeeded — the sandbox built, the
  // suite executed to a verdict — and the verdict is "these tests fail". ok:false is
  // reserved for the run itself failing (no repo, timeout, runner crash).
  const red = dryRun(root, { tests: ["test/pass.test.js", "test/fail.test.js"] });
  assert.equal(red.ok, true, "a failing SUITE is still a successful RUN");
  assert.ok(red.failed > 0, "the failure is measured, not hidden");
  assert.equal(red.passed, 1);
  assert.equal(red.worktree, "removed");
  assert.deepEqual(red.perFile, {
    "test/pass.test.js": "pass",
    "test/fail.test.js": "fail",
  });
  assert.match(red.output, /# fail 1/, "TAP tail is preserved as evidence");

  // The sandbox must actually be gone: no new forge-dryrun-* dirs in tmp, and the
  // fixture repo's worktree bookkeeping is back to just the main checkout.
  for (const d of dryrunTmpEntries())
    assert.ok(before.has(d), `ephemeral worktree dir leaked: ${d}`);
  const list = git("worktree", "list", "--porcelain").toString();
  const count = (list.match(/^worktree /gm) || []).length;
  assert.equal(count, 1, `git worktree list shows leftovers:\n${list}`);
});

test("dryRun refuses gracefully outside a git repo and on an empty suite", () => {
  const plain = fixture(); // mkdtemp dir, never git-init'ed
  const notRepo = dryRun(plain, { tests: ["test/pass.test.js"] });
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.reason, /not a git repository/);

  const { root } = gitFixture();
  assert.equal(dryRun(root, { tests: [] }).ok, false);
  assert.equal(dryRun(root).ok, false, "missing opts is a precondition failure, not a throw");
  assert.ok(!existsSync(join(root, ".forge")), "refusal writes nothing into the repo");
});

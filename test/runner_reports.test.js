import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countedGradleReports, gradleReports } from "../src/junit_reports.js";
import { countVerdict, observedTestCounts } from "../src/test_counts.js";

test("Gradle counts only JUnit reports rewritten during this invocation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-junit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = gradleReports(root);
  const dest = join(root, "module", "build", "test-results", "test");
  mkdirSync(dest, { recursive: true });
  writeFileSync(
    join(dest, "TEST-Demo.xml"),
    '<?xml version="1.0"?><testsuite name="Demo" tests="3" skipped="1" failures="0" errors="0"></testsuite>',
  );
  assert.equal(countedGradleReports(root, before).pass, 2);
  assert.equal(countedGradleReports(root, gradleReports(root)), null);
});

test("terminal summaries from common runners preserve published count units", () => {
  for (const [raw, passes] of [
    ["  3 passing (5ms)", 3],
    ["12 examples, 0 failures", 12],
    ["12 runs, 14 assertions, 0 failures, 0 errors, 0 skips", 12],
    ["OK (12 tests, 30 assertions)", 12],
    ["Ran 12 tests in 0.003s\n\nOK", 12],
    [
      "test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      14,
    ],
    ["  3 pass\n 0 fail\n 6 expect() calls\nRan 3 tests across 1 file. [12.00ms]", 3],
    ["[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 1\n[INFO] BUILD SUCCESS", 4],
    ["4 tests completed, 1 skipped", 3],
    ["Passed!  - Failed: 0, Passed: 2, Skipped: 1, Total: 3, Duration: 11 ms", 2],
    ['{"Package":"demo","Test":"TestOne","Action":"pass"}\n{"Package":"demo","Action":"pass"}', 1],
    ["1 xpassed in 0.01s", 1],
  ]) {
    const result = observedTestCounts(raw);
    assert.equal(countVerdict(result), "PASS", raw);
    assert.equal(result.pass, passes, raw);
  }
  for (const raw of [
    "ok   demo/pkg  0.012s",
    "BUILD SUCCESSFUL",
    "0 passing (4ms)",
    "Ran 0 tests in 0.0s\n\nOK",
  ]) {
    assert.equal(countVerdict(observedTestCounts(raw)), "INCOMPLETE", raw);
  }
});

test("messages from a test and child programs cannot override the enclosing runner's terminal result", () => {
  const node = [
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 9",
  ].join("\n");
  for (const log of ["Tests: loading fixtures", "3 retries in 0.5s", "1 failed in 0.2s"]) {
    assert.equal(countVerdict(observedTestCounts(log + "\n" + node, [], "node")), "PASS", log);
    assert.equal(countVerdict(observedTestCounts(log + "\n" + node)), "PASS", log);
  }
  assert.equal(
    countVerdict(observedTestCounts("1 passed in 0.2s\nmore test output", [], "pytest")),
    "INCOMPLETE",
  );
  assert.equal(countVerdict(observedTestCounts("1 passed in 0.2s", [], "node")), "INCOMPLETE");
});

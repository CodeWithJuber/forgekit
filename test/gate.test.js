import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPath, gateDecision, obligationsFor } from "../src/gate.js";

test("obligationsFor derives change-type obligations (P1-05)", () => {
  const code = obligationsFor({ code: ["src/x.js"] });
  assert.ok(
    code.some((o) => /test/.test(o)),
    "code change obliges a test, not just a handoff note",
  );
  const config = obligationsFor({ config: ["Dockerfile"] });
  assert.ok(config.some((o) => /config/i.test(o)));
  assert.deepEqual(obligationsFor({ test: ["x.test.js"] }), [], "test-only owes no prose");
});

test("classifyPath: one total function from the shared registries", () => {
  assert.equal(classifyPath(".forge/state.md"), "docs", "state snapshot IS the doc signal");
  assert.equal(classifyPath(".forge/decisions.md"), "docs");
  assert.equal(classifyPath(".forge/lessons/x.md"), "internal");
  assert.equal(classifyPath("AGENTS.md"), "internal", "generated instruction files owe nothing");
  assert.equal(classifyPath("CLAUDE.md"), "internal");
  assert.equal(classifyPath("README.md"), "docs");
  assert.equal(classifyPath("docs/GUIDE.md"), "docs");
  assert.equal(classifyPath("CHANGELOG.md"), "docs", "a changelog entry satisfies the gate");
  assert.equal(classifyPath("src/route.js"), "code");
  assert.equal(classifyPath("lib/store.py"), "code");
  assert.equal(classifyPath("test/route.test.js"), "test");
  assert.equal(classifyPath("src/__tests__/x.jsx"), "test");
  assert.equal(classifyPath("Dockerfile"), "config");
  assert.equal(classifyPath(".github/workflows/ci.yml"), "config");
  assert.equal(classifyPath("vite.config.ts"), "config");
  assert.equal(classifyPath("logo.png"), "other");
  assert.equal(classifyPath("package-lock.json"), "other", "lockfiles are churn, not config");
});

test("gate table: guard rows always allow", () => {
  assert.equal(gateDecision({ stopHookActive: true }).row, "stop-hook-active");
  assert.equal(gateDecision({ isRepo: false }).row, "not-a-repo");
  assert.equal(gateDecision({ markerExists: true }).row, "already-blocked");
  assert.equal(gateDecision({ killSwitch: true }).row, "kill-switch");
  for (const r of [
    gateDecision({ stopHookActive: true }),
    gateDecision({ isRepo: false }),
    gateDecision({ markerExists: true }),
    gateDecision({ killSwitch: true }),
  ])
    assert.equal(r.allow, true);
});

test("gate table: clean and internal-only sessions owe nothing", () => {
  assert.equal(gateDecision({ changed: [] }).row, "no-changes");
  const internal = gateDecision({
    changed: [".forge/lessons/a.md", "AGENTS.md"],
  });
  assert.equal(internal.row, "no-changes", "internal artifacts never trigger the gate");
  assert.equal(internal.allow, true);
});

test("gate table: THE row — code moved with no test evidence → block (RA-10)", () => {
  const r = gateDecision({ changed: ["src/route.js", "src/gate.js"] });
  assert.equal(r.allow, false);
  assert.equal(r.row, "code-without-test-evidence");
  assert.deepEqual(r.classes.code, ["src/route.js", "src/gate.js"]);
});

test("gate table: docs/handoff alone no longer satisfy a code change (RA-10)", () => {
  assert.equal(
    gateDecision({ changed: ["src/route.js", "README.md"] }).allow,
    false,
    "code + docs but NO test evidence blocks — ceremony is not evidence",
  );
  assert.equal(
    gateDecision({ changed: ["src/route.js"], stateTouched: true }).row,
    "code-without-test-evidence",
    "a handoff alone can no longer pass a code change",
  );
  assert.equal(
    gateDecision({ changed: ["src/x.js", ".forge/state.md"] }).row,
    "code-without-test-evidence",
  );
});

test("gate table: code + test evidence but NO docs/state → code-without-docs", () => {
  const r = gateDecision({ changed: ["src/x.js", "test/x.test.js"] });
  assert.equal(r.allow, false);
  assert.equal(r.row, "code-without-docs", "reachable only WITH test evidence now");
});

test("gate table: code + test evidence + docs (or state) → allow code-with-evidence", () => {
  const tested = gateDecision({
    changed: ["src/x.js", "test/x.test.js", "README.md"],
  });
  assert.equal(tested.allow, true);
  assert.equal(tested.row, "code-with-evidence");
  const handoff = gateDecision({
    changed: ["src/x.js", "test/x.test.js"],
    stateTouched: true,
  });
  assert.equal(handoff.allow, true, "state/handoff still counts as the continuity leg");
  assert.equal(handoff.row, "code-with-evidence");
});

test("gate table: a fresh passing verify run is test evidence; stale or FAIL is not", () => {
  const base = { changed: ["src/x.js", "README.md"] };
  const fresh = gateDecision({
    ...base,
    verifyEvidence: { fresh: true, status: "PASS" },
  });
  assert.equal(fresh.allow, true);
  assert.equal(fresh.row, "code-with-evidence");
  assert.equal(
    gateDecision({ ...base, verifyEvidence: { fresh: false, status: "PASS" } }).row,
    "code-without-test-evidence",
    "a stale provenance stamp proves nothing about THIS session's change",
  );
  assert.equal(
    gateDecision({ ...base, verifyEvidence: { fresh: true, status: "FAIL" } }).row,
    "code-without-test-evidence",
    "a fresh FAIL is not evidence of completion",
  );
  assert.equal(
    gateDecision({
      changed: ["src/x.js"],
      verifyEvidence: { fresh: true, status: "PASS" },
    }).row,
    "code-without-docs",
    "verify evidence covers the test leg only — docs are still owed",
  );
});

test("gate table: test-only sessions pass (a regression test owes no prose)", () => {
  const r = gateDecision({ changed: ["test/gate.test.js"] });
  assert.equal(r.allow, true);
  assert.equal(r.row, "test-only");
});

test("gate table: config-only owes the lighter continuity bar", () => {
  const bare = gateDecision({ changed: [".github/workflows/ci.yml"] });
  assert.equal(bare.allow, false);
  assert.equal(bare.row, "config-without-docs");
  assert.equal(
    gateDecision({ changed: [".github/workflows/ci.yml"], stateTouched: true }).allow,
    true,
    "a handoff alone satisfies THIS row (config-only)",
  );
  assert.equal(
    gateDecision({ changed: [".github/workflows/ci.yml", "docs/DEPLOY.md"] }).row,
    "docs-touched",
  );
});

test("gate table: docs-only and other-only changes still pass", () => {
  assert.equal(gateDecision({ changed: ["docs/GUIDE.md"] }).row, "docs-touched");
  assert.equal(gateDecision({ changed: ["assets/logo.png"] }).row, "no-code-class");
});

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

test("gate table: THE row — code moved, no doc/state followed → block", () => {
  const r = gateDecision({ changed: ["src/route.js", "src/gate.js"] });
  assert.equal(r.allow, false);
  assert.equal(r.row, "code-without-docs");
  assert.deepEqual(r.classes.code, ["src/route.js", "src/gate.js"]);
});

test("gate table: any doc-class artifact (or a state touch) satisfies the floor", () => {
  assert.equal(gateDecision({ changed: ["src/route.js", "README.md"] }).row, "docs-touched");
  assert.equal(gateDecision({ changed: ["src/route.js"], stateTouched: true }).row, "docs-touched");
  assert.equal(gateDecision({ changed: ["docs/GUIDE.md"] }).row, "docs-touched");
  assert.equal(
    gateDecision({ changed: ["src/x.js", ".forge/state.md"] }).row,
    "docs-touched",
    "the gitignore-invisible snapshot counts via the changed set too",
  );
});

test("gate table: test-only, config-only, and other-only changes pass (precision rule)", () => {
  assert.equal(gateDecision({ changed: ["test/gate.test.js"] }).row, "no-code-class");
  assert.equal(gateDecision({ changed: [".github/workflows/ci.yml"] }).row, "no-code-class");
  assert.equal(gateDecision({ changed: ["assets/logo.png"] }).row, "no-code-class");
  assert.equal(
    gateDecision({ changed: ["src/x.js", "test/x.test.js"] }).allow,
    false,
    "code + tests but NO docs still blocks — tests are not prose",
  );
});

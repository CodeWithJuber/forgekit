import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyPath,
  gateDecision,
  obligationsFor,
  recordUiCheck,
  repairReason,
} from "../src/gate.js";

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

test("gate table: a fresh code-state-matching verify PASS is test evidence; stale/FAIL/moved-code is not", () => {
  const base = { changed: ["src/x.js", "README.md"] };
  const fresh = gateDecision({
    ...base,
    verifyEvidence: { fresh: true, status: "PASS", codeStateMatches: true },
  });
  assert.equal(fresh.allow, true);
  assert.equal(fresh.row, "code-with-evidence");
  assert.equal(
    gateDecision({
      ...base,
      verifyEvidence: { fresh: false, status: "PASS", codeStateMatches: true },
    }).row,
    "code-without-test-evidence",
    "a stale provenance stamp proves nothing about THIS session's change",
  );
  assert.equal(
    gateDecision({
      ...base,
      verifyEvidence: { fresh: true, status: "FAIL", codeStateMatches: true },
    }).row,
    "code-without-test-evidence",
    "a fresh FAIL is not evidence of completion",
  );
  assert.equal(
    gateDecision({
      ...base,
      verifyEvidence: { fresh: true, status: "PASS", codeStateMatches: false },
    }).row,
    "code-without-test-evidence",
    "HI-02: a PASS whose code state moved since verification is stale and does not count",
  );
  assert.equal(
    gateDecision({
      changed: ["src/x.js"],
      verifyEvidence: { fresh: true, status: "PASS", codeStateMatches: true },
    }).row,
    "code-without-docs",
    "verify evidence covers the test leg only — docs are still owed",
  );
});

test("gate table: HI-04 — a changed test file is not proof unless substantive", () => {
  const changed = ["src/x.js", "test/x.test.js", "README.md"];
  assert.equal(
    gateDecision({ changed, substantiveTests: [] }).row,
    "code-without-test-evidence",
    "a deleted/emptied test file does not satisfy the code-change test leg",
  );
  assert.equal(
    gateDecision({ changed, substantiveTests: ["test/x.test.js"] }).allow,
    true,
    "a real added/modified test file still counts as the weaker evidence leg",
  );
  assert.equal(
    gateDecision({ changed }).allow,
    true,
    "back-compat: no FS filter supplied → raw classification still decides",
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

test("classifyPath: stylesheets are the ui class (the same visual change as a className edit)", () => {
  for (const p of ["src/app/globals.css", "styles/site.scss", "a.sass", "theme.less"])
    assert.equal(classifyPath(p), "ui", p);
  assert.equal(classifyPath("src/components/Hero.tsx"), "code", "by path a .tsx is code");
  assert.equal(classifyPath("tailwind.config.ts"), "config", "config still wins over code");
});

test("gate table: a UI-only change owes a record OR a UI check, never a unit test", () => {
  const hero = "src/components/Hero.tsx";
  const bare = gateDecision({ changed: [hero], uiOnly: [hero] });
  assert.equal(bare.allow, false);
  assert.equal(bare.row, "ui-without-evidence");
  assert.deepEqual(bare.classes.ui, [hero], "a presentational code file moves to ui");
  assert.deepEqual(bare.classes.code, []);
  for (const [why, extra] of [
    ["a design doc", { changed: [hero, "DESIGN.md"] }],
    ["a handoff", { stateTouched: true }],
    ["a fresh uicheck PASS", { uiCheckEvidence: true }],
    ["a passing e2e run", { e2eEvidence: true }],
    [
      "a fresh verify PASS",
      { verifyEvidence: { fresh: true, status: "PASS", codeStateMatches: true } },
    ],
  ]) {
    const r = gateDecision({ changed: [hero], uiOnly: [hero], ...extra });
    assert.equal(r.allow, true, why);
    assert.equal(r.row, "ui-with-evidence", why);
  }
  assert.equal(
    gateDecision({ changed: ["src/app/globals.css"] }).row,
    "ui-without-evidence",
    "a bare stylesheet change is no longer free",
  );
});

test("gate table: a logic change in the same file stays code; uiOnly never hides it", () => {
  const r = gateDecision({ changed: ["src/components/Hero.tsx", "DESIGN.md"], uiOnly: [] });
  assert.equal(r.row, "code-without-test-evidence");
  assert.equal(
    gateDecision({
      changed: ["src/components/Hero.tsx", "DESIGN.md"],
      uiOnly: [],
      uiCheckEvidence: true,
    }).row,
    "code-without-test-evidence",
    "a UI check is not test evidence for logic",
  );
  assert.equal(
    gateDecision({ changed: ["src/x.js", "README.md"], e2eEvidence: true }).row,
    "code-with-evidence",
    "a passing e2e run IS test evidence for code",
  );
});

test("gate table: UI evidence does not cover config that moved alongside", () => {
  const r = gateDecision({
    changed: ["src/app/globals.css", "tailwind.config.ts"],
    uiCheckEvidence: true,
  });
  assert.equal(r.row, "config-without-docs", "config still owes its docs/state bar");
  assert.equal(
    gateDecision({ changed: ["src/app/globals.css", "tailwind.config.ts"], stateTouched: true })
      .row,
    "ui-with-evidence",
  );
});

test("obligationsFor: a UI-only change names the record-or-check obligation", () => {
  const [ui] = obligationsFor({ ui: ["a.css"] });
  assert.match(ui, /UI-only/);
  assert.match(ui, /uicheck/);
  assert.match(ui, /not owed/, "says a unit test is not owed");
});

test("repairReason: the UI row leads with the UI check and cites the UI files", () => {
  const reason = repairReason("/nonexistent-forge-root", {
    row: "ui-without-evidence",
    classes: { ui: ["src/components/Hero.tsx"] },
    unattributed: 2,
  });
  assert.match(reason, /UI-only change/);
  assert.match(reason, /Changed UI: src\/components\/Hero\.tsx/);
  assert.match(reason, /uicheck design/);
  assert.match(reason, /this alone satisfies the gate for a UI-only change/);
  assert.match(reason, /2 other changed file\(s\).*another agent/);
  assert.doesNotMatch(reason, /NO test evidence/);
});

test("recordUiCheck: a signed, code-state-bound stamp inside a repo; nothing outside one", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-uicheck-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "a.css"), "a{}\n");
  assert.equal(recordUiCheck(root, { check: "design", pass: true, files: ["./a.css"] }), true);
  const stamp = JSON.parse(readFileSync(join(root, ".forge", "uicheck.json"), "utf8"));
  assert.equal(stamp.check, "design");
  assert.equal(stamp.status, "PASS");
  assert.deepEqual(stamp.files, ["a.css"], "the checked files, repo-relative");
  assert.equal(typeof stamp.codeState.dirtyHash, "string");
  assert.match(stamp.signature, /^[0-9a-f]{64}$/, "MAC'd like the verify stamp");
  recordUiCheck(root, { check: "design", pass: false });
  assert.equal(
    JSON.parse(readFileSync(join(root, ".forge", "uicheck.json"), "utf8")).status,
    "FAIL",
    "a FAIL replaces an earlier PASS",
  );
  const bare = mkdtempSync(join(tmpdir(), "forge-uicheck-"));
  assert.equal(recordUiCheck(bare, { check: "design", pass: true }), false);
  assert.equal(existsSync(join(bare, ".forge")), false, "no stray .forge outside a repo");
});

test("recordUiCheck: run from a subdirectory, the stamp lands at the toplevel, toplevel-relative", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-uicheck-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "web", "src"), { recursive: true });
  writeFileSync(join(root, "web", "src", "a.css"), "a{}\n");
  const sub = join(root, "web");
  assert.equal(recordUiCheck(sub, { check: "design", pass: true, files: ["src/a.css"] }), true);
  assert.equal(existsSync(join(sub, ".forge")), false, "not in the subdirectory");
  const stamp = JSON.parse(readFileSync(join(root, ".forge", "uicheck.json"), "utf8"));
  assert.deepEqual(stamp.files, ["web/src/a.css"], "the path `git status` reports");
});

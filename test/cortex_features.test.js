import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeFeatures,
  featuresForEdit,
  gitChurn,
  grepFanout,
  moduleStem,
  referencingFiles,
} from "../src/cortex_features.js";
import { newLesson } from "../src/lessons.js";

test("computeFeatures normalizes and derives every feature", () => {
  const f = computeFeatures(
    { file: "src/auth.ts", symbol: "validateToken" },
    {
      callerCount: 20,
      churnCommits: 5,
      hasTest: false,
      signatureChange: true,
      callersInDiff: false,
    },
  );
  assert.equal(f.caller_fanout, 1, "20 callers clamps to 1");
  assert.equal(f.churn, 0.5, "5/10 commits");
  assert.equal(f.test_coverage_gap, 1, "no test → gap");
  assert.equal(f.signature_change, 1);
  assert.equal(f.no_caller_update, 1, "signature changed + callers not in diff = classic break");
});

test("lesson_match + past_mistake_here reflect a matching active lesson", () => {
  const lesson = {
    ...newLesson({ id: "l", trigger: { symbols: ["validateToken"] } }, 0),
    status: "active",
    evidenceCount: 2,
  };
  const f = computeFeatures(
    { file: "src/auth.ts", symbol: "validateToken" },
    { activeLessons: [lesson], nowDay: 0 },
  );
  assert.ok(f.lesson_match > 0, "an active lesson on this symbol raises lesson_match");
  assert.equal(f.past_mistake_here, 1, "prior evidence here");

  const none = computeFeatures({ symbol: "unrelated" }, { activeLessons: [lesson], nowDay: 0 });
  assert.equal(none.lesson_match, 0, "no match for a different symbol");
  assert.equal(none.past_mistake_here, 0);
});

test("no_caller_update only fires when a signature changed AND callers weren't touched", () => {
  assert.equal(
    computeFeatures({}, { signatureChange: true, callersInDiff: true }).no_caller_update,
    0,
  );
  assert.equal(
    computeFeatures({}, { signatureChange: false, callersInDiff: false }).no_caller_update,
    0,
  );
});

test("featuresForEdit degrades gracefully on a non-git repo (no throw, valid vector)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-feat-"));
  const f = featuresForEdit(root, { file: "src/x.ts", symbol: "foo" }, { nowDay: 1 });
  assert.equal(f.churn, 0, "no git → no churn");
  assert.equal(f.caller_fanout, 0, "no git grep → no fan-out");
  assert.equal(f.lesson_match, 0, "no lessons yet");
});

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "forge-feat-git-"));
  const git = (args, env) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
  git(["init", "-q"]);
  git(["config", "user.email", "forge@test.invalid"]);
  git(["config", "user.name", "forge-test"]);
  const commit = (message, date) => {
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-qm", message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  };
  return { root, commit };
}

test("grepFanout counts whole-word matches only ('get' no longer matches 'target')", () => {
  const { root, commit } = gitRepo();
  writeFileSync(join(root, "a.js"), "export const target = 1;\nexport const widget = 2;\n");
  writeFileSync(join(root, "b.js"), "import { get } from './x.js';\nexport const b = get();\n");
  writeFileSync(join(root, "c.js"), "export function get() {\n  return 1;\n}\n");
  commit("fixture");
  assert.equal(grepFanout(root, "get"), 2, "only the two files that use `get` as a word");
  assert.equal(grepFanout(root, "target"), 1);
  assert.equal(grepFanout(root, ""), 0, "no symbol → no fan-out");
});

test("gitChurn counts only commits inside the time window", () => {
  const { root, commit } = gitRepo();
  writeFileSync(join(root, "ancient.js"), "export const a = 1;\n");
  commit("ancient", "2015-01-01T00:00:00Z");
  writeFileSync(join(root, "ancient.js"), "export const a = 2;\n");
  commit("ancient again", "2015-02-01T00:00:00Z");
  writeFileSync(join(root, "fresh.js"), "export const f = 1;\n");
  commit("fresh");
  assert.equal(gitChurn(root, "ancient.js"), 0, "untouched for a decade → no churn");
  assert.equal(gitChurn(root, "fresh.js"), 1);
  assert.ok(gitChurn(root, "ancient.js", { days: 6000 }) >= 2, "a wider window sees the history");
});

// --- caller_fanout from the FILE when the caller has no symbol --------------------------

/** A module with `callers` importers, one test, and one same-named doc (never a caller). */
const fanoutRepo = (callers = 6) => {
  const { root, commit } = gitRepo();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "pricing.js"), "export function pricing(q) {\n  return q;\n}\n");
  for (let i = 0; i < callers; i++)
    writeFileSync(
      join(root, "src", `caller${i}.js`),
      `import { pricing } from "./pricing.js";\nexport const v${i} = pricing(${i});\n`,
    );
  writeFileSync(join(root, "test", "pricing.test.js"), 'import "../src/pricing.js";\n');
  writeFileSync(join(root, "PRICING.md"), "# pricing\n\nThe pricing module.\n");
  commit("fixture");
  return root;
};

test("featuresForEdit derives caller_fanout from the FILE when the edit has no symbol", () => {
  // The production callers (the pre-edit hook) only ever have a path. Asking grepFanout
  // about `undefined` pinned caller_fanout at 0 for every one of them — the feature was
  // dead. Six importers must now register.
  const root = fanoutRepo(6);
  const bySymbol = featuresForEdit(root, { file: "src/pricing.js", symbol: "pricing" });
  const byFile = featuresForEdit(root, { file: "src/pricing.js" });
  assert.ok(bySymbol.caller_fanout > 0, "symbol path still works");
  assert.equal(byFile.caller_fanout, 0.6, "6 code importers / 10 — the file's own fan-out");
  assert.equal(
    featuresForEdit(root, { file: "src/unreferenced.js" }).caller_fanout,
    0,
    "a file nobody names still has no fan-out — the signal did not become free",
  );
});

test("referencingFiles splits callers from tests and never counts the file itself", () => {
  const root = fanoutRepo(2);
  const { callers, tests } = referencingFiles(root, "src/pricing.js");
  assert.deepEqual(callers.sort(), ["src/caller0.js", "src/caller1.js"]);
  assert.deepEqual(
    tests,
    ["test/pricing.test.js"],
    "a test referencing it is coverage, not fan-out",
  );
  assert.ok(!callers.includes("src/pricing.js"), "the definition is not its own caller");
  assert.ok(!callers.includes("PRICING.md"), "prose that names the module is not a caller");
});

test("moduleStem uses the directory for entry-point names and refuses short stems", () => {
  assert.equal(moduleStem("src/pricing.js"), "pricing");
  assert.equal(moduleStem("src/auth/index.js"), "auth");
  assert.equal(moduleStem("pkg/mod.rs"), "pkg");
  assert.equal(moduleStem("src/db.js"), "", "a 2-char stem greps too widely to be signal");
  assert.equal(moduleStem(""), "");
});

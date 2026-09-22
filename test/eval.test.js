import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { IMPACT_CASES } from "../bench/impact_cases.mjs";
import { build } from "../src/atlas.js";
import { evalImpact, score } from "../src/eval.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("score computes precision/recall/f1", () => {
  const s = score(["a", "b", "c"], ["b", "c", "d"]);
  assert.equal(s.tp, 2);
  assert.ok(Math.abs(s.precision - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.recall - 2 / 3) < 1e-9);
  assert.equal(score([], []).recall, 1, "nothing to find, nothing predicted → perfect recall");
});

test("evalImpact: the oracle recalls more of the true blast radius than edited-file-only", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-eval-"));
  // File and symbol names must differ (a file whose module name equals the symbol makes the
  // call target ambiguous — a known atlas limitation, not what we're measuring here).
  writeFileSync(join(root, "util.js"), "export function coreFn(){ return 1 }\n");
  writeFileSync(
    join(root, "a.js"),
    "import { coreFn } from './util.js'\nexport function a(){ return coreFn() }\n",
  );
  writeFileSync(
    join(root, "b.js"),
    "import { coreFn } from './util.js'\nexport function b(){ return coreFn() }\n",
  );
  const atlas = build({ root });
  const cases = [
    { target: "coreFn", expected: ["util.js", "a.js", "b.js"], editedFile: "util.js" },
  ];
  const r = evalImpact(atlas, cases);
  assert.ok(r.oracle.recall >= r.baseline.recall, "oracle recall ≥ baseline");
  assert.ok(r.oracle.recall > 0.5, `oracle finds most dependents (recall ${r.oracle.recall})`);
});

// ---------------------------------------------------------------------------
// The impact benchmark's labels must stay GROUND TRUTH. They are a hand-derived
// fixture (bench/impact_cases.mjs) that the published precision/recall/F1 are scored
// against, so a label set that drifts from the source silently corrupts a number in
// reports/benchmarks.md and README.md. This re-derives the referencers mechanically and
// fails the moment the two disagree — which is how four of the six sets went stale.
// ---------------------------------------------------------------------------

// Files that name a target only in PROSE — a comment, a doc line, or a string such as an
// assertion message. Not references, deliberately not labeled. Listing them here (rather
// than filtering by heuristic) is what makes "unlabeled" mean "someone decided".
const MENTION_ONLY = {
  claimText: ["test/dash.test.js"], // :69, inside an assertion message
};

// This file names every target as DATA (the table above, assertion text), so `git grep`
// finds it for all of them. It excludes itself from the "unlabeled referencer" check
// rather than listing itself under every key — it is the checker, not a dependent.
const SELF = "test/eval.test.js";

const gitGrepFiles = (symbol) => {
  const r = spawnSync("git", ["grep", "-l", "-w", "-F", "-e", symbol, "--", "src/*", "test/*"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0 && r.status !== 1) return null; // no git / not a work tree → skip
  return (r.stdout || "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
};

test("bench impact labels are ground truth: every label is grep-backed, nothing real is missing", (t) => {
  if (gitGrepFiles("IMPACT_CASES") === null) return t.skip("git grep unavailable");
  for (const c of IMPACT_CASES) {
    const hits = new Set(gitGrepFiles(c.target));
    const labeled = new Set(c.expected);
    assert.ok(hits.size > 0, `${c.target}: grep found nothing — is the symbol gone?`);
    assert.ok(labeled.has(c.editedFile), `${c.target}: the defining file is always labeled`);

    const ghosts = [...labeled].filter((f) => !hits.has(f));
    assert.deepEqual(ghosts, [], `${c.target}: labeled file(s) that no longer name it`);

    const allowed = new Set(MENTION_ONLY[c.target] ?? []);
    const unlabeled = [...hits].filter((f) => f !== SELF && !labeled.has(f) && !allowed.has(f));
    assert.deepEqual(
      unlabeled,
      [],
      `${c.target}: file(s) reference it but are not labeled — re-read each one and either ` +
        "add it to expected in bench/impact_cases.mjs or record it in MENTION_ONLY here",
    );
  }
});

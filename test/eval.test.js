import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/atlas.js";
import { evalImpact, score } from "../src/eval.js";

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

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRollout, freezeSuite } from "../src/rollout_eval.js";

const suite = () => ({
  version: 1,
  purpose: "parallel",
  baseline: "one lead",
  candidate: "two workers",
  controls: "same host, acceptance script, frozen model and budgets",
  tasks: Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    repo: "app",
    revision: "abc123",
    task: `fixture ${i}`,
    acceptance: "node test.mjs",
  })),
});
const run = (frozen) => ({
  suiteHash: frozen.hash,
  source: "observed",
  runs: frozen.spec.tasks.map(({ id }) => {
    const a = {
      seconds: 100,
      quality: 90,
      costUsd: 0.2,
      accepted: true,
      wrongPackages: 0,
      tokens: 100,
      toolCalls: 3,
      newDuplicates: 0,
    };
    return {
      id,
      baseline: { ...a, evidence: `local-baseline.log:${id}` },
      candidate: { ...a, seconds: 80, evidence: `local-candidate.log:${id}` },
    };
  }),
});
test("20 paired tasks cross the exact parallel speed boundary; regressions and simulations stay visible", () => {
  const frozen = freezeSuite(suite());
  const r = run(frozen);
  assert.equal(evaluateRollout(frozen, r).verdict, "eligible");
  r.runs[0].candidate.seconds = 81;
  assert.equal(evaluateRollout(frozen, r).verdict, "keep-baseline");
  r.runs[0].candidate.seconds = 79;
  r.runs[1].candidate.accepted = false;
  assert.deepEqual(evaluateRollout(frozen, r).checks.acceptanceRegressions, [
    frozen.spec.tasks[1].id,
  ]);
  r.source = "simulation";
  assert.equal(evaluateRollout(frozen, r).verdict, "simulation-only");
});
test("tampered snapshots, mismatched results, duplicate cases and reused evidence are rejected", () => {
  const raw = suite();
  const f = freezeSuite(raw),
    r = run(f);
  r.runs[0].candidate.evidence = r.runs[0].baseline.evidence;
  assert.throws(() => evaluateRollout(f, r), /distinct/);
  r.suiteHash = "old";
  assert.throws(() => evaluateRollout(f, r), /different/);
  raw.tasks[1].id = raw.tasks[0].id;
  assert.throws(() => freezeSuite(raw), /Duplicate/);
  f.spec.tasks[0].revision = "different";
  assert.throws(() => evaluateRollout(f, r), /hash/);
});
test("routing needs lower cost at equal quality; context needs fewer tokens at equal quality", () => {
  for (const purpose of ["routing", "context"]) {
    const frozen = freezeSuite({ ...suite(), purpose });
    const r = run(frozen);
    assert.equal(evaluateRollout(frozen, r).verdict, "keep-baseline");
    r.runs[0].candidate.costUsd = 0.1;
    r.runs[0].candidate.tokens = 99;
    assert.equal(evaluateRollout(frozen, r).verdict, "eligible");
    r.runs[0].candidate.quality--;
    assert.equal(evaluateRollout(frozen, r).verdict, "keep-baseline");
  }
});

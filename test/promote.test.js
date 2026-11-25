// Measured-promotion gate (promote.js) + its concrete routing application (route.js).
// The gate promotes a candidate over a baseline ONLY when it measurably wins on held-out
// data — the honesty register's kill-criteria (overview §4), generalized from predictor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mae, promotionGate } from "../src/promote.js";

test("mae is the mean absolute error; empty → 0", () => {
  assert.equal(
    mae([
      { score: 0.5, label: 1 },
      { score: 0.5, label: 0 },
    ]),
    0.5,
  );
  assert.equal(mae([{ score: 1, label: 1 }]), 0);
  assert.equal(mae([]), 0);
});

const altSamples = (n) => Array.from({ length: n }, (_, i) => ({ x: i % 2, y: i % 2 }));

test("promotionGate: promotes a candidate that measurably beats the baseline", () => {
  const res = promotionGate(altSamples(80), {
    baseline: () => 0.5, // useless baseline (MAE 0.5)
    fit: () => ({}),
    predict: (_m, s) => s.x, // candidate == label → MAE 0
    label: (s) => s.y,
    margin: 0.1,
    minSamples: 20,
  });
  assert.equal(res.mode, "candidate");
  assert.ok(res.candidateMetric < res.baselineMetric);
  assert.ok(res.model);
});

test("promotionGate: keeps the baseline when the candidate does not beat it by the margin", () => {
  const res = promotionGate(altSamples(40), {
    baseline: (s) => s.x, // already perfect
    fit: () => ({}),
    predict: () => 0.5, // useless candidate
    label: (s) => s.y,
    margin: 0.05,
    minSamples: 20,
  });
  assert.equal(res.mode, "baseline");
  assert.equal(res.model, undefined);
});

test("promotionGate: cold-start (too few labels) keeps the baseline", () => {
  const res = promotionGate([{ x: 0, y: 0 }], {
    baseline: () => 0,
    fit: () => ({}),
    predict: () => 0,
    label: (s) => s.y,
  });
  assert.equal(res.mode, "baseline");
  assert.match(res.reason, /cold-start/);
});

test("promotionGate: a candidate that throws while fitting falls back to the baseline", () => {
  const res = promotionGate(altSamples(40), {
    baseline: (s) => s.x,
    fit: () => {
      throw new Error("boom");
    },
    predict: () => 0,
    label: (s) => s.y,
  });
  assert.equal(res.mode, "baseline");
  assert.match(res.reason, /failed to fit/);
});

test("an apparent win on four held-out cases is insufficient for a blocking model", () => {
  const result = promotionGate(altSamples(20), {
    baseline: () => 0.5,
    fit: () => true,
    predict: (_, item) => item.y,
    label: (item) => item.y,
  });
  assert.equal(result.mode, "baseline");
  assert.equal(result.holdout, 4);
  assert.equal(result.pValue, 1 / 16);
});

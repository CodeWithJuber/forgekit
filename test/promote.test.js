// Measured-promotion gate (promote.js) + its concrete routing application (route.js).
// The gate promotes a candidate over a baseline ONLY when it measurably wins on held-out
// data — the honesty register's kill-criteria (overview §4), generalized from predictor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mae, promotionGate } from "../src/promote.js";
import {
  applyCalibration,
  CALIBRATION_SAMPLES,
  calibratedComplexity,
  calibrateRouting,
  fitComplexityCalibration,
} from "../src/route.js";

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
  const res = promotionGate(altSamples(40), {
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

test("fitComplexityCalibration recovers a known affine relation", () => {
  const train = [
    { x: 0.1, y: 0.3 },
    { x: 0.2, y: 0.5 },
    { x: 0.3, y: 0.7 },
    { x: 0.4, y: 0.9 },
  ]; // y = 2x + 0.1
  const { a, b } = fitComplexityCalibration(train);
  assert.ok(Math.abs(a - 2) < 1e-6);
  assert.ok(Math.abs(b - 0.1) < 1e-6);
  assert.ok(Math.abs(applyCalibration({ a, b }, 0.25) - 0.6) < 1e-6);
});

test("calibrateRouting returns a measured verdict over the held-out fixture", () => {
  const res = calibrateRouting();
  assert.equal(res.n, CALIBRATION_SAMPLES.length);
  assert.ok(res.mode === "baseline" || res.mode === "candidate");
  assert.equal(typeof res.baselineMetric, "number");
  assert.equal(typeof res.candidateMetric, "number");
});

test("calibratedComplexity applies the calibration only when the gate promoted it", () => {
  const kept = calibratedComplexity("fix a typo", { mode: "baseline" });
  assert.equal(kept.calibrated, false);
  const promoted = calibratedComplexity("fix a typo", {
    mode: "candidate",
    model: { a: 0, b: 0.9 },
  });
  assert.equal(promoted.calibrated, true);
  assert.ok(Math.abs(promoted.score - 0.9) < 1e-9); // a=0,b=0.9 → 0.9 regardless of the base
});

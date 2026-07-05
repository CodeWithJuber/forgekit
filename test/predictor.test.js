import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aucPr,
  band,
  evaluate,
  heuristicRisk,
  predictLogistic,
  riskFor,
  trainLogistic,
} from "../src/predictor.js";

test("heuristicRisk rises with risk features; band thresholds", () => {
  const low = heuristicRisk({});
  const high = heuristicRisk({
    no_caller_update: 1,
    lesson_match: 1,
    past_mistake_here: 1,
  });
  assert.ok(high > low, "more risk signals → higher risk");
  assert.equal(band(0.2), "low");
  assert.equal(band(0.5), "med");
  assert.equal(band(0.9), "high");
});

test("aucPr = 1 for a perfect ranking, low for an inverted one", () => {
  const perfect = [
    { score: 0.9, label: 1 },
    { score: 0.8, label: 1 },
    { score: 0.2, label: 0 },
  ];
  assert.equal(aucPr(perfect), 1);
  const inverted = [
    { score: 0.9, label: 0 },
    { score: 0.8, label: 0 },
    { score: 0.2, label: 1 },
  ];
  assert.ok(aucPr(inverted) < 0.5, "inverted ranking scores poorly");
});

test("cold-start: below minSamples always falls back to the heuristic", () => {
  const few = Array.from({ length: 5 }, () => ({
    features: { churn: 1 },
    label: 1,
  }));
  const r = evaluate(few);
  assert.equal(r.mode, "heuristic");
  assert.match(r.reason, /cold-start/);
});

test("kill-criteria: features with no signal DISABLE prediction (no nagging on noise)", () => {
  // Inverted: high-risk-looking edits are NOT mistakes; zero-risk edits ARE. The heuristic
  // ranks backwards, so AUC-PR falls below the floor → prediction disabled.
  const samples = Array.from({ length: 24 }, (_, i) =>
    i % 2 === 0
      ? { features: { past_mistake_here: 1, no_caller_update: 1 }, label: 0 }
      : { features: {}, label: 1 },
  );
  const r = evaluate(samples);
  assert.equal(r.mode, "disabled");
  assert.ok(r.heuristicAucPr < 0.6, "below the floor");
});

test("kill-criteria INVARIANTS always hold (this is the anti-vaporware guarantee)", () => {
  // A separable-by-a-single-feature set: the heuristic already ranks it perfectly, so the
  // learned model is NOT allowed to take over for no gain.
  const samples = Array.from({ length: 30 }, (_, i) => ({
    features: { churn: i % 2 },
    label: i % 2,
  }));
  const r = evaluate(samples);
  assert.notEqual(r.mode, "disabled", "a learnable signal is not disabled");
  if (r.mode === "learned") {
    assert.ok(
      r.learnedAucPr >= r.heuristicAucPr + 0.05,
      "learned only wins by the required margin",
    );
  } else {
    assert.equal(r.mode, "heuristic", "otherwise the heuristic is retained");
  }
  assert.ok(r.learnedAucPr >= 0.9, "the trained model separates a separable set");
});

test("trainLogistic learns a separable boundary", () => {
  const data = [
    { features: { churn: 1 }, label: 1 },
    { features: { churn: 1 }, label: 1 },
    { features: { churn: 0 }, label: 0 },
    { features: { churn: 0 }, label: 0 },
  ];
  const w = trainLogistic(data);
  assert.ok(predictLogistic(w, { churn: 1 }) > predictLogistic(w, { churn: 0 }));
});

test("riskFor routes by the blessed mode (disabled → silent, learned → learned path)", () => {
  assert.equal(riskFor({ churn: 1 }, { mode: "disabled" }).path, "disabled");
  assert.equal(riskFor({ churn: 1 }, { mode: "disabled" }).risk, 0);
  const learned = riskFor({ churn: 1 }, { mode: "learned", weights: { bias: 0, churn: 5 } });
  assert.equal(learned.path, "learned");
  assert.equal(riskFor({ churn: 1 }, { mode: "heuristic" }).path, "heuristic");
});

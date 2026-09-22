import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aucPr,
  band,
  chanceAucPr,
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
  // ranks backwards, so AUC-PR falls below the chance baseline → prediction disabled.
  const samples = Array.from({ length: 60 }, (_, i) =>
    i % 2 === 0
      ? { features: { past_mistake_here: 1, no_caller_update: 1 }, label: 0 }
      : { features: {}, label: 1 },
  );
  const r = evaluate(samples);
  assert.equal(r.mode, "disabled");
  assert.ok(r.heuristicAucPr < r.chanceAucPr, "below what a random ranking scores");
});

test("aucPr: tied scores are one threshold — the result no longer depends on input order", () => {
  // Regression (review E2): 1.0 with the positive listed first, 0.333 with it last.
  const posFirst = [
    { score: 0.5, label: 1 },
    { score: 0.5, label: 0 },
    { score: 0.5, label: 0 },
  ];
  const posLast = [posFirst[1], posFirst[2], posFirst[0]];
  assert.equal(aucPr(posFirst), aucPr(posLast));
  assert.ok(Math.abs(aucPr(posFirst) - 1 / 3) < 1e-12, "all tied → AP = prevalence");
  // ties inside a longer ranking: {0.9:+} then {0.5: +,−} → 1·½ + (2/3)·½
  const mixed = [
    { score: 0.5, label: 0 },
    { score: 0.9, label: 1 },
    { score: 0.5, label: 1 },
  ];
  assert.ok(Math.abs(aucPr(mixed) - (0.5 + (2 / 3) * 0.5)) < 1e-12);
  // NaN scores rank last and never hang the grouping loop
  assert.equal(
    aucPr([
      { score: Number.NaN, label: 0 },
      { score: 0.2, label: 1 },
    ]),
    1,
  );
});

test("chanceAucPr is the exact mean AP of a random ranking (→ prevalence as n grows)", () => {
  // brute force over every placement of 2 positives among 5 ranks (all orderings equiprobable)
  let sum = 0;
  let count = 0;
  for (let a = 0; a < 5; a++)
    for (let b = a + 1; b < 5; b++) {
      const scored = Array.from({ length: 5 }, (_, i) => ({
        score: 5 - i,
        label: i === a || i === b ? 1 : 0,
      }));
      sum += aucPr(scored);
      count += 1;
    }
  assert.ok(Math.abs(chanceAucPr(5, 2) - sum / count) < 1e-12);
  assert.equal(chanceAucPr(2, 1), 0.75);
  assert.ok(Math.abs(chanceAucPr(5000, 500) - 0.1) < 0.005, "large n → prevalence");
  assert.equal(chanceAucPr(10, 0), 0);
});

test("kill-criteria: no kill decision on a tiny held-out split (was: disabled on 4 samples)", () => {
  // 20 samples → a 4-sample future split with no positives: AP ≡ 0, which used to DISABLE a
  // feature that predicts every label perfectly.
  const samples = Array.from({ length: 20 }, (_, i) => {
    const y = i < 16 && i % 4 === 0 ? 1 : 0;
    return { features: { churn: y }, label: y };
  });
  const r = evaluate(samples);
  assert.equal(r.mode, "heuristic", "too little held-out evidence to kill anything");
  assert.match(r.reason, /held-out split too small/);
});

test("kill-criteria: the bar is the chance baseline, not a prevalence-blind 0.6 floor", () => {
  // Pure noise at 80% positives cleared the fixed 0.6 floor (and "learned" took over).
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const noise = Array.from({ length: 200 }, () => ({
    features: { churn: rnd() },
    label: rnd() < 0.8 ? 1 : 0,
  }));
  const r = evaluate(noise);
  assert.equal(r.mode, "disabled", "no better than a random ranking → no signal");
  assert.ok(r.heuristicAucPr > 0.6, "it would have passed the old fixed floor");
  // A real low-prevalence signal (10% positives, AP 0.33 ≈ 1.5× chance) was KILLED by 0.6.
  const rare = Array.from({ length: 100 }, (_, i) => ({
    features: { churn: i % 10 >= 7 ? 1 : 0 },
    label: i % 10 === 9 ? 1 : 0,
  }));
  const k = evaluate(rare);
  assert.notEqual(k.mode, "disabled");
  assert.ok(k.heuristicAucPr < 0.6 && k.heuristicAucPr > k.chanceAucPr);
});

test("kill-criteria INVARIANTS always hold (this is the anti-vaporware guarantee)", () => {
  // A separable-by-a-single-feature set: the heuristic already ranks it perfectly, so the
  // learned model is NOT allowed to take over for no gain.
  const samples = Array.from({ length: 60 }, (_, i) => ({
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

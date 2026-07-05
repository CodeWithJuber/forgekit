// forge predictor — the moonshot, made honest. Predicts "does this edit resemble a past
// mistake / look risky?" from cheap structured features. A hand-weighted HEURISTIC ships
// day one (and is the permanent fallback); a tiny logistic model is trained locally on the
// repo's own correction history and only takes over if it MEASURABLY beats the heuristic on
// future-held-out data. Zero runtime deps: the "model" is a JSON weight vector; inference
// is a dot product. Everything here is pure so the kill-criteria can't be hand-waved.

/** Heuristic weights (hand-set priors). bias is the intercept. */
export const DEFAULT_WEIGHTS = {
  bias: -1.5,
  caller_fanout: 0.9, // editing a high-fanout symbol's signature risks breaking callers
  lesson_match: 1.4, // this edit matches an active lesson's trigger
  churn: 0.5, // fragile, frequently-changed area
  test_coverage_gap: 0.7, // edited code has no covering test
  signature_change: 0.6, // alters an API surface, not a body
  no_caller_update: 1.1, // signature changed but no caller touched in the same diff
  past_mistake_here: 1.0, // this exact spot bit us before
};

export const FEATURE_KEYS = Object.keys(DEFAULT_WEIGHTS).filter((k) => k !== "bias");

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Heuristic risk in [0,1]. Advisory only — never blocks. */
export function heuristicRisk(features, weights = DEFAULT_WEIGHTS) {
  let z = weights.bias ?? 0;
  for (const k of FEATURE_KEYS) z += (weights[k] ?? 0) * (features[k] ?? 0);
  return sigmoid(z);
}

/** Coarse band — we never claim false-precision probabilities at these sample sizes. */
export function band(risk) {
  return risk >= 0.66 ? "high" : risk >= 0.4 ? "med" : "low";
}

/** Train logistic regression by batch gradient descent (pure, zero-dep). */
export function trainLogistic(samples, keys = FEATURE_KEYS, { epochs = 300, lr = 0.3 } = {}) {
  const w = { bias: 0 };
  for (const k of keys) w[k] = 0;
  for (let e = 0; e < epochs; e++) {
    for (const s of samples) {
      let z = w.bias;
      for (const k of keys) z += w[k] * (s.features[k] ?? 0);
      const err = sigmoid(z) - s.label;
      w.bias -= lr * err;
      for (const k of keys) w[k] -= lr * err * (s.features[k] ?? 0);
    }
  }
  return w;
}

export function predictLogistic(w, features, keys = FEATURE_KEYS) {
  let z = w.bias ?? 0;
  for (const k of keys) z += (w[k] ?? 0) * (features[k] ?? 0);
  return sigmoid(z);
}

/**
 * Average precision (area under precision-recall). PR, not ROC: mistakes are the rare
 * positive class, and ROC-AUC flatters a model under imbalance.
 * @param {{score:number, label:number}[]} scored
 */
export function aucPr(scored) {
  const positives = scored.filter((s) => s.label === 1).length;
  if (!positives) return 0;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  let sumPrecision = 0;
  for (const s of sorted) {
    if (s.label === 1) {
      tp += 1;
      sumPrecision += tp / (tp + fp);
    } else {
      fp += 1;
    }
  }
  return sumPrecision / positives;
}

/**
 * Prequential (train-on-past / test-on-future) evaluation + the KILL CRITERIA that decide
 * whether the learned model is allowed to take over. This is the anti-vaporware gate.
 * @param {{features:object, label:number}[]} samples - time-ordered.
 * @returns {{mode:"heuristic"|"learned"|"disabled", reason:string, heuristicAucPr?:number, learnedAucPr?:number, weights?:object, n:number}}
 */
export function evaluate(samples, keys = FEATURE_KEYS, opts = {}) {
  const { minSamples = 20, floor = 0.6, margin = 0.05 } = opts;
  if (samples.length < minSamples) {
    return {
      mode: "heuristic",
      reason: "cold-start — not enough labels yet",
      n: samples.length,
    };
  }
  const cut = Math.floor(samples.length * 0.8);
  const train = samples.slice(0, cut);
  const test = samples.slice(cut);

  const heuristicAucPr = aucPr(
    test.map((s) => ({ score: heuristicRisk(s.features), label: s.label })),
  );
  // If even the heuristic can't separate mistakes here, the features carry no signal for
  // this repo — disable prediction entirely rather than nag on noise.
  if (heuristicAucPr < floor) {
    return {
      mode: "disabled",
      reason: "features carry no signal in this repo",
      heuristicAucPr,
      n: samples.length,
    };
  }

  const w = trainLogistic(train, keys);
  const learnedAucPr = aucPr(
    test.map((s) => ({
      score: predictLogistic(w, s.features, keys),
      label: s.label,
    })),
  );
  const beats = learnedAucPr >= heuristicAucPr + margin;
  return {
    mode: beats ? "learned" : "heuristic",
    reason: beats
      ? `learned beats heuristic by ≥${margin} AUC-PR`
      : "heuristic retained — learned did not beat it by the margin",
    heuristicAucPr: Number(heuristicAucPr.toFixed(3)),
    learnedAucPr: Number(learnedAucPr.toFixed(3)),
    weights: beats ? w : undefined,
    n: samples.length,
  };
}

/** The live predictor: use the learned weights only if evaluate() blessed them. */
export function riskFor(features, evaluation) {
  if (evaluation?.mode === "disabled") return { risk: 0, band: "low", path: "disabled" };
  if (evaluation?.mode === "learned" && evaluation.weights) {
    const risk = predictLogistic(evaluation.weights, features);
    return { risk, band: band(risk), path: "learned" };
  }
  const risk = heuristicRisk(features);
  return { risk, band: band(risk), path: "heuristic" };
}

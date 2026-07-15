// forge promote — the measured-promotion gate (the honesty register, overview §4). An
// advisory signal (a calibrated weight, a consolidation cluster, a hazard estimate) is
// allowed to become a BLOCKING/active signal ONLY if it MEASURABLY beats the current
// baseline on held-out data. This generalizes predictor.js's kill-criteria (`evaluate`)
// so any faculty can promote a candidate the same honest way instead of asserting a
// threshold. Pure, zero-dep — the decision is a metric comparison, never a claim.
import { aucPr } from "./predictor.js";

export { aucPr };

const round = (x) => Number(x.toFixed(3));

/** Mean absolute error over {score,label} pairs — the regression metric (lower is better). */
export function mae(scored) {
  if (!scored.length) return 0;
  return scored.reduce((s, x) => s + Math.abs(x.score - x.label), 0) / scored.length;
}

/** Default split: prequential (train on the past 80%, test on the held-out future 20%). */
const prequential = (samples) => {
  const cut = Math.floor(samples.length * 0.8);
  return [samples.slice(0, cut), samples.slice(cut)];
};

/**
 * Decide whether a CANDIDATE may replace a BASELINE. Fits the candidate on the train
 * split, scores both on the held-out test split, and promotes the candidate only if it
 * beats the baseline by `margin` under `metric`. Cold-start (too few labels) or a
 * candidate that fails to fit → keep the baseline (fail-safe, never throws).
 *
 * @template S,M
 * @param {S[]} samples
 * @param {{
 *   baseline: (s: S) => number,
 *   fit: (train: S[]) => M,
 *   predict: (model: M, s: S) => number,
 *   label: (s: S) => number,
 *   metric?: (scored: {score:number,label:number}[]) => number,
 *   split?: (samples: S[]) => [S[], S[]],
 *   minSamples?: number,
 *   margin?: number,
 *   lowerIsBetter?: boolean,
 * }} spec
 * @returns {{mode:"baseline"|"candidate", n:number, reason:string, baselineMetric?:number, candidateMetric?:number, model?:M}}
 */
export function promotionGate(samples, spec) {
  const {
    baseline,
    fit,
    predict,
    label,
    metric = mae,
    split = prequential,
    minSamples = 20,
    margin = 0.02,
    lowerIsBetter = true,
  } = spec;

  if (!Array.isArray(samples) || samples.length < minSamples) {
    return {
      mode: "baseline",
      n: samples?.length ?? 0,
      reason: "cold-start — not enough labels to measure a promotion",
    };
  }
  const [train, test] = split(samples);
  if (!train.length || !test.length) {
    return { mode: "baseline", n: samples.length, reason: "no held-out split to measure against" };
  }

  const baselineMetric = metric(test.map((s) => ({ score: baseline(s), label: label(s) })));
  let model;
  try {
    model = fit(train);
  } catch {
    return {
      mode: "baseline",
      n: samples.length,
      reason: "candidate failed to fit — baseline retained",
      baselineMetric: round(baselineMetric),
    };
  }
  const candidateMetric = metric(test.map((s) => ({ score: predict(model, s), label: label(s) })));
  const beats = lowerIsBetter
    ? candidateMetric <= baselineMetric - margin
    : candidateMetric >= baselineMetric + margin;

  return {
    mode: beats ? "candidate" : "baseline",
    n: samples.length,
    reason: beats
      ? `candidate beats baseline by ≥${margin} on held-out data`
      : "baseline retained — candidate did not beat it by the margin",
    baselineMetric: round(baselineMetric),
    candidateMetric: round(candidateMetric),
    model: beats ? model : undefined,
  };
}

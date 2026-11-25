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

// Under paired exchangeability, swapping the two predictions for a task is a
// draw under the null. Enumerate small holdouts exactly and use a reproducible
// Monte Carlo tail with the plus-one correction for larger cohorts.
function pairedTail(base, proposed, metric, direction, observed) {
  const n = base.length;
  const exact = n <= 12;
  const draws = exact ? 2 ** n : 2047;
  let state = 0x31415926;
  let extreme = 0;
  const left = Array(n);
  const right = Array(n);
  for (let draw = 0; draw < draws; draw++) {
    for (let i = 0; i < n; i++) {
      if (!exact) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
      }
      const swap = exact ? (draw >>> i) & 1 : state >>> 31;
      left[i] = swap ? proposed[i] : base[i];
      right[i] = swap ? base[i] : proposed[i];
    }
    const delta = direction * (metric(right) - metric(left));
    if (!Number.isFinite(delta)) return 1;
    if (delta >= observed - Number.EPSILON * Math.max(1, Math.abs(observed))) extreme++;
  }
  return exact ? extreme / draws : (extreme + 1) / (draws + 1);
}

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
 *   alpha?: number,
 *   margin?: number,
 *   lowerIsBetter?: boolean,
 * }} spec
 * @returns {{mode:"baseline"|"candidate", n:number, reason:string, baselineMetric?:number, candidateMetric?:number, holdout?:number, pValue?:number, model?:M}}
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
    alpha = 0.05,
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

  const base = test.map((s) => ({ score: baseline(s), label: label(s) }));
  const baselineMetric = metric(base);
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
  const proposed = test.map((s, i) => ({ score: predict(model, s), label: base[i].label }));
  const candidateMetric = metric(proposed);
  const direction = lowerIsBetter ? -1 : 1;
  const improvement = direction * (candidateMetric - baselineMetric);
  const finite = [...base, ...proposed].every(
    (row) => Number.isFinite(row.score) && Number.isFinite(row.label),
  );
  const measured =
    finite &&
    Number.isFinite(improvement) &&
    Number.isFinite(margin) &&
    margin >= 0 &&
    Number.isFinite(alpha) &&
    alpha > 0 &&
    alpha < 1;
  const pValue =
    measured && improvement > 0 && improvement >= margin
      ? pairedTail(base, proposed, metric, direction, improvement)
      : 1;
  const beats = measured && pValue <= alpha;

  return {
    mode: beats ? "candidate" : "baseline",
    n: samples.length,
    holdout: test.length,
    pValue,
    reason: beats
      ? `held-out improvement meets the margin ${margin} and paired test at alpha ${alpha}`
      : "baseline retained — insufficient held-out evidence of a material improvement",
    baselineMetric: round(baselineMetric),
    candidateMetric: round(candidateMetric),
    model: beats ? model : undefined,
  };
}

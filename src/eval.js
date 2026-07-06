// forge eval — a small, honest evaluation harness for the impact oracle. The Python prototype
// used mutation testing against a real suite; this ships the deterministic core of that idea so
// the atlas/impact quality claim is CHECKABLE in CI: for a set of {target → files that truly
// depend on it} cases, score the oracle's precision/recall/F1 and compare it to the naive
// "edited-file-only" baseline the paper measured against. Pure; no repo/network.
import { impact } from "./atlas.js";

/** Pure: precision/recall/F1 of a predicted set against ground truth. */
export function score(predicted, groundTruth) {
  const P = new Set(predicted);
  const G = new Set(groundTruth);
  let tp = 0;
  for (const g of G) if (P.has(g)) tp += 1;
  const precision = P.size ? tp / P.size : G.size ? 0 : 1;
  const recall = G.size ? tp / G.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, predicted: P.size, groundTruth: G.size };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Evaluate the impact oracle over labeled cases and against the edited-file-only baseline.
 * @param {object} atlas
 * @param {{target:string, expected:string[], editedFile?:string}[]} cases
 * @returns {{oracle:{precision:number,recall:number,f1:number}, baseline:{recall:number}, n:number, perCase:object[]}}
 */
export function evalImpact(atlas, cases, opts = {}) {
  const perCase = cases.map((c) => {
    const predicted = impact(atlas, c.target, opts).impactedFiles;
    const oracle = score(predicted, c.expected);
    // Baseline: an agent that only "knows" the file it edited breaks nothing else it can see.
    const baselineHits = c.editedFile && c.expected.includes(c.editedFile) ? [c.editedFile] : [];
    const baseline = score(baselineHits, c.expected);
    return { target: c.target, oracle, baseline };
  });
  return {
    n: cases.length,
    oracle: {
      precision: mean(perCase.map((p) => p.oracle.precision)),
      recall: mean(perCase.map((p) => p.oracle.recall)),
      f1: mean(perCase.map((p) => p.oracle.f1)),
    },
    baseline: { recall: mean(perCase.map((p) => p.baseline.recall)) },
    perCase,
  };
}

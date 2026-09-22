// Task features for the universal router: countable properties of the task text and, when a
// repository is available, of the code it touches. The router learns how each feature shifts
// difficulty; nothing here decides a model.
import { routeTask, rubricComplexity, rubricSignals } from "../route.js";

export const FEATURE_NAMES = [
  "log_chars",
  "log_lines",
  "code_fences",
  "log_constraints",
  "log_steps",
  "rubric_knn",
  "rubric_score",
  "log_files",
  "log_fanout",
  "log_churn",
  "past_mistakes",
  "ambiguity",
];

/**
 * Raw (unstandardised) features. `root` may be null for text-only use (no repo signals).
 * @param {string|null} root
 * @param {string} task
 */
export function rawFeatures(root, task) {
  const text = String(task ?? "");
  const sig = rubricSignals(text);
  const rub = rubricComplexity(text);
  let repo = { files: 0, fanout: 0, churn: 0, pastMistakes: 0, ambiguity: 0 };
  if (root) {
    try {
      repo = routeTask(root, text, { llm: false }).signals ?? repo;
    } catch {}
  }
  return [
    Math.log1p(text.length),
    Math.log1p((text.match(/\n/g) || []).length),
    (text.match(/```/g) || []).length / 2,
    Math.log1p(sig.nConstraints),
    Math.log1p(sig.nSteps),
    Number(rub.knn) || 0,
    Number(rub.score) || 0,
    Math.log1p(repo.files || 0),
    Math.log1p(repo.fanout || 0),
    Math.log1p(repo.churn || 0),
    Number(repo.pastMistakes) || 0,
    Number(repo.ambiguity) || 0,
  ];
}

/** Standardisation fitted on training data (a zero-variance feature keeps scale 1). */
export function fitScaler(rows) {
  const d = rows[0]?.length ?? FEATURE_NAMES.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i] / rows.length;
  for (const r of rows) for (let i = 0; i < d; i++) std[i] += (r[i] - mean[i]) ** 2 / rows.length;
  return { names: FEATURE_NAMES.slice(0, d), mean, std: std.map((v) => (v > 1e-12 ? Math.sqrt(v) : 1)) };
}

export const standardise = (scaler, raw) => raw.map((v, i) => (v - scaler.mean[i]) / scaler.std[i]);

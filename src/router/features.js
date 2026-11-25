// Observable properties of the input, identical during fitting and prediction. Their
// coefficients are estimated from task outcomes. These counts require no repository I/O.
export const FEATURE_NAMES = ["log_chars", "log_lines", "code_fences"];

export function rawFeatures(_root, task) {
  const text = String(task ?? "");
  return [
    Math.log1p(text.length),
    Math.log1p(text.split("\n").length - 1),
    (text.split("```").length - 1) / 2,
  ];
}

// Historical outcome records store these same three measurements first. Other axes
// included authored prompt labels and cannot be inputs to the current fit.
export function currentFeatures(stored) {
  return Array.isArray(stored) && stored.length === 12
    ? stored.slice(0, FEATURE_NAMES.length)
    : stored;
}

/** Standardisation fitted on training data (a zero-variance feature keeps scale 1). */
export function fitScaler(rows) {
  const d = rows[0]?.length ?? FEATURE_NAMES.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i] / rows.length;
  for (const r of rows) for (let i = 0; i < d; i++) std[i] += (r[i] - mean[i]) ** 2 / rows.length;
  return {
    names: FEATURE_NAMES.slice(0, d),
    mean,
    std: std.map((v) => (v > 1e-12 ? Math.sqrt(v) : 1)),
  };
}

export const standardise = (scaler, raw) => raw.map((v, i) => (v - scaler.mean[i]) / scaler.std[i]);

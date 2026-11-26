// Flaky test or real regression? A small exact model.
//
// On identical inputs (same code, same environment digest) a test with no regression fails with
// probability f. History of same-digest reruns gives f ~ Beta(a, b). A deterministic regression
// fails every time. After k consecutive failures on a new digest:
//   P(regression | k failures) = prior / (prior + (1 - prior) E[f^k]),
//   E[f^k] = prod_{j<k} (a + j) / (a + b + j).
// One pass on the same digest rules out a deterministic regression under this model. Whether the
// failure RATE went up is a different question, answered by sequential.js.

/** E[f^k] for f ~ Beta(a, b). */
export function flakyMoment(a, b, k) {
  if (!(a > 0) || !(b > 0)) throw new Error("need a, b > 0");
  if (!Number.isInteger(k) || k < 0) throw new Error("k must be a nonnegative integer");
  let m = 1;
  for (let j = 0; j < k; j++) m *= (a + j) / (a + b + j);
  return m;
}

export function regressionPosterior({ prior, a, b, failures }) {
  if (!(prior > 0 && prior < 1)) throw new Error("need 0 < prior < 1");
  const m = flakyMoment(a, b, failures);
  return prior / (prior + (1 - prior) * m);
}

/** Smallest number of consecutive failures (first run included) reaching posterior >= 1 - eps. */
export function failuresNeeded({ prior, a, b, eps, max = 1000 }) {
  if (!(eps > 0 && eps < 1)) throw new Error("need 0 < eps < 1");
  for (let k = 1; k <= max; k++) {
    if (regressionPosterior({ prior, a, b, failures: k }) >= 1 - eps) return k;
  }
  return null; // not reachable within max reruns: escalate to a person
}

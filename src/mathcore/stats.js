// Exact binomial tools. These are fixed-sample statements: the number of trials is chosen
// before looking. For a decision re-checked after every observation use sequential.js — an exact
// bound that is re-read as data arrive stops being a bound (test/mathcore_sequential.test.js).

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Natural log of the gamma function for x > 0. */
export function logGamma(x) {
  if (!(x > 0)) throw new Error("logGamma needs x > 0");
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

function betaContinuedFraction(a, b, x) {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 20000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) return h;
  }
  throw new Error("incomplete beta did not converge");
}

/** Regularized incomplete beta function I_x(a, b). */
export function betaInc(a, b, x) {
  if (!(a > 0) || !(b > 0)) throw new Error("betaInc needs a, b > 0");
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x),
  );
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Quantile of Beta(a, b): the x with I_x(a, b) = p. */
export function betaQuantile(p, a, b) {
  if (!(p >= 0 && p <= 1)) throw new Error("probability out of range");
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (betaInc(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function checkCounts(k, n, alpha) {
  if (!(n >= 0) || !(k >= 0) || k > n) throw new Error("need 0 <= k <= n");
  if (!(alpha > 0 && alpha < 1)) throw new Error("need 0 < alpha < 1");
}

/** One-sided Clopper-Pearson lower bound on a success probability, confidence 1 - alpha. */
export function cpLower(k, n, alpha) {
  checkCounts(k, n, alpha);
  return k === 0 ? 0 : betaQuantile(alpha, k, n - k + 1);
}

/** One-sided Clopper-Pearson upper bound on a success probability, confidence 1 - alpha. */
export function cpUpper(k, n, alpha) {
  checkCounts(k, n, alpha);
  return k === n ? 1 : betaQuantile(1 - alpha, k + 1, n - k);
}

/** P(X >= k) for X ~ Binomial(n, p), by direct summation. Independent of betaInc. */
export function binomTailGE(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let total = 0;
  for (let i = k; i <= n; i++) {
    const logTerm =
      logGamma(n + 1) -
      logGamma(i + 1) -
      logGamma(n - i + 1) +
      i * Math.log(p) +
      (n - i) * Math.log1p(-p);
    total += Math.exp(logTerm);
  }
  return Math.min(1, total);
}

/** Smallest n such that n successes in n prespecified trials give cpLower >= q. */
export function minZeroFailureTrials(q, alpha) {
  if (!(q > 0 && q < 1) || !(alpha > 0 && alpha < 1)) throw new Error("need 0 < q, alpha < 1");
  let n = Math.max(1, Math.floor(Math.log(alpha) / Math.log(q)));
  while (alpha ** (1 / n) < q) n++;
  return n;
}

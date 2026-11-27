// Has the distribution of a stream of vectors changed? A two-sample test with a threshold that
// follows from the data: the unbiased MMD^2 statistic with a Gaussian kernel and a permutation
// p-value. Under the hypothesis that both samples are exchangeable the test has level alpha in
// the usual randomisation sense, for any kernel and any dimension.
//
// This is ONE fixed-sample test. Watching a stream by re-running it spends alpha on every look;
// for repeated monitoring feed a scalar signal to the e-detector in sequential.js instead.
// It measures distribution shift. It does not measure rival statements, which is what a
// retrieval study found to hurt a long context (see rivals.js).

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sqDist(x, y) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - y[i]) ** 2;
  return s;
}

function distanceMatrix(points) {
  const n = points.length;
  const d = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      d[i][j] = sqDist(points[i], points[j]);
      d[j][i] = d[i][j];
    }
  return d;
}

function mmdFromIndex(d, gamma, xs, ys) {
  const k = (i, j) => Math.exp(-gamma * d[i][j]);
  const m = xs.length;
  const n = ys.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) xx += k(xs[i], xs[j]);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) yy += k(ys[i], ys[j]);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) xy += k(xs[i], ys[j]);
  return xx / (m * (m - 1)) + yy / (n * (n - 1)) - (2 * xy) / (m * n);
}

/**
 * Unbiased MMD^2 between two samples and its permutation p-value. The kernel bandwidth is the
 * median pooled squared distance, so no bandwidth is chosen by hand.
 * @param {number[][]} X reference sample
 * @param {number[][]} Y recent sample
 * @param {{permutations?:number, seed?:number}} [options]
 * @returns {{mmd2:number, pValue:number}}
 */
export function mmdPermutationTest(X, Y, { permutations = 200, seed = 1 } = {}) {
  if (X.length < 2 || Y.length < 2) throw new RangeError("each sample needs at least two points");
  const pooled = [...X, ...Y];
  const d = distanceMatrix(pooled);
  const flat = [];
  for (let i = 0; i < pooled.length; i++)
    for (let j = i + 1; j < pooled.length; j++) flat.push(d[i][j]);
  flat.sort((a, b) => a - b);
  const gamma = 1 / (flat[Math.floor(flat.length / 2)] || 1);
  const index = pooled.map((_, i) => i);
  const observed = mmdFromIndex(d, gamma, index.slice(0, X.length), index.slice(X.length));
  const random = mulberry32(seed);
  let atLeast = 0;
  for (let b = 0; b < permutations; b++) {
    const perm = index.slice();
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    if (mmdFromIndex(d, gamma, perm.slice(0, X.length), perm.slice(X.length)) >= observed)
      atLeast++;
  }
  return { mmd2: observed, pValue: (1 + atLeast) / (1 + permutations) };
}

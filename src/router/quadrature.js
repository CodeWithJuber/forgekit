// Gauss–Hermite quadrature for expectations under a standard normal, computed (not tabulated)
// with the Golub–Welsch algorithm: the nodes are the eigenvalues of the Jacobi matrix of the
// probabilists' Hermite polynomials (zero diagonal, off-diagonal sqrt(i)), and each weight is the
// squared first component of the matching normalised eigenvector.

/**
 * Eigen-decomposition of a symmetric tridiagonal matrix (implicit QL with Wilkinson shifts),
 * returning eigenvalues and the first component of each eigenvector.
 * @param {number[]} diag
 * @param {number[]} off off[i] couples i and i+1 (length n-1)
 */
function tridiagEigen(diag, off) {
  const n = diag.length;
  const d = diag.slice();
  const e = [...off, 0];
  // z holds the first row of the accumulated rotation matrix (= first eigenvector components).
  /** @type {number[]} */
  const z = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
  for (let l = 0; l < n; l++) {
    for (let iter = 0; iter < 200; iter++) {
      let m = l;
      for (; m < n - 1; m++) {
        const dd = Math.abs(d[m]) + Math.abs(d[m + 1]);
        if (Math.abs(e[m]) <= Number.EPSILON * dd) break;
      }
      if (m === l) break;
      let g = (d[l + 1] - d[l]) / (2 * e[l]);
      let r = Math.hypot(g, 1);
      g = d[m] - d[l] + e[l] / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
      let s = 1;
      let c = 1;
      let p = 0;
      let i = m - 1;
      for (; i >= l; i--) {
        let f = s * e[i];
        const b = c * e[i];
        r = Math.hypot(f, g);
        e[i + 1] = r;
        if (r === 0) {
          d[i + 1] -= p;
          e[m] = 0;
          break;
        }
        s = f / r;
        c = g / r;
        g = d[i + 1] - p;
        r = (d[i] - g) * s + 2 * c * b;
        p = s * r;
        d[i + 1] = g + p;
        g = c * r - b;
        f = z[i + 1];
        z[i + 1] = s * z[i] + c * f;
        z[i] = c * z[i] - s * f;
      }
      if (r === 0 && i >= l) continue;
      d[l] -= p;
      e[l] = g;
      e[m] = 0;
    }
  }
  return { values: d, first: z };
}

/**
 * Nodes and weights with Σ w·f(x) ≈ E[f(X)], X ~ N(0, 1). Exact for polynomials of degree
 * below 2q.
 * @param {number} q number of nodes (≥ 1)
 */
export function normalNodes(q) {
  if (!Number.isInteger(q) || q < 1) throw new Error("normalNodes: q must be a positive integer");
  if (q === 1) return { x: [0], w: [1] };
  const off = Array.from({ length: q - 1 }, (_, i) => Math.sqrt(i + 1));
  const { values, first } = tridiagEigen(new Array(q).fill(0), off);
  const pairs = values.map((x, i) => [x, first[i] ** 2]).sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  return { x: pairs.map(([x]) => x), w: pairs.map(([, w]) => w / total) };
}

/**
 * Product grid for E over N(0, I_k): Q = q^k points.
 * @param {number} k dimensions
 * @param {number} q nodes per dimension
 * @returns {{points: number[][], weights: number[]}}
 */
export function normalGrid(k, q) {
  const { x, w } = normalNodes(q);
  let points = [[]];
  let weights = [1];
  for (let d = 0; d < k; d++) {
    const np = [];
    const nw = [];
    for (let i = 0; i < points.length; i++)
      for (let j = 0; j < x.length; j++) {
        np.push([...points[i], x[j]]);
        nw.push(weights[i] * w[j]);
      }
    points = np;
    weights = nw;
  }
  return { points, weights };
}

/**
 * Nodes per dimension so the grid stays near a fixed evaluation budget: exactness degree grows
 * with q, cost grows as q^k. Budget ≈ 256 points keeps a fit over a few thousand outcomes fast.
 * @param {number} k
 * @param {number} [budget]
 */
export function nodesFor(k, budget = 256) {
  return Math.max(3, Math.floor(budget ** (1 / Math.max(1, k))));
}

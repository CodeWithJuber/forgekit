// Small dense linear algebra for the router's least-squares fits.

/** Solve A x = b (A square) by Gaussian elimination with partial pivoting. */
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error("singular system");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Ridge-regularised least squares: argmin ||y - X β||² + Σ_i ridge_i β_i².
 * @param {number[][]} X rows
 * @param {number[]} y
 * @param {number[]} ridge per-coefficient penalty (0 = unpenalised)
 */
export function leastSquares(X, y, ridge) {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let r = 0; r < p; r++) {
      b[r] += xi[r] * y[i];
      for (let c = 0; c < p; c++) A[r][c] += xi[r] * xi[c];
    }
  }
  for (let r = 0; r < p; r++) A[r][r] += ridge[r] ?? 0;
  return solve(A, b);
}

// Limited-memory BFGS with a backtracking Armijo line search. Minimises f: R^n -> R given a
// function returning { value, grad }. Used for maximum-a-posteriori fits of the router's models.

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * @param {(x: number[]) => {value: number, grad: number[]}} f
 * @param {number[]} x0
 * @param {{maxIter?: number, memory?: number, gradTol?: number, relTol?: number}} [opts]
 */
export function minimize(
  f,
  x0,
  { maxIter = 500, memory = 10, gradTol = 1e-6, relTol = 1e-10 } = {},
) {
  let x = x0.slice();
  let { value: fx, grad: g } = f(x);
  const S = [];
  const Y = [];
  let iter = 0;
  for (; iter < maxIter; iter++) {
    const gnorm = Math.sqrt(dot(g, g));
    if (!Number.isFinite(fx) || gnorm < gradTol * Math.max(1, Math.abs(fx))) break;
    // Two-loop recursion: d = -H g.
    const q = g.slice();
    const alpha = [];
    for (let i = S.length - 1; i >= 0; i--) {
      const rho = 1 / dot(Y[i], S[i]);
      const a = rho * dot(S[i], q);
      alpha[i] = a;
      for (let j = 0; j < q.length; j++) q[j] -= a * Y[i][j];
    }
    let gamma = 1;
    if (S.length) gamma = dot(S.at(-1), Y.at(-1)) / dot(Y.at(-1), Y.at(-1));
    else gamma = 1 / Math.max(gnorm, 1);
    for (let j = 0; j < q.length; j++) q[j] *= gamma;
    for (let i = 0; i < S.length; i++) {
      const rho = 1 / dot(Y[i], S[i]);
      const b = rho * dot(Y[i], q);
      for (let j = 0; j < q.length; j++) q[j] += S[i][j] * (alpha[i] - b);
    }
    let d = q.map((v) => -v);
    let slope = dot(g, d);
    if (!(slope < 0)) {
      // Not a descent direction (curvature information went stale): restart from steepest descent.
      S.length = 0;
      Y.length = 0;
      d = g.map((v) => -v / Math.max(gnorm, 1));
      slope = dot(g, d);
    }
    let step = 1;
    let next;
    let xn;
    for (let ls = 0; ls < 40; ls++) {
      xn = x.map((v, i) => v + step * d[i]);
      next = f(xn);
      if (Number.isFinite(next.value) && next.value <= fx + 1e-4 * step * slope) break;
      step *= 0.5;
      next = undefined;
    }
    if (!next) break;
    const s = xn.map((v, i) => v - x[i]);
    const y = next.grad.map((v, i) => v - g[i]);
    if (dot(s, y) > 1e-12) {
      S.push(s);
      Y.push(y);
      if (S.length > memory) {
        S.shift();
        Y.shift();
      }
    }
    const improved = fx - next.value;
    x = xn;
    fx = next.value;
    g = next.grad;
    if (improved >= 0 && improved < relTol * Math.max(1, Math.abs(fx))) break;
  }
  return { x, value: fx, grad: g, iterations: iter };
}

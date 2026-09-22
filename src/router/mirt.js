// Multidimensional item response theory (MIRT) for "which model solves which task".
//
//   P(model m solves task j | θ_j) = σ(a_m − w·x_j + λ_m·θ_j),   θ_j ~ N(0, I_k)
//
// a_m   ability of model m (any provider; no tiers)
// w·x_j difficulty of task j predicted from its features x_j (so unseen tasks get a difficulty)
// θ_j   the part of task j's difficulty the features do not explain, shared by all models
//       through their loadings λ_m. This is what makes failures correlated: when one model
//       fails a task, others are more likely to fail it too, which is exactly what a cascade
//       ("try A, and if it fails try B") must account for.
//
// Parameters are fitted by maximum a posteriori over the MARGINAL likelihood (θ integrated out
// with Gauss–Hermite quadrature), from sparse observations: each task may have been tried by
// any subset of models. The latent dimension k and the prior scale are chosen by K-fold
// cross-validated likelihood, not fixed in code.
import { minimize } from "./lbfgs.js";
import { nodesFor, normalGrid } from "./quadrature.js";

const logSigmoid = (z) => (z >= 0 ? -Math.log1p(Math.exp(-z)) : z - Math.log1p(Math.exp(z)));
export const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/**
 * @typedef {{ nModels: number, nFeatures: number, tasks: {x: number[], obs: [number, 0|1][]}[] }} MirtData
 * obs entries are [modelIndex, solved].
 * @typedef {{ k: number, a: number[], w: number[], L: number[][] }} MirtParams
 * @typedef {{ a?: number[], w?: number[], L?: number[][], scaleA?: number, scaleW?: number, scaleL?: number }} MirtPrior
 */

function pack(p) {
  return [...p.a, ...p.w, ...p.L.flat()];
}
function unpack(v, M, D, k) {
  const a = v.slice(0, M);
  const w = v.slice(M, M + D);
  const L = [];
  for (let m = 0; m < M; m++) L.push(v.slice(M + D + m * k, M + D + (m + 1) * k));
  return { k, a, w, L };
}

/**
 * Negative log posterior and its gradient.
 * @param {number[]} v packed parameters
 * @param {MirtData} data
 * @param {number} k
 * @param {{points: number[][], weights: number[]}} grid
 * @param {Required<MirtPrior>} prior
 * @param {number[]} [taskIdx] subset of tasks (defaults to all)
 */
export function objective(v, data, k, grid, prior, taskIdx) {
  const M = data.nModels;
  const D = data.nFeatures;
  const { a, w, L } = unpack(v, M, D, k);
  const Q = grid.weights.length;
  const logW = grid.weights.map(Math.log);
  // LT[m][q] = λ_m · θ_q
  const LT = L.map((lm) =>
    grid.points.map((t) => {
      let s = 0;
      for (let d = 0; d < k; d++) s += lm[d] * t[d];
      return s;
    }),
  );
  const ga = new Array(M).fill(0);
  const gw = new Array(D).fill(0);
  const gL = L.map(() => new Array(k).fill(0));
  let nll = 0;
  const lq = new Array(Q);
  const idx = taskIdx ?? data.tasks.map((_, j) => j);
  for (const j of idx) {
    const task = data.tasks[j];
    if (!task.obs.length) continue;
    let b = 0;
    for (let d = 0; d < D; d++) b += w[d] * task.x[d];
    let mx = -Infinity;
    for (let q = 0; q < Q; q++) {
      let s = logW[q];
      for (const [m, y] of task.obs) {
        const z = a[m] - b + LT[m][q];
        s += y ? logSigmoid(z) : logSigmoid(-z);
      }
      lq[q] = s;
      if (s > mx) mx = s;
    }
    let tot = 0;
    for (let q = 0; q < Q; q++) {
      lq[q] = Math.exp(lq[q] - mx);
      tot += lq[q];
    }
    nll -= mx + Math.log(tot);
    // Posterior node weights r_q; d(-ll)/dz_mq = -r_q (y - σ(z)).
    let gb = 0;
    for (let q = 0; q < Q; q++) {
      const r = lq[q] / tot;
      if (r < 1e-300) continue;
      for (const [m, y] of task.obs) {
        const z = a[m] - b + LT[m][q];
        const g = r * (y - sigmoid(z));
        ga[m] -= g;
        gb += g;
        const t = grid.points[q];
        for (let d = 0; d < k; d++) gL[m][d] -= g * t[d];
      }
    }
    for (let d = 0; d < D; d++) gw[d] += gb * task.x[d];
  }
  // Gaussian priors (MAP).
  for (let m = 0; m < M; m++) {
    const da = a[m] - prior.a[m];
    nll += (0.5 * da * da) / prior.scaleA ** 2;
    ga[m] += da / prior.scaleA ** 2;
    for (let d = 0; d < k; d++) {
      const dl = L[m][d] - (prior.L[m]?.[d] ?? 0);
      nll += (0.5 * dl * dl) / prior.scaleL ** 2;
      gL[m][d] += dl / prior.scaleL ** 2;
    }
  }
  for (let d = 0; d < D; d++) {
    const dw = w[d] - prior.w[d];
    nll += (0.5 * dw * dw) / prior.scaleW ** 2;
    gw[d] += dw / prior.scaleW ** 2;
  }
  return { value: nll, grad: [...ga, ...gw, ...gL.flat()] };
}

function fullPrior(M, D, k, prior = {}) {
  return {
    a: prior.a ?? new Array(M).fill(0),
    w: prior.w ?? new Array(D).fill(0),
    // Default loading prior mean: a common positive first factor (models agree on which tasks
    // are hard), zero on further factors. It only centres the prior; the data moves it.
    L: prior.L ?? Array.from({ length: M }, () => Array.from({ length: k }, (_, d) => (d === 0 ? 1 : 0))),
    scaleA: prior.scaleA ?? 2,
    scaleW: prior.scaleW ?? 1,
    scaleL: prior.scaleL ?? 1,
  };
}

/**
 * MAP fit for a given k and prior.
 * @param {MirtData} data
 * @param {number} k
 * @param {MirtPrior} [prior]
 * @param {number[]} [taskIdx]
 */
export function fitMirt(data, k, prior = {}, taskIdx) {
  const M = data.nModels;
  const D = data.nFeatures;
  const pr = fullPrior(M, D, k, prior);
  const grid = normalGrid(k, nodesFor(k));
  // Start at the prior mean, with a small deterministic asymmetry on extra factors so they can
  // leave the symmetric saddle at zero.
  const init = {
    k,
    a: pr.a.slice(),
    w: pr.w.slice(),
    L: pr.L.map((row, m) => row.map((v, d) => (d === 0 ? v : v + 0.1 * Math.cos(1 + m * (d + 1))))),
  };
  const res = minimize((v) => objective(v, data, k, grid, pr, taskIdx), pack(init), {
    maxIter: 400,
  });
  return { params: unpack(res.x, M, D, k), nlp: res.value, iterations: res.iterations };
}

/** Held-out marginal log-likelihood of tasks (no prior terms). */
export function heldOutLogLik(params, data, taskIdx) {
  const M = data.nModels;
  const D = data.nFeatures;
  const k = params.k;
  const grid = normalGrid(k, nodesFor(k));
  // Flat, zero-strength prior: objective() adds prior terms, so neutralise them with huge scales.
  const flat = { ...fullPrior(M, D, k), scaleA: 1e12, scaleW: 1e12, scaleL: 1e12 };
  return -objective(pack(params), data, k, grid, flat, taskIdx).value;
}

/**
 * Choose k and the prior scale by K-fold cross-validated held-out likelihood, then refit on all
 * tasks with the winner. Folds are assigned deterministically.
 * @param {MirtData} data
 * @param {{ks?: number[], scales?: number[], folds?: number, prior?: MirtPrior}} [opts]
 */
export function selectAndFit(data, { ks = [1, 2, 3], scales = [0.5, 1, 2], folds = 3, prior = {}, maxExpand = 4 } = {}) {
  const J = data.tasks.length;
  const order = data.tasks.map((_, j) => j).sort((x, y) => hash32(x) - hash32(y));
  const foldOf = new Array(J);
  order.forEach((j, i) => {
    foldOf[j] = i % folds;
  });
  const table = [];
  let best = null;
  const cv = (k, s) => {
    let ll = 0;
    for (let f = 0; f < folds; f++) {
      const tr = [];
      const te = [];
      for (let j = 0; j < J; j++) (foldOf[j] === f ? te : tr).push(j);
      const { params } = fitMirt(data, k, { ...prior, scaleA: 2 * s, scaleW: s, scaleL: s }, tr);
      ll += heldOutLogLik(params, data, te);
    }
    table.push({ k, scale: s, heldOutLogLik: ll });
    if (!best || ll > best.heldOutLogLik) best = { k, scale: s, heldOutLogLik: ll };
    return ll;
  };
  for (const k of ks) {
    const grid = [...scales].sort((x, y) => x - y);
    const lls = grid.map((s) => cv(k, s));
    // If the best scale sits on an edge of the grid, the optimum may lie beyond it: step outward
    // (halving or doubling) while the held-out likelihood keeps improving.
    for (let n = 0; n < maxExpand; n++) {
      const bi = lls.indexOf(Math.max(...lls));
      if (bi !== 0 && bi !== grid.length - 1) break;
      const low = bi === 0;
      const s = low ? grid[0] / 2 : grid.at(-1) * 2;
      const ll = cv(k, s);
      if (low) {
        grid.unshift(s);
        lls.unshift(ll);
      } else {
        grid.push(s);
        lls.push(ll);
      }
      if (ll <= lls[low ? 1 : lls.length - 2]) break;
    }
  }
  const fit = fitMirt(data, best.k, { ...prior, scaleA: 2 * best.scale, scaleW: best.scale, scaleL: best.scale });
  return { ...fit, selection: { chosen: best, table, folds } };
}

function hash32(n) {
  let h = (n + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Conditional success probabilities at each quadrature node, for one task.
 * @param {MirtParams} params
 * @param {number[]} x standardised feature vector
 * @returns {{P: number[][], weights: number[]}} P[m][q]
 */
export function nodeProbabilities(params, x) {
  const grid = normalGrid(params.k, nodesFor(params.k));
  let b = 0;
  for (let d = 0; d < params.w.length; d++) b += params.w[d] * x[d];
  const P = params.a.map((am, m) =>
    grid.points.map((t) => {
      let s = am - b;
      for (let d = 0; d < params.k; d++) s += params.L[m][d] * t[d];
      return sigmoid(s);
    }),
  );
  return { P, weights: grid.weights };
}

/** Marginal P(model m solves the task) = E_θ[σ(...)]. */
export function marginals({ P, weights }) {
  return P.map((row) => row.reduce((s, p, q) => s + p * weights[q], 0));
}

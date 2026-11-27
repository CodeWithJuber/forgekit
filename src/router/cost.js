// Expected cost of one attempt by a model on a task.
//
//   log cost = α_m + β·x + ε        E[cost] = exp(α_m + β·x) · S
//
// S is the retransformation factor E[exp(ε)]. If ε were normal it would be exp(s²/2), and that
// is the fallback. Recorded attempt costs have a heavier right tail than a log-normal, so
// exp(s²/2) under-predicts the mean: on six held-out splits of the SWE-bench Verified runs the
// FIRST attempt alone was under-predicted in five. With enough data S is therefore Duan's
// smearing estimate, the mean of exp(residual) over all fitted attempts (residuals rescaled by
// sqrt(n/dof) so they carry the same variance as s²). A fit too sparse for slopes keeps
// exp(s²/2).
//
// One factor for every model, on purpose. A factor per model (`smearByModel`, reported for
// inspection) forecasts the cost level better, but it also reorders models, and on the same six
// splits the cascades chosen with it cost 1.8% more on held-out tasks (5.7% more on one split,
// interval excluding zero) for 4 more solved tasks in 2,100. A shared factor changes the level
// and leaves every comparison between models exactly as the regression made it.
//
// α_m (per model) and the shared slope β are fitted by least squares on observed attempt costs.
// A model with prices but no observed attempts gets α_m from its price: across the models that
// have both, α_k − log(blended price_k) is nearly constant (same agent, same token volume), so
// α_m = log(blended price_m) + mean(α_k − log blended price_k). The input/output blend ρ is the
// value that makes that difference most constant across those models (chosen from data).
//
// Sparse data (review F11). The regression needs residual degrees of freedom: with fewer
// observations than per-model intercepts + slopes + 2, the slopes cannot be estimated and the
// old code fell back to α = 0 (a $1 attempt) with a residual variance computed from THAT
// arbitrary fit — one observed $0.05 attempt predicted ≈ $88.87. Now, when the slopes are not
// identifiable, each model's α is its MEAN LOG COST (slopes 0), and s² is the pooled
// within-model variance shrunk toward an explicit prior (LOG_COST_VAR_PRIOR), or the prior
// alone when no model has two observations. Every fit reports its `method`, where s² came from
// (`s2Source`), the per-model observation `counts`, and the standard error of each α
// (`alphaSE`), so a sparse estimate is visibly uncertain rather than silently confident.
// Zero-cost attempts (a provider that recorded no charge) and missing costs cannot enter a
// log-cost fit: they are excluded and counted in `excluded`.
import { leastSquares } from "./linalg.js";

/** Residual variance of log attempt cost assumed when the data cannot estimate it: the
 *  shipped SWE-bench fit's own residual variance (data/router_prior.json → cost.s2 = 0.438,
 *  5,498 attempts), rounded. An explicit, documented prior — pass `s2Prior` to override. */
export const LOG_COST_VAR_PRIOR = 0.44;
/** Pseudo-observations the variance prior is worth when pooling a few residuals. */
const VAR_PRIOR_WEIGHT = 2;

/**
 * @param {{model: number, x: number[], cost: number}[]} obs
 * @param {number} nModels
 * @param {number} nFeatures
 * @param {{priceIn?: number|null, priceOut?: number|null}[]} [prices] per model, USD per Mtok
 */
export function fitCost(
  obs,
  nModels,
  nFeatures,
  prices = [],
  { s2Prior = LOG_COST_VAR_PRIOR } = {},
) {
  const inRange = obs.filter(
    (o) => Number.isInteger(o?.model) && o.model >= 0 && o.model < nModels && Array.isArray(o.x),
  );
  const used = inRange.filter((o) => Number.isFinite(o.cost) && o.cost > 0);
  const excluded = {
    zeroCost: inRange.filter((o) => o.cost === 0).length,
    missingCost: inRange.filter((o) => !Number.isFinite(o.cost) || o.cost < 0).length,
    invalid: obs.length - inRange.length,
  };
  const seen = new Set(used.map((o) => o.model));
  const models = [...seen].sort((a, b) => a - b);
  const col = new Map(models.map((m, i) => [m, i]));
  const X = used.map((o) => [...models.map((m) => (m === o.model ? 1 : 0)), ...o.x]);
  const y = used.map((o) => Math.log(o.cost));
  const counts = new Array(nModels).fill(0);
  for (const o of used) counts[o.model]++;
  // Slopes are identifiable only with residual degrees of freedom left over (≥ 2).
  const dofOls = used.length - models.length - nFeatures;
  const method = dofOls >= 2 ? "ols" : used.length ? "mean-log" : null;
  let coef;
  if (method === "ols") {
    // A tiny ridge on the slopes only keeps the system well-posed.
    const ridge = [
      ...models.map(() => 0),
      ...new Array(nFeatures).fill(1e-6 * Math.max(1, used.length)),
    ];
    coef = leastSquares(X, y, ridge);
  } else {
    // Per-model mean log cost, no slopes: the estimate the data CAN support.
    const sums = new Map();
    for (const [i, o] of used.entries()) sums.set(o.model, (sums.get(o.model) ?? 0) + y[i]);
    coef = [
      ...models.map((m) => /** @type {number} */ (sums.get(m)) / counts[m]),
      ...new Array(nFeatures).fill(0),
    ];
  }
  const alpha = new Array(nModels).fill(null);
  for (const m of models) alpha[m] = coef[col.get(m)];
  const beta = coef.slice(models.length);
  let rss = 0;
  for (let i = 0; i < used.length; i++) {
    const pred = X[i].reduce((s, v, c) => s + v * coef[c], 0);
    rss += (y[i] - pred) ** 2;
  }
  let s2;
  let s2Source;
  if (method === "ols") {
    s2 = rss / dofOls;
    s2Source = "fitted";
  } else {
    // Within-model residuals only (no slopes were fitted), shrunk toward the prior.
    const dofPooled = used.length - models.length;
    s2 =
      dofPooled > 0 ? (rss + VAR_PRIOR_WEIGHT * s2Prior) / (dofPooled + VAR_PRIOR_WEIGHT) : s2Prior;
    s2Source = dofPooled > 0 ? "pooled+prior" : "prior";
  }
  // Standard error of each fitted α (a model with one observation is barely known).
  const alphaSE = counts.map((n, m) => (alpha[m] === null || !n ? null : Math.sqrt(s2 / n)));

  // Smearing factor (see the header). Only an OLS fit has residuals worth exponentiating: with
  // per-model means and a handful of attempts the in-sample residuals are near zero by
  // construction and would understate the mean.
  /** @type {number|null} */
  let smear = null;
  /** @type {(number|null)[]} */
  let smearByModel = new Array(nModels).fill(null);
  if (method === "ols") {
    const inflate = Math.sqrt(used.length / dofOls);
    const sums = new Array(nModels).fill(0);
    let total = 0;
    for (let i = 0; i < used.length; i++) {
      const pred = X[i].reduce((t, v, c) => t + v * coef[c], 0);
      const e = Math.exp((y[i] - pred) * inflate);
      sums[used[i].model] += e;
      total += e;
    }
    smear = total / used.length;
    smearByModel = counts.map((n, m) => (n ? sums[m] / n : null));
  }

  // Cold start from prices.
  const priced = models.filter((m) => prices[m]?.priceIn > 0 && prices[m]?.priceOut > 0);
  let rho = null;
  let kappa = null;
  if (priced.length >= 1) {
    const spread = (r) => {
      const d = priced.map(
        (m) => alpha[m] - Math.log(r * prices[m].priceIn + (1 - r) * prices[m].priceOut),
      );
      const mean = d.reduce((s, v) => s + v, 0) / d.length;
      return { mean, var: d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length };
    };
    let best = null;
    for (let i = 0; i <= 100; i++) {
      const r = i / 100;
      const sp = spread(r);
      // Ties (e.g. a single priced model) resolve to the smallest ρ that is exactly as good,
      // which is the least committal blend; the tie is reported via `pricedModels`.
      if (!best || sp.var < best.var - 1e-15) best = { r, ...sp };
    }
    rho = best.r;
    kappa = best.mean;
  }
  const source = new Array(nModels).fill(null);
  for (const m of models) source[m] = "observed";
  for (let m = 0; m < nModels; m++) {
    if (alpha[m] !== null) continue;
    const p = prices[m];
    if (kappa !== null && p?.priceIn > 0 && p?.priceOut > 0) {
      alpha[m] = Math.log(rho * p.priceIn + (1 - rho) * p.priceOut) + kappa;
      source[m] = "price";
    }
  }
  return {
    alpha,
    beta,
    s2,
    rho,
    kappa,
    source,
    pricedModels: priced.length,
    n: used.length,
    method,
    s2Source,
    counts,
    alphaSE,
    excluded,
    smear,
    smearByModel,
  };
}

/**
 * The retransformation factor: the fit's smearing estimate, else the log-normal exp(s²/2) (a
 * fit too sparse to have one, and every prior written before smearing existed).
 */
export function meanFactor(costModel) {
  return Number.isFinite(costModel.smear) ? costModel.smear : Math.exp(costModel.s2 / 2);
}

/** Expected attempt cost per model for a task (null where the model's cost is unknown). */
export function expectedCosts(costModel, x) {
  const bx = costModel.beta.reduce((s, b, d) => s + b * (x[d] ?? 0), 0);
  const factor = meanFactor(costModel);
  return costModel.alpha.map((a) => (a === null ? null : Math.exp(a + bx) * factor));
}

/**
 * How much more a failed attempt costs than a successful one, as a log ratio δ.
 *
 * The cascade cost formula used to assume an attempt costs the same whatever its outcome. In
 * the recorded runs a failed attempt cost 1.2 to 2.0 times a successful one for every model,
 * which is why expected cascade cost was under-predicted. δ is estimated WITHIN each model, so
 * a cheap model that fails often cannot masquerade as "failures are cheap":
 *
 *   d_m = mean(residual | failed) − mean(residual | passed),  residual = log cost − β·x
 *   δ̂   = Σ_m w_m d_m / Σ_m w_m,   w_m = n_pass·n_fail / (n_pass + n_fail)
 *
 * The model intercept cancels in d_m. `weight` (Σ w_m) is the number of paired observations the
 * estimate is worth, and Var(δ̂) = s² / weight. A model with only passes or only failures
 * contributes nothing. The caller shrinks δ̂ toward its prior; with no usable model δ̂ is null.
 * @param {{model:number, x:number[], cost:number, passed:boolean}[]} obs
 * @param {{beta:number[], s2:number}} costModel
 * @returns {{delta:number|null, weight:number, se:number|null, passed:number, failed:number}}
 */
export function failLogRatio(obs, costModel) {
  /** @type {Map<number, {pass:number[], fail:number[]}>} */
  const byModel = new Map();
  for (const o of obs) {
    if (!(o?.cost > 0) || !Number.isFinite(o.cost) || typeof o.passed !== "boolean") continue;
    if (!Number.isInteger(o.model) || !Array.isArray(o.x)) continue;
    const resid = Math.log(o.cost) - costModel.beta.reduce((t, b, d) => t + b * (o.x[d] ?? 0), 0);
    const g = byModel.get(o.model) ?? { pass: [], fail: [] };
    (o.passed ? g.pass : g.fail).push(resid);
    byModel.set(o.model, g);
  }
  const mean = (v) => v.reduce((t, x) => t + x, 0) / v.length;
  let num = 0;
  let weight = 0;
  let passed = 0;
  let failed = 0;
  for (const g of byModel.values()) {
    if (!g.pass.length || !g.fail.length) continue;
    const w = (g.pass.length * g.fail.length) / (g.pass.length + g.fail.length);
    num += w * (mean(g.fail) - mean(g.pass));
    weight += w;
    passed += g.pass.length;
    failed += g.fail.length;
  }
  if (weight === 0) return { delta: null, weight: 0, se: null, passed: 0, failed: 0 };
  return { delta: num / weight, weight, se: Math.sqrt(costModel.s2 / weight), passed, failed };
}

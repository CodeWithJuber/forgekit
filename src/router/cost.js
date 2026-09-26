// Expected cost of one attempt by a model on a task.
//
//   log cost = α_m + β·x + ε,   ε ~ N(0, s²)   ⇒   E[cost] = exp(α_m + β·x + s²/2)
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
    used.forEach((o, i) => sums.set(o.model, (sums.get(o.model) ?? 0) + y[i]));
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
  };
}

/** Expected attempt cost per model for a task (null where the model's cost is unknown). */
export function expectedCosts(costModel, x) {
  const bx = costModel.beta.reduce((s, b, d) => s + b * (x[d] ?? 0), 0);
  return costModel.alpha.map((a) => (a === null ? null : Math.exp(a + bx + costModel.s2 / 2)));
}

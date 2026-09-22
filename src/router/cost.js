// Expected cost of one attempt by a model on a task.
//
//   log cost = α_m + β·x + ε,   ε ~ N(0, s²)   ⇒   E[cost] = exp(α_m + β·x + s²/2)
//
// α_m (per model) and the shared slope β are fitted by least squares on observed attempt costs.
// A model with prices but no observed attempts gets α_m from its price: across the models that
// have both, α_k − log(blended price_k) is nearly constant (same agent, same token volume), so
// α_m = log(blended price_m) + mean(α_k − log blended price_k). The input/output blend ρ is the
// value that makes that difference most constant across those models (chosen from data).
import { leastSquares } from "./linalg.js";

/**
 * @param {{model: number, x: number[], cost: number}[]} obs
 * @param {number} nModels
 * @param {number} nFeatures
 * @param {{priceIn?: number|null, priceOut?: number|null}[]} [prices] per model, USD per Mtok
 */
export function fitCost(obs, nModels, nFeatures, prices = []) {
  const used = obs.filter((o) => o.cost > 0 && Number.isFinite(o.cost));
  const seen = new Set(used.map((o) => o.model));
  const models = [...seen].sort((a, b) => a - b);
  const col = new Map(models.map((m, i) => [m, i]));
  const X = used.map((o) => [...models.map((m) => (m === o.model ? 1 : 0)), ...o.x]);
  const y = used.map((o) => Math.log(o.cost));
  // A tiny ridge on the slopes only keeps the system well-posed with few observations.
  const ridge = [
    ...models.map(() => 0),
    ...new Array(nFeatures).fill(1e-6 * Math.max(1, used.length)),
  ];
  const coef =
    used.length > models.length
      ? leastSquares(X, y, ridge)
      : [...models.map(() => 0), ...new Array(nFeatures).fill(0)];
  const alpha = new Array(nModels).fill(null);
  for (const m of models) alpha[m] = coef[col.get(m)];
  const beta = coef.slice(models.length);
  let rss = 0;
  for (let i = 0; i < used.length; i++) {
    const pred = X[i].reduce((s, v, c) => s + v * coef[c], 0);
    rss += (y[i] - pred) ** 2;
  }
  const dof = Math.max(1, used.length - models.length - nFeatures);
  const s2 = used.length ? rss / dof : 0;

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
  return { alpha, beta, s2, rho, kappa, source, pricedModels: priced.length, n: used.length };
}

/** Expected attempt cost per model for a task (null where the model's cost is unknown). */
export function expectedCosts(costModel, x) {
  const bx = costModel.beta.reduce((s, b, d) => s + b * (x[d] ?? 0), 0);
  return costModel.alpha.map((a) => (a === null ? null : Math.exp(a + bx + costModel.s2 / 2)));
}

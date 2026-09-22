// Fit the universal router from per-task outcome data (tasks × models, sparse allowed):
// features → standardisation → MIRT with k and prior scale chosen by cross-validation → cost model.
import { fitCost } from "./cost.js";
import { fitScaler, rawFeatures, standardise } from "./features.js";
import { selectAndFit } from "./mirt.js";
import { loadRegistry } from "./registry.js";

/**
 * @param {{source?: object, tasks: {id: string, text: string, features?: number[]}[],
 *          outcomes: Record<string, Record<string, {resolved: boolean, cost: number|null}>>}} input
 * @param {Set<string>|null} [only] restrict to these task ids
 * @param {{registry?: {models: object[]}, root?: string|null}} [opts]
 */
export function buildPrior(input, only = null, { registry = loadRegistry(null), root = null } = {}) {
  const models = Object.keys(input.outcomes).filter((id) => registry.models.some((m) => m.id === id));
  const tasks = input.tasks.filter((t) => !only || only.has(t.id));
  const raw = tasks.map((t) => t.features ?? rawFeatures(root, t.text));
  const scaler = fitScaler(raw);
  const X = raw.map((r) => standardise(scaler, r));
  const data = {
    nModels: models.length,
    nFeatures: scaler.mean.length,
    tasks: tasks.map((t, j) => ({
      x: X[j],
      obs: models
        .map((id, m) => [m, input.outcomes[id][t.id]])
        .filter(([, o]) => o)
        .map(([m, o]) => [m, o.resolved ? 1 : 0]),
    })),
  };
  const fit = selectAndFit(data);
  const costObs = [];
  tasks.forEach((t, j) =>
    models.forEach((id, m) => {
      const o = input.outcomes[id][t.id];
      if (o?.cost > 0) costObs.push({ model: m, x: X[j], cost: o.cost });
    }),
  );
  const prices = models.map((id) => {
    const r = registry.models.find((m) => m.id === id);
    return { priceIn: r?.price_in ?? null, priceOut: r?.price_out ?? null };
  });
  const cost = fitCost(costObs, models.length, scaler.mean.length, prices);
  return {
    version: 1,
    models,
    features: scaler,
    mirt: fit.params,
    cost,
    selection: fit.selection,
    provenance: {
      ...(input.source ?? {}),
      tasks: tasks.length,
      outcomes: data.tasks.reduce((s, t) => s + t.obs.length, 0),
      fittedAt: new Date().toISOString(),
    },
  };
}


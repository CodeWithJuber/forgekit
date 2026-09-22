// Universal router: pick the model, or the cascade of models, that minimises expected cost for
// the success probability the user asks for — across any provider in the registry.
//
// Pieces (each in its own module, each documented with its equation):
//   features.js  task → feature vector
//   mirt.js      P(model solves task) with correlated failures (multidimensional IRT)
//   cost.js      E[cost of one attempt]
//   policy.js    best single model or cascade under the chosen objective
//   registry.js  which models exist and who can serve them (data)
//
// Learning: `recordOutcome` appends (task features, model, verified pass/fail, cost) to
// .forge/route_outcomes.jsonl, and `fitRouter` refits with the shipped fit as the prior
// (a Bayesian update), writing .forge/router_model.json. The shipped fit comes from public
// per-task results (data/router_prior.json records its source and date).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedCosts, fitCost } from "./cost.js";
import { rawFeatures, standardise } from "./features.js";
import { fitMirt, marginals, nodeProbabilities } from "./mirt.js";
import { choose, parseObjective } from "./policy.js";
import { loadRegistry, servableBy } from "./registry.js";

const SHIPPED_PRIOR = new URL("../../data/router_prior.json", import.meta.url);
const LOCAL_MODEL = (root) => join(root, ".forge", "router_model.json");
const OUTCOMES = (root) => join(root, ".forge", "route_outcomes.jsonl");

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** The fitted router in effect: the project's refit if present, else the shipped prior fit. */
export function loadRouterModel(root) {
  const local = root && existsSync(LOCAL_MODEL(root)) ? readJson(LOCAL_MODEL(root)) : null;
  if (local?.mirt) return { ...local, origin: ".forge/router_model.json" };
  const shipped = readJson(SHIPPED_PRIOR);
  return shipped?.mirt ? { ...shipped, origin: "data/router_prior.json" } : null;
}

/**
 * Align a fitted model with the registry: models known to the fit keep their parameters; models
 * only in the registry enter "cold" — ability and loadings at the mean of the fitted models (the
 * population prior), cost from their price if the registry has one.
 */
export function alignModels(fitted, registry) {
  const ids = registry.models.map((m) => m.id);
  const idx = new Map(fitted.models.map((id, i) => [id, i]));
  const k = fitted.mirt.k;
  const meanA = fitted.mirt.a.reduce((s, v) => s + v, 0) / fitted.mirt.a.length;
  const meanL = Array.from({ length: k }, (_, d) => fitted.mirt.L.reduce((s, r) => s + r[d], 0) / fitted.mirt.L.length);
  const a = [];
  const L = [];
  const alpha = [];
  const status = [];
  const prices = registry.models.map((m) => ({ priceIn: m.price_in ?? null, priceOut: m.price_out ?? null }));
  for (let i = 0; i < ids.length; i++) {
    const j = idx.get(ids[i]);
    if (j !== undefined) {
      a.push(fitted.mirt.a[j]);
      L.push(fitted.mirt.L[j]);
      alpha.push(fitted.cost.alpha[j]);
      status.push("fitted");
    } else {
      a.push(meanA);
      L.push(meanL);
      const p = prices[i];
      const c = fitted.cost;
      alpha.push(
        c.kappa !== null && c.rho !== null && p.priceIn > 0 && p.priceOut > 0
          ? Math.log(c.rho * p.priceIn + (1 - c.rho) * p.priceOut) + c.kappa
          : null,
      );
      status.push("cold");
    }
  }
  return {
    ids,
    mirt: { k, a, w: fitted.mirt.w, L },
    cost: { ...fitted.cost, alpha },
    status,
  };
}

/**
 * Recommend a model or cascade for a task.
 * @param {string|null} root
 * @param {string} task
 * @param {{objective?: string, maxDepth?: number, provider?: string, candidates?: string[], features?: number[]}} [opts]
 */
export function routeUniversal(root, task, opts = {}) {
  const fitted = opts.model ?? loadRouterModel(root);
  if (!fitted) return { ok: false, reason: "no fitted router model (data/router_prior.json missing)" };
  const registry = opts.registry ?? loadRegistry(root);
  const aligned = alignModels(fitted, registry);
  const raw = opts.features ?? rawFeatures(root, task);
  const x = standardise(fitted.features, raw);
  const objective = parseObjective(opts.objective ?? readConfigObjective(root));
  const allowed = new Set(opts.candidates ?? servableBy(registry, opts.provider ?? "any"));
  const candidates = aligned.ids.map((id, i) => (allowed.has(id) ? i : -1)).filter((i) => i >= 0);
  const nodes = nodeProbabilities(aligned.mirt, x);
  const costs = expectedCosts(aligned.cost, x);
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 3, candidates.length));
  const pick = choose(nodes, costs, candidates, objective, maxDepth);
  if (!pick) return { ok: false, reason: "no candidate model has a known cost for this provider" };
  const p1 = marginals(nodes);
  return {
    ok: true,
    cascade: pick.seq.map((i) => ({
      model: aligned.ids[i],
      status: aligned.status[i],
      pSolveAlone: p1[i],
      expectedAttemptCost: costs[i],
    })),
    pSuccess: pick.p,
    expectedCost: pick.cost,
    objective,
    target: pick.target,
    targetMet: pick.targetMet,
    bestSingle: { model: aligned.ids[pick.bestSingle.model], pSuccess: pick.bestSingle.p, expectedCost: pick.bestSingle.cost },
    candidates: candidates.length,
    cascadesEvaluated: pick.evaluated,
    fit: { origin: fitted.origin, k: fitted.mirt.k, provenance: fitted.provenance ?? null },
    taskRef: taskRef(task),
  };
}

function readConfigObjective(root) {
  if (!root) return undefined;
  const cfg = readJson(join(root, ".forge", "config.json"));
  return cfg?.route?.objective;
}

export const taskRef = (task) => createHash("sha256").update(String(task)).digest("hex").slice(0, 16);

/**
 * Record a verified outcome of one attempt (the only evidence the router learns from). The task
 * text is not stored: only its hash and features.
 */
export function recordOutcome(root, { task, model, passed, cost = null, features = null }) {
  if (!model || typeof passed !== "boolean") throw new Error("recordOutcome needs model and passed (boolean)");
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  const row = {
    at: new Date().toISOString(),
    task: taskRef(task),
    features: features ?? rawFeatures(root, task),
    model,
    passed,
    cost: Number.isFinite(cost) ? cost : null,
  };
  appendFileSync(OUTCOMES(root), `${JSON.stringify(row)}\n`);
  return row;
}

export function readOutcomes(root) {
  if (!existsSync(OUTCOMES(root))) return [];
  return readFileSync(OUTCOMES(root), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Refit on the project's recorded outcomes with the shipped fit as the prior mean (Bayesian
 * update: few local outcomes barely move it, many outcomes dominate). Writes
 * .forge/router_model.json and returns it.
 */
export function fitRouter(root, { outcomes = readOutcomes(root), registry = loadRegistry(root) } = {}) {
  const shipped = readJson(SHIPPED_PRIOR);
  if (!shipped?.mirt) throw new Error("data/router_prior.json missing: cannot fit without a prior");
  const base = alignModels(shipped, registry);
  const index = new Map(base.ids.map((id, i) => [id, i]));
  const byTask = new Map();
  const costObs = [];
  let skipped = 0;
  for (const o of outcomes) {
    const m = index.get(o.model);
    if (m === undefined || !Array.isArray(o.features)) {
      skipped++;
      continue;
    }
    const x = standardise(shipped.features, o.features);
    if (!byTask.has(o.task)) byTask.set(o.task, { x, obs: [] });
    byTask.get(o.task).obs.push([m, o.passed ? 1 : 0]);
    if (o.cost > 0) costObs.push({ model: m, x, cost: o.cost });
  }
  const data = { nModels: base.ids.length, nFeatures: shipped.features.mean.length, tasks: [...byTask.values()] };
  const scale = shipped.selection?.chosen?.scale ?? 1;
  const { params } = fitMirt(data, base.mirt.k, {
    a: base.mirt.a,
    w: base.mirt.w,
    L: base.mirt.L,
    scaleA: 2 * scale,
    scaleW: scale,
    scaleL: scale,
  });
  // Cost: shipped α is worth one observation (unit-information prior); local attempts update it.
  const alpha = base.cost.alpha.slice();
  for (let m = 0; m < alpha.length; m++) {
    const mine = costObs.filter((c) => c.model === m);
    if (!mine.length) continue;
    const resid = mine.map((c) => Math.log(c.cost) - base.cost.beta.reduce((s, b, d) => s + b * c.x[d], 0));
    const prior = alpha[m] ?? resid.reduce((s, v) => s + v, 0) / resid.length;
    alpha[m] = (prior + resid.reduce((s, v) => s + v, 0)) / (1 + resid.length);
  }
  const model = {
    version: 1,
    models: base.ids,
    features: shipped.features,
    mirt: params,
    cost: { ...base.cost, alpha },
    selection: shipped.selection,
    provenance: {
      prior: shipped.provenance,
      local: { outcomes: outcomes.length - skipped, skipped, tasks: data.tasks.length, fittedAt: new Date().toISOString() },
    },
  };
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(LOCAL_MODEL(root), JSON.stringify(model, null, 2));
  return model;
}

export { fitCost };

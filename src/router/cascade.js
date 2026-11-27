// Exact cascade search over SETS of attempts instead of ordered sequences.
//
// policy.js scores a cascade s = (m1, m2, …) by
//
//   E[cost of s] = Σ_i c_{m_i} · F({m_1 … m_{i-1}}),   F(T) = P(every attempt in T fails)
//
// The charge for position i depends only on the SET of earlier attempts, never on their order,
// and P(s solves) = 1 − F(S) does not depend on order at all. So the cheapest order of each set
// follows from a dynamic programme over subsets:
//
//   g(∅) = 0,   g(S) = min_{i ∈ S} [ g(S \ {i}) + c_i · F(S \ {i}) ]
//
// That is O(2^n · n) where enumerating ordered cascades is O(n!), and it stays exact when
// failures are correlated, because F may come from any joint model — including the quadrature
// nodes policy.js already integrates over. `chooseBySubsets` returns what `choose` returns for
// the same inputs (test/router_cascade.test.js compares them on random instances).
//
// Two facts worth keeping in view when reading a plan:
//   - with INDEPENDENT attempts the best order of a fixed set sorts by cost / success
//     probability; sorting by price alone is right only when all success rates are equal;
//   - with correlated failures even that ratio rule can lose, which is why the programme
//     is used instead of a sort.
// The model assumes an external verifier that never accepts a wrong answer.
//
// Cost conditioned on outcomes. With a fail/success cost ratio r ≠ 1 (policy.js), the charge for
// attempting i after the set T has failed is Σ_q w_q · Π_{l∈T}(1 − P[l][q]) · k_i(q). It still
// depends on T as a SET, so the same programme stays exact:
//
//   g(S) = min_{i ∈ S} [ g(S \ {i}) + charge(i, S \ {i}) ]
//
// `routeUniversal` uses `chooseBySubsets`; policy.js `choose` remains the reference the tests
// compare it with.

import { nodeCosts, validRatio } from "./policy.js";

/** Joint model with independent attempts: p[i] is the success probability of attempt i. */
export function independentModel(p) {
  return (mask) => {
    let prod = 1;
    for (let i = 0; i < p.length; i++) if (mask & (1 << i)) prod *= 1 - p[i];
    return prod;
  };
}

/**
 * Joint model from quadrature nodes, as policy.js uses them: P[m][q] = P(m solves | θ_q),
 * weights w_q. `members[i]` is the model index behind bit i of a mask.
 * @param {number[][]} P
 * @param {number[]} weights
 * @param {number[]} members
 */
export function nodeModel(P, weights, members) {
  return (mask) => {
    let total = 0;
    for (let q = 0; q < weights.length; q++) {
      let prod = 1;
      for (let i = 0; i < members.length; i++) if (mask & (1 << i)) prod *= 1 - P[members[i]][q];
      total += weights[q] * prod;
    }
    return total;
  };
}

/** Expected cost of one explicit order (array of attempt indexes). */
export function expectedCost(order, costs, failAll, failurePenalty = 0) {
  let mask = 0;
  let total = 0;
  for (const i of order) {
    total += costs[i] * failAll(mask);
    mask |= 1 << i;
  }
  return total + failurePenalty * failAll(mask);
}

function popcount(mask) {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

/**
 * Cheapest order of every attempt set of size ≤ maxSize.
 * @param {number[]} costs
 * @param {(mask: number) => number} failAll
 * @param {number} maxSize
 */
function solveSubsets(costs, failAll, maxSize) {
  const n = costs.length;
  if (n === 0 || n > 20) throw new Error("between 1 and 20 attempts");
  if (costs.some((c) => !(c >= 0) || !Number.isFinite(c)))
    throw new Error("costs must be finite and nonnegative");
  const size = 1 << n;
  const fail = new Float64Array(size);
  const g = new Float64Array(size).fill(Infinity);
  const last = new Int8Array(size).fill(-1);
  const bits = new Uint8Array(size);
  fail[0] = failAll(0);
  g[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    bits[mask] = popcount(mask);
    if (bits[mask] > maxSize) continue;
    fail[mask] = failAll(mask);
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const prev = mask ^ (1 << i);
      const value = g[prev] + costs[i] * fail[prev];
      // Strict improvement keeps the lowest index on ties, which makes the result deterministic.
      if (value < g[mask]) {
        g[mask] = value;
        last[mask] = i;
      }
    }
  }
  const orderOf = (mask) => {
    const order = [];
    for (let m = mask; m; m ^= 1 << last[m]) order.unshift(last[m]);
    return order;
  };
  return { size, fail, g, bits, orderOf };
}

/**
 * The same programme with cost conditioned on outcomes: the charge for a step is integrated
 * over the quadrature nodes instead of being cost × P(reached). `members[i]` is the model behind
 * bit i. Pushes from each set to its supersets so a set's node failure vector is built once.
 * @param {number[][]} P
 * @param {number[]} weights
 * @param {number[]} members
 * @param {number[]} costs fitted expected attempt cost per member
 * @param {number} ratio cost of a failed attempt over a successful one
 * @param {number} maxSize
 */
function solveSubsetsConditioned(P, weights, members, costs, ratio, maxSize) {
  const n = members.length;
  if (n === 0 || n > 20) throw new Error("between 1 and 20 attempts");
  if (costs.some((c) => !(c >= 0) || !Number.isFinite(c)))
    throw new Error("costs must be finite and nonnegative");
  const Q = weights.length;
  const k = members.map((m, i) => nodeCosts(P[m], weights, costs[i], ratio));
  const size = 1 << n;
  const fail = new Float64Array(size);
  const g = new Float64Array(size).fill(Infinity);
  const last = new Int8Array(size).fill(-1);
  const bits = new Uint8Array(size);
  const node = new Float64Array(Q);
  g[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    if (mask) bits[mask] = popcount(mask);
    if (bits[mask] > maxSize) continue;
    // Node failure vector of this set, and its total.
    let total = 0;
    for (let q = 0; q < Q; q++) {
      let prod = 1;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) prod *= 1 - P[members[i]][q];
      node[q] = weights[q] * prod;
      total += node[q];
    }
    fail[mask] = total;
    if (bits[mask] === maxSize || g[mask] === Infinity) continue;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      let charge = 0;
      for (let q = 0; q < Q; q++) charge += node[q] * k[i][q];
      const next = mask | (1 << i);
      const value = g[mask] + charge;
      // Strict improvement, or an exact tie won by the lower index: deterministic.
      if (value < g[next] || (value === g[next] && i < last[next])) {
        g[next] = value;
        last[next] = i;
      }
    }
  }
  const orderOf = (mask) => {
    const order = [];
    for (let m = mask; m; m ^= 1 << last[m]) order.unshift(last[m]);
    return order;
  };
  // Expected cost of attempt i given that the set `prev` has failed.
  const chargeGiven = (i, prev) => {
    let reach = 0;
    let charge = 0;
    for (let q = 0; q < Q; q++) {
      let prod = weights[q];
      for (let j = 0; j < n; j++) if (prev & (1 << j)) prod *= 1 - P[members[j]][q];
      reach += prod;
      charge += prod * k[i][q];
    }
    return reach > 0 ? charge / reach : 0;
  };
  return { size, fail, g, bits, orderOf, chargeGiven };
}

/**
 * Cheapest cascade. `allowed(mask, failProbability)` filters attempt sets (for example a
 * quality constraint). Returns the order, its expected cost, and the probability that the
 * whole cascade fails, or null when no set is allowed.
 * @param {{costs: number[], failAll: (mask: number) => number, failurePenalty?: number,
 *   allowed?: (mask: number, fail: number) => boolean}} problem
 * @returns {{order: number[], cost: number, failAll: number}|null}
 */
export function bestCascade({ costs, failAll, failurePenalty = 0, allowed }) {
  const { size, fail, g, orderOf } = solveSubsets(costs, failAll, costs.length);
  let best = null;
  for (let mask = 1; mask < size; mask++) {
    if (allowed && !allowed(mask, fail[mask])) continue;
    const total = g[mask] + failurePenalty * fail[mask];
    if (best === null || total < best.cost - 1e-15)
      best = { mask, cost: total, failAll: fail[mask] };
  }
  return best && { order: orderOf(best.mask), cost: best.cost, failAll: best.failAll };
}

/** With independent attempts the optimal order of a fixed set sorts by cost / success. */
export function ratioOrder(costs, p) {
  return costs.map((_, i) => i).sort((a, b) => costs[a] * p[b] - costs[b] * p[a] || a - b);
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-15) return true;
    if (a[i] > b[i] + 1e-15) return false;
  }
  return false;
}

/**
 * The same decision as policy.js `choose`, computed over attempt sets. Same arguments, same
 * objectives, same result fields; `evaluated` counts attempt sets instead of ordered cascades.
 * When two cascades tie exactly on the objective, the one returned may differ from `choose`.
 * @param {{P: number[][], weights: number[]}} nodes
 * @param {(number|null)[]} costs expected attempt cost per model (null = unknown, excluded)
 * @param {number[]} candidates model indices allowed
 * @param {{kind: string, target?: number, value?: number, budget?: number}} objective
 * @param {number} maxDepth
 * @param {{failCostRatio?: number}} [options]
 */
export function chooseBySubsets(
  nodes,
  costs,
  candidates,
  objective,
  maxDepth,
  { failCostRatio = 1 } = {},
) {
  const { P, weights } = nodes;
  const ratio = validRatio(failCostRatio);
  const usable = candidates.filter((m) => costs[m] !== null && Number.isFinite(costs[m]));
  if (!usable.length) return null;
  const local = usable.map((m) => /** @type {number} */ (costs[m]));
  const depth = Math.max(1, Math.min(maxDepth, usable.length));
  const conditioned =
    ratio === 1 ? null : solveSubsetsConditioned(P, weights, usable, local, ratio, depth);
  const { size, fail, g, bits, orderOf } =
    conditioned ?? solveSubsets(local, nodeModel(P, weights, usable), depth);
  const single = usable.map((m, i) => ({ m, p: 1 - fail[1 << i], cost: g[1 << i] }));
  const bestSingle = single.reduce((a, b) => (b.p > a.p ? b : a));
  const target =
    objective.kind === "match-best-single"
      ? bestSingle.p
      : objective.kind === "target"
        ? objective.target
        : null;
  const eps = 1e-12;
  let best = null;
  let bestKey = null;
  let evaluated = 0;
  for (let mask = 1; mask < size; mask++) {
    if (bits[mask] > depth) continue;
    evaluated++;
    const p = 1 - fail[mask];
    const cost = g[mask];
    const len = bits[mask];
    let key;
    if (target !== null) key = p >= target - eps ? [0, cost, -p, len] : [1, -p, cost, len];
    else if (objective.kind === "value") key = [0, -(objective.value * p - cost), len];
    else key = cost <= objective.budget + eps ? [0, -p, cost, len] : [1, cost, -p, len];
    if (!bestKey || lexLess(key, bestKey)) {
      bestKey = key;
      best = { mask, p, cost };
    }
  }
  const order = orderOf(best.mask);
  const seq = order.map((i) => usable[i]);
  const targetMet = target === null ? null : best.p >= target - eps;
  const budgetMet = objective.kind === "budget" ? best.cost <= objective.budget + eps : null;
  const minimumExpectedCost = Math.min(...single.map((x) => x.cost));
  let estimatedCostIfAllAttemptsRun = 0;
  let prev = 0;
  for (const i of order) {
    estimatedCostIfAllAttemptsRun += conditioned ? conditioned.chargeGiven(i, prev) : local[i];
    prev |= 1 << i;
  }
  const feasible = targetMet !== false && budgetMet !== false;
  const reason = feasible
    ? undefined
    : budgetMet === false
      ? `infeasible: no cascade's expected cost fits the budget $${objective.budget} (the cheapest expected cost is $${minimumExpectedCost.toFixed(4)})`
      : `infeasible: no cascade reaches P(success) ${target} (the best reachable is ${best.p.toFixed(4)})`;
  return {
    seq,
    p: best.p,
    cost: best.cost,
    target,
    targetMet,
    budgetMet,
    feasible,
    ...(reason ? { reason } : {}),
    minimumExpectedCost,
    estimatedCostIfAllAttemptsRun,
    bestSingle: { model: bestSingle.m, p: bestSingle.p, cost: bestSingle.cost },
    evaluated,
  };
}

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
// the same inputs (test/router_cascade.test.js compares them on random instances); nothing in
// the router calls it yet, so routing behaviour is unchanged by this module.
//
// Two facts worth keeping in view when reading a plan:
//   - with INDEPENDENT attempts the best order of a fixed set sorts by cost / success
//     probability; sorting by price alone is right only when all success rates are equal;
//   - with correlated failures even that ratio rule can lose, which is why the programme
//     is used instead of a sort.
// The model assumes an external verifier that never accepts a wrong answer and an attempt cost
// that does not depend on earlier attempts having failed — the same assumptions policy.js states.

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
 */
export function chooseBySubsets(nodes, costs, candidates, objective, maxDepth) {
  const { P, weights } = nodes;
  const usable = candidates.filter((m) => costs[m] !== null && Number.isFinite(costs[m]));
  if (!usable.length) return null;
  const local = usable.map((m) => /** @type {number} */ (costs[m]));
  const depth = Math.max(1, Math.min(maxDepth, usable.length));
  const { size, fail, g, bits, orderOf } = solveSubsets(
    local,
    nodeModel(P, weights, usable),
    depth,
  );
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
  const seq = orderOf(best.mask).map((i) => usable[i]);
  const targetMet = target === null ? null : best.p >= target - eps;
  const budgetMet = objective.kind === "budget" ? best.cost <= objective.budget + eps : null;
  const minimumExpectedCost = Math.min(...single.map((x) => x.cost));
  const estimatedCostIfAllAttemptsRun = seq.reduce(
    (sum, m) => sum + /** @type {number} */ (costs[m]),
    0,
  );
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

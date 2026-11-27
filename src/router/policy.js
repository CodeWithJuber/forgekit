// Choosing a model, or a cascade of models, for one task.
//
// A cascade s = (m1, m2, …) runs m1; only if an external check says it failed does it run m2,
// and so on. With node probabilities P[m][q] = P(m solves | θ_q) and weights w_q:
//
//   P(s solves)   = 1 − Σ_q w_q Π_{m∈s} (1 − P[m][q])
//   E[cost of s]  = Σ_i c_{m_i} · Σ_q w_q Π_{l<i} (1 − P[m_l][q])
//
// Integrating over θ is what keeps correlated failures honest: after m1 fails, the task is
// probably hard for m2 too. Treating models as independent overstates what a cascade buys.
//
// Objectives (none has a built-in threshold; each takes the user's stated preference or none):
//   match-best-single (default): the cheapest cascade whose P(success) is at least that of the
//                                best single candidate for this task — never worse than always
//                                using the strongest model, at the lowest expected cost.
//   target:p                    : the cheapest cascade with P(success) ≥ p (else the most likely).
//   value:V                     : maximise V·P(success) − E[cost]  (V = what a solved task is worth).
//   budget:B                    : the most likely cascade with E[cost] ≤ B.
//
// Infeasibility is explicit (review F12): when no cascade meets the target or fits the budget,
// the least-bad cascade is still computed, but the result says `feasible: false` with a
// `reason`, `budgetMet: false` for a budget objective, and `minimumExpectedCost` — the caller
// must choose to fall back; nothing reads as "within budget". A budget constrains EXPECTED
// cost only. `estimatedCostIfAllAttemptsRun` is the sum of every attempt's EXPECTED cost —
// a modeled figure for the path where each stage runs, not a bound on what a stochastic run can
// bill (it was called `maxPossibleCost`, which overstated it). The ACTUAL charge is whatever the
// attempts cost — enforce a hard cap at execution time if one is promised.
//
// Cost conditioned on outcomes. A failed attempt costs more than a successful one (1.2 to 2.0
// times, for every model, in the recorded runs), and a later attempt is reached only on tasks
// the earlier ones failed, where it is more likely to fail too. With `failCostRatio` r, the cost
// of an attempt by m at node q is
//
//   k_m(q) = c_m · (P[m][q] + (1 − P[m][q])·r) / (p̄_m + (1 − p̄_m)·r),   p̄_m = Σ_q w_q P[m][q]
//
// so that Σ_q w_q k_m(q) = c_m: a FIRST attempt still costs exactly its fitted expectation,
// and
//
//   E[cost of s]  = Σ_i Σ_q w_q · Π_{l<i} (1 − P[m_l][q]) · k_{m_i}(q)
//
// charges a later attempt for the harder tasks it actually sees. r = 1 is the old formula,
// which assumed E[cost_i | earlier failed, x] = E[cost_i | x] and under-predicted cascade cost
// by 5 to 22% in the in-repo replay. r comes from recorded outcomes (cost.js); with none it is
// 1 and the result says so.

/** Check a fail/success cost ratio. 1 means "an attempt costs the same whatever its outcome". */
export function validRatio(ratio) {
  if (!(ratio > 0) || !Number.isFinite(ratio))
    throw new RangeError("failCostRatio must be a finite number above 0");
  return ratio;
}

/**
 * Per-node attempt cost k_m(q), normalised so its mean over the nodes is `cost`.
 * @param {number[]} Pm success probability of one model at each node
 * @param {number[]} w node weights
 * @param {number} cost the model's fitted expected attempt cost for this task
 * @param {number} ratio cost of a failed attempt over a successful one
 */
export function nodeCosts(Pm, w, cost, ratio) {
  if (ratio === 1) return w.map(() => cost);
  let mean = 0;
  for (let q = 0; q < w.length; q++) mean += w[q] * Pm[q];
  const success = cost / (mean + (1 - mean) * ratio);
  return w.map((_, q) => success * (Pm[q] + (1 - Pm[q]) * ratio));
}

/**
 * Success probability and expected cost of one ordered cascade. `ifAllRun` is the sum of each
 * attempt's expected cost GIVEN that it is reached (every earlier attempt failed).
 * @param {number[][]} P @param {number[]} w @param {number[]} costs @param {number[]} seq
 * @param {number} [ratio] cost of a failed attempt over a successful one (1 = no conditioning)
 */
export function cascadeStats(P, w, costs, seq, ratio = 1) {
  const fail = w.map(() => 1);
  let cost = 0;
  let ifAllRun = 0;
  for (const m of seq) {
    let reach = 0;
    for (let q = 0; q < w.length; q++) reach += w[q] * fail[q];
    if (ratio === 1) {
      // The unconditioned formula, in its original arithmetic so results are unchanged bit for bit.
      cost += costs[m] * reach;
      ifAllRun += costs[m];
    } else {
      const k = nodeCosts(P[m], w, costs[m], ratio);
      let charge = 0;
      for (let q = 0; q < w.length; q++) charge += w[q] * fail[q] * k[q];
      cost += charge;
      // An attempt that can never be reached adds nothing; its conditional cost is undefined.
      ifAllRun += reach > 0 ? charge / reach : 0;
    }
    for (let q = 0; q < w.length; q++) fail[q] *= 1 - P[m][q];
  }
  let pf = 0;
  for (let q = 0; q < w.length; q++) pf += w[q] * fail[q];
  return { p: 1 - pf, cost, ifAllRun };
}

/** All ordered cascades of distinct candidates up to `maxDepth` models long. */
export function* cascades(candidates, maxDepth) {
  function* rec(prefix, used) {
    if (prefix.length) yield prefix;
    if (prefix.length >= maxDepth) return;
    for (const m of candidates) if (!used.has(m)) yield* rec([...prefix, m], new Set([...used, m]));
  }
  yield* rec([], new Set());
}

/**
 * Parse an objective string: "match-best-single" | "target:0.85" | "value:2" | "budget:0.5".
 * @param {string|undefined} spec
 */
export function parseObjective(spec) {
  if (!spec || spec === "match-best-single" || spec === "match")
    return { kind: "match-best-single" };
  const [kind, raw] = String(spec).split(":");
  const v = Number(raw);
  if (kind === "target" && v > 0 && v < 1) return { kind, target: v };
  if (kind === "value" && v > 0) return { kind, value: v };
  if (kind === "budget" && v > 0) return { kind, budget: v };
  throw new Error(
    `unknown objective "${spec}" (use match-best-single, target:<0..1>, value:<$>, budget:<$>)`,
  );
}

/**
 * @param {{P: number[][], weights: number[]}} nodes
 * @param {(number|null)[]} costs expected attempt cost per model (null = unknown, excluded)
 * @param {number[]} candidates model indices allowed
 * @param {{kind: string, target?: number, value?: number, budget?: number}} objective
 * @param {number} maxDepth
 * @param {{failCostRatio?: number}} [options]
 */
export function choose(nodes, costs, candidates, objective, maxDepth, { failCostRatio = 1 } = {}) {
  const { P, weights } = nodes;
  const ratio = validRatio(failCostRatio);
  const usable = candidates.filter((m) => costs[m] !== null && Number.isFinite(costs[m]));
  if (!usable.length) return null;
  const single = usable.map((m) => ({ m, ...cascadeStats(P, weights, costs, [m], ratio) }));
  const bestSingle = single.reduce((a, b) => (b.p > a.p ? b : a));
  const target =
    objective.kind === "match-best-single"
      ? bestSingle.p
      : objective.kind === "target"
        ? objective.target
        : null;
  let best = null;
  let bestKey = null;
  let evaluated = 0;
  const eps = 1e-12;
  for (const seq of cascades(usable, maxDepth)) {
    const st = cascadeStats(P, weights, costs, seq, ratio);
    evaluated++;
    let key;
    if (target !== null)
      key =
        st.p >= target - eps ? [0, st.cost, -st.p, seq.length] : [1, -st.p, st.cost, seq.length];
    else if (objective.kind === "value") key = [0, -(objective.value * st.p - st.cost), seq.length];
    else
      key =
        st.cost <= objective.budget + eps
          ? [0, -st.p, st.cost, seq.length]
          : [1, st.cost, -st.p, seq.length];
    if (!bestKey || lexLess(key, bestKey)) {
      bestKey = key;
      best = { seq, ...st };
    }
  }
  const targetMet = target === null ? null : best.p >= target - eps;
  const budgetMet = objective.kind === "budget" ? best.cost <= objective.budget + eps : null;
  const minimumExpectedCost = Math.min(...single.map((x) => x.cost));
  const { ifAllRun: estimatedCostIfAllAttemptsRun, ...chosen } = best;
  const feasible = targetMet !== false && budgetMet !== false;
  const reason = feasible
    ? undefined
    : budgetMet === false
      ? `infeasible: no cascade's expected cost fits the budget $${objective.budget} (the cheapest expected cost is $${minimumExpectedCost.toFixed(4)})`
      : `infeasible: no cascade reaches P(success) ${target} (the best reachable is ${best.p.toFixed(4)})`;
  return {
    ...chosen,
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

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-15) return true;
    if (a[i] > b[i] + 1e-15) return false;
  }
  return false;
}

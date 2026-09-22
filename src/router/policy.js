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

/** @param {number[][]} P @param {number[]} w @param {number[]} costs @param {number[]} seq */
export function cascadeStats(P, w, costs, seq) {
  const fail = w.map(() => 1);
  let cost = 0;
  for (const m of seq) {
    let reach = 0;
    for (let q = 0; q < w.length; q++) reach += w[q] * fail[q];
    cost += costs[m] * reach;
    for (let q = 0; q < w.length; q++) fail[q] *= 1 - P[m][q];
  }
  let pf = 0;
  for (let q = 0; q < w.length; q++) pf += w[q] * fail[q];
  return { p: 1 - pf, cost };
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
  if (!spec || spec === "match-best-single" || spec === "match") return { kind: "match-best-single" };
  const [kind, raw] = String(spec).split(":");
  const v = Number(raw);
  if (kind === "target" && v > 0 && v < 1) return { kind, target: v };
  if (kind === "value" && v > 0) return { kind, value: v };
  if (kind === "budget" && v > 0) return { kind, budget: v };
  throw new Error(`unknown objective "${spec}" (use match-best-single, target:<0..1>, value:<$>, budget:<$>)`);
}

/**
 * @param {{P: number[][], weights: number[]}} nodes
 * @param {(number|null)[]} costs expected attempt cost per model (null = unknown, excluded)
 * @param {number[]} candidates model indices allowed
 * @param {{kind: string, target?: number, value?: number, budget?: number}} objective
 * @param {number} maxDepth
 */
export function choose(nodes, costs, candidates, objective, maxDepth) {
  const { P, weights } = nodes;
  const usable = candidates.filter((m) => costs[m] !== null && Number.isFinite(costs[m]));
  if (!usable.length) return null;
  const single = usable.map((m) => ({ m, ...cascadeStats(P, weights, costs, [m]) }));
  const bestSingle = single.reduce((a, b) => (b.p > a.p ? b : a));
  const target =
    objective.kind === "match-best-single" ? bestSingle.p : objective.kind === "target" ? objective.target : null;
  let best = null;
  let bestKey = null;
  let evaluated = 0;
  const eps = 1e-12;
  for (const seq of cascades(usable, maxDepth)) {
    const st = cascadeStats(P, weights, costs, seq);
    evaluated++;
    let key;
    if (target !== null) key = st.p >= target - eps ? [0, st.cost, -st.p, seq.length] : [1, -st.p, st.cost, seq.length];
    else if (objective.kind === "value") key = [0, -(objective.value * st.p - st.cost), seq.length];
    else key = st.cost <= objective.budget + eps ? [0, -st.p, st.cost, seq.length] : [1, st.cost, -st.p, seq.length];
    if (!bestKey || lexLess(key, bestKey)) {
      bestKey = key;
      best = { seq, ...st };
    }
  }
  return {
    ...best,
    target,
    targetMet: target === null ? null : best.p >= target - eps,
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

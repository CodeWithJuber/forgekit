// Replay candidate cascades against first attempts at the same verified tasks.
// Keeping whole task rows together preserves cross-model failure and cost correlations.
import { cascadeSearchSize, cascades, parseObjective } from "./policy.js";

export function wilson(passed, n) {
  if (
    !Number.isSafeInteger(n) ||
    n < 1 ||
    !Number.isSafeInteger(passed) ||
    passed < 0 ||
    passed > n
  )
    throw new RangeError(
      "A Wilson interval needs a positive trial count and a valid number of successes",
    );
  const z = 1.959963984540054; // 97.5th percentile of the standard normal.
  const score = passed / n;
  const denominator = 1 + z ** 2 / n;
  const center = (score + z ** 2 / (2 * n)) / denominator;
  const radius = (z / denominator) * Math.sqrt((score * (1 - score)) / n + z ** 2 / (4 * n ** 2));
  return {
    score,
    n,
    low: passed === 0 ? 0 : center - radius,
    high: passed === n ? 1 : center + radius,
  };
}

export function firstAttempts(rows, workload) {
  const attempts = new Map();
  for (const row of rows) {
    if (row.provenance !== "verify-event" || (row.workload ?? "repo-verified") !== workload)
      continue;
    if (!attempts.has(row.model)) attempts.set(row.model, new Map());
    const tasks = attempts.get(row.model);
    if (!tasks.has(row.task)) tasks.set(row.task, row);
  }
  return attempts;
}

// Reported prices are JSON decimal numbers. Express every distinct price and the
// budget on their common power-of-ten scale, including fractional cents.
function priceScale(prices) {
  const parts = new Map();
  let exponent = 0;
  for (const price of prices) {
    const [mantissa, shift = "0"] = String(price).split("e");
    const [integer, fraction = ""] = mantissa.split(".");
    const power = Number(shift) - fraction.length;
    exponent = Math.min(exponent, power);
    parts.set(price, { digits: BigInt(integer + fraction), power });
  }
  const units = new Map();
  for (const [price, { digits, power }] of parts)
    units.set(price, digits * 10n ** BigInt(power - exponent));
  return { units, exponent };
}

function replay(seq, tasks, attempts, units) {
  let passed = 0;
  let total = 0n;
  for (const task of tasks) {
    for (const model of seq) {
      const observation = attempts.get(model).get(task);
      total += units.get(observation.cost);
      if (observation.passed) {
        passed++;
        break;
      }
    }
  }
  return { seq, interval: wilson(passed, tasks.length), total };
}

function order(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** @param {Map<string, Map<string, any>>} attempts @param {Map<string, any>} bindings @param {string} task
 * @param {{objective?:string,maxDepth?:number,profile?:string}} options */
export function measuredRoute(
  attempts,
  bindings,
  task,
  { objective: spec, maxDepth = 1, profile } = {},
) {
  const objective = parseObjective(spec);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1)
    throw new Error("Depth must be a positive integer");
  const priced = (row) => Number.isFinite(row?.cost) && row.cost >= 0;
  const candidates = [...bindings.keys()]
    .filter((id) => [...(attempts.get(id)?.values() ?? [])].some(priced))
    .sort();
  if (!candidates.length)
    return {
      ok: false,
      reason: "No first attempts with verified verdicts and reported costs for the listed models",
    };
  const paired = [...attempts.get(candidates[0]).keys()].filter((t) =>
    candidates.every((id) => priced(attempts.get(id).get(t))),
  );
  if (!paired.length)
    return {
      ok: false,
      reason: "No common verified tasks with first-attempt costs for the listed models",
    };
  const exact = paired.includes(task);
  const tasks = exact ? [task] : paired;
  const depth = Math.min(maxDepth, candidates.length);
  // A user-provided depth can request factorial work. Fail explicitly instead of
  // silently truncating the search and describing the result as an optimum.
  const count = cascadeSearchSize(candidates.length, depth, tasks.length);
  if (count === null)
    return {
      ok: false,
      reason:
        "Exact replay exceeds the computation limit. Reduce the requested depth or filter the candidates.",
    };
  const prices = new Set();
  for (const id of candidates) for (const t of tasks) prices.add(attempts.get(id).get(t).cost);
  if (objective.kind === "budget") prices.add(objective.budget);
  const { units, exponent } = priceScale(prices);
  const n = BigInt(tasks.length);
  const budgetTotal = objective.kind === "budget" ? units.get(objective.budget) * n : null;
  // Only public estimates and the utility objective need a floating-point mean.
  // Keep enough decimal places to represent even one price unit divided over all n tasks.
  const extraPlaces = Number.MAX_SAFE_INTEGER.toString().length + tasks.length.toString().length;
  const precision = 10n ** BigInt(extraPlaces);
  const mean = (total) => Number(`${(total * precision) / n}e${exponent - extraPlaces}`);
  const singles = new Map(candidates.map((id) => [id, replay([id], tasks, attempts, units)]));
  const strongest = [...singles.values()].sort((a, b) =>
    order([-a.interval.score, a.total], [-b.interval.score, b.total]),
  )[0];
  if (strongest.interval.score === 0)
    return { ok: false, reason: "No listed model has a verified success on the comparable tasks" };
  const target =
    objective.kind === "match-best-single" ? strongest.interval.low : (objective.target ?? null);
  function rank(result) {
    const p = result.interval.low;
    if (target !== null)
      return p >= target
        ? [0, result.total, -p, result.seq.length]
        : [1, -p, result.total, result.seq.length];
    if (budgetTotal !== null)
      return result.total <= budgetTotal
        ? [0, -p, result.total, result.seq.length]
        : [1, result.total, -p, result.seq.length];
    return [0, -(objective.value * p - mean(result.total)), result.seq.length];
  }
  let best = strongest;
  for (const seq of cascades(candidates, depth)) {
    const trial = seq.length === 1 ? singles.get(seq[0]) : replay(seq, tasks, attempts, units);
    if (order(rank(trial), rank(best)) < 0) best = trial;
  }
  const bestSingle = {
    model: strongest.seq[0],
    pSuccess: strongest.interval.score,
    expectedCost: mean(strongest.total),
  };
  const budgetMet = budgetTotal === null ? null : best.total <= budgetTotal;
  const targetMet = target !== null ? best.interval.low >= target : null;
  const feasible = budgetMet !== false && targetMet !== false;
  const cascade = best.seq.map((id) => {
    const single = singles.get(id);
    return {
      model: id,
      wireId: bindings.get(id).id,
      band: bindings.get(id).rating.band,
      pSolveAlone: single.interval.score,
      interval: single.interval,
      expectedAttemptCost: mean(single.total),
      providers: profile ? [profile] : [],
      status: "observed",
      costSource: "operator-reported paired first attempts",
    };
  });
  const result = {
    ok: feasible,
    feasible,
    applicable: true,
    unmapped: [],
    cascade,
    objective,
    target,
    targetMet,
    budgetMet,
    pSuccess: best.interval.score,
    interval: best.interval,
    expectedCost: mean(best.total),
    minimumExpectedCost: Math.min(...[...singles.values()].map((s) => mean(s.total))),
    estimatedCostIfAllAttemptsRun: mean(
      best.seq.reduce((sum, id) => sum + singles.get(id).total, 0n),
    ),
    bestSingle,
    candidates: candidates.length,
    cascadesEvaluated: count,
    taskRef: task,
    fit: {
      origin: "paired verified first attempts",
      cohort: exact ? "exact-task" : "shared-workload",
      n: tasks.length,
      verifiedFields: ["passed"],
      operatorReportedFields: ["model", "cost", "workload", "task"],
    },
  };
  return feasible
    ? result
    : {
        ok: false,
        feasible,
        budgetMet,
        targetMet,
        minimumExpectedCost: result.minimumExpectedCost,
        reason: "No measured route satisfies the requested budget or lower confidence bound",
        fallback: result,
      };
}

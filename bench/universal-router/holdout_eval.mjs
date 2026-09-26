#!/usr/bin/env node
// Held-out replay of the universal router on public SWE-bench Verified outcomes (review E3,
// stage 1), run entirely from this repository.
//
// This is NOT harness-bench run 4. That experiment's 150/350 split ids, pre-registration and
// metric code live in harness-bench, not here, so its headline (76.3% solved at $0.093 per task)
// is neither reproduced nor tested by this script. This is a separate experiment with its own
// seeded split of the same 500 tasks.
//
//   node bench/universal-router/holdout_eval.mjs <input.json> --out <results.json>
//     [--seed 20260926] [--dev 150] [--draws 10000] [--objective match-best-single] [--max-depth 3]
//
// <input.json> is what build_input.py writes. The steps:
//  1. Split. Shuffle the task ids (input order: instance_id ascending) with a Fisher-Yates
//     shuffle driven by mulberry32(seed). The first --dev ids are dev, the rest are held out.
//     Both id lists go into the output.
//  2. Fit on dev only: buildPrior(input, devIds). The shipped all-500 prior is never used.
//  3. Baselines, each chosen on dev outcomes only: the single model that solved the most dev
//     tasks; the single model with the lowest dev mean cost; and the fixed cascade (up to
//     --max-depth models) with the lowest dev mean cost among those that solve at least as many
//     dev tasks as that best single model (the router's match-best-single objective applied to
//     dev outcomes).
//  4. Replay each held-out task. routeUniversal() picks a cascade with the dev fit, over a
//     registry restricted to the fitted models. The cascade, and each baseline, is then played
//     on the recorded outcomes: try the models in order until one resolved the task. Its cost
//     is the sum of the recorded costs of the attempted models. A failed attempt recorded at
//     cost 0 costs 0 and is counted.
//  5. Paired bootstrap over held-out tasks (seeded): 95% percentile intervals for the router's
//     solve-rate and mean-cost differences to each baseline.
//
// The replay assumes a perfect check between cascade attempts (the recorded SWE-bench label)
// that costs nothing. A real cascade needs its own verifier, which can be wrong and costs money.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeUniversal } from "../../src/router/index.js";
import { cascades } from "../../src/router/policy.js";
import { buildPrior } from "../../src/router/prior.js";
import { loadRegistry } from "../../src/router/registry.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const inputPath = args[0];
const outPath = opt("--out");
if (!inputPath || inputPath.startsWith("--") || !outPath) {
  console.error("usage: holdout_eval.mjs <input.json> --out <results.json> [--seed N] [--dev N]");
  process.exit(2);
}
const seed = Number(opt("--seed", 20260926)) >>> 0;
const nDev = Number(opt("--dev", 150));
const draws = Number(opt("--draws", 10000));
const objective = opt("--objective", "match-best-single");
const maxDepth = Number(opt("--max-depth", 3));

const t0 = Date.now();

// The code this run loaded, recorded before anything else happens: the router's source files
// and the rubric (sha256, CRLF read as LF), the git HEAD, and any uncommitted change to them.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function codeState() {
  const files = [
    ...readdirSync(join(ROOT, "src/router"))
      .filter((f) => f.endsWith(".js"))
      .sort()
      .map((f) => `src/router/${f}`),
    "src/route.js",
    "data/models.json",
  ];
  const sha256 = Object.fromEntries(
    files.map((f) => {
      const text = readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
      return [f, `sha256:${createHash("sha256").update(text).digest("hex")}`];
    }),
  );
  const git = (...a) =>
    execFileSync("git", ["-C", ROOT, ...a], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  let gitHead = null;
  let uncommitted = null;
  try {
    gitHead = git("rev-parse", "HEAD");
    uncommitted =
      git("diff", "--stat", "HEAD", "--", "src/router", "src/route.js", "data/models.json") ||
      "none";
  } catch {}
  return { gitHead, uncommitted, sha256 };
}
const code = codeState();
const rawInput = readFileSync(inputPath);
const input = JSON.parse(rawInput.toString("utf8"));
const taskIds = input.tasks.map((t) => t.id);
const textOf = new Map(input.tasks.map((t) => [t.id, t.text]));
if (!(Number.isInteger(nDev) && nDev > 0 && nDev < taskIds.length))
  throw new Error(`--dev must be an integer in 1..${taskIds.length - 1}`);
if (!(Number.isInteger(draws) && draws > 0)) throw new Error("--draws must be a positive integer");
if (!(Number.isInteger(maxDepth) && maxDepth > 0))
  throw new Error("--max-depth must be a positive integer");

/** mulberry32: a small, well-known 32-bit PRNG; one seed gives one stream on every platform. */
function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. Split.
const shuffled = taskIds.slice();
const splitRand = mulberry32(seed);
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(splitRand() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
const devSet = new Set(shuffled.slice(0, nDev));
const dev = taskIds.filter((id) => devSet.has(id));
const heldOut = taskIds.filter((id) => !devSet.has(id));

// 2. Fit on dev only.
const registry = loadRegistry(null);
const models = Object.keys(input.outcomes).filter((id) => registry.models.some((m) => m.id === id));
const restricted = {
  models: registry.models.filter((m) => models.includes(m.id)),
  sources: registry.sources,
};
const tFit = Date.now();
const fit = buildPrior(input, devSet);
const fitSeconds = (Date.now() - tFit) / 1000;
if (fit.provenance.tasks !== dev.length) throw new Error("dev fit saw tasks outside the dev set");

// Play a model sequence on one task's recorded outcomes.
function play(seq, id) {
  let cost = 0;
  let zeroCostFailed = 0;
  for (let i = 0; i < seq.length; i++) {
    const o = input.outcomes[seq[i]]?.[id];
    if (!o || !Number.isFinite(o.cost))
      throw new Error(`no recorded outcome for ${seq[i]} on ${id}`);
    cost += o.cost;
    if (o.resolved) return { solved: 1, cost, attempts: i + 1, zeroCostFailed };
    if (o.cost === 0) zeroCostFailed++;
  }
  return { solved: 0, cost, attempts: seq.length, zeroCostFailed };
}

function summarize(rows) {
  const n = rows.length;
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const solved = sum("solved");
  const totalCost = sum("cost");
  return {
    tasks: n,
    solved,
    solveRate: solved / n,
    meanCost: totalCost / n,
    costPerSolved: solved ? totalCost / solved : null,
    totalCost,
    meanAttempts: sum("attempts") / n,
    zeroCostFailedAttempts: sum("zeroCostFailed"),
  };
}
const playAll = (seq, ids) => ids.map((id) => play(seq, id));
const bySeq = (a, b) => (a.seq.join(" ") < b.seq.join(" ") ? -1 : 1);

// 3. Baselines, chosen on dev outcomes only.
const devSingles = models.map((m) => ({ seq: [m], ...summarize(playAll([m], dev)) }));
const bestSingle = devSingles
  .slice()
  .sort((a, b) => b.solved - a.solved || a.totalCost - b.totalCost || bySeq(a, b))[0];
const cheapestSingle = devSingles
  .slice()
  .sort((a, b) => a.totalCost - b.totalCost || b.solved - a.solved || bySeq(a, b))[0];
let bestFixedCascade = null;
let cascadesConsidered = 0;
for (const seq of cascades(models, maxDepth)) {
  cascadesConsidered++;
  const s = { seq, ...summarize(playAll(seq, dev)) };
  if (s.solved < bestSingle.solved) continue;
  const c = bestFixedCascade;
  if (
    !c ||
    s.totalCost < c.totalCost ||
    (s.totalCost === c.totalCost &&
      (s.solved > c.solved || (s.solved === c.solved && seq.length < c.seq.length)))
  )
    bestFixedCascade = s;
}

// 4. Router replay on held-out tasks.
const decisions = heldOut.map((id) => {
  const r = routeUniversal(null, textOf.get(id), {
    model: fit,
    registry: restricted,
    objective,
    maxDepth,
  });
  // A target or budget no cascade can meet comes back as ok:false with the least-bad cascade
  // as `fallback` (match-best-single is always feasible). The replay runs that fallback and
  // counts the task as infeasible.
  const pick = r.ok ? r : r.fallback;
  if (!pick?.cascade) throw new Error(`router gave no cascade for ${id}: ${r.reason}`);
  const seq = pick.cascade.map((c) => c.model);
  return {
    id,
    cascade: seq,
    feasible: Boolean(r.ok),
    pSuccess: pick.pSuccess,
    expectedCost: pick.expectedCost,
    ...play(seq, id),
  };
});
const infeasible = decisions.filter((d) => !d.feasible).length;

const policies = {
  router: decisions,
  bestSingle: playAll(bestSingle.seq, heldOut),
  cheapestSingle: playAll(cheapestSingle.seq, heldOut),
  bestFixedCascade: playAll(bestFixedCascade.seq, heldOut),
};
const baselines = ["bestSingle", "cheapestSingle", "bestFixedCascade"];

// 5. Paired bootstrap over held-out tasks.
const bootSeed = (seed ^ 0x9e3779b9) >>> 0;
const bootRand = mulberry32(bootSeed);
const n = heldOut.length;
const cols = Object.fromEntries(
  Object.entries(policies).map(([k, rows]) => [
    k,
    {
      solved: Float64Array.from(rows, (r) => r.solved),
      cost: Float64Array.from(rows, (r) => r.cost),
    },
  ]),
);
const samples = Object.fromEntries(
  baselines.map((b) => [
    b,
    {
      dSolve: new Float64Array(draws),
      dCost: new Float64Array(draws),
      ratio: new Float64Array(draws),
    },
  ]),
);
const names = Object.keys(policies);
const sums = Object.fromEntries(names.map((k) => [k, { solved: 0, cost: 0 }]));
for (let d = 0; d < draws; d++) {
  for (const k of names) {
    sums[k].solved = 0;
    sums[k].cost = 0;
  }
  for (let i = 0; i < n; i++) {
    const j = Math.floor(bootRand() * n);
    for (const k of names) {
      sums[k].solved += cols[k].solved[j];
      sums[k].cost += cols[k].cost[j];
    }
  }
  for (const b of baselines) {
    samples[b].dSolve[d] = (sums.router.solved - sums[b].solved) / n;
    samples[b].dCost[d] = (sums.router.cost - sums[b].cost) / n;
    samples[b].ratio[d] = sums.router.cost / sums[b].cost;
  }
}
/** Percentile with linear interpolation between order statistics (numpy's default). */
function quantile(sorted, q) {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo] + (h - lo) * (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]);
}
const interval = (estimate, arr) => {
  const s = Float64Array.from(arr).sort();
  return { estimate, ci95: [quantile(s, 0.025), quantile(s, 0.975)] };
};
const heldOutSummary = Object.fromEntries(names.map((k) => [k, summarize(policies[k])]));
const comparisons = Object.fromEntries(
  baselines.map((b) => {
    const r = heldOutSummary.router;
    const x = heldOutSummary[b];
    // Paired discordant tasks: with only a handful, the bootstrap interval says little.
    let routerOnly = 0;
    let baselineOnly = 0;
    for (let i = 0; i < n; i++) {
      if (cols.router.solved[i] > cols[b].solved[i]) routerOnly++;
      else if (cols.router.solved[i] < cols[b].solved[i]) baselineOnly++;
    }
    return [
      b,
      {
        solveRateDelta: interval(r.solveRate - x.solveRate, samples[b].dSolve),
        meanCostDelta: interval(r.meanCost - x.meanCost, samples[b].dCost),
        meanCostRatio: interval(r.meanCost / x.meanCost, samples[b].ratio),
        solvedByOnlyOne: { router: routerOnly, baseline: baselineOnly },
      },
    ];
  }),
);

// Calibration of the router's own predictions for the cascades it chose (quintiles of pSuccess).
const byP = decisions.slice().sort((a, b) => a.pSuccess - b.pSuccess);
const mean = (rows, f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
const calibration = {
  meanPredictedSuccess: mean(decisions, (r) => r.pSuccess),
  observedSolveRate: heldOutSummary.router.solveRate,
  brier: mean(decisions, (r) => (r.pSuccess - r.solved) ** 2),
  meanExpectedCost: mean(decisions, (r) => r.expectedCost),
  meanObservedCost: heldOutSummary.router.meanCost,
  quintiles: [0, 1, 2, 3, 4].map((q) => {
    const rows = byP.slice(Math.round((q * n) / 5), Math.round(((q + 1) * n) / 5));
    return {
      tasks: rows.length,
      predicted: mean(rows, (r) => r.pSuccess),
      observed: mean(rows, (r) => r.solved),
      expectedCost: mean(rows, (r) => r.expectedCost),
      observedCost: mean(rows, (r) => r.cost),
    };
  }),
};

// What the router chose.
const tally = (f) => {
  const m = new Map();
  for (const r of decisions) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
const composition = {
  cascadeLength: tally((r) => r.cascade.length),
  firstModel: tally((r) => r.cascade[0]),
  cascades: tally((r) => r.cascade.join(" > ")),
};

// Per-repository slices (held-out only; small slices are noisy).
const repoOf = (id) => id.split("__")[0];
const repos = [...new Set(heldOut.map(repoOf))].sort();
const perRepository = repos.map((repo) => {
  const idx = heldOut.map((id, i) => (repoOf(id) === repo ? i : -1)).filter((i) => i >= 0);
  const slice = (k) => {
    const s = summarize(idx.map((i) => policies[k][i]));
    return { solveRate: s.solveRate, meanCost: s.meanCost };
  };
  return { repo, tasks: idx.length, ...Object.fromEntries(names.map((k) => [k, slice(k)])) };
});

const cpu = cpus();
const result = {
  experiment:
    "holdout_eval.mjs: in-repo held-out replay of the universal router on SWE-bench Verified " +
    "outcomes (review E3, stage 1)",
  notTheHeadline:
    "A new seeded split made by this script. It is not harness-bench run 4, whose split ids, " +
    "pre-registration and metric code are not in this repository, so it neither reproduces " +
    "nor tests the 76.3% / $0.093 headline.",
  assumptions: [
    "Each model's single recorded attempt per task (mini-SWE-agent 2.0.0, February 2026 costs) " +
      "stands for any attempt of that model on that task.",
    "A cascade stops at the first attempt whose recorded SWE-bench label is resolved: a perfect " +
      "check between attempts, with no verification cost.",
    "The router sees only the task text (problem_statement); labels and costs are used only " +
      "to fit on dev and to score held-out decisions.",
  ],
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${platform()}-${arch()}`,
    cpu: cpu[0]?.model ?? null,
    cpus: cpu.length,
  },
  code,
  input: {
    path: inputPath,
    sha256: createHash("sha256").update(rawInput).digest("hex"),
    source: input.source ?? null,
    tasks: taskIds.length,
    models,
  },
  split: {
    seed,
    prng: "mulberry32",
    method:
      "Fisher-Yates shuffle of the task ids in input order (instance_id ascending); " +
      "the first `dev` ids are dev, the rest held out. Id lists are in input order.",
    dev: { tasks: dev.length, ids: dev },
    heldOut: { tasks: heldOut.length, ids: heldOut },
  },
  fit: {
    seconds: fitSeconds,
    tasks: fit.provenance.tasks,
    outcomes: fit.provenance.outcomes,
    k: fit.mirt.k,
    scale: fit.selection.chosen.scale,
    selection: fit.selection,
  },
  policy: { objective, maxDepth, candidates: models.length, infeasibleTasks: infeasible },
  devSelection: {
    singles: devSingles,
    bestSingle: bestSingle.seq,
    cheapestSingle: cheapestSingle.seq,
    bestFixedCascade: bestFixedCascade.seq,
    bestFixedCascadeDev: bestFixedCascade,
    cascadesConsidered,
  },
  heldOut: {
    ...heldOutSummary,
    singles: Object.fromEntries(models.map((m) => [m, summarize(playAll([m], heldOut))])),
  },
  bootstrap: {
    draws,
    seed: bootSeed,
    method: "paired: resample held-out tasks with replacement; percentile 95% intervals",
    router_minus: comparisons,
  },
  calibration,
  composition,
  perRepository,
  perTask: decisions,
  elapsedSeconds: (Date.now() - t0) / 1000,
};
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

const pct = (v) => `${(100 * v).toFixed(1)}%`;
const usd = (v) => `$${v.toFixed(3)}`;
const line = (name, s, seq) =>
  `  ${name.padEnd(20)} ${pct(s.solveRate).padStart(6)} solved  ${usd(s.meanCost)}/task  ` +
  `${s.costPerSolved === null ? "-" : usd(s.costPerSolved)}/solved${seq ? `  [${seq.join(" > ")}]` : ""}`;
console.log(
  `holdout_eval (NOT the harness-bench split): seed ${seed}, dev ${dev.length} / held-out ${n}, ` +
    `fit k=${fit.mirt.k} scale=${fit.selection.chosen.scale} in ${fitSeconds.toFixed(1)}s`,
);
if (infeasible)
  console.log(
    `  ${objective}: infeasible on ${infeasible} tasks (their fallback cascade was replayed)`,
  );
console.log(line("router", heldOutSummary.router));
console.log(line("best single (dev)", heldOutSummary.bestSingle, bestSingle.seq));
console.log(line("cheapest (dev)", heldOutSummary.cheapestSingle, cheapestSingle.seq));
console.log(line("fixed cascade (dev)", heldOutSummary.bestFixedCascade, bestFixedCascade.seq));
for (const b of baselines) {
  const c = comparisons[b];
  const pp = (v) => `${(100 * v).toFixed(1)}`;
  console.log(
    `  router - ${b}: solve ${pp(c.solveRateDelta.estimate)} pp ` +
      `[${pp(c.solveRateDelta.ci95[0])}, ${pp(c.solveRateDelta.ci95[1])}], ` +
      `cost ${c.meanCostDelta.estimate.toFixed(3)} [${c.meanCostDelta.ci95[0].toFixed(3)}, ` +
      `${c.meanCostDelta.ci95[1].toFixed(3)}] $/task; solved by only one: ` +
      `router ${c.solvedByOnlyOne.router}, ${b} ${c.solvedByOnlyOne.baseline}`,
  );
}
console.log(`wrote ${outPath} in ${result.elapsedSeconds.toFixed(1)}s`);

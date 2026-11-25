// Predict the next completed CI outcome using only evidence available when that run started.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DEFAULT_HALF_LIFE_DAYS, isDormant, outcomeRecord, val } from "../../src/ledger.js";

const cutoff = Date.parse("2026-10-01T00:00:00Z") / 1000;
const end = Date.parse("2026-11-24T00:00:00Z") / 1000;
const day = (sec) => Math.floor(sec / 86400);
const file = new URL("./ledger-ci.tsv", import.meta.url);
const cohort = process.argv[2] ?? "master";
if (!["master", "pr"].includes(cohort)) throw new Error("Choose master or pr");
const records = readFileSync(file, "utf8")
  .trimEnd()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [started, completed, workflow, run, sha, conclusion] = line.split("\t");
    if (
      !/^[a-f0-9]{40}$/.test(sha) ||
      !["success", "failure"].includes(conclusion) ||
      !(+completed >= +started && +completed < end)
    )
      throw new Error("Invalid archived CI outcome");
    return {
      started: +started,
      completed: +completed,
      workflow,
      run,
      sha,
      success: Number(conclusion === "success"),
    };
  })
  .filter((r) => r.workflow.startsWith("pr-") === (cohort === "pr"))
  .sort((a, b) => a.started - b.started || Number(a.run) - Number(b.run));

if (cohort === "master") {
  const shas = [...new Set(records.map((r) => r.sha))];
  const objects = execFileSync("git", ["cat-file", "--batch-check=%(objecttype)"], {
    cwd: new URL("../../", import.meta.url),
    input: shas.join("\n") + "\n",
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  if (objects.length !== shas.length || objects.some((type) => type !== "commit"))
    throw new Error("Run the benchmark in a clone containing the archived default-branch commits");
}

const seen = new Set();
const events = records
  .filter((r) => {
    const key = r.workflow + "/" + r.sha;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .map((r) => {
    const evidence = (ref) =>
      outcomeRecord({
        oracle: "ci.run",
        result: r.success ? "confirm" : "contradict",
        author: "github-actions",
        ref,
        t: day(r.completed),
      }).outcome;
    return {
      ...r,
      resolved: evidence(
        cohort === "master" ? "git:" + r.sha : "ci:CodeWithJuber/forgekit@" + r.run,
      ),
      locator: evidence("ci:CodeWithJuber/forgekit@" + r.run),
    };
  });

function score(rows, field) {
  if (!rows.length) return null;
  const mean = (fn) => rows.reduce((total, r) => total + fn(r), 0) / rows.length;
  return {
    n: rows.length,
    rate: mean((r) => r.y),
    forecast: mean((r) => r[field]),
    bias: mean((r) => r[field] - r.y),
    brier: mean((r) => (r[field] - r.y) ** 2),
  };
}

const workflows = [...new Set(events.map((r) => r.workflow))].sort();
const forecasts = [],
  retention = [];
for (const workflow of workflows) {
  const stream = events
    .filter((r) => r.workflow === workflow)
    .sort((a, b) => a.completed - b.completed || Number(a.run) - Number(b.run));
  const priorAt = (start) => stream.filter((r) => r.completed < start);
  for (const event of stream.filter((e) => e.started >= cutoff)) {
    const history = priorAt(event.started);
    const at = day(event.started),
      claim = { evidence: history.map((r) => r.resolved) };
    const locators = { evidence: history.map((r) => r.locator) };
    forecasts.push({
      workflow,
      week: Math.floor(at / 7),
      nPrior: history.length,
      y: event.success,
      decay: val(claim, at),
      flat: val(claim, at, { halfLife: Infinity }),
      last: val({ evidence: claim.evidence.slice(-1) }, at),
      prior: val({ evidence: [] }, at),
      locator: val(locators, at),
      locatorFlat: val(locators, at, { halfLife: Infinity }),
    });
  }
  for (const [point, at] of [
    ["start", cutoff],
    ["end", end],
  ]) {
    const claim = { evidence: priorAt(at).map((r) => r.resolved) };
    if (!claim.evidence.length) continue;
    retention.push({
      workflow,
      point,
      evidence: claim.evidence.length,
      decay: !isDormant(claim, day(at)),
      flat: !isDormant(claim, day(at), { halfLife: Infinity }),
    });
  }
}

// Resample whole seven-day blocks so correlated workflows and repeated runs stay together.
const weeks = [...new Set(forecasts.map((r) => r.week))];
const blocks = weeks.map((w) => forecasts.filter((r) => r.week === w));
let seed = 263;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const deltas = Array.from({ length: 2000 }, () => {
  const rows = blocks.flatMap(() => blocks[Math.floor(next() * blocks.length)]);
  return score(rows, "decay").brier - score(rows, "flat").brier;
}).sort((a, b) => a - b);

const sparse = forecasts.filter((r) => r.nPrior <= 1);
console.log(
  JSON.stringify(
    {
      cohort,
      streams: workflows.length,
      halfLife: DEFAULT_HALF_LIFE_DAYS,
      input: records.length,
      unique: events.length,
      heldOutWeeks: weeks.length,
      sparse: { n: sparse.length, decay: score(sparse, "decay"), flat: score(sparse, "flat") },
      scores: Object.fromEntries(
        ["decay", "flat", "last", "prior", "locator", "locatorFlat"].map((name) => [
          name,
          score(forecasts, name),
        ]),
      ),
      byWorkflow:
        cohort === "pr"
          ? undefined
          : Object.fromEntries(
              workflows.map((w) => [
                w,
                {
                  decay: score(
                    forecasts.filter((r) => r.workflow === w),
                    "decay",
                  ),
                  flat: score(
                    forecasts.filter((r) => r.workflow === w),
                    "flat",
                  ),
                },
              ]),
            ),
      brierDifference95: [
        deltas[Math.floor(0.025 * deltas.length)],
        deltas[Math.ceil(0.975 * deltas.length) - 1],
      ],
      retention: ["start", "end"].map((point) => {
        const rows = retention.filter((r) => r.point === point);
        return {
          point,
          histories: rows.length,
          decay: rows.filter((r) => r.decay).length,
          flat: rows.filter((r) => r.flat).length,
        };
      }),
    },
    null,
    2,
  ),
);

// Offline, paired release decision. A frozen plan pins task definitions, controls
// and both configurations. Neither a template nor a simulation is a measured run.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import {
  blankCostSuite,
  costMetadata,
  costTask,
  costWorksheet,
  evaluateCostPilot,
} from "./cost_pilot.js";
import { hasSecret } from "./secrets.js";

// The v1 thresholds remain part of the hash-compatible historical protocol.
const legacyTargets = { speedGainPct: 20, qualityGainPoints: 10 };
const MIN_TASKS = 20;
const fields = [
  "seconds",
  "costUsd",
  "tokens",
  "toolCalls",
  "newDuplicates",
  "wrongPackages",
  "quality",
];
const nonnegativeInteger = (v) => Number.isSafeInteger(v) && v >= 0;
function value(s, name, max = 500) {
  if (
    typeof s !== "string" ||
    !s.trim() ||
    s.length > max ||
    /[\p{Cc}\p{Cf}]/u.test(s) ||
    hasSecret(s)
  )
    throw new Error(`Expected a short, non-secret ${name}`);
  return s.trim();
}

// Canonical reconstruction makes whitespace and JSON key order immaterial.
export function freezeSuite(raw) {
  if (
    ![1, 2].includes(raw?.version) ||
    !Array.isArray(raw.tasks) ||
    raw.tasks.length < MIN_TASKS ||
    raw.tasks.length > 1000
  )
    throw new Error("A frozen suite must have 20–1000 tasks and a supported protocol version");
  const ids = new Set();
  const cost = raw.purpose === "cost";
  const tasks = raw.tasks
    .map((t) => {
      const id = value(t?.id, "task ID", 80);
      if (ids.has(id)) throw new Error(`Duplicate task ID ${id}`);
      ids.add(id);
      return {
        id,
        repo: value(t.repo, "repository"),
        revision: cost ? t.revision : value(t.revision, "frozen revision"),
        ...(cost ? costTask(t) : {}),
        task: value(t.task, "task"),
        acceptance: value(t.acceptance, "executable acceptance or grading rubric"),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (
    cost &&
    new Set(tasks.map((t) => JSON.stringify([t.repo, t.revision, t.task, t.acceptance]))).size !==
      tasks.length
  )
    throw new Error("Duplicate frozen cost workload");
  if (!["parallel", "routing", "context", "cost"].includes(raw.purpose))
    throw new Error("Choose a parallel, routing, context or cost evaluation");
  let targets;
  if (raw.version === 2 && raw.purpose === "parallel") {
    const { speedGainPct, qualityGainPoints } = raw.targets ?? {};
    if (![speedGainPct, qualityGainPoints].every((n) => Number.isFinite(n) && n > 0 && n <= 100))
      throw new Error("Freeze positive speedGainPct and qualityGainPoints targets of at most 100");
    targets = { speedGainPct, qualityGainPoints };
  } else if (raw.targets !== undefined)
    throw new Error("Custom targets require a version 2 parallel study");
  const spec = {
    version: raw.version,
    purpose: raw.purpose,
    ...(targets ? { targets } : {}),
    baseline: value(raw.baseline, "baseline configuration"),
    candidate: value(raw.candidate, "candidate configuration"),
    controls: value(raw.controls, "fixed host, model, permissions and test conditions"),
    ...(cost ? { pilot: costMetadata(raw, value) } : {}),
    tasks,
  };
  if (spec.baseline === spec.candidate) throw new Error("The two named configurations must differ");
  const hash = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
  return { spec, hash };
}

function checkMeasurement(m) {
  if (
    !m ||
    typeof m.accepted !== "boolean" ||
    fields.some((f) => typeof m[f] !== "number" || !Number.isFinite(m[f]) || m[f] < 0) ||
    ["tokens", "toolCalls", "newDuplicates", "wrongPackages"].some(
      (f) => !nonnegativeInteger(m[f]),
    ) ||
    m.seconds <= 0 ||
    m.quality > 100
  )
    throw new Error(
      "Each arm needs observed acceptance, positive wall seconds, cost, counts and 0–100 quality",
    );
  return {
    ...Object.fromEntries(fields.map((f) => [f, m[f]])),
    seconds: m.seconds,
    quality: m.quality,
    accepted: m.accepted,
    evidence: value(m.evidence, "log or run reference"),
  };
}

function checkFrozen(frozen) {
  const result = freezeSuite(frozen?.spec);
  if (result.hash !== frozen.hash)
    throw new Error("The frozen suite hash does not match its contents");
  return result;
}

// Exact one-sided paired sign test under independent, exchangeable non-tied pairs.
// Summing binomial mass by recurrence avoids factorial overflow.
function pairedSigns(wins, losses, total) {
  const n = wins + losses;
  let mass = 2 ** -n,
    upper = 0;
  for (let k = 0; k <= n - wins; k++) {
    upper += mass;
    mass *= (n - k) / (k + 1);
  }
  return { wins, losses, ties: total - n, pOneSided: n ? Math.min(1, upper) : null };
}

export function evaluateRollout(frozen, result) {
  const { spec, hash } = checkFrozen(frozen);
  if (spec.purpose === "cost") return evaluateCostPilot(spec, hash, result, value);
  if (result?.suiteHash !== hash)
    throw new Error("Run measurements belong to a different frozen suite");
  if (
    !["observed", "simulation"].includes(result.source) ||
    !Array.isArray(result.runs) ||
    result.runs.length !== spec.tasks.length
  )
    throw new Error("Supply observed or simulation results for every frozen task exactly once");
  const byId = new Map();
  for (const row of result.runs) {
    if (byId.has(row?.id)) throw new Error("Duplicate measured task ID");
    byId.set(row?.id, row);
  }
  const totals = () => Object.fromEntries([...fields, "accepted"].map((f) => [f, 0]));
  const baseline = totals(),
    candidate = totals(),
    regressions = [];
  let faster = 0,
    higherQuality = 0,
    slower = 0,
    lowerQuality = 0;
  for (const { id } of spec.tasks) {
    const row = byId.get(id);
    if (!row) throw new Error(`Missing measurements for ${id}`);
    const a = checkMeasurement(row.baseline),
      b = checkMeasurement(row.candidate);
    if (a.evidence === b.evidence)
      throw new Error(
        `Use distinct arm evidence locators for ${id} (a shared log can use two line numbers)`,
      );
    for (const f of fields) {
      baseline[f] += a[f];
      candidate[f] += b[f];
    }
    baseline.accepted += Number(a.accepted);
    candidate.accepted += Number(b.accepted);
    if (a.accepted && !b.accepted) regressions.push(id);
    if (b.seconds < a.seconds) faster++;
    if (b.quality > a.quality) higherQuality++;
    if (b.seconds > a.seconds) slower++;
    if (b.quality < a.quality) lowerQuality++;
  }
  const n = spec.tasks.length,
    timeSavedPct = (100 * (baseline.seconds - candidate.seconds)) / baseline.seconds;
  const qualityDelta = (candidate.quality - baseline.quality) / n;
  baseline.quality /= n;
  candidate.quality /= n;
  const qualityHeld = qualityDelta >= 0 && !regressions.length;
  const targets = spec.targets ?? legacyTargets;
  const checks = {
    speedThreshold: timeSavedPct >= targets.speedGainPct,
    qualityThreshold: qualityDelta >= targets.qualityGainPoints,
    qualityHeld,
    costReduced: candidate.costUsd < baseline.costUsd,
    tokenVolumeReduced: candidate.tokens < baseline.tokens,
    acceptanceRegressions: regressions,
    wrongPackageCount: candidate.wrongPackages,
    newDuplicateCount: candidate.newDuplicates,
  };
  const meetsTarget =
    spec.purpose === "parallel"
      ? (checks.speedThreshold || checks.qualityThreshold) && !regressions.length
      : spec.purpose === "routing"
        ? checks.costReduced && qualityHeld
        : checks.tokenVolumeReduced && qualityHeld;
  const eligible = meetsTarget && candidate.wrongPackages === 0;
  return {
    suiteHash: hash,
    tasks: n,
    source: result.source,
    purpose: spec.purpose,
    verdict:
      result.source === "simulation" ? "simulation-only" : eligible ? "eligible" : "keep-baseline",
    meetsTarget,
    checks,
    baseline,
    candidate,
    timeSavedPct,
    qualityDelta,
    pairedSigns: {
      speed: pairedSigns(faster, slower, n),
      quality: pairedSigns(higherQuality, lowerQuality, n),
    },
    ...(spec.purpose === "parallel" ? { targets } : {}),
    fasterTasks: faster,
    higherQualityTasks: higherQuality,
  };
}

const blankSpec = () => ({
  version: 1,
  purpose: "parallel",
  baseline: "single lead",
  candidate: "lead plus specialists",
  controls: "",
  tasks: Array.from({ length: MIN_TASKS }, (_, i) => ({
    id: `T${String(i + 1).padStart(2, "0")}`,
    repo: "",
    revision: "",
    task: "",
    acceptance: "",
  })),
});
function load(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("Evaluation input must be a JSON file of at most 4 MiB");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
function save(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(path);
}

export function rolloutCommand(args, purpose = "parallel") {
  const [action, input, output] = args;
  if (action === "init" && args.length === 2)
    return save(
      input,
      purpose === "cost"
        ? blankCostSuite(blankSpec())
        : { ...blankSpec(), version: 2, targets: { speedGainPct: null, qualityGainPoints: null } },
    );
  if (action === "freeze" && args.length === 3) {
    const raw = load(input);
    if (purpose === "cost" && raw.purpose !== "cost") throw new Error("Use a frozen cost pilot");
    return save(output, freezeSuite(raw));
  }
  if (action === "template" && args.length === 3) {
    const { spec, hash } = checkFrozen(load(input));
    if (spec.purpose === "cost") return save(output, costWorksheet({ spec, hash }));
    if (purpose === "cost") throw new Error("Use a frozen cost pilot");
    const blank = Object.fromEntries([...fields, "accepted", "evidence"].map((f) => [f, null]));
    return save(output, {
      suiteHash: hash,
      source: "observed",
      runs: spec.tasks.map((t) => ({ id: t.id, baseline: { ...blank }, candidate: { ...blank } })),
    });
  }
  if (action === "compare" && args.length === 3) {
    const frozen = load(input);
    if (purpose === "cost" && frozen?.spec?.purpose !== "cost")
      throw new Error("Use a frozen cost pilot");
    console.log(JSON.stringify(evaluateRollout(frozen, load(output)), null, 2));
    return;
  }
  const command = purpose === "cost" ? "forge cost pilot" : "forge team evaluate";
  throw new Error(
    `Use ${command} init <suite>, freeze <suite> <frozen>, template <frozen> <runs>, or compare <frozen> <runs>`,
  );
}

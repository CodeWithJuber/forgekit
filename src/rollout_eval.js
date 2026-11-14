// Offline, paired release decision. A frozen plan pins task definitions, controls
// and both configurations. Neither a template nor a simulation is a measured run.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hasSecret } from "./secrets.js";

const VERSION = 1;
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
    raw?.version !== VERSION ||
    !Array.isArray(raw.tasks) ||
    raw.tasks.length < MIN_TASKS ||
    raw.tasks.length > 1000
  )
    throw new Error("A frozen suite must have 20–1000 tasks and version 1");
  const ids = new Set();
  const tasks = raw.tasks
    .map((t) => {
      const id = value(t?.id, "task ID", 80);
      if (ids.has(id)) throw new Error(`Duplicate task ID ${id}`);
      ids.add(id);
      return {
        id,
        repo: value(t.repo, "repository"),
        revision: value(t.revision, "frozen revision"),
        task: value(t.task, "task"),
        acceptance: value(t.acceptance, "executable acceptance or grading rubric"),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!["parallel", "routing", "context"].includes(raw.purpose))
    throw new Error("Choose a parallel, routing or context evaluation");
  const spec = {
    version: VERSION,
    purpose: raw.purpose,
    baseline: value(raw.baseline, "baseline configuration"),
    candidate: value(raw.candidate, "candidate configuration"),
    controls: value(raw.controls, "fixed host, model, permissions and test conditions"),
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

export function evaluateRollout(frozen, result) {
  const { spec, hash } = checkFrozen(frozen);
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
    higherQuality = 0;
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
  }
  const n = spec.tasks.length,
    timeSavedPct = (100 * (baseline.seconds - candidate.seconds)) / baseline.seconds;
  const qualityDelta = (candidate.quality - baseline.quality) / n;
  baseline.quality /= n;
  candidate.quality /= n;
  const qualityHeld = qualityDelta >= 0 && !regressions.length;
  const checks = {
    speedThreshold: timeSavedPct >= 20,
    qualityThreshold: qualityDelta >= 10,
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
    fasterTasks: faster,
    higherQualityTasks: higherQuality,
  };
}

const blankSpec = () => ({
  version: VERSION,
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
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(path);
}

export function rolloutCommand(args) {
  const [action, input, output] = args;
  if (action === "init" && args.length === 2) return save(input, blankSpec());
  if (action === "freeze" && args.length === 3) return save(output, freezeSuite(load(input)));
  if (action === "template" && args.length === 3) {
    const { spec, hash } = checkFrozen(load(input));
    const blank = Object.fromEntries([...fields, "accepted", "evidence"].map((f) => [f, null]));
    return save(output, {
      suiteHash: hash,
      source: "observed",
      runs: spec.tasks.map((t) => ({ id: t.id, baseline: { ...blank }, candidate: { ...blank } })),
    });
  }
  if (action === "compare" && args.length === 3) {
    console.log(JSON.stringify(evaluateRollout(load(input), load(output)), null, 2));
    return;
  }
  throw new Error(
    "Use forge team evaluate init <suite>, freeze <suite> <frozen>, template <frozen> <runs>, or compare <frozen> <runs>",
  );
}

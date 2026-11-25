// P8 compares observed spend across the same frozen workload and acceptance rubric.
import { createHash } from "node:crypto";

const strata = ["repeat-heavy", "mixed", "cold"];
const minPairs = 100;
const draws = 2000;
const arms = ["baseline", "candidate"];

const sha = (s) => typeof s === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
function requireField(ok, message) {
  if (!ok) throw new Error(message);
}

export function costMetadata(raw, text) {
  const p = raw.pilot;
  requireField(
    p?.consented === true && p.heldOut === true,
    "Freeze an operator-consented, held-out pilot",
  );
  requireField(sha(p.forgeRevision), "Record a complete ForgeKit revision");
  const margin = (x, max) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max;
  requireField(
    margin(p.qualityMarginPoints, 100) && margin(p.completionMargin, 1),
    "Set both noninferiority margins before freezing",
  );
  return {
    consented: true,
    consentRef: text(p.consentRef, "consent reference"),
    heldOut: true,
    selection: text(p.selection, "held-out workload selection"),
    forgeRevision: p.forgeRevision,
    billingScope: text(
      p.billingScope,
      "billing scope including retries, cached tokens, tools and verifier costs",
    ),
    qualityMarginPoints: p.qualityMarginPoints,
    completionMargin: p.completionMargin,
  };
}

export function costTask(t) {
  requireField(
    sha(t.revision) && strata.includes(t.stratum),
    "Cost pilot tasks need a full revision and repeat-heavy, mixed or cold stratum",
  );
  return { stratum: t.stratum };
}
export function blankCostSuite(base) {
  return {
    ...base,
    purpose: "cost",
    baseline: "current configuration",
    candidate: "proposed configuration",
    pilot: {
      consented: false,
      consentRef: "",
      heldOut: false,
      selection: "",
      forgeRevision: "",
      billingScope: "",
      qualityMarginPoints: 5,
      completionMargin: 0.05,
    },
    tasks: Array.from({ length: minPairs }, (_, i) => ({
      ...base.tasks[0],
      id: `T${String(i + 1).padStart(3, "0")}`,
      stratum: "",
    })),
  };
}
const fingerprint = (t) => createHash("sha256").update(JSON.stringify(t)).digest("hex");
export function costWorksheet({ spec, hash }) {
  return {
    suiteHash: hash,
    source: "observed",
    runId: "",
    billingDate: "",
    allAttempts: false,
    independentVerifier: false,
    runs: spec.tasks.map((t) => ({
      id: t.id,
      ...Object.fromEntries(
        arms.map((k) => [
          k,
          {
            config: spec[k],
            revision: t.revision,
            taskHash: fingerprint(t),
            status: null,
            quality: null,
            actualUsd: null,
            evidence: "",
            billingEvidence: "",
          },
        ]),
      ),
    })),
  };
}

// Chernoff bounds for means of independent [0,1] observations. Bounds remain
// informative when no discordant pair was observed, including at zero variance.
function boundedMean(p, n, upper) {
  if ((p === 0 && !upper) || (p === 1 && upper)) return p;
  let a = upper ? p : 0,
    b = upper ? 1 : p;
  const limit = Math.log(4 / 0.05) / n;
  for (let i = 0; i < 52; i++) {
    const q = (a + b) / 2;
    const d =
      (p > 0 ? p * Math.log(p / q) : 0) + (p < 1 ? (1 - p) * Math.log((1 - p) / (1 - q)) : 0);
    if (d < limit === upper) a = q;
    else b = q;
  }
  return upper ? b : a;
}
function pairedInterval(deltas, scale) {
  const n = deltas.length;
  const gain = deltas.reduce((s, x) => s + Math.max(x, 0) / scale, 0) / n;
  const loss = deltas.reduce((s, x) => s + Math.max(-x, 0) / scale, 0) / n;
  return {
    estimate: (gain - loss) * scale,
    lower: (boundedMean(gain, n, false) - boundedMean(loss, n, true)) * scale,
    upper: (boundedMean(gain, n, true) - boundedMean(loss, n, false)) * scale,
  };
}
function armSummary(pairs, k) {
  let verified = 0,
    abandoned = 0,
    knownSpendUsd = 0,
    missingBills = 0;
  for (const p of pairs) {
    const r = p[k];
    verified += Number(r.status === "verified");
    abandoned += Number(r.status === "abandoned");
    if (r.actualUsd === null) missingBills++;
    else knownSpendUsd += r.actualUsd;
  }
  return {
    tasks: pairs.length,
    verified,
    abandoned,
    verifiedRate: verified / pairs.length,
    abandonedRate: abandoned / pairs.length,
    missingBills,
    knownSpendUsd,
    totalSpendUsd: missingBills ? null : knownSpendUsd,
    usdPerVerified: !missingBills && verified ? knownSpendUsd / verified : null,
  };
}

// Paired stratified percentile bootstrap of total-cost / verified-count difference.
// Resample baseline and candidate together; all failed/abandoned attempts still cost money.
function costInterval(groups, hash) {
  let state = Number.parseInt(hash.slice(0, 8), 16);
  function random() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  }
  const baseline = [],
    candidate = [],
    difference = [];
  for (let i = 0; i < draws; i++) {
    let ba = 0,
      ca = 0,
      bv = 0,
      cv = 0;
    for (const group of groups)
      for (let j = 0; j < group.length; j++) {
        const { baseline: b, candidate: c } = group[Math.floor(random() * group.length)];
        ba += b.actualUsd;
        ca += c.actualUsd;
        bv += Number(b.status === "verified");
        cv += Number(c.status === "verified");
      }
    if (!bv || !cv) return null;
    baseline.push(ba / bv);
    candidate.push(ca / cv);
    difference.push(ca / cv - ba / bv);
  }
  function interval(values) {
    values.sort((a, b) => a - b);
    const quantile = (p) => {
      const at = (values.length - 1) * p,
        floor = Math.floor(at);
      return values[floor] + (at - floor) * (values[Math.ceil(at)] - values[floor]);
    };
    return { lower: quantile(0.025), upper: quantile(0.975), draws, unit: "USD per verified task" };
  }
  return {
    baseline: interval(baseline),
    candidate: interval(candidate),
    difference: interval(difference),
  };
}

export function evaluateCostPilot(spec, hash, result, text) {
  requireField(result?.suiteHash === hash, "Run measurements belong to a different frozen suite");
  requireField(
    ["observed", "simulation"].includes(result.source),
    "Use observed or simulation as the source",
  );
  const runId = text(result.runId, "run ID");
  requireField(
    /^\d{4}-\d{2}-\d{2}$/.test(result.billingDate) &&
      !Number.isNaN(Date.parse(result.billingDate)) &&
      new Date(result.billingDate).toISOString().slice(0, 10) === result.billingDate,
    "Record the ISO billing date",
  );
  requireField(
    result.allAttempts === true && result.independentVerifier === true,
    "Attest to complete attempts and an independent acceptance check",
  );
  requireField(
    Array.isArray(result.runs) && result.runs.length === spec.tasks.length,
    "Supply both arms of every frozen task",
  );
  const observations = new Map(result.runs.map((r) => [r?.id, r]));
  requireField(observations.size === result.runs.length, "Duplicate measured task ID");
  const evidence = new Set(),
    groups = strata.map(() => []),
    pairs = [];
  for (const t of spec.tasks) {
    const row = observations.get(t.id);
    requireField(row, `Missing frozen task ${t.id}`);
    for (const k of arms) {
      const r = row[k];
      requireField(
        r && r.config === spec[k] && r.revision === t.revision && r.taskHash === fingerprint(t),
        "Both arms must match frozen revision, task, rubric and configuration",
      );
      requireField(
        ["verified", "failed", "abandoned"].includes(r.status) &&
          Number.isFinite(r.quality) &&
          r.quality >= 0 &&
          r.quality <= 100,
        "Each outcome needs verifier status and a 0–100 quality score",
      );
      requireField(
        r.actualUsd === null ||
          (Number.isFinite(r.actualUsd) &&
            r.actualUsd >= 0 &&
            r.actualUsd <= Number.MAX_SAFE_INTEGER),
        "Use actual nonnegative USD or null for missing billing",
      );
      const ref = text(r.evidence, "distinct acceptance evidence");
      requireField(!evidence.has(ref), "Use distinct evidence for each task arm");
      evidence.add(ref);
      if (r.actualUsd !== null)
        text(r.billingEvidence, "billing reference including a measured zero");
    }
    groups[strata.indexOf(t.stratum)].push(row);
    pairs.push(row);
  }
  const baseline = armSummary(pairs, "baseline"),
    candidate = armSummary(pairs, "candidate");
  const completeBilling = !baseline.missingBills && !candidate.missingBills;
  const cost =
    completeBilling && baseline.verified && candidate.verified ? costInterval(groups, hash) : null;
  const quality = pairedInterval(
    pairs.map((r) => r.candidate.quality - r.baseline.quality),
    100,
  );
  const completion = pairedInterval(
    pairs.map(
      (r) => Number(r.candidate.status === "verified") - Number(r.baseline.status === "verified"),
    ),
    1,
  );
  const checks = {
    minimumTasks: pairs.length >= minPairs,
    allStrata: groups.every((g) => g.length > 0),
    completeBilling,
    qualityNoninferior: quality.lower >= -spec.pilot.qualityMarginPoints,
    completionNoninferior: completion.lower >= -spec.pilot.completionMargin,
    lowerCost: cost !== null && cost.difference.upper < 0,
  };
  return {
    schemaVersion: 1,
    purpose: "cost",
    suiteHash: hash,
    runId,
    source: result.source,
    billingDate: result.billingDate,
    currency: "USD",
    pilot: spec.pilot,
    controls: spec.controls,
    configurations: { baseline: spec.baseline, candidate: spec.candidate },
    tasks: pairs.length,
    strata: Object.fromEntries(strata.map((s, i) => [s, groups[i].length])),
    baseline: { ...baseline, usdPerVerifiedInterval: cost?.baseline ?? null },
    candidate: { ...candidate, usdPerVerifiedInterval: cost?.candidate ?? null },
    comparison: {
      qualityPoints: quality,
      completionRate: completion,
      costDifferenceUsdPerVerified: cost && {
        estimate: candidate.usdPerVerified - baseline.usdPerVerified,
        ...cost.difference,
      },
      intervalLevel: 0.95,
      healthMethod: "paired bounded gain/loss KL-Chernoff with Bonferroni tails",
      costMethod: "task-paired bootstrap within frozen workload strata",
    },
    checks,
    verdict:
      result.source === "simulation"
        ? "simulation-only"
        : Object.values(checks).every(Boolean)
          ? "eligible"
          : "keep-baseline",
  };
}

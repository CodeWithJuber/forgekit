export const DIMENSIONS = Object.freeze([
  "runtime",
  "contract",
  "verification",
  "docs",
  "config",
  "delivery",
  "merge",
]);

const ZERO = Object.freeze(Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0])));
const clamp01 = (value) =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? Number(value) : 0));
const vector = (value = {}) =>
  Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, clamp01(value[dimension] ?? 0)]));
const maxDimension = (value) =>
  Math.max(...DIMENSIONS.map((dimension) => value[dimension] ?? 0));

export const CHANGE_PROFILES = Object.freeze({
  formatting: vector({
    runtime: 0.005,
    contract: 0.005,
    verification: 0.03,
    docs: 0.01,
    config: 0.005,
    delivery: 0.02,
    merge: 0.02,
  }),
  comment: vector({
    runtime: 0.005,
    contract: 0.01,
    verification: 0.02,
    docs: 0.08,
    config: 0.005,
    delivery: 0.01,
    merge: 0.01,
  }),
  docs: vector({
    docs: 0.82,
    verification: 0.08,
    delivery: 0.08,
    merge: 0.03,
  }),
  test: vector({
    verification: 0.82,
    delivery: 0.08,
    merge: 0.04,
  }),
  logic: vector({
    runtime: 0.68,
    contract: 0.28,
    verification: 0.72,
    docs: 0.12,
    config: 0.1,
    delivery: 0.18,
    merge: 0.12,
  }),
  public_api: vector({
    runtime: 0.78,
    contract: 0.96,
    verification: 0.88,
    docs: 0.78,
    config: 0.18,
    delivery: 0.28,
    merge: 0.18,
  }),
  config: vector({
    runtime: 0.42,
    contract: 0.38,
    verification: 0.52,
    docs: 0.28,
    config: 0.92,
    delivery: 0.68,
    merge: 0.18,
  }),
  schema: vector({
    runtime: 0.78,
    contract: 0.94,
    verification: 0.86,
    docs: 0.62,
    config: 0.76,
    delivery: 0.7,
    merge: 0.2,
  }),
  dependency: vector({
    runtime: 0.72,
    contract: 0.62,
    verification: 0.68,
    docs: 0.34,
    config: 0.78,
    delivery: 0.84,
    merge: 0.16,
  }),
  generated: vector({
    runtime: 0.3,
    contract: 0.32,
    verification: 0.28,
    docs: 0.78,
    config: 0.4,
    delivery: 0.52,
    merge: 0.08,
  }),
  ci: vector({
    runtime: 0.16,
    contract: 0.12,
    verification: 0.58,
    docs: 0.12,
    config: 0.64,
    delivery: 0.94,
    merge: 0.12,
  }),
  security: vector({
    runtime: 0.76,
    contract: 0.72,
    verification: 0.94,
    docs: 0.42,
    config: 0.64,
    delivery: 0.72,
    merge: 0.2,
  }),
});

// Sparse transfer matrices. Rows are target dimensions and columns are source dimensions.
// A relation says how one consequence kind transforms into another at its dependent.
export const RELATION_MATRICES = Object.freeze({
  imports: {
    runtime: { runtime: 0.88, contract: 0.62, config: 0.35 },
    contract: { contract: 0.76 },
    verification: { runtime: 0.2, contract: 0.25, config: 0.2 },
    merge: { merge: 0.35 },
  },
  calls: {
    runtime: { runtime: 0.94, contract: 0.52 },
    contract: { contract: 0.5 },
    verification: { runtime: 0.24, contract: 0.24 },
    merge: { merge: 0.3 },
  },
  inherits: {
    runtime: { runtime: 0.92, contract: 0.72 },
    contract: { contract: 0.86 },
    verification: { runtime: 0.3, contract: 0.35 },
    docs: { contract: 0.14 },
  },
  verified_by: {
    verification: {
      runtime: 0.98,
      contract: 0.98,
      config: 0.9,
      delivery: 0.55,
      verification: 0.92,
    },
    merge: { merge: 0.15 },
  },
  documented_by: {
    docs: { contract: 0.96, runtime: 0.38, config: 0.55, docs: 0.92 },
    verification: { contract: 0.08, docs: 0.12 },
  },
  generates: {
    docs: { runtime: 0.92, contract: 0.72, config: 0.9, docs: 0.96 },
    delivery: { runtime: 0.38, config: 0.72, delivery: 0.7 },
    verification: { runtime: 0.18, config: 0.2 },
  },
  configures: {
    runtime: { config: 0.82, contract: 0.28 },
    contract: { config: 0.46, contract: 0.55 },
    verification: { config: 0.72 },
    config: { config: 0.94 },
    delivery: { config: 0.72, delivery: 0.5 },
  },
  publishes: {
    contract: { contract: 0.94, runtime: 0.32, config: 0.35 },
    docs: { contract: 0.72, docs: 0.65 },
    delivery: { contract: 0.38, config: 0.5, delivery: 0.84 },
    verification: { contract: 0.35, delivery: 0.3 },
  },
  workflow_uses: {
    verification: { runtime: 0.46, contract: 0.32, verification: 0.62, config: 0.62 },
    config: { config: 0.58 },
    delivery: { runtime: 0.32, contract: 0.22, config: 0.72, delivery: 0.94 },
  },
  registry_member: {
    runtime: { runtime: 0.42, contract: 0.42 },
    contract: { contract: 0.78, config: 0.35 },
    docs: { contract: 0.62, docs: 0.35 },
    verification: { contract: 0.32, config: 0.22 },
  },
  historical_coupling: Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, { [dimension]: 0.28 }]),
  ),
});

export function signalForChange(change = {}) {
  const base = CHANGE_PROFILES[change.kind] || CHANGE_PROFILES.logic;
  const lines = Math.max(1, Number(change.linesChanged ?? change.lines ?? 1) || 1);
  const size = Math.min(1, Math.log2(1 + lines) / 8);
  const scaled = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      clamp01(base[dimension] * (1 + 0.22 * size)),
    ]),
  );
  for (const [dimension, value] of Object.entries(change.signal || {})) {
    if (DIMENSIONS.includes(dimension)) scaled[dimension] = clamp01(value);
  }
  return scaled;
}

function applyMatrix(current, matrix, confidence, decay) {
  const out = { ...ZERO };
  for (const target of DIMENSIONS) {
    const row = matrix?.[target];
    if (!row) continue;
    let best = 0;
    for (const [source, weight] of Object.entries(row)) {
      best = Math.max(best, (current[source] || 0) * clamp01(weight));
    }
    out[target] = clamp01(best * confidence * decay);
  }
  return out;
}

function improve(existing, candidate, epsilon) {
  const next = { ...existing };
  let changed = false;
  for (const dimension of DIMENSIONS) {
    if ((candidate[dimension] || 0) > (existing[dimension] || 0) + epsilon) {
      next[dimension] = candidate[dimension];
      changed = true;
    }
  }
  return { next, changed };
}

function noisyOr(values) {
  let remain = 1;
  for (const value of values) remain *= 1 - clamp01(value);
  return clamp01(1 - remain);
}

function artifactOverall(signal, criticality = 0) {
  const weights = {
    runtime: 0.22,
    contract: 0.2,
    verification: 0.18,
    docs: 0.1,
    config: 0.12,
    delivery: 0.12,
    merge: 0.06,
  };
  const peak = maxDimension(signal);
  const mean = DIMENSIONS.reduce(
    (sum, dimension) => sum + signal[dimension] * weights[dimension],
    0,
  );
  const base = clamp01(0.7 * peak + 0.3 * mean);
  return noisyOr([base, 0.28 * clamp01(criticality) * base]);
}

function indexArtifacts(artifacts) {
  return new Map((artifacts || []).map((artifact) => [artifact.id, artifact]));
}

export function analyzeMergeImpact({
  artifacts = [],
  changes = [],
  relations = [],
  decay = 0.9,
  epsilon = 1e-6,
} = {}) {
  const artifactsById = indexArtifacts(artifacts);
  for (const change of changes) {
    if (!artifactsById.has(change.artifact)) {
      artifactsById.set(change.artifact, { id: change.artifact, kind: "unknown" });
    }
  }

  const outgoing = new Map();
  for (const relation of relations) {
    const current = outgoing.get(relation.from) || [];
    current.push(relation);
    outgoing.set(relation.from, current);
  }

  /** @type {Array<{ change: { artifact: string }, signal: Record<string, number>, best: Map<string, Record<string, number>> }>} */
  const perSeed = [];
  let truncated = false;
  for (const change of changes) {
    const signal = signalForChange(change);
    const best = new Map([[change.artifact, signal]]);
    const queue = [change.artifact];
    let head = 0;
    const maxRelaxations = Math.max(
      128,
      (artifactsById.size + 1) * Math.max(1, relations.length) * 4,
    );
    let relaxations = 0;

    while (head < queue.length && relaxations < maxRelaxations) {
      const from = queue[head++];
      const current = best.get(from) || ZERO;
      for (const relation of outgoing.get(from) || []) {
        const matrix = relation.matrix || RELATION_MATRICES[relation.kind];
        if (!matrix) continue;
        const candidate = applyMatrix(
          current,
          matrix,
          clamp01(relation.confidence ?? 1),
          clamp01(relation.decay ?? decay),
        );
        const previous = best.get(relation.to) || ZERO;
        const { next, changed } = improve(previous, candidate, epsilon);
        if (changed) {
          best.set(relation.to, next);
          queue.push(relation.to);
        }
        relaxations++;
        if (relaxations >= maxRelaxations) break;
      }
    }
    if (head < queue.length) truncated = true;
    perSeed.push({ change, signal, best });
  }

  const impacted = [];
  for (const [id, artifact] of artifactsById.entries()) {
    const combined = {};
    for (const dimension of DIMENSIONS) {
      combined[dimension] = noisyOr(
        perSeed.map((seed) => seed.best.get(id)?.[dimension] || 0),
      );
    }
    const overall = artifactOverall(combined, artifact.criticality || 0);
    if (overall <= epsilon) continue;
    impacted.push({
      id,
      kind: artifact.kind || "unknown",
      changed: changes.some((change) => change.artifact === id),
      criticality: clamp01(artifact.criticality || 0),
      dimensions: combined,
      overall,
    });
  }
  impacted.sort((left, right) => right.overall - left.overall || left.id.localeCompare(right.id));

  const changedSet = new Set(changes.map((change) => change.artifact));
  const secondary = impacted.filter((item) => !changedSet.has(item.id));
  const peak = impacted[0]?.overall || 0;
  const secondaryMass = secondary.reduce((sum, item) => sum + item.overall, 0);
  const breadth = clamp01(1 - Math.exp(-secondaryMass / 4));

  const uncertaintyParts = [];
  for (const seed of perSeed) {
    const edges = outgoing.get(seed.change.artifact) || [];
    const severity = maxDimension(seed.signal);
    if (!edges.length) {
      uncertaintyParts.push(0.65 * severity);
      continue;
    }
    const totalConfidence = edges.reduce(
      (sum, relation) => sum + clamp01(relation.confidence ?? 1),
      0,
    );
    const averageConfidence = totalConfidence / edges.length;
    uncertaintyParts.push(0.18 * severity * (1 - averageConfidence));
  }
  if (truncated) uncertaintyParts.push(0.6);
  const uncertainty = noisyOr(uncertaintyParts);

  const verificationGaps = [];
  for (const item of impacted) {
    if (["test", "documentation"].includes(item.kind)) continue;
    const consequential = Math.max(
      item.dimensions.runtime,
      item.dimensions.contract,
      item.dimensions.config,
      item.dimensions.delivery,
    );
    if (consequential < 0.35) continue;
    const hasTest = (outgoing.get(item.id) || []).some(
      (relation) => relation.kind === "verified_by",
    );
    if (!hasTest) verificationGaps.push(consequential * 0.55);
  }
  const verificationGap = noisyOr(verificationGaps);
  const risk = noisyOr([
    0.58 * peak,
    0.38 * breadth,
    0.5 * uncertainty,
    0.52 * verificationGap,
  ]);
  const level =
    risk >= 0.75 ? "critical" : risk >= 0.5 ? "high" : risk >= 0.25 ? "medium" : "low";

  const obligations = {
    tests: impacted
      .filter((item) => item.kind === "test" && item.dimensions.verification >= 0.08)
      .map((item) => item.id),
    docs: impacted
      .filter((item) => item.kind === "documentation" && item.dimensions.docs >= 0.08)
      .map((item) => item.id),
    config: impacted
      .filter(
        (item) =>
          ["config", "workflow", "manifest"].includes(item.kind) &&
          Math.max(item.dimensions.config, item.dimensions.delivery) >= 0.08,
      )
      .map((item) => item.id),
  };

  return {
    risk,
    level,
    peak,
    breadth,
    uncertainty,
    verificationGap,
    truncated,
    impacted,
    obligations,
  };
}

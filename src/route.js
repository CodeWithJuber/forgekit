// forge route — complexity-based model routing. Generic routers score prompt difficulty;
// this scores CODE-TASK complexity from signals Forge already computes (files in scope, impact
// fan-out, churn/fragility, past-mistake density here, ambiguity, task size) → cheapest capable
// tier. Advisory by default; a LiteLLM config emit exposes the tiers as gateway aliases you request.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { matchingLessons } from "./cortex.js";
import { gitChurn, grepFanout } from "./cortex_features.js";
import { recordRoute } from "./cost_report.js";
import { mergedLessons } from "./ledger_read.js";
import { setOverlap } from "./math.js";
import { MODELS } from "./model_tiers.js";
import { preflightRepo, referencedEntities } from "./preflight.js";
import { activeProvider, envModelOverride } from "./providers.js";
import { clamp01, contentHash, epochDay } from "./util.js";

// ---------------------------------------------------------------------------
// Text-complexity rubric: similarity-weighted k-NN regression over a labeled
// exemplar bank. The bank is DATA (example tasks with target complexities —
// tunable, diffable, growable); the decision is MATH (overlap-coefficient
// similarity → confidence-shrunk k-NN estimate). This replaced four hand-tuned
// topic keyword regexes: an unseen phrasing ("stop the two workers clobbering
// each other's writes") scores by resemblance to labeled neighbors, where a
// keyword list needed the literal token ("race condition") to appear.
// ---------------------------------------------------------------------------

/**
 * Labeled exemplars. `y` = target complexity in [0,1], calibrated to the tier
 * cutoffs in recommend(): ~0.08 trivial, ~0.42 data-structure/library level,
 * ~0.78 algorithmic/systems, ~0.85 architectural. Add rows freely — coverage
 * improves routing without touching any weight.
 */
export const EXEMPLARS = [
  // trivial
  { text: "fix a typo", y: 0.08 },
  { text: "rename a variable", y: 0.08 },
  { text: "add a comment", y: 0.08 },
  { text: "fix indentation and whitespace", y: 0.08 },
  { text: "reverse a string", y: 0.08 },
  { text: "check if a number is prime", y: 0.08 },
  { text: "check if a number is even or odd", y: 0.08 },
  { text: "compute the factorial of a number", y: 0.08 },
  { text: "print the fibonacci sequence", y: 0.08 },
  { text: "sum a list of numbers", y: 0.08 },
  { text: "count the vowels in a string", y: 0.08 },
  { text: "capitalize or lowercase a word", y: 0.08 },
  { text: "convert celsius to fahrenheit", y: 0.08 },
  { text: "write a hello world program", y: 0.08 },
  // moderate — data structure / class / library-level work
  { text: "implement an lru cache class with get and put", y: 0.42 },
  { text: "add a small in-memory cache with get and set", y: 0.42 },
  { text: "write a debounce or throttle helper", y: 0.42 },
  { text: "parse a csv or json file into objects", y: 0.42 },
  { text: "in-order traversal of a binary tree", y: 0.42 },
  { text: "sort records by multiple keys", y: 0.42 },
  { text: "merge two sorted lists", y: 0.42 },
  { text: "add validation to user input", y: 0.42 },
  { text: "implement a linked list stack or queue class", y: 0.42 },
  { text: "write a regex to extract fields from a line", y: 0.42 },
  { text: "add an async retry wrapper around a request", y: 0.42 },
  { text: "build an adjacency list graph and walk it", y: 0.42 },
  { text: "write a decorator that memoizes a function", y: 0.42 },
  { text: "refactor a function to remove duplication", y: 0.42 },
  // algorithmic / systems
  { text: "implement dijkstra shortest path algorithm", y: 0.78 },
  { text: "solve with dynamic programming and memoization", y: 0.78 },
  { text: "fix a race condition with mutex locking", y: 0.78 },
  { text: "thread-safe concurrent queue with condition variable signaling", y: 0.78 },
  { text: "implement a rate limiter with a token bucket", y: 0.78 },
  { text: "write a recursive descent parser for a grammar", y: 0.78 },
  { text: "resolve a deadlock between concurrent threads", y: 0.78 },
  { text: "fix a deadlock in a worker pool", y: 0.78 },
  { text: "fix the race condition in a queue", y: 0.78 },
  { text: "distributed consensus and replication protocol", y: 0.78 },
  { text: "cryptographic signing and verification flow", y: 0.78 },
  // spaced form on purpose: contentGrams splits "back-pressure" into two tokens,
  // so the exemplar must carry the split form for the bigram to line up.
  { text: "producer consumer blocking queue with back pressure", y: 0.78 },
  { text: "handle back pressure in a stream pipeline", y: 0.78 },
  { text: "run a database schema migration", y: 0.7 },
  { text: "state machine with invariants and transitions", y: 0.78 },
  { text: "numerical stability of a floating point computation", y: 0.78 },
  { text: "np-hard optimization with a heuristic search", y: 0.78 },
  { text: "compiler pass over an abstract syntax tree", y: 0.78 },
  { text: "idempotent retry with exactly-once delivery semantics", y: 0.78 },
  // architectural / cross-module
  { text: "design the architecture of a new service", y: 0.85 },
  { text: "refactor module boundaries across the codebase", y: 0.85 },
  { text: "design a schema migration for the database", y: 0.85 },
  { text: "api design with consistency guarantees and trade-offs", y: 0.85 },
  { text: "migrate a multi-module system end to end", y: 0.85 },
  { text: "design a locking strategy across services", y: 0.85 },
  { text: "plan scalability for a growing distributed system", y: 0.85 },
  { text: "cross-module refactor of shared interfaces", y: 0.85 },
];

// Excluded from the lexical footprint: function words AND generic task verbs
// (write/fix/add/…) — both appear in every request regardless of topic, so any
// overlap through them is spurious ("fix the deadlock" must match the deadlock
// exemplar, not "fix a typo").
const STOP = new Set(
  (
    "a an the in on of to for with and or is are be it its this that as at by from into up out " +
    "then after first should must please when if between two new small " +
    "write implement add make fix resolve create build use check"
  ).split(" "),
);

// Naive plural fold: both sides get the same transform, so "threads"↔"thread"
// overlap without a stemmer dependency (mangled stems like "clas" are harmless —
// they only ever compare against identically-mangled stems).
const stem = (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

/** Stopword-filtered, plural-folded unigram+bigram set — the lexical footprint
 *  similarity runs on. */
export function contentGrams(text) {
  const toks = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem);
  const grams = new Set(toks);
  for (let i = 0; i + 1 < toks.length; i++) grams.add(`${toks[i]} ${toks[i + 1]}`);
  return grams;
}

/** Every rubric constant in one inspectable table (same transparency rule as WEIGHTS). */
export const RUBRIC = {
  k: 3, // neighbors in the k-NN estimate
  prior: 0.15, // no-signal complexity (the old "base cost of any task")
  confSat: 0.5, // top similarity at which the estimate earns full weight
  strongScore: 0.65, // k-NN estimate marking a confidently-hard task (LLM lower-bound floor)
  // Calibrated against short phrasings: "fix the race condition in the worker pool"
  // overlaps its exemplar at ~0.43 (extra scope words dilute the coefficient), and
  // the floor MUST hold there — 0.5 let a bad LLM vote talk concurrency work down.
  strongConf: 0.35,
  bands: { cheap: 0.3, mid: 0.6 }, // score < cheap → cheap; ≤ mid → mid; else premium
  struct: { codeContext: 0.05, length: 0.1, constraints: 0.05, steps: 0.05 },
};

// Exemplar footprints are static — compute once, not per routeTask call (the ambient
// hook routes on every prompt; re-tokenizing 50 exemplars each time was pure waste).
const EXEMPLAR_GRAMS = EXEMPLARS.map((e) => ({ ...e, grams: contentGrams(e.text) }));

/** Structural (non-topic) features of the task text — countable, graded inputs. */
export function rubricSignals(task = "") {
  const text = String(task);
  return {
    lengthTokens: Math.max(1, Math.floor(text.length / 4)),
    hasCodeContext: /```/.test(text),
    // Explicit requirement markers: bullet/numbered lines and modal verbs. A count
    // feeding a saturating weight — feature extraction, not a classification.
    nConstraints: (text.match(/(^\s*[-*\d.]|\b(must|should|ensure|require|constraint)\b)/gim) || [])
      .length,
    // Sequencing markers: numbered-list lines plus prose connectives ("and then",
    // "after that") — multi-step requests carry complexity the topic estimate misses.
    nSteps:
      (text.match(/^\s*\d+[.)]\s/gm) || []).length +
      (text.match(/\b(and then|after that|step \d)\b/gi) || []).length,
  };
}

/**
 * Text rubric: k-NN over EXEMPLARS with credibility shrinkage toward the prior,
 * plus a bounded structural term. Deterministic, and every score is attributable:
 * the neighbors that produced it are returned, not just the number.
 */
export function rubricComplexity(task = "") {
  const sig = rubricSignals(task);
  const grams = contentGrams(task);
  const neighbors = EXEMPLAR_GRAMS.map(({ grams: eg, ...e }) => ({
    ...e,
    sim: setOverlap(grams, eg),
  }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, RUBRIC.k)
    .filter((n) => n.sim > 0);
  const simSum = neighbors.reduce((s, n) => s + n.sim, 0);
  const knn = simSum ? neighbors.reduce((s, n) => s + n.sim * n.y, 0) / simSum : RUBRIC.prior;
  const confidence = neighbors.length ? neighbors[0].sim : 0;
  // Credibility shrinkage: a weak best-match barely moves the estimate off the prior.
  const topic = RUBRIC.prior + (knn - RUBRIC.prior) * clamp01(confidence / RUBRIC.confSat);
  const s = RUBRIC.struct;
  const struct =
    s.codeContext * (sig.hasCodeContext ? 1 : 0) +
    s.length * clamp01(sig.lengthTokens / 150) +
    s.constraints * clamp01(sig.nConstraints / 5) +
    s.steps * clamp01(sig.nSteps / 3);
  // Structure adds complexity on top of topic, saturating — it can never flip a
  // trivial topic into premium on its own (struct is bounded by Σ weights = 0.25).
  const score = clamp01(topic + struct * (1 - topic));
  const band = score < RUBRIC.bands.cheap ? "cheap" : score <= RUBRIC.bands.mid ? "mid" : "premium";
  const strongTopicSignal = knn >= RUBRIC.strongScore && confidence >= RUBRIC.strongConf;
  const reasons = [
    ...neighbors
      .filter((n) => n.sim >= 0.2)
      .map((n) => ({
        weight: n.sim * n.y,
        reason: `similar to "${n.text}" (sim ${n.sim.toFixed(2)}, complexity ${n.y})`,
      })),
    ...(sig.hasCodeContext ? [{ weight: s.codeContext, reason: "carries code context" }] : []),
    ...(sig.lengthTokens > 55
      ? [
          {
            weight: s.length * clamp01(sig.lengthTokens / 150),
            reason: `long spec (~${sig.lengthTokens} tok)`,
          },
        ]
      : []),
    ...(sig.nConstraints >= 5
      ? [{ weight: s.constraints, reason: `${sig.nConstraints} explicit constraints` }]
      : []),
    ...(sig.nSteps >= 2 ? [{ weight: s.steps, reason: `${sig.nSteps} numbered steps` }] : []),
  ];
  return { score, band, confidence, knn, neighbors, signals: sig, reasons, strongTopicSignal };
}

const WEIGHTS = {
  files: 0.22,
  fanout: 0.22,
  churn: 0.12,
  mistakes: 0.18,
  ambiguity: 0.12,
  size: 0.14,
};

/**
 * Pure: raw task signals → complexity in [0,1].
 * @param {{files?:number, fanout?:number, churn?:number, pastMistakes?:number, ambiguity?:number, sizeWords?:number}} s
 */
export function complexity(s = {}) {
  const norm = {
    files: clamp01((s.files ?? 0) / 5), // >5 files touched = complex
    fanout: clamp01((s.fanout ?? 0) / 15), // >15 call sites = complex
    churn: clamp01((s.churn ?? 0) / 12), // fragile, frequently-changed area
    mistakes: clamp01((s.pastMistakes ?? 0) / 3), // repeated pain here
    ambiguity: clamp01(s.ambiguity ?? 0), // already 0..1 (from preflight)
    size: clamp01((s.sizeWords ?? 0) / 60), // long ask = more moving parts
  };
  let score = 0;
  for (const k of Object.keys(WEIGHTS)) score += WEIGHTS[k] * norm[k];
  return { score: clamp01(score), norm };
}

/** Pure: score → recommended model + the reasons that drove it. */
export function recommend(score, norm = {}) {
  const key = score < 0.25 ? "haiku" : score < 0.55 ? "sonnet" : score < 0.8 ? "opus" : "fable";
  const reasons = Object.entries(norm)
    .filter(([, v]) => v >= 0.5)
    .map(([k]) => k)
    .sort();
  return { key, model: MODELS[key], tier: MODELS[key].tier, reasons };
}

// M1 routing — LLM proposer. Estimates task complexity c(x) as a coarse band. PROPOSER ONLY:
// the reconcile in routeTask() lets a RAISE through freely but bounds any LOWER (within one band
// and never below a strong-signal floor), so the model can escalate on hidden complexity yet can
// never under-provision a genuinely hard task; escalation still gates on a verified failure.
const BAND_FLOOR = { cheap: 0.15, mid: 0.4, premium: 0.65 };

export function buildComplexityPrompt(task) {
  return `Judge the intrinsic complexity of this coding task for model selection (not how to do it).
Task: """${String(task).slice(0, 1200)}"""
Answer with STRICT JSON and nothing else:
{"band":"cheap|mid|premium","reason":"<short why>"}
cheap = trivial/boilerplate; mid = a data structure, class, or library-level change; premium =
algorithmic/systems/architectural/multi-module work. No text outside the JSON object.`;
}

export function parseComplexityProposal(obj) {
  const band = String(obj.band ?? "")
    .trim()
    .toLowerCase();
  if (!(band in BAND_FLOOR)) return null;
  return { band, score: BAND_FLOOR[band], reason: asText(obj.reason) };
}

/** Ask the model for a complexity band (proposer). Returns null when off/unavailable. */
export function complexityLLM(task, { run = buildRunner() } = {}) {
  return adjudicate({ prompt: buildComplexityPrompt(task), parse: parseComplexityProposal, run });
}

/**
 * Repo wrapper: gather the real signals for a task and route it. `run` is injectable for tests.
 * @param {string} root
 * @param {string} task
 * @param {object} [opts]
 * @param {boolean} [opts.llm]
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {(p:string)=>string} [opts.run]
 * @param {boolean} [opts.bidirectional]
 * @param {number} [opts.routingBand]
 * @param {number} [opts.signalFloor]
 * @param {number} [opts.ambiguity] precomputed information-gap (skips a duplicate preflight pass)
 */
export function routeTask(
  root,
  task,
  {
    llm,
    model,
    timeoutMs,
    run,
    bidirectional = true,
    routingBand = 0.2,
    signalFloor = 0.4,
    ambiguity,
  } = {},
) {
  const { symbols, files } = referencedEntities(task);
  const fanout = symbols.reduce((m, sym) => Math.max(m, grepFanout(root, sym)), 0);
  const churn = files.reduce((m, f) => Math.max(m, gitChurn(root, f)), 0);
  // Merged view (P2 read flip): teammate lessons raise past-mistake density here too.
  const pastMistakes = matchingLessons(mergedLessons(root, epochDay()), {
    files,
    symbols,
  }).length;
  // The routing signal only needs the DETERMINISTIC gap. Accept a precomputed one (substrate
  // already has it) and, when computing our own, force llm:false — the gap never depends on the
  // model, so an LLM assumption call here would be pure wasted latency.
  const ambiguityScore =
    typeof ambiguity === "number"
      ? ambiguity
      : preflightRepo(root, task, { allowBuild: false, llm: false }).gap;
  const sizeWords = task.trim().split(/\s+/).filter(Boolean).length;
  const signals = {
    files: files.length,
    fanout,
    churn,
    pastMistakes,
    ambiguity: ambiguityScore,
    sizeWords,
  };
  const { score: repoScore, norm } = complexity(signals);
  const rubric = rubricComplexity(task);
  // Upper envelope, not an average: text and repo signals measure DIFFERENT facets
  // of complexity, and under-provisioning is the expensive failure (an escalation
  // retry costs more than a one-tier overshoot). Whichever facet detects difficulty
  // sets the tier — same philosophy as the LLM proposer's "free raise" below.
  const detScore = Math.max(repoScore, rubric.score);
  // M1 proposer (opt-in): the model PROPOSES a complexity band. A RAISE is free (spotting hidden
  // complexity costs at most a bigger model). A LOWER is bounded — never more than one `band`
  // below the rubric, and never below `signalFloor` when the rubric confidently matched an
  // algorithmic/architectural exemplar, so a "distributed rate-limiter" can't be talked down
  // to the cheap tier.
  // With `bidirectional:false` it stays raise-only. Fail-safe: a null proposal is ignored.
  const proposal = llmEnabled({ llm })
    ? complexityLLM(task, { run: run || buildRunner({ model, timeoutMs }) })
    : null;
  const strongSignal = rubric.strongTopicSignal;
  let score = detScore;
  let path = proposal ? "llm-agreed" : "deterministic";
  if (proposal) {
    if (proposal.score > detScore) {
      score = proposal.score; // free raise
      path = "llm-raised";
    } else if (bidirectional && proposal.score < detScore) {
      const floor = Math.max(detScore - routingBand, strongSignal ? signalFloor : 0);
      const lowered = Math.max(floor, proposal.score);
      if (lowered < detScore) {
        score = lowered; // bounded lower
        path = "llm-lowered";
      }
    }
  }
  const recommended = recommend(score, norm);
  const modelOvr = envModelOverride();
  return {
    score,
    repoScore,
    signals,
    rubric,
    llm: proposal
      ? { band: proposal.band, reason: proposal.reason, direction: path.replace("llm-", "") }
      : null,
    provenance: { path },
    ...recommended,
    modelOverride: modelOvr || undefined,
    reasons: [
      ...new Set([
        ...(recommended.reasons || []),
        ...rubric.reasons.filter((r) => r.weight > 0).map((r) => r.reason),
        ...(path === "llm-raised" || path === "llm-lowered"
          ? [`model judged ${proposal.band} (${path.replace("llm-", "")}): ${proposal.reason}`]
          : []),
      ]),
    ],
  };
}

/**
 * Best-effort route-stage metering (05-cost-model.md) for EXPLICIT callers only — the
 * `forge route` CLI and the explicit substrate gate call this AFTER a routing decision.
 * Deliberately NOT called from routeTask itself: ambient hooks route on every prompt
 * and must stay write-free, same rule as recordGate in substrate.js. One metrics line:
 * the chosen tier + a short task hash as the ref (never the task text — metrics are
 * telemetry, not a prompt log). No token counts here — this is an advisory routing
 * decision, not a priced generation, and the cost report excludes unpriced events
 * rather than estimating them.
 * @param {string} root
 * @param {string} task
 * @param {{tier?: string}} rec the routeTask result (only .tier is read)
 */
export function meterRoute(root, task, rec) {
  try {
    recordRoute(root, { tier: rec?.tier, ref: contentHash(String(task)).slice(0, 12) });
  } catch {}
}

/** Emit a LiteLLM config exposing the complexity tiers as aliases (request the one `forge route` picks).
 *  Provider-aware: uses the active provider's model IDs for the passthrough entries
 *  and the correct LiteLLM model prefix (anthropic/ for direct, openrouter/ for OR).
 *  Returns `{ ok: false, reason }` for hosted gateways the user cannot configure. */
export function emitGatewayConfig(root = process.cwd()) {
  const prov = activeProvider(root);
  if (prov._autoDetected && prov._source === "LITELLM_BASE_URL") {
    return {
      ok: false,
      reason:
        `Hosted LiteLLM gateway detected at ${prov.baseUrl}. ` +
        `No local config needed — requests go directly to the hosted gateway. ` +
        `Use standard model names (the gateway handles routing).`,
    };
  }
  const prefix = prov.type === "openrouter" ? "openrouter/" : "anthropic/";
  const path = join(root, "litellm.config.yaml");
  const body = `# Forge Preflight — LiteLLM routing config (complexity tier -> model).
# HOW ROUTING WORKS: LiteLLM routes by the REQUESTED model name; it cannot infer task
# complexity on its own. So 'forge route' tells you the tier, and your tool REQUESTS the
# matching alias (forge-simple/medium/complex). A normal claude-* request passes through
# unchanged — pointing ANTHROPIC_BASE_URL here never breaks existing traffic.
#   pip install "litellm[proxy]==<pin an exact verified version>"   # supply-chain: pin exact, no floating tag
#   litellm --config litellm.config.yaml       # then export ANTHROPIC_BASE_URL=http://localhost:4000
# Provider: ${prov.label || prov.name} (${prov.type})
# Models verified 2026-07-05; re-verify via dev-radar.
model_list:
  # Tier aliases — request one of these (per 'forge route') to pick a model by complexity.
  - model_name: forge-simple   # ${MODELS.haiku.name} — ${MODELS.haiku.use}
    litellm_params: { model: ${prefix}${MODELS.haiku.id} }
  - model_name: forge-medium   # ${MODELS.sonnet.name} — default
    litellm_params: { model: ${prefix}${MODELS.sonnet.id} }
  - model_name: forge-complex  # ${MODELS.opus.name}
    litellm_params: { model: ${prefix}${MODELS.opus.id} }
  # Passthrough — a normal claude-* request still works when pointed at the gateway.
  - model_name: ${MODELS.haiku.id}
    litellm_params: { model: ${prefix}${MODELS.haiku.id} }
  - model_name: ${MODELS.sonnet.id}
    litellm_params: { model: ${prefix}${MODELS.sonnet.id} }
  - model_name: ${MODELS.opus.id}
    litellm_params: { model: ${prefix}${MODELS.opus.id} }
${prov.envKey ? `litellm_settings:\n  drop_params: true\n  set_verbose: false` : ""}
router_settings:
  routing_strategy: simple-shuffle
`;
  writeFileSync(path, body);
  return path;
}

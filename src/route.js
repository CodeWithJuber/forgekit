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
import { choice, jevEnabled, systemOne } from "./jev.js";
import { mergedLessons } from "./ledger_read.js";
import { setOverlap } from "./math.js";
import { MODELS } from "./model_tiers.js";
import { preflightRepo, referencedEntities } from "./preflight.js";
import { promotionGate } from "./promote.js";
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

// ---------------------------------------------------------------------------
// Outcome-calibrated routing (ROADMAP: advisory → gated promotion). The rubric above
// is the advisory baseline. Below: fit an affine correction of its score toward labeled
// complexities and PROMOTE it over the raw rubric ONLY if it beats the rubric on a
// held-out fixture (promote.js measured gate) — never on assertion. recommend() keeps
// the raw rubric unless a caller opts into the returned calibration, so this stays
// advisory until the measurement earns the promotion (overview §4 honesty register).
// ---------------------------------------------------------------------------

/**
 * Held-out labeled complexities, DISTINCT from EXEMPLARS (the k-NN bank), so the gate
 * measures generalization, not memorization. Interleaved by tier so any strided split is
 * balanced. y matches the recommend() cutoffs: ~0.08 trivial · ~0.42 library-level ·
 * ~0.78 algorithmic/systems · ~0.85 architectural.
 */
export const CALIBRATION_SAMPLES = [
  { text: "print numbers from 1 to 100", y: 0.08 },
  { text: "implement a fixed-size ring buffer", y: 0.42 },
  { text: "detect a cycle in a directed graph", y: 0.78 },
  { text: "design a multi-tenant billing subsystem", y: 0.85 },
  { text: "trim whitespace from a string", y: 0.08 },
  { text: "group a list of records by a key", y: 0.42 },
  { text: "implement quicksort in place", y: 0.78 },
  { text: "plan a migration from a monolith to services", y: 0.85 },
  { text: "swap two variables", y: 0.08 },
  { text: "flatten a deeply nested array", y: 0.42 },
  { text: "build a thread-safe bounded blocking queue", y: 0.78 },
  { text: "architect an event-sourced order pipeline", y: 0.85 },
  { text: "return the length of an array", y: 0.08 },
  { text: "add pagination to a list query", y: 0.42 },
  { text: "write an lru eviction policy with o(1) operations", y: 0.78 },
  { text: "design cross-region data replication", y: 0.85 },
  { text: "convert a string to uppercase", y: 0.08 },
  { text: "build a simple event emitter class", y: 0.42 },
  { text: "parse arithmetic expressions with operator precedence", y: 0.78 },
  { text: "define the module boundaries for a new platform", y: 0.85 },
  { text: "add two integers", y: 0.08 },
  { text: "validate an email address format", y: 0.42 },
  { text: "coordinate leader election across nodes", y: 0.78 },
  { text: "design an auth system with roles and sessions", y: 0.85 },
];

/** Least-squares affine calibration a·x + b mapping a rubric score x to the label y. Pure. */
export function fitComplexityCalibration(train) {
  const n = train.length;
  if (!n) return { a: 1, b: 0 };
  const mx = train.reduce((s, r) => s + r.x, 0) / n;
  const my = train.reduce((s, r) => s + r.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const r of train) {
    num += (r.x - mx) * (r.y - my);
    den += (r.x - mx) ** 2;
  }
  const a = den ? num / den : 1;
  return { a, b: my - a * mx };
}

/** Apply an affine calibration, clamped to [0,1]. */
export const applyCalibration = ({ a, b }, x) => clamp01(a * x + b);

// Strided split (every 5th sample to the held-out test set): deterministic and, with the
// interleaved fixture, tier-balanced — no RNG (Math.random is unavailable to scripts).
/** @returns {[any[], any[]]} */
const stridedSplit = (samples) => {
  const train = [];
  const test = [];
  samples.forEach((s, i) => {
    (i % 5 === 0 ? test : train).push(s);
  });
  return [train, test];
};

/**
 * Run the measured-promotion gate on the routing rubric: fit an affine correction on the
 * training split and promote it only if it lowers held-out MAE past the margin.
 * @param {{text:string,y:number}[]} [samples] labeled tasks (default: the held-out fixture)
 * @param {{margin?:number, minSamples?:number}} [opts]
 */
export function calibrateRouting(samples = CALIBRATION_SAMPLES, opts = {}) {
  const enriched = samples.map((s) => ({ ...s, x: rubricComplexity(s.text).score }));
  return promotionGate(enriched, {
    baseline: (s) => s.x,
    fit: fitComplexityCalibration,
    predict: (model, s) => applyCalibration(model, s.x),
    label: (s) => s.y,
    split: stridedSplit,
    minSamples: opts.minSamples ?? 20,
    margin: opts.margin ?? 0.01,
    lowerIsBetter: true,
  });
}

/**
 * The live complexity estimate: the calibrated mapping ONLY if the gate blessed it
 * (mirrors predictor.riskFor). Falls back to the raw rubric otherwise.
 * @param {string} task
 * @param {{mode:string, model?:{a:number,b:number}}} [promotion] result of calibrateRouting
 */
export function calibratedComplexity(task, promotion) {
  const base = rubricComplexity(task);
  if (promotion?.mode === "candidate" && promotion.model) {
    return { ...base, score: applyCalibration(promotion.model, base.score), calibrated: true };
  }
  return { ...base, calibrated: false };
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

/** recommend()'s tier cutoffs — the ONE complexity scale every routing input is read on. */
export const TIER_CUTOFFS = { haiku: 0.25, sonnet: 0.55, opus: 0.8 };

/** Tier used when the score is not a finite number: unknown complexity is routed to the
 *  default tier (model_tiers: sonnet is "the default"), never to the most expensive one. */
const UNKNOWN_SCORE_KEY = "sonnet";

/** Pure: score → recommended model + the reasons that drove it. */
export function recommend(score, norm = {}) {
  const reasons = Object.entries(norm)
    .filter(([, v]) => v >= 0.5)
    .map(([k]) => k)
    .sort();
  // Fail safe on a non-finite score (NaN from a garbled signal, ±Infinity): every comparison
  // below is false for NaN, which used to fall through to fable — the most expensive tier.
  if (typeof score !== "number" || !Number.isFinite(score)) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge route: non-finite complexity score (${score}) → default tier\n`);
    const key = UNKNOWN_SCORE_KEY;
    return {
      key,
      model: MODELS[key],
      tier: MODELS[key].tier,
      reasons: [...reasons, "unknown-score"],
    };
  }
  const key =
    score < TIER_CUTOFFS.haiku
      ? "haiku"
      : score < TIER_CUTOFFS.sonnet
        ? "sonnet"
        : score < TIER_CUTOFFS.opus
          ? "opus"
          : "fable";
  return { key, model: MODELS[key], tier: MODELS[key].tier, reasons };
}

// M1 routing — LLM proposer. Estimates task complexity c(x) as a coarse band. PROPOSER ONLY:
// reconcileRoute() compares the proposer's band with the band the deterministic score already
// sits in — band to band, never band floor against point score. The three bands are intervals
// on recommend()'s scale (cheap = haiku, mid = sonnet, premium = opus/fable); each ceiling sits
// just under the next band's floor so a score moved onto it stays inside the band.
const BAND_ORDER = ["cheap", "mid", "premium"];
export const BANDS = {
  cheap: { floor: 0, ceiling: TIER_CUTOFFS.haiku - 0.01 },
  mid: { floor: TIER_CUTOFFS.haiku, ceiling: TIER_CUTOFFS.sonnet - 0.01 },
  premium: { floor: TIER_CUTOFFS.sonnet, ceiling: 1 },
};

/** The band a complexity score falls in (same cutoffs as recommend()). */
export const bandOf = (score) =>
  score < TIER_CUTOFFS.haiku ? "cheap" : score < TIER_CUTOFFS.sonnet ? "mid" : "premium";

/**
 * Minimum probability a proposer must put on its band before the vote may move the tier.
 * An a-priori conservative default, NOT fit to any data: the right value has to be chosen on
 * fresh labelled tasks (the frozen held-out set is spent). A proposal that reports no
 * probability at all (the text-LLM proposer) cannot clear it; configurable per call and via
 * `llm.minConfidence` in source/substrate.json (0 disables the gate).
 */
export const ROUTE_MIN_CONFIDENCE = 0.8;

/** p(band) for a proposal: Jev's probability on the voted band, else its confidence, else null. */
function proposalConfidence(proposal) {
  const p = proposal?.probabilities?.[proposal.band];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  return typeof proposal?.confidence === "number" && Number.isFinite(proposal.confidence)
    ? proposal.confidence
    : null;
}

/**
 * Pure: reconcile the deterministic complexity score with a proposer's band vote.
 *   - same band        → the deterministic score stands ("llm-agreed");
 *   - higher band      → NOT applied (whitepaper §5.1: spend more only when an external check
 *                        on the output fails, never on a model's self-assessment). The tier the
 *                        vote would have picked is returned as `escalateTo` — an ADVISORY
 *                        recommendation only: nothing in forge acts on it automatically (no
 *                        verifier-failure path consumes it yet) ("llm-raise-deferred");
 *   - lower band       → lowered to that band's ceiling — only when bidirectional, only when
 *                        the vote clears `minConfidence`, and never below `signalFloor` when
 *                        the rubric has a strong topic signal ("llm-lowered"); otherwise the
 *                        deterministic score stands and `overruledBy` says why ("llm-overruled").
 * @param {number} detScore
 * @param {{band:string, confidence?:number|null, probabilities?:Record<string,number>|null}|null} proposal
 * @param {{bidirectional?:boolean, minConfidence?:number, strongSignal?:boolean, signalFloor?:number}} [opts]
 * @returns {{score:number, path:string, escalateTo?:string, overruledBy?:string, floored?:boolean}}
 */
export function reconcileRoute(
  detScore,
  proposal,
  {
    bidirectional = true,
    minConfidence = ROUTE_MIN_CONFIDENCE,
    strongSignal = false,
    signalFloor = 0.4,
  } = {},
) {
  if (!proposal || !(proposal.band in BANDS)) return { score: detScore, path: "deterministic" };
  const detBand = bandOf(detScore);
  const vote = proposal.band;
  if (vote === detBand) return { score: detScore, path: "llm-agreed" };
  if (BAND_ORDER.indexOf(vote) > BAND_ORDER.indexOf(detBand)) {
    return {
      score: detScore,
      path: "llm-raise-deferred",
      escalateTo: recommend(BANDS[vote].floor).key,
    };
  }
  if (!bidirectional)
    return { score: detScore, path: "llm-overruled", overruledBy: "bidirectional-off" };
  const p = proposalConfidence(proposal);
  if (minConfidence > 0 && (p == null || p < minConfidence))
    return { score: detScore, path: "llm-overruled", overruledBy: "confidence" };
  const ceiling = BANDS[vote].ceiling;
  const floored = strongSignal && signalFloor > ceiling;
  const target = floored ? signalFloor : ceiling;
  if (bandOf(target) === detBand)
    return { score: detScore, path: "llm-overruled", overruledBy: "signal-floor" };
  return { score: target, path: "llm-lowered", ...(floored ? { floored: true } : {}) };
}

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
  if (!(band in BANDS)) return null;
  return { band, score: BANDS[band].floor, reason: asText(obj.reason) };
}

/** Ask the model for a complexity band (proposer). Returns null when off/unavailable. */
export function complexityLLM(task, { run = buildRunner() } = {}) {
  return adjudicate({ prompt: buildComplexityPrompt(task), parse: parseComplexityProposal, run });
}

/** The complexity judgment as a Jev Choice — the same three bands the text proposer uses. */
export function buildComplexityChoice(task) {
  return {
    state: String(task).slice(0, 1200),
    questions: {
      band: choice(
        "Judge the intrinsic complexity of this coding task for model selection (not how to do the task).",
        {
          cheap: "Trivial or boilerplate: a typo, rename, formatting, or a one-line helper",
          mid: "A data structure, class, or library-level change with a few moving parts",
          premium: "Algorithmic, systems, concurrency, architectural, or multi-module work",
        },
      ),
    },
  };
}

/**
 * Ask Jev (TypeSafe System One) for a complexity band. Same proposal contract as
 * complexityLLM — reconcileRoute() still judges the band against the deterministic score —
 * but the answer is typed and carries the probability distribution Jev computed (which the
 * reconcile's confidence gate reads), in ~150ms instead of a text round-trip. Returns null
 * when off/unavailable.
 * @param {string} task
 * @param {object} [opts]
 * @param {boolean} [opts.llm]
 * @param {(payload:object)=>object} [opts.call] injectable Jev transport (tests)
 */
export function complexityJev(task, { llm, call } = {}) {
  if (!jevEnabled({ llm })) return null;
  const { state, questions } = buildComplexityChoice(task);
  const res = systemOne({ state, questions, call });
  const ans = res?.answers?.band;
  if (!ans) return null;
  const band = ans.choice.toLowerCase();
  if (!(band in BANDS)) return null;
  return {
    band,
    score: BANDS[band].floor,
    reason: ans.confidence != null ? `jev confidence ${ans.confidence.toFixed(2)}` : "jev choice",
    provider: "jev",
    confidence: ans.confidence ?? null,
    probabilities: ans.probabilities ?? null,
  };
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
 * @param {(payload:object)=>object} [opts.jevCall] injectable Jev transport (tests)
 * @param {boolean} [opts.bidirectional] may a proposer LOWER the tier (false: it never moves it)
 * @param {number} [opts.minConfidence] p(band) a vote needs before it may move the tier
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
    jevCall,
    bidirectional = true,
    minConfidence = ROUTE_MIN_CONFIDENCE,
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
  // sets the tier.
  const detScore = Math.max(repoScore, rubric.score);
  // M1 proposer (opt-in): the model PROPOSES a complexity band; reconcileRoute() decides what it
  // may change (band-to-band, confidence-gated, lower-only — see its doc). Jev (typed, ~150ms)
  // is the preferred proposer when its key is configured; the text-LLM runner is the fallback,
  // and a null from either is ignored (fail-safe).
  const proposal = llmEnabled({ llm })
    ? (complexityJev(task, { llm, call: jevCall }) ??
      complexityLLM(task, { run: run || buildRunner({ model, timeoutMs }) }))
    : null;
  const verdict = reconcileRoute(detScore, proposal, {
    bidirectional,
    minConfidence,
    strongSignal: rubric.strongTopicSignal,
    signalFloor,
  });
  const { score, path } = verdict;
  const recommended = recommend(score, norm);
  const modelOvr = envModelOverride();
  return {
    score,
    repoScore,
    signals,
    rubric,
    llm: proposal
      ? {
          band: proposal.band,
          reason: proposal.reason,
          direction: path.replace("llm-", ""),
          provider: proposal.provider ?? "text",
          ...(proposal.confidence != null ? { confidence: proposal.confidence } : {}),
          ...(verdict.escalateTo ? { escalateTo: verdict.escalateTo } : {}),
          ...(verdict.overruledBy ? { overruledBy: verdict.overruledBy } : {}),
          ...(verdict.floored ? { floored: true } : {}),
        }
      : null,
    provenance: { path },
    ...recommended,
    modelOverride: modelOvr || undefined,
    reasons: [
      ...new Set([
        ...(recommended.reasons || []),
        ...rubric.reasons.filter((r) => r.weight > 0).map((r) => r.reason),
        ...(path === "llm-lowered"
          ? [`model judged ${proposal.band} (lowered): ${proposal.reason}`]
          : []),
        ...(path === "llm-raise-deferred"
          ? [
              `model judged ${proposal.band} — not applied; advisory only: consider ${verdict.escalateTo} if a verifier fails (nothing escalates automatically)`,
            ]
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

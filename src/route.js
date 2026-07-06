// forge route — complexity-based model routing. Generic routers score prompt difficulty;
// this scores CODE-TASK complexity from signals Forge already computes (files in scope, impact
// fan-out, churn/fragility, past-mistake density here, ambiguity, task size) → cheapest capable
// tier. Advisory by default; a LiteLLM config emit exposes the tiers as gateway aliases you request.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { matchingLessons } from "./cortex.js";
import { gitChurn, grepFanout } from "./cortex_features.js";
import { load as loadLessons } from "./lessons_store.js";
import { MODELS } from "./model_tiers.js";
import { preflightRepo, referencedEntities } from "./preflight.js";

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Weights sum to 1. Each raw signal is normalized by the point where it reads as "complex".

const ALGO_TERMS =
  /\b(recursion|recursive|recursive-?descent|dynamic programming|dijkstra|a\*|concurren|thread-?safe|mutex|race condition|deadlock|distributed|consensus|parser|compiler|cryptograph|np-hard|state machine|invariant|numerical stability|back-?pressure|token[- ]bucket|rate limiter|idempoten|migration|producer|consumer|blocking queue|condition[- ]variable)\b/i;
const ARCH_TERMS =
  /\b(architect|\bdesign\b|trade-?off|refactor a|migrate|scal(e|able|ing)|schema (migration|design)|api design|multi-?module|cross-?module|end-?to-?end|consistency (guarantee|trade)|locking strategy|module boundaries)\b/i;
const MODERATE_TERMS =
  /\b(class\b|cache|lru|queue|stack|heap|linked list|binary tree|tree|traversal|graph|decorator|regex|debounce|throttle|merge|sort(ed|ing)?|parse|o\(\s*\d|o\(n|o\(1|thread|async|lock|validate|in-?order|adjacency)\b/i;
const TRIVIAL_TERMS =
  /\b(hello world|rename|typo|indent|add a comment|reverse a string|reverse the string|is[_ ]?even|is[_ ]?odd|factorial|fibonacci|is[_ ]?prime|prime\b|sum of|sum_list|capitalize|count vowels|celsius|fahrenheit|lower ?case|upper ?case)\b/i;
const MULTISTEP =
  /\b(and then|after that|first.*then|step \d|multiple|several|each of|for every)\b/i;

export function rubricSignals(task = "") {
  const text = String(task);
  return {
    lengthTokens: Math.max(1, Math.floor(text.length / 4)),
    hasAlgorithmicTerms: ALGO_TERMS.test(text),
    hasArchitecturalTerms: ARCH_TERMS.test(text),
    hasModerateTerms: MODERATE_TERMS.test(text),
    hasTrivialMarkers: TRIVIAL_TERMS.test(text),
    hasMultistep: MULTISTEP.test(text),
    hasCodeContext: /```/.test(text),
    nConstraints: (text.match(/(^\s*[-*\d.]|\b(must|should|ensure|require|constraint)\b)/gim) || [])
      .length,
  };
}

export function rubricComplexity(task = "") {
  const sig = rubricSignals(task);
  const reasons = [{ weight: 1.5, reason: "base cost of any task" }];
  let score = 1.5;
  if (sig.hasAlgorithmicTerms) {
    score += 4;
    reasons.push({ weight: 4, reason: "algorithmic/systems difficulty" });
  }
  if (sig.hasArchitecturalTerms) {
    score += 4;
    reasons.push({ weight: 4, reason: "architectural/design scope" });
  }
  if (sig.hasModerateTerms) {
    score += 2;
    reasons.push({ weight: 2, reason: "data-structure/class/library-level work" });
  }
  if (sig.hasMultistep) {
    score += 1;
    reasons.push({ weight: 1, reason: "multi-step request" });
  }
  if (sig.hasCodeContext) {
    score += 1;
    reasons.push({ weight: 1, reason: "carries code context" });
  }
  if (sig.lengthTokens > 120) {
    score += 1.5;
    reasons.push({ weight: 1.5, reason: `long spec (~${sig.lengthTokens} tok)` });
  } else if (sig.lengthTokens > 55) {
    score += 0.7;
    reasons.push({ weight: 0.7, reason: `medium spec (~${sig.lengthTokens} tok)` });
  }
  if (sig.nConstraints >= 5) {
    score += 1;
    reasons.push({ weight: 1, reason: `${sig.nConstraints} explicit constraints` });
  }
  if (sig.hasTrivialMarkers && !sig.hasAlgorithmicTerms && !sig.hasArchitecturalTerms) {
    score -= 3;
    reasons.push({ weight: -3, reason: "trivial-task marker" });
  }
  const rawScore = Math.max(0, score);
  const band = rawScore < 3 ? "cheap" : rawScore <= 6 ? "mid" : "premium";
  return { rawScore, band, signals: sig, reasons };
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
  const band = String(obj.band ?? "").toLowerCase();
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
 */
export function routeTask(
  root,
  task,
  { llm, model, timeoutMs, run, bidirectional = true, routingBand = 0.2, signalFloor = 0.4 } = {},
) {
  const { symbols, files } = referencedEntities(task);
  const fanout = symbols.reduce((m, sym) => Math.max(m, grepFanout(root, sym)), 0);
  const churn = files.reduce((m, f) => Math.max(m, gitChurn(root, f)), 0);
  const pastMistakes = matchingLessons(loadLessons(root), {
    files,
    symbols,
  }).length;
  const ambiguity = preflightRepo(root, task, { allowBuild: false }).gap;
  const sizeWords = task.trim().split(/\s+/).filter(Boolean).length;
  const signals = {
    files: files.length,
    fanout,
    churn,
    pastMistakes,
    ambiguity,
    sizeWords,
  };
  const { score: repoScore, norm } = complexity(signals);
  const rubric = rubricComplexity(task);
  const rubricScore = Math.min(1, rubric.rawScore / 10);
  const detScore = Math.max(repoScore, rubricScore);
  // M1 proposer (opt-in): the model PROPOSES a complexity band. A RAISE is free (spotting hidden
  // complexity costs at most a bigger model). A LOWER is bounded — never more than one `band`
  // below the rubric, and never below `signalFloor` when the rubric detected algorithmic or
  // architectural terms, so a "distributed rate-limiter" can't be talked down to the cheap tier.
  // With `bidirectional:false` it stays raise-only. Fail-safe: a null proposal is ignored.
  const proposal = llmEnabled({ llm })
    ? complexityLLM(task, { run: run || buildRunner({ model, timeoutMs }) })
    : null;
  const strongSignal = rubric.signals.hasAlgorithmicTerms || rubric.signals.hasArchitecturalTerms;
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

/** Emit a LiteLLM config exposing the complexity tiers as aliases (request the one `forge route` picks). */
export function emitGatewayConfig(root = process.cwd()) {
  const path = join(root, "litellm.config.yaml");
  const body = `# Forge Preflight — LiteLLM routing config (complexity tier -> model).
# HOW ROUTING WORKS: LiteLLM routes by the REQUESTED model name; it cannot infer task
# complexity on its own. So 'forge route' tells you the tier, and your tool REQUESTS the
# matching alias (forge-simple/medium/complex). A normal claude-* request passes through
# unchanged — pointing ANTHROPIC_BASE_URL here never breaks existing traffic.
#   pip install "litellm[proxy]==<pin an exact verified version>"   # supply-chain: pin exact, no floating tag
#   litellm --config litellm.config.yaml       # then export ANTHROPIC_BASE_URL=http://localhost:4000
# Models verified 2026-07-05; re-verify via dev-radar.
model_list:
  # Tier aliases — request one of these (per 'forge route') to pick a model by complexity.
  - model_name: forge-simple   # ${MODELS.haiku.name} — ${MODELS.haiku.use}
    litellm_params: { model: anthropic/${MODELS.haiku.id} }
  - model_name: forge-medium   # ${MODELS.sonnet.name} — default
    litellm_params: { model: anthropic/${MODELS.sonnet.id} }
  - model_name: forge-complex  # ${MODELS.opus.name}
    litellm_params: { model: anthropic/${MODELS.opus.id} }
  # Passthrough — a normal claude-* request still works when pointed at the gateway.
  - model_name: ${MODELS.haiku.id}
    litellm_params: { model: anthropic/${MODELS.haiku.id} }
  - model_name: ${MODELS.sonnet.id}
    litellm_params: { model: anthropic/${MODELS.sonnet.id} }
  - model_name: ${MODELS.opus.id}
    litellm_params: { model: anthropic/${MODELS.opus.id} }
router_settings:
  routing_strategy: simple-shuffle
`;
  writeFileSync(path, body);
  return path;
}

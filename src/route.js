// forge route — complexity-based model routing. Generic routers score prompt difficulty;
// this scores CODE-TASK complexity from signals Forge already computes (files in scope, impact
// fan-out, churn/fragility, past-mistake density here, ambiguity, task size) → cheapest capable
// tier. Advisory by default; a LiteLLM config emit gives real auto-routing for gateway traffic.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchingLessons } from "./cortex.js";
import { gitChurn, grepFanout } from "./cortex_features.js";
import { load as loadLessons } from "./lessons_store.js";
import { MODELS } from "./model_tiers.js";
import { preflightRepo, referencedEntities } from "./preflight.js";

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Weights sum to 1. Each raw signal is normalized by the point where it reads as "complex".
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

/** Repo wrapper: gather the real signals for a task and route it. */
export function routeTask(root, task) {
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
  const { score, norm } = complexity(signals);
  return { score, signals, ...recommend(score, norm) };
}

/** Emit a LiteLLM gateway config so simple tasks can auto-route to Haiku (opt-in, gateway-only). */
export function emitGatewayConfig(root = process.cwd()) {
  const path = join(root, "litellm.config.yaml");
  const body = `# Forge Preflight — LiteLLM routing config (complexity tier -> model).
# Auto-routes ONLY traffic sent through the gateway. Advisory 'forge route' works with no gateway.
#   pip install "litellm[proxy]==<pin an exact verified version>"   # supply-chain: pin exact, no floating tag
#   litellm --config litellm.config.yaml       # then export ANTHROPIC_BASE_URL=http://localhost:4000
# Models verified 2026-07-05; re-verify via dev-radar.
model_list:
  - model_name: forge-simple   # ${MODELS.haiku.name} — ${MODELS.haiku.use}
    litellm_params: { model: anthropic/${MODELS.haiku.id} }
  - model_name: forge-medium   # ${MODELS.sonnet.name} — default
    litellm_params: { model: anthropic/${MODELS.sonnet.id} }
  - model_name: forge-complex  # ${MODELS.opus.name}
    litellm_params: { model: anthropic/${MODELS.opus.id} }
router_settings:
  routing_strategy: simple-shuffle
`;
  writeFileSync(path, body);
  return path;
}

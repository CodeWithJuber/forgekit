// forge cost report — the P8 measured-stage report (docs/plans/substrate-v2/05-cost-model.md).
// The cost model is multiplicative: C = C₀ · Π(1 − fᵢ) over independent stages. The discipline
// this module enforces is the paper's (§4, C6): a number is an assumption until measured. Every
// factor here is ARITHMETIC over .forge/metrics.jsonl lines that stages actually emitted; a
// stage with no events reports measured:false and value:null — it is never guessed, defaulted,
// or backfilled from a target. The ~90 % figure in the plan stays a TARGET everywhere in this
// module's output; the only measured external figure (62 % routing, paper §9) is cited as
// context, clearly labeled as not-local.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { read, record } from "./metrics.js";
import { MODELS } from "./model_tiers.js";

/** Saving weight per cache-hit tier — must stay consistent with reuse.js savedEstimate
 *  (exact = full regeneration avoided; near/adapt still spend adaptation tokens). */
export const CACHE_TIER_SAVINGS = { hit_exact: 1.0, hit_near: 0.85, hit_adapt: 0.5 };

// The route factor's baseline is "always-premium": the tier an unrouted agent defaults to.
// That is the complex tier (opus), NOT the extreme tier — pricing the baseline at the
// rarely-justified top model would flatter the savings, and honesty is the point.
const ROUTE_BASELINE_KEY = "opus";

/** Resolve a metrics `tier` field to a pricing row — accepts the model key ("haiku")
 *  or the tier name ("simple"), since both appear in route results. */
const modelForTier = (tier) =>
  MODELS[tier] ?? Object.values(MODELS).find((m) => m.tier === tier) ?? null;

const tokenCost = (m, tokensIn, tokensOut) => tokensIn * m.inCost + tokensOut * m.outCost;

const unmeasured = () => ({ measured: false, value: null, events: 0 });

/**
 * Per-stage measured factors from .forge/metrics.jsonl. Each factor is
 * {measured:boolean, value:number|null, events:number} — `events` counts only the lines
 * usable for that stage's arithmetic, and a stage with none reports measured:false /
 * value:null. NEVER invents a number.
 *
 * - gate: fraction of "gate" events with outcome "halt" — requests where spend was avoided
 *   entirely. (This measures h_gate; the plan's g ≈ per-halt spend share is taken as 1 —
 *   i.e. a halted task is assumed to have cost an average task, the simplest honest reading
 *   until the paired harness prices halts individually.)
 * - cache: hit rate weighted by tier savings (exact 1.0 / near 0.85 / adapt 0.5); a miss
 *   contributes 0 to the numerator but counts in the denominator.
 * - route: 1 − (actual token cost / always-premium cost) over "route" events that carry a
 *   resolvable tier AND real token counts — events without tokens can't be priced and are
 *   excluded rather than estimated.
 * - context: fraction of would-have-been input tokens avoided, Σsaved / (Σsaved + Σactual),
 *   over "context" events carrying both savedEstimate and tokensIn.
 * @param {string} root
 */
export function stageFactors(root) {
  const gateEvents = read(root, { stage: "gate" });
  const gate = gateEvents.length
    ? {
        measured: true,
        value: gateEvents.filter((e) => e.outcome === "halt").length / gateEvents.length,
        events: gateEvents.length,
      }
    : unmeasured();

  const cacheEvents = read(root, { stage: "cache" });
  const cache = cacheEvents.length
    ? {
        measured: true,
        value:
          cacheEvents.reduce((s, e) => s + (CACHE_TIER_SAVINGS[e.outcome] ?? 0), 0) /
          cacheEvents.length,
        events: cacheEvents.length,
      }
    : unmeasured();

  const baseline = MODELS[ROUTE_BASELINE_KEY];
  const routeEvents = read(root, { stage: "route" }).filter(
    (e) =>
      modelForTier(e.tier) &&
      Number.isFinite(e.tokensIn) &&
      Number.isFinite(e.tokensOut) &&
      e.tokensIn + e.tokensOut > 0,
  );
  const route = routeEvents.length
    ? {
        measured: true,
        value:
          1 -
          routeEvents.reduce(
            (s, e) => s + tokenCost(modelForTier(e.tier), e.tokensIn, e.tokensOut),
            0,
          ) /
            routeEvents.reduce((s, e) => s + tokenCost(baseline, e.tokensIn, e.tokensOut), 0),
        events: routeEvents.length,
      }
    : unmeasured();

  const ctxEvents = read(root, { stage: "context" }).filter(
    (e) => Number.isFinite(e.savedEstimate) && Number.isFinite(e.tokensIn),
  );
  const ctxSaved = ctxEvents.reduce((s, e) => s + e.savedEstimate, 0);
  const ctxActual = ctxEvents.reduce((s, e) => s + e.tokensIn, 0);
  const context =
    ctxEvents.length && ctxSaved + ctxActual > 0
      ? { measured: true, value: ctxSaved / (ctxSaved + ctxActual), events: ctxEvents.length }
      : unmeasured();

  return { gate, cache, route, context };
}

/**
 * The multiplicative composition C = C₀ · Π(1 − fᵢ) over ONLY the measured factors.
 * Honest framing: because unmeasured stages contribute exactly nothing (factor 0, not a
 * target), the result is a LOWER BOUND built from measured stages only — it can only grow
 * as more stages start emitting metrics, and it is never the plan's ~90 % target restated.
 * @param {ReturnType<typeof stageFactors>} factors
 * @returns {{measuredReduction:number, stagesIncluded:string[], stagesMissing:string[]}}
 */
export function composedReduction(factors) {
  const stagesIncluded = [];
  const stagesMissing = [];
  let remaining = 1;
  for (const [name, f] of Object.entries(factors)) {
    if (f.measured && typeof f.value === "number") {
      stagesIncluded.push(name);
      remaining *= 1 - f.value;
    } else stagesMissing.push(name);
  }
  return { measuredReduction: 1 - remaining, stagesIncluded, stagesMissing };
}

/**
 * Assemble the full report: factors, composition, raw totals, and a caveat per unmeasured
 * stage plus the workload-dependence caveat — the caveats ship WITH the numbers so no
 * consumer can quote the reduction without its conditions.
 * @param {string} root
 */
export function report(root) {
  const factors = stageFactors(root);
  const composed = composedReduction(factors);
  const all = read(root);
  const totals = {
    events: all.length,
    savedEstimateTokens: all.reduce(
      (s, e) => s + (Number.isFinite(e.savedEstimate) ? e.savedEstimate : 0),
      0,
    ),
  };
  const caveats = composed.stagesMissing.map(
    (s) =>
      `stage "${s}" has no recorded events — unmeasured, contributes nothing to the composition`,
  );
  caveats.push(
    "stage rates are workload-dependent: these factors describe this repo's recorded traffic, not a general claim (05-cost-model.md §2)",
    "the composed figure is a lower bound from measured stages only; savings are not correctness-guarded until the P8 paired harness runs (05-cost-model.md §3)",
  );
  return { factors, composed, totals, caveats };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Human rendering. Register matters as much as arithmetic: measured numbers print as
 * measurements, the paper's 62 % routing figure prints as CONTEXT (a citation, not a local
 * result), and the ~90 % figure appears only with the word "target" in front of it — this
 * report never claims it as achieved.
 * @param {ReturnType<typeof report>} r
 */
export function renderCostReport(r) {
  const lines = ["Forge cost — measured stage factors (.forge/metrics.jsonl)", ""];
  lines.push(`  ${"stage".padEnd(9)} ${"factor".padEnd(10)} events`);
  for (const [name, f] of Object.entries(r.factors)) {
    const shown = f.measured && typeof f.value === "number" ? pct(f.value) : "no data";
    lines.push(`  ${name.padEnd(9)} ${shown.padEnd(10)} ${f.events}`);
  }
  lines.push("");
  lines.push(
    r.composed.stagesIncluded.length
      ? `  composed measured reduction: ${pct(r.composed.measuredReduction)} (from: ${r.composed.stagesIncluded.join(", ")}) — lower bound, measured stages only`
      : "  composed measured reduction: 0.0% — no stage has recorded events yet",
  );
  lines.push(
    `  totals: ${r.totals.events} metric event(s) · ~${r.totals.savedEstimateTokens} tokens saved (stage self-estimates)`,
  );
  lines.push(
    "",
    "  context (not a local measurement): the paper measured a 62% routing saving on live tokens (paper §9)",
    "  target (unmet until measured): the plan's composed target is ~90% (docs/plans/substrate-v2/05-cost-model.md)",
  );
  lines.push("", "  caveats:");
  for (const c of r.caveats) lines.push(`    - ${c}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Emit-side helpers — one obvious call per stage, so future wiring (context assembly,
// real route execution) adds a single line instead of re-deriving the schema. Thin
// wrappers over metrics.record, which is already best-effort (never throws).
// ---------------------------------------------------------------------------

/** Record one assumption-gate decision: halted = spend avoided.
 *  @param {string} root
 *  @param {{halted?: boolean, ref?: string}} [opts] */
export function recordGate(root, { halted, ref } = {}) {
  return record(root, { stage: "gate", outcome: halted ? "halt" : "pass", ref });
}

/** Record one routed generation with its tier and real token counts.
 *  @param {string} root
 *  @param {{tier?: string, tokensIn?: number, tokensOut?: number, ref?: string}} [opts] */
export function recordRoute(root, { tier, tokensIn, tokensOut, ref } = {}) {
  return record(root, { stage: "route", tier, tokensIn, tokensOut, ref });
}

/**
 * Fallback spend estimation from Claude's native JSONL session logs when ccusage
 * is unavailable. Scans ~/.claude/projects/ for session files and computes cost
 * from token counts x model_tiers pricing. Best-effort, never throws.
 */
export function estimateSpendFromLogs() {
  try {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return null;
    const pricingPerM = {};
    for (const [, m] of Object.entries(MODELS)) {
      pricingPerM[m.id] = { inCost: m.inCost, outCost: m.outCost };
    }
    const byModel = {};
    let sessions = 0;
    for (const project of readdirSync(projectsDir)) {
      const pDir = join(projectsDir, project);
      let files;
      try {
        files = readdirSync(pDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        sessions++;
        try {
          const lines = readFileSync(join(pDir, f), "utf8").split("\n");
          for (const line of lines) {
            if (!line.includes('"usage"')) continue;
            try {
              const entry = JSON.parse(line);
              const usage = entry.usage || entry.message?.usage;
              const model = entry.model || entry.message?.model || "";
              if (!usage) continue;
              const inTok = usage.input_tokens || 0;
              const outTok = usage.output_tokens || 0;
              if (!byModel[model]) byModel[model] = { inTokens: 0, outTokens: 0 };
              byModel[model].inTokens += inTok;
              byModel[model].outTokens += outTok;
            } catch {}
          }
        } catch {}
      }
    }
    let totalCost = 0;
    const modelBreakdown = [];
    for (const [model, usage] of Object.entries(byModel)) {
      const pricing = pricingPerM[model] || { inCost: 3, outCost: 15 };
      const cost =
        (usage.inTokens * pricing.inCost + usage.outTokens * pricing.outCost) / 1_000_000;
      totalCost += cost;
      modelBreakdown.push({ model, cost, inTokens: usage.inTokens, outTokens: usage.outTokens });
    }
    modelBreakdown.sort((a, b) => b.cost - a.cost);
    return { totalCost, sessions, byModel: modelBreakdown };
  } catch {
    return null;
  }
}

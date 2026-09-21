// forge cost report — the P8 measured-stage report (docs/plans/substrate-v2/05-cost-model.md).
// The cost model is multiplicative: C = C₀ · Π(1 − fᵢ) over independent stages. The discipline
// this module enforces is the paper's (§4, C6): a number is an assumption until measured. Every
// factor here is ARITHMETIC over .forge/metrics.jsonl lines that stages actually emitted; a
// stage with no events reports measured:false and value:null — it is never guessed, defaulted,
// or backfilled from a target. The ~90 % figure in the plan stays a TARGET everywhere in this
// module's output. The white paper's 62 % routing saving (§9) is cited only as REFUTED: the
// held-out replication (research/empirical-refutation) measured −20.2 % on total spend.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { read, record } from "./metrics.js";
import { MODELS } from "./model_tiers.js";
import { contentHash } from "./util.js";

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
 * Honest framing: unmeasured stages contribute exactly nothing (factor 0, not a target),
 * and it is never the plan's ~90 % target restated. It is NOT a bound in either direction:
 * a measured factor can be negative (routing that priced above the always-premium baseline
 * raises cost), so adding a measured stage can LOWER the figure, and an unmeasured stage
 * could move it either way once measured.
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
    "the composed figure covers measured stages only and is not a bound — a stage can be negative (it raised cost), so a newly measured stage can lower it; savings are not correctness-guarded until the P8 paired harness runs (05-cost-model.md §3)",
  );
  return { factors, composed, totals, caveats };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Human rendering. Register matters as much as arithmetic: measured numbers print as
 * measurements, the paper's 62 % routing figure prints only as REFUTED next to the measured
 * −20.2 % (never as a result), and the ~90 % figure appears only with the word "target" in
 * front of it — this report never claims it as achieved.
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
      ? `  composed measured reduction: ${pct(r.composed.measuredReduction)} (from: ${r.composed.stagesIncluded.join(", ")}) — measured stages only, not a bound (a stage can raise cost)`
      : "  composed measured reduction: 0.0% — no stage has recorded events yet",
  );
  lines.push(
    `  totals: ${r.totals.events} metric event(s) · ~${r.totals.savedEstimateTokens} tokens saved (stage self-estimates)`,
  );
  lines.push(
    "",
    "  context (not a local measurement): the paper's 62% routing saving (§9) is REFUTED — the held-out replication measured −20.2% on total spend: routing cost more than always-premium (research/empirical-refutation)",
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

/** The metrics `ref` for a task: a short content hash of the task text, never the text
 *  itself (metrics are telemetry, not a prompt log). The ONE recipe — `meterRoute` writes
 *  it and `lastRouteEscalation` reads it, so the two can never disagree on the key.
 *  @param {string} task */
export const routeRef = (task) => contentHash(String(task)).slice(0, 12);

/** Record one routed generation with its tier and real token counts. `escalateTo` is the
 *  routing verdict's ADVISORY escalation target (a proposer voted higher and was not
 *  applied) — recorded so a later EXTERNAL failure can name the tier instead of guessing.
 *  @param {string} root
 *  @param {{tier?: string, tokensIn?: number, tokensOut?: number, ref?: string,
 *           escalateTo?: string}} [opts] */
export function recordRoute(root, { tier, tokensIn, tokensOut, ref, escalateTo } = {}) {
  return record(root, { stage: "route", tier, tokensIn, tokensOut, ref, escalateTo });
}

/**
 * The advisory escalation tier routing recorded for this exact task, or "" if there is
 * none. Most recent wins — a task routed twice escalates to what the latest decision said.
 * Best-effort like every metrics read: a missing or corrupt log is "no target", never a
 * throw. Whitepaper §5.1 keeps the trigger elsewhere: this only ANSWERS "which tier",
 * it never decides that an escalation is warranted.
 * @param {string} root
 * @param {string} task the same task text that was routed
 * @returns {string}
 */
export function lastRouteEscalation(root, task) {
  if (!task) return "";
  try {
    const ref = routeRef(task);
    const hit = read(root, { stage: "route" })
      .filter((e) => e.ref === ref && typeof e.escalateTo === "string" && e.escalateTo)
      .pop();
    return hit ? hit.escalateTo : "";
  } catch {
    return "";
  }
}

/**
 * Anthropic prompt-caching prices as ratios of a model's BASE input price — the
 * model_tiers table carries base input/output only. A 5-minute cache write costs 1.25×,
 * a 1-hour write 2×, and a cache read 0.1× (Anthropic's published caching multipliers;
 * model-specific exceptions are not modeled). In Claude Code logs cache reads and writes
 * are most of the input, so leaving them out undercounts spend several-fold.
 */
export const CACHE_PRICE_RATIO = Object.freeze({ write5m: 1.25, write1h: 2, read: 0.1 });

/** Token counts of one `usage` object, cache writes split by TTL. Missing → 0. */
function usageTokens(usage) {
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const w1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const w5m = n(usage.cache_creation?.ephemeral_5m_input_tokens);
  // The total is authoritative; without a TTL breakdown every write is the 5-minute kind.
  const writes = Math.max(n(usage.cache_creation_input_tokens), w5m + w1h);
  return {
    inTokens: n(usage.input_tokens),
    outTokens: n(usage.output_tokens),
    cacheWrite5mTokens: writes - w1h,
    cacheWrite1hTokens: w1h,
    cacheReadTokens: n(usage.cache_read_input_tokens),
  };
}

/**
 * Fallback spend estimation from Claude's native JSONL session logs when ccusage
 * is unavailable. Scans ~/.claude/projects/ for session files and computes cost
 * from token counts x model_tiers pricing — uncached input and output at the model's
 * rates, cache writes and reads at CACHE_PRICE_RATIO of its input rate. Claude Code
 * writes one API response on several lines (one per content block), each repeating the
 * same message id and usage, and a resumed session re-logs its history into a new file,
 * so each message id is counted once across every file. Best-effort, never throws.
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
    const seen = new Set();
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
              const id = entry.message?.id ?? entry.requestId ?? null;
              if (id) {
                if (seen.has(id)) continue; // the same response, logged again
                seen.add(id);
              }
              const t = usageTokens(usage);
              const acc = (byModel[model] ??= {
                inTokens: 0,
                outTokens: 0,
                cacheWrite5mTokens: 0,
                cacheWrite1hTokens: 0,
                cacheReadTokens: 0,
              });
              for (const k of Object.keys(acc)) acc[k] += t[k];
            } catch {}
          }
        } catch {}
      }
    }
    let totalCost = 0;
    const modelBreakdown = [];
    for (const [model, u] of Object.entries(byModel)) {
      const pricing = pricingPerM[model] || { inCost: 3, outCost: 15 };
      const cost =
        (u.inTokens * pricing.inCost +
          u.outTokens * pricing.outCost +
          u.cacheWrite5mTokens * pricing.inCost * CACHE_PRICE_RATIO.write5m +
          u.cacheWrite1hTokens * pricing.inCost * CACHE_PRICE_RATIO.write1h +
          u.cacheReadTokens * pricing.inCost * CACHE_PRICE_RATIO.read) /
        1_000_000;
      totalCost += cost;
      modelBreakdown.push({
        model,
        cost,
        inTokens: u.inTokens,
        outTokens: u.outTokens,
        cacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
        cacheReadTokens: u.cacheReadTokens,
      });
    }
    modelBreakdown.sort((a, b) => b.cost - a.cost);
    return { totalCost, sessions, byModel: modelBreakdown };
  } catch {
    return null;
  }
}

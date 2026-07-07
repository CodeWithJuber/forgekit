// forge metrics — the measurement backbone of the cost model
// (docs/plans/substrate-v2/05-cost-model.md): every substrate stage appends one
// JSONL line, and savings are later ARITHMETIC on these lines, never an estimate
// asserted after the fact. Append-only, corrupt-line tolerant, best-effort — a
// metrics failure must never break the stage it measures.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const metricsPath = (root = process.cwd()) => join(root, ".forge", "metrics.jsonl");

/**
 * Record one stage event: { t?, stage, outcome?, tokensIn?, tokensOut?, savedEstimate?,
 * tier?, ref?, ... }. `t` defaults to wall-clock ms (metrics are telemetry, not
 * content-addressed protocol state — clock use is fine here, unlike the ledger).
 */
export function record(root, entry) {
  try {
    const dir = join(root, ".forge");
    mkdirSync(dir, { recursive: true });
    appendFileSync(metricsPath(root), `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** All events, oldest first (corrupt lines skipped). Optional stage filter.
 *  @param {string} root
 *  @param {{stage?: string}} [opts] */
export function read(root, { stage } = {}) {
  const path = metricsPath(root);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!stage || e.stage === stage) out.push(e);
    } catch {}
  }
  return out;
}

/** Counts by stage → outcome, plus summed token-saving estimates per stage. */
export function summarize(root) {
  const stages = {};
  for (const e of read(root)) {
    const s = (stages[e.stage] ??= { events: 0, byOutcome: {}, savedEstimate: 0 });
    s.events++;
    if (e.outcome) s.byOutcome[e.outcome] = (s.byOutcome[e.outcome] ?? 0) + 1;
    if (Number.isFinite(e.savedEstimate)) s.savedEstimate += e.savedEstimate;
  }
  return stages;
}

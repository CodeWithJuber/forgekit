// forge budget — cost governance: per-day and per-task (session) spend budgets,
// alert thresholds, and an opt-in circuit breaker for the cost guard.
//
// The budget lives in `.forge/forge.config.json` under the `budget` key — unknown keys
// round-trip through writeForgeConfig, so this needs no config-schema change. Spend is
// read from ccusage when installed, else estimateSpendFromLogs (the same precedence as
// `forge cost`). Everything here is best-effort: a missing tool, an unreadable log, or a
// corrupt state file yields "unknown", never a throw — a governor that crashes the hook
// it guards governs nothing.
//
// Honesty rules, stated once:
// - A day or task with no measurable spend is UNKNOWN, not $0. Unknown never triggers
//   an alert or a block; it reports itself as unknown.
// - "Per-task" means per session (the guard's session_id). Task spend is derived as
//   (today's spend − spend when the session started), which is exact only when one
//   session spends at a time — the status output says so.
// - The circuit breaker (`hard: true`) is strictly opt-in. The default is the historic
//   behavior: over budget ASKS the human, exactly like FORGE_COST_CEILING always did.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateSpendFromLogs } from "./cost_report.js";
import { readForgeConfig, writeForgeConfig } from "./repo_config.js";

/** Default alert threshold: warn when spend reaches 80 % of a budget. */
export const DEFAULT_ALERT_AT = 0.8;
/** Historic daily ceiling (the cost-budget guard's FORGE_COST_CEILING default). */
export const DEFAULT_DAILY_CEILING = 10;
/** Session baselines older than this are pruned from the state file. */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_REL = ".forge/budget-state.json";

/**
 * Validate a budget patch. Pure. Accepts a partial object; every present key is
 * checked and the clean budget returned. `null` clears a key.
 * @param {unknown} patch
 * @returns {{ok:true, budget:{daily?:number|null, perTask?:number|null, alertAt:number, hard:boolean}}|{ok:false, errors:string[]}}
 */
export function validateBudget(patch) {
  const errors = [];
  const p = patch && typeof patch === "object" ? patch : {};
  const num = (v, name) => {
    if (v === undefined || v === null) return v;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${name} must be a positive number (got ${JSON.stringify(v)})`);
    return n;
  };
  const daily = num(p.daily, "daily");
  const perTask = num(p.perTask, "perTask");
  let alertAt = DEFAULT_ALERT_AT;
  if (p.alertAt !== undefined && p.alertAt !== null) {
    alertAt = Number(p.alertAt);
    if (!Number.isFinite(alertAt) || alertAt <= 0 || alertAt >= 1)
      errors.push(`alertAt must be between 0 and 1 exclusive (got ${JSON.stringify(p.alertAt)})`);
  }
  let hard = false;
  if (p.hard !== undefined && p.hard !== null) {
    if (typeof p.hard !== "boolean") errors.push(`hard must be a boolean (got ${JSON.stringify(p.hard)})`);
    else hard = p.hard;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, budget: { daily, perTask, alertAt, hard } };
}

/**
 * The effective budget: `.forge/forge.config.json`'s `budget` key overlaid by the
 * environment. `FORGE_COST_CEILING` (the historic guard variable) overrides
 * `budget.daily` when set — env wins so existing setups keep working. Never throws.
 * @param {string} [root]
 * @returns {{daily:number|null, perTask:number|null, alertAt:number, hard:boolean,
 *   dailySource:"env"|"config"|"default"|"none", configured:boolean}}
 */
export function readBudget(root = process.cwd()) {
  let cfg = {};
  try {
    cfg = readForgeConfig(root)?.budget ?? {};
  } catch {
    cfg = {};
  }
  const valid = validateBudget(cfg);
  const b = valid.ok ? valid.budget : { daily: undefined, perTask: undefined, alertAt: DEFAULT_ALERT_AT, hard: false };
  // Env override for the daily ceiling (historic behavior; documented precedence).
  const envDaily = process.env.FORGE_COST_CEILING;
  let daily = b.daily ?? null;
  let dailySource = daily != null ? "config" : "none";
  if (envDaily !== undefined && envDaily !== "") {
    const n = Number(envDaily);
    if (Number.isFinite(n) && n > 0) {
      daily = n;
      dailySource = "env";
    }
  }
  // The historic guard default: without any configuration the ceiling is $10/day.
  // It only ASKS (soft) — the breaker stays opt-in.
  if (daily == null) {
    daily = DEFAULT_DAILY_CEILING;
    dailySource = "default";
  }
  return {
    daily,
    perTask: b.perTask ?? null,
    alertAt: b.alertAt,
    hard: b.hard,
    dailySource,
    configured: (cfg && typeof cfg === "object" && Object.keys(cfg).length > 0) || dailySource === "env",
  };
}

/**
 * Persist a budget patch into `.forge/forge.config.json`. Never throws — returns
 * `{ok:false}` with the reason instead.
 * @param {string} root
 * @param {unknown} patch partial budget
 */
export function writeBudget(root, patch) {
  const v = validateBudget(patch);
  if (!v.ok) return { ok: false, errors: v.errors };
  try {
    const res = writeForgeConfig(root, (cfg) => {
      // `undefined` = leave the key alone; `null` = clear it. Spreading the raw
      // validated object would overwrite an existing value with undefined.
      const patch = Object.fromEntries(
        Object.entries(v.budget).filter(([, val]) => val !== undefined),
      );
      const next = { ...(cfg.budget ?? {}), ...patch };
      for (const k of ["daily", "perTask"]) if (patch[k] === null) delete next[k];
      if (Object.keys(next).length === 0) delete cfg.budget;
      else cfg.budget = next;
      return cfg;
    });
    if (res.ok === false) return { ok: false, errors: [res.reason] };
    return { ok: true, budget: readBudget(root) };
  } catch (e) {
    return { ok: false, errors: [String(e?.message ?? e)] };
  }
}

/**
 * Clear budget keys: `which` is "daily", "perTask", or "all" (default). Never throws.
 * @param {string} root
 * @param {"daily"|"perTask"|"all"} [which]
 */
export function clearBudget(root, which = "all") {
  try {
    const res = writeForgeConfig(root, (cfg) => {
      if (!cfg.budget) return cfg;
      if (which === "all") delete cfg.budget;
      else delete cfg.budget[which];
      if (cfg.budget && Object.keys(cfg.budget).length === 0) delete cfg.budget;
      return cfg;
    });
    if (res.ok === false) return { ok: false, errors: [res.reason] };
    return { ok: true, budget: readBudget(root) };
  } catch (e) {
    return { ok: false, errors: [String(e?.message ?? e)] };
  }
}

// ---------------------------------------------------------------------------
// Spend reading — ccusage first, estimateSpendFromLogs as fallback (same as
// `forge cost`). Seams (`runCcusage`, `estimateFn`) keep this unit-testable.
// ---------------------------------------------------------------------------

/** Extract today's total cost from `ccusage daily --json` output. The guard's
 *  historic heuristic was "first totalCost in the text"; the structured parse
 *  prefers the `daily` array's first row (today) and falls back to that regex.
 *  @param {string} text
 *  @returns {number|null} */
export function parseCcusageDaily(text) {
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed?.daily;
    if (Array.isArray(rows) && rows.length) {
      const c = Number(rows[0]?.totalCost);
      if (Number.isFinite(c) && c >= 0) return c;
    }
  } catch {
    // fall through to the regex heuristic
  }
  const m = /"totalCost"\s*:\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Today's spend in USD. Never throws; unmeasurable → `{amount: null}`.
 * @param {{root?:string, runCcusage?:()=>string, estimateFn?:(opts:any)=>any}} [opts]
 */
export function readSpend({ root = process.cwd(), runCcusage, estimateFn } = {}) {
  const at = new Date().toISOString();
  try {
    const run = runCcusage ?? (() => execFileSync("ccusage", ["daily", "--json"], { encoding: "utf8", stdio: "pipe", timeout: 15000 }));
    const amount = parseCcusageDaily(run());
    if (amount != null) return { amount, source: "ccusage", at };
  } catch {
    // ccusage missing or failed — fall through to the log estimate
  }
  try {
    const est = (estimateFn ?? estimateSpendFromLogs)({ root });
    if (est && Number.isFinite(est.totalCost) && est.totalCost > 0)
      return { amount: est.totalCost, source: "estimate", at, complete: est.complete !== false };
  } catch {
    // ignore — unknown spend below
  }
  return { amount: null, source: null, at };
}

// ---------------------------------------------------------------------------
// Session state — per-task baselines in `.forge/budget-state.json`. Best-effort;
// a missing or corrupt file is "no baselines", never a throw.
// ---------------------------------------------------------------------------

function readState(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, STATE_REL), "utf8"));
    if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object")
      return raw.sessions;
  } catch {
    // missing or corrupt → no baselines
  }
  return {};
}

function writeState(root, sessions) {
  try {
    const now = Date.now();
    const pruned = Object.fromEntries(
      Object.entries(sessions).filter(([, s]) => now - Number(s?.at ?? 0) < STATE_TTL_MS),
    );
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(join(root, STATE_REL), `${JSON.stringify({ sessions: pruned }, null, 2)}\n`);
  } catch {
    // state is telemetry — losing it degrades to re-baselining, never an error
  }
}

/**
 * The spend baseline for a session: recorded on first sight, returned afterwards.
 * Prunes baselines older than 7 days on write.
 * @param {string} root
 * @param {string} sid
 * @param {number|null} spend today's spend right now (null → no baseline possible)
 * @returns {number|null} the baseline, or null when spend is unknown
 */
export function sessionBaseline(root, sid, spend) {
  if (!sid || spend == null) return null;
  const sessions = readState(root);
  const now = Date.now();
  if (sessions[sid] && Number.isFinite(sessions[sid].baseline)) return sessions[sid].baseline;
  sessions[sid] = { baseline: spend, at: now };
  writeState(root, sessions);
  return spend;
}

/**
 * This session's spend: today's spend minus its baseline. Null when either is
 * unknown. Never negative (a fresh day resets ccusage; clamp, don't confuse).
 * @param {string} root
 * @param {string} sid
 * @param {number|null} spend
 * @returns {number|null}
 */
export function sessionSpend(root, sid, spend) {
  const base = sessionBaseline(root, sid, spend);
  if (base == null || spend == null) return null;
  return Math.max(0, spend - base);
}

/** All tracked sessions with their current spend. Best-effort.
 *  @param {string} root
 *  @param {number|null} spend today's spend
 *  @returns {{sid:string, baseline:number|null, spend:number|null, at:number}[]} */
export function listSessions(root, spend) {
  const sessions = readState(root);
  return Object.entries(sessions).map(([sid, s]) => ({
    sid,
    baseline: Number.isFinite(s?.baseline) ? s.baseline : null,
    spend: s && Number.isFinite(s.baseline) && spend != null ? Math.max(0, spend - s.baseline) : null,
    at: Number(s?.at) || 0,
  }));
}

// ---------------------------------------------------------------------------
// Evaluation — pure. One decision for the guard, plus human-readable notes.
// ---------------------------------------------------------------------------

const money = (n) => `$${n.toFixed(2)}`;

/**
 * Evaluate spend against the budget. Pure.
 * @param {{dailySpend:number|null, taskSpend:number|null,
 *   budget:{daily:number|null, perTask:number|null, alertAt:number, hard:boolean}}} opts
 * @returns {{daily:{limit:number|null, spend:number|null, ratio:number|null, state:string},
 *   task:{limit:number|null, spend:number|null, ratio:number|null, state:string}|null,
 *   decision:"allow"|"ask"|"deny", notes:string[]}}
 */
export function evaluateBudget({ dailySpend, taskSpend, budget }) {
  const limb = (spend, limit) => {
    if (limit == null) return { limit, spend, ratio: null, state: "unlimited" };
    if (spend == null) return { limit, spend, ratio: null, state: "unknown" };
    const ratio = spend / limit;
    const state = ratio >= 1 ? "over" : ratio >= budget.alertAt ? "alert" : "ok";
    return { limit, spend, ratio, state };
  };
  const daily = limb(dailySpend, budget.daily);
  const task = budget.perTask != null ? limb(taskSpend, budget.perTask) : null;
  const notes = [];
  for (const [name, l] of [["day", daily], ...(task ? [["task", task]] : [])]) {
    if (l.state === "alert")
      notes.push(`${name} spend ${money(l.spend)} is at ${Math.round(l.ratio * 100)}% of the ${money(l.limit)} budget`);
    else if (l.state === "over")
      notes.push(`${name} spend ${money(l.spend)} exceeds the ${money(l.limit)} budget`);
  }
  const over = [daily, task].some((l) => l?.state === "over");
  const decision = over ? (budget.hard ? "deny" : "ask") : "allow";
  return { daily, task, decision, notes };
}

/** The guard-facing verdict: decision + one actionable reason line.
 *  @param {ReturnType<typeof evaluateBudget>} ev
 *  @param {{daily:number|null, perTask:number|null, hard:boolean}} budget */
export function verdictReason(ev, budget) {
  const overLimbs = [ev.daily.state === "over" && ["day", ev.daily], ev.task?.state === "over" && ["task", ev.task]].filter(Boolean);
  if (!overLimbs.length) return "";
  const parts = overLimbs.map(([name, l]) => `${name} spend ${money(l.spend)} > ${money(l.limit)} budget`);
  const fix = budget.hard
    ? "Raise it with `forge budget set --daily <n>`, or `forge budget clear`."
    : "Continue, switch to a cheaper model, scope the task, or raise the budget with `forge budget set --daily <n>`.";
  return `forge budget: ${parts.join("; ")}. ${fix}`;
}

/**
 * Human rendering of `forge budget status`.
 * @param {{budget:ReturnType<typeof readBudget>, spend:{amount:number|null, source:string|null},
 *   sessions:{sid:string, spend:number|null}[]}} opts
 */
export function renderBudgetStatus({ budget, spend, sessions }) {
  const lines = ["Forge budget — spend vs budget", ""];
  const bar = (ratio) => {
    if (ratio == null) return "[unknown]";
    const filled = Math.min(20, Math.round(ratio * 20));
    return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.round(ratio * 100)}%`;
  };
  const spendTxt = spend.amount == null ? "unknown" : `${money(spend.amount)}${spend.source ? ` (${spend.source})` : ""}`;
  const ev = evaluateBudget({ dailySpend: spend.amount, taskSpend: null, budget });
  lines.push(`  today  ${spendTxt} of ${money(budget.daily)} ${bar(ev.daily.ratio)}  [${ev.daily.state}]`);
  if (budget.perTask != null) {
    lines.push(`  per-task budget ${money(budget.perTask)} — session spend:`);
    if (!sessions.length) lines.push("    (no sessions tracked yet — the guard records one per session)");
    for (const s of sessions.slice(0, 8)) {
      const st = s.spend == null ? "unknown" : `${money(s.spend)} ${bar(budget.perTask ? s.spend / budget.perTask : null)}`;
      lines.push(`    ${s.sid.slice(0, 12)}  ${st}`);
    }
    if (sessions.length > 8) lines.push(`    …and ${sessions.length - 8} more`);
  } else {
    lines.push("  per-task budget: not set (`forge budget set --per-task <n>`)");
  }
  lines.push(
    "",
    `  alert at ${Math.round(budget.alertAt * 100)}% · breaker: ${budget.hard ? "HARD (blocks tool calls over budget)" : "soft (asks you over budget)"} · daily source: ${budget.dailySource}`,
    spend.amount == null ? "  spend is unknown — install ccusage for precise tracking: npm i -g ccusage" : "",
  );
  return lines.filter((l) => l !== "").join("\n");
}

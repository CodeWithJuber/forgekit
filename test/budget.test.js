import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearBudget,
  DEFAULT_ALERT_AT,
  DEFAULT_DAILY_CEILING,
  evaluateBudget,
  listSessions,
  parseCcusageDaily,
  readBudget,
  readSpend,
  renderBudgetStatus,
  sessionBaseline,
  sessionSpend,
  validateBudget,
  verdictReason,
  writeBudget,
} from "../src/budget.js";

const tmp = () => mkdtempSync(join(tmpdir(), "forge-budget-"));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// process.execPath (not "node") so tests can run with an empty PATH — the seam that
// simulates "ccusage is not installed" deterministically.
const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1", ...env },
  });
/** A PATH with no binaries: ccusage lookup fails, the CLI falls back to "unknown". */
const noBin = () => mkdtempSync(join(tmpdir(), "forge-nobin-"));

// --- validateBudget: pure validation -----------------------------------------

test("validateBudget: a sane partial patch validates with defaults filled", () => {
  const r = validateBudget({ daily: 10, perTask: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.budget.daily, 10);
  assert.equal(r.budget.perTask, 2);
  assert.equal(r.budget.alertAt, DEFAULT_ALERT_AT);
  assert.equal(r.budget.hard, false);
});

test("validateBudget: non-positive / non-numeric money is refused", () => {
  for (const bad of [0, -5, "free", NaN, Infinity]) {
    const r = validateBudget({ daily: bad });
    assert.equal(r.ok, false, `daily=${JSON.stringify(bad)} must fail`);
    assert.ok(r.errors.length > 0);
  }
});

test("validateBudget: alertAt must be strictly between 0 and 1", () => {
  for (const bad of [0, 1, 1.5, -0.1, "soon"]) assert.equal(validateBudget({ alertAt: bad }).ok, false);
  assert.equal(validateBudget({ alertAt: 0.5 }).ok, true);
});

test("validateBudget: hard must be a boolean", () => {
  assert.equal(validateBudget({ hard: "yes" }).ok, false);
  assert.equal(validateBudget({ hard: true }).budget.hard, true);
});

test("validateBudget: null clears a key, undefined leaves it alone", () => {
  const r = validateBudget({ daily: null });
  assert.equal(r.ok, true);
  assert.equal(r.budget.daily, null);
  assert.equal(r.budget.perTask, undefined);
});

// --- readBudget: config + env precedence -------------------------------------

test("readBudget: no config → historic $10/day soft default", () => {
  const b = readBudget(tmp());
  assert.equal(b.daily, DEFAULT_DAILY_CEILING);
  assert.equal(b.dailySource, "default");
  assert.equal(b.hard, false);
  assert.equal(b.perTask, null);
});

test("readBudget: config budget is respected", () => {
  const root = tmp();
  assert.equal(writeBudget(root, { daily: 25, perTask: 3, hard: true }).ok, true);
  const b = readBudget(root);
  assert.equal(b.daily, 25);
  assert.equal(b.dailySource, "config");
  assert.equal(b.perTask, 3);
  assert.equal(b.hard, true);
});

test("readBudget: FORGE_COST_CEILING overrides config daily", () => {
  const root = tmp();
  writeBudget(root, { daily: 25 });
  const prev = process.env.FORGE_COST_CEILING;
  process.env.FORGE_COST_CEILING = "7";
  try {
    const b = readBudget(root);
    assert.equal(b.daily, 7);
    assert.equal(b.dailySource, "env");
  } finally {
    if (prev === undefined) delete process.env.FORGE_COST_CEILING;
    else process.env.FORGE_COST_CEILING = prev;
  }
});

test("readBudget: corrupt config never throws — falls back to defaults", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "forge.config.json"), "{not json");
  const b = readBudget(root); // warns once on stderr, returns defaults
  assert.equal(b.daily, DEFAULT_DAILY_CEILING);
});

// --- writeBudget / clearBudget: round-trip through the unified config --------

test("writeBudget: writes the budget key, preserves other keys", () => {
  const root = tmp();
  writeBudget(root, { daily: 10 });
  writeBudget(root, { perTask: 2, hard: true });
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  assert.equal(cfg.budget.daily, 10);
  assert.equal(cfg.budget.perTask, 2);
  assert.equal(cfg.budget.hard, true);
});

test("writeBudget: invalid patch refuses and leaves the file untouched", () => {
  const root = tmp();
  writeBudget(root, { daily: 10 });
  const before = readFileSync(join(root, ".forge", "forge.config.json"), "utf8");
  const r = writeBudget(root, { daily: -3 });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"), before);
});

test("clearBudget: clears one key or all", () => {
  const root = tmp();
  writeBudget(root, { daily: 10, perTask: 2 });
  assert.equal(clearBudget(root, "daily").ok, true);
  let b = readBudget(root);
  assert.equal(b.daily, DEFAULT_DAILY_CEILING); // back to the default ceiling
  assert.equal(b.dailySource, "default");
  assert.equal(b.perTask, 2);
  assert.equal(clearBudget(root, "all").ok, true);
  b = readBudget(root);
  assert.equal(b.perTask, null);
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  assert.ok(!("budget" in cfg), "empty budget object is removed, not left as {}");
});

// --- parseCcusageDaily -------------------------------------------------------

test("parseCcusageDaily: structured daily array → today's totalCost", () => {
  assert.equal(parseCcusageDaily('{"daily":[{"date":"2026-09-28","totalCost":4.25}]}'), 4.25);
  assert.equal(parseCcusageDaily('[{"totalCost":1.5},{"totalCost":9}]'), 1.5);
});

test("parseCcusageDaily: falls back to the guard's historic first-totalCost heuristic", () => {
  assert.equal(parseCcusageDaily('noise "totalCost":3.75 trailing'), 3.75);
  assert.equal(parseCcusageDaily("nothing here"), null);
  assert.equal(parseCcusageDaily(""), null);
});

// --- readSpend: ccusage → estimate → unknown ---------------------------------

test("readSpend: ccusage wins when it works", () => {
  const s = readSpend({ runCcusage: () => '{"daily":[{"totalCost":2.5}]}' });
  assert.deepEqual([s.amount, s.source], [2.5, "ccusage"]);
});

test("readSpend: falls back to the log estimate when ccusage fails", () => {
  const s = readSpend({
    runCcusage: () => {
      throw new Error("ENOENT");
    },
    estimateFn: () => ({ totalCost: 1.25, complete: true }),
  });
  assert.deepEqual([s.amount, s.source], [1.25, "estimate"]);
});

test("readSpend: unmeasurable spend is null, never a throw", () => {
  const s = readSpend({
    runCcusage: () => {
      throw new Error("ENOENT");
    },
    estimateFn: () => null,
  });
  assert.equal(s.amount, null);
  assert.equal(s.source, null);
});

// --- session baselines --------------------------------------------------------

test("sessionBaseline: first sight records, later calls return the same baseline", () => {
  const root = tmp();
  assert.equal(sessionBaseline(root, "s1", 4.0), 4.0);
  assert.equal(sessionBaseline(root, "s1", 6.5), 4.0); // not re-baselined mid-session
  assert.equal(sessionSpend(root, "s1", 6.5), 2.5);
});

test("sessionSpend: null spend → null (unknown, not zero)", () => {
  const root = tmp();
  assert.equal(sessionSpend(root, "s1", null), null);
  assert.equal(sessionBaseline(root, "s1", null), null);
});

test("sessionSpend: a fresh day (spend below baseline) clamps to 0, never negative", () => {
  const root = tmp();
  sessionBaseline(root, "s1", 9.0);
  assert.equal(sessionSpend(root, "s1", 1.0), 0);
});

test("session state: corrupt state file re-baselines instead of throwing", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "budget-state.json"), "garbage{{{");
  assert.equal(sessionBaseline(root, "s1", 3.0), 3.0);
});

test("listSessions: reports each session's spend against today's total", () => {
  const root = tmp();
  sessionBaseline(root, "a", 2.0);
  sessionBaseline(root, "b", 5.0);
  const list = listSessions(root, 7.0);
  assert.equal(list.length, 2);
  assert.deepEqual(
    Object.fromEntries(list.map((s) => [s.sid, s.spend])),
    { a: 5.0, b: 2.0 },
  );
});

// --- evaluateBudget: the pure decision table ----------------------------------

const B = (over = {}) => ({ daily: 10, perTask: 2, alertAt: 0.8, hard: false, ...over });

test("evaluateBudget: comfortably under → allow, no notes", () => {
  const ev = evaluateBudget({ dailySpend: 3, taskSpend: 0.5, budget: B() });
  assert.equal(ev.decision, "allow");
  assert.deepEqual(ev.notes, []);
  assert.equal(ev.daily.state, "ok");
});

test("evaluateBudget: at the alert threshold → allow with a nudge note", () => {
  const ev = evaluateBudget({ dailySpend: 8.5, taskSpend: 0.5, budget: B() });
  assert.equal(ev.decision, "allow");
  assert.equal(ev.daily.state, "alert");
  assert.ok(ev.notes.some((n) => n.includes("80%") || n.includes("85%")));
});

test("evaluateBudget: over budget, soft → ask; hard → deny", () => {
  const ask = evaluateBudget({ dailySpend: 12, taskSpend: 0.5, budget: B() });
  assert.equal(ask.decision, "ask");
  const deny = evaluateBudget({ dailySpend: 12, taskSpend: 0.5, budget: B({ hard: true }) });
  assert.equal(deny.decision, "deny");
});

test("evaluateBudget: per-task over triggers even when the day is fine", () => {
  const ev = evaluateBudget({ dailySpend: 3, taskSpend: 2.5, budget: B() });
  assert.equal(ev.decision, "ask");
  assert.equal(ev.task.state, "over");
});

test("evaluateBudget: unknown spend never alerts or blocks", () => {
  const ev = evaluateBudget({ dailySpend: null, taskSpend: null, budget: B() });
  assert.equal(ev.decision, "allow");
  assert.equal(ev.daily.state, "unknown");
});

test("evaluateBudget: no per-task budget → task is null, not zero", () => {
  const ev = evaluateBudget({ dailySpend: 3, taskSpend: 99, budget: B({ perTask: null }) });
  assert.equal(ev.task, null);
  assert.equal(ev.decision, "allow");
});

test("verdictReason: names the breached budget and the fix; empty when fine", () => {
  const ev = evaluateBudget({ dailySpend: 12, taskSpend: 0.5, budget: B({ hard: true }) });
  const r = verdictReason(ev, B({ hard: true }));
  assert.match(r, /\$12\.00/);
  assert.match(r, /\$10\.00/);
  assert.match(r, /forge budget set/);
  const ok = evaluateBudget({ dailySpend: 3, taskSpend: 0.5, budget: B() });
  assert.equal(verdictReason(ok, B()), "");
});

// --- renderBudgetStatus -------------------------------------------------------

test("renderBudgetStatus: the meter shows spend, budget, breaker mode", () => {
  const out = renderBudgetStatus({
    budget: { ...B({ hard: true }), dailySource: "config" },
    spend: { amount: 6.4, source: "ccusage" },
    sessions: [{ sid: "abcdef1234567890", spend: 1.1 }],
  });
  assert.match(out, /\$6\.40/);
  assert.match(out, /\$10\.00/);
  assert.match(out, /HARD/);
  assert.match(out, /abcdef123456/);
});

test("renderBudgetStatus: unknown spend says unknown, never $0", () => {
  const out = renderBudgetStatus({
    budget: { ...B(), dailySource: "default" },
    spend: { amount: null, source: null },
    sessions: [],
  });
  assert.match(out, /unknown/);
  assert.doesNotMatch(out, /\$0\.00 of/);
});

// --- CLI boundary: exit codes and routing are the contract --------------------

test("CLI: budget set writes config and status shows the meter", () => {
  const root = tmp();
  let r = run(["budget", "set", "--daily", "10", "--per-task", "2"], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\$10\.00/);
  r = run(["budget", "status"], root, { PATH: noBin() }); // no ccusage → unknown spend
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unknown/);
});

test("CLI: budget set refuses a negative daily without touching config", () => {
  const root = tmp();
  const r = run(["budget", "set", "--daily", "-5"], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /positive/);
});

test("CLI: budget check prints the guard protocol", () => {
  const root = tmp();
  run(["budget", "set", "--daily", "10"], root);
  const r = run(["budget", "check", "--session-id", "s1"], root, { PATH: noBin() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^decision: (allow|context|ask|deny)$/m);
  assert.match(r.stdout, /^reason: /m);
});

test("CLI: budget check needs --session-id", () => {
  const root = tmp();
  const r = run(["budget", "check"], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /session-id/);
});

test("CLI: budget clear removes the budget", () => {
  const root = tmp();
  run(["budget", "set", "--daily", "10", "--per-task", "2"], root);
  const r = run(["budget", "clear"], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cleared/);
});

test("CLI: budget --help renders the registered command help", () => {
  const r = run(["budget", "--help"], tmp());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /circuit breaker/i);
});

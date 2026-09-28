// forge CLI — the budget commands: `budget set|status|clear|check`. Moved into its
// own module like the other domains (review A03): dispatch and presentation here,
// domain logic in ../budget.js. cli.js registers these into its dispatch table;
// nothing here runs at import time.
import {
  clearBudget,
  evaluateBudget,
  listSessions,
  readBudget,
  readSpend,
  renderBudgetStatus,
  sessionSpend,
  verdictReason,
  writeBudget,
} from "../budget.js";
import { BRAND, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

/** Minimal flag parser: `--key value` / `--key=value` / `--flag`. Unknown flags throw. */
function parseFlags(argv, known) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    const key = (eq === -1 ? a : a.slice(0, eq)).slice(2);
    if (!known.includes(key)) throw new Error(`unknown flag: --${key}`);
    out[key] = eq === -1 ? (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i]) : a.slice(eq + 1);
  }
  return out;
}

const money = (n) => `$${Number(n).toFixed(2)}`;

async function cmdSet(root, argv) {
  const f = parseFlags(argv, ["daily", "per-task", "alert-at", "hard", "soft", "json"]);
  if (f.hard && f.soft) throw new Error("pick one: --hard or --soft");
  const patch = {};
  if (f.daily !== undefined) patch.daily = f.daily === "none" ? null : f.daily;
  if (f["per-task"] !== undefined) patch.perTask = f["per-task"] === "none" ? null : f["per-task"];
  if (f["alert-at"] !== undefined) patch.alertAt = f["alert-at"];
  if (f.hard) patch.hard = true;
  if (f.soft) patch.hard = false;
  if (!Object.keys(patch).length)
    throw new Error("nothing to set — e.g. `forge budget set --daily 10 --per-task 2 --hard`");
  const res = writeBudget(root, patch);
  if (!res.ok) {
    for (const e of res.errors) console.error(`  ${BRAND.cli} budget: ${e}`);
    process.exitCode = 1;
    return;
  }
  const b = res.budget;
  if (f.json) return console.log(JSON.stringify(b, null, 2));
  heading(`${BRAND.brand} budget — updated\n`);
  console.log(`  daily     ${b.daily != null ? money(b.daily) : "unlimited"}${b.dailySource === "env" ? "  (FORGE_COST_CEILING overrides the config)" : ""}`);
  console.log(`  per-task  ${b.perTask != null ? money(b.perTask) : "not set"}`);
  console.log(`  alert at  ${Math.round(b.alertAt * 100)}% of a budget`);
  console.log(`  breaker   ${b.hard ? "HARD — tool calls are blocked over budget" : "soft — the guard asks you over budget"}`);
  console.log(paint("\n  the cost guard enforces this on every tool call (checked 1/100 calls)", "dim"));
}

async function cmdStatus(root, argv) {
  const f = parseFlags(argv, ["json"]);
  const budget = readBudget(root);
  const spend = readSpend({ root });
  const sessions = spend.amount != null ? listSessions(root, spend.amount) : [];
  if (f.json)
    return console.log(
      JSON.stringify(
        { budget, spend, sessions, evaluation: evaluateBudget({ dailySpend: spend.amount, taskSpend: null, budget }) },
        null,
        2,
      ),
    );
  console.log(renderBudgetStatus({ budget, spend, sessions }));
}

/** Guard protocol: `decision: <allow|context|ask|deny>` + `reason: <one line>`.
 *  Always exits 0 — the guard, not the exit code, decides what to do. */
async function cmdCheck(root, argv) {
  const f = parseFlags(argv, ["session-id", "json"]);
  const sid = f["session-id"];
  if (!sid) throw new Error("`forge budget check` needs --session-id <sid>");
  const budget = readBudget(root);
  const spend = readSpend({ root });
  const taskSpend = spend.amount != null ? sessionSpend(root, sid, spend.amount) : null;
  const ev = evaluateBudget({ dailySpend: spend.amount, taskSpend, budget });
  // An alert (not over) surfaces as a context nudge, not a question — the guard
  // throttles spend checks to 1/100 calls, so this can't nag every call.
  const decision = ev.decision === "allow" && ev.notes.length ? "context" : ev.decision;
  const reason = ev.decision === "allow" ? ev.notes.join("; ") : verdictReason(ev, budget);
  if (f.json)
    return console.log(JSON.stringify({ decision, reason, evaluation: ev, spend, budget }, null, 2));
  console.log(`decision: ${decision}`);
  console.log(`reason: ${reason}`);
}

async function cmdClear(root, argv) {
  const f = parseFlags(argv, ["daily", "per-task", "json"]);
  const which = f.daily ? "daily" : f["per-task"] ? "perTask" : "all";
  const res = clearBudget(root, which);
  if (!res.ok) {
    for (const e of res.errors) console.error(`  ${BRAND.cli} budget: ${e}`);
    process.exitCode = 1;
    return;
  }
  if (f.json) return console.log(JSON.stringify(res.budget, null, 2));
  console.log(
    which === "all"
      ? "  budget cleared — the guard falls back to the $10/day soft ceiling (FORGE_COST_CEILING to change it)"
      : `  ${which} budget cleared`,
  );
}

HANDLERS.budget = async (argv) => {
  const root = process.cwd();
  const [sub, ...rest] = argv.slice(1);
  try {
    if (sub === "set") return cmdSet(root, rest);
    if (sub === "status" || sub === undefined) return cmdStatus(root, rest);
    if (sub === "clear") return cmdClear(root, rest);
    if (sub === "check") return cmdCheck(root, rest);
    throw new Error(`unknown subcommand: ${sub} — set | status | clear | check`);
  } catch (e) {
    console.error(`  ${BRAND.cli} budget: ${e.message}`);
    console.error(paint(`  usage: ${BRAND.cli} budget set --daily 10 --per-task 2 [--alert-at 0.8] [--hard|--soft]`, "dim"));
    process.exitCode = 1;
  }
};

export default HANDLERS;

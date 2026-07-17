// forge verify — the independent verification layer. Deterministic-first and
// cross-tool: it trusts the project's OWN tests (never a benchmark number) and
// reuses `atlas` to flag calls to symbols that exist nowhere in the codebase
// (a cheap, zero-LLM hallucination signal). It emits a provenance stamp so a
// reviewer reads WHAT was checked, not the authoring transcript.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build as buildAtlas, has, isStale, load as loadAtlas } from "./atlas.js";
import { detectStack } from "./stack.js";

// Shared call-site extractor — one source of truth with atlas.js (they used to duplicate this).
export { extractCalledSymbols } from "./extract.js";

import { extractCalledSymbols } from "./extract.js";

/** Pure: which called symbols are defined nowhere in the atlas (possible hallucinations). */
export function findUnknownSymbols(atlas, symbols) {
  return symbols.filter((s) => !has(atlas, s));
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge verify git: ${err?.message ?? err}\n`);
    return "";
  }
}

// Run the project's OWN tests, driven off the stack detector (never a benchmark). The verdict
// is an honest four-state `status`:
//   PASS           — a real verifier ran and passed
//   FAIL           — a real verifier ran and failed
//   NOT_CONFIGURED — no test runner exists for this repo (nothing ran → NEVER ok)
//   INCOMPLETE     — a runner was expected but couldn't complete (timeout, or no concrete
//                    executor for the detected command)
// `ran`/`passed` are kept for back-compat (consensus.js reads them). Bounded by a timeout
// (FORGE_VERIFY_TIMEOUT_MS, default 10 min) so a hanging test can't hang the gate.
/**
 * @typedef {object} VerifyTests
 * @property {boolean} ran
 * @property {boolean} [passed]
 * @property {"PASS"|"FAIL"|"INCOMPLETE"|"NOT_CONFIGURED"} status
 * @property {string} [runner]
 * @property {boolean} [timedOut]
 * @property {string[]} [detected]
 * @property {string} [output]
 */
/**
 * @param {string} cwd
 * @returns {VerifyTests}
 */
function runTests(cwd) {
  const timeout = Number(process.env.FORGE_VERIFY_TIMEOUT_MS) || 600000;
  const run = (cmd, args) =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe", timeout });
  // Detect the repo's real test commands (no test script → none → NOT_CONFIGURED, not a
  // forced npm-test failure).
  let detected = [];
  try {
    detected = detectStack(cwd).testCommands;
  } catch {}
  if (!detected.length) return { ran: false, status: "NOT_CONFIGURED" };
  // Concrete runners forge can actually execute. npm test is only real if a package.json exists.
  const npm =
    detected.some((c) => /(^|\s)(npm|pnpm|yarn|bun)\s+test\b/.test(c)) &&
    existsSync(join(cwd, "package.json"));
  const pytest = detected.some((c) => /\bpytest\b/.test(c));
  try {
    if (npm) {
      run("npm", ["test"]);
      return { ran: true, passed: true, status: "PASS", runner: "npm test" };
    }
    if (pytest) {
      run("pytest", ["-q"]);
      return { ran: true, passed: true, status: "PASS", runner: "pytest" };
    }
    // A runner was detected but forge has no concrete executor for it — expected, didn't complete.
    return { ran: false, status: "INCOMPLETE", detected };
  } catch (e) {
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      return {
        ran: true,
        passed: false,
        timedOut: true,
        status: "INCOMPLETE",
        output: `test run exceeded ${timeout}ms`,
      };
    }
    return {
      ran: true,
      passed: false,
      status: "FAIL",
      output: String(e.stdout || e.message || "").slice(-600),
    };
  }
}

/**
 * M6 — checkpoint cadence as an optimal-stopping threshold rule (spec §6:
 * docs/plans/substrate-v2/06-faculties-and-mechanisms.md). Insert a checkpoint once
 * the expected loss of continuing-while-wrong exceeds the check's price:
 * pErr·tokensPerStep·costPerToken·n > checkCost, i.e. check every
 * n* = ⌈checkCost / (pErr · tokensPerStep · costPerToken)⌉ meaningful steps. No
 * magic constants: pErr is measured per tier from ledger outcome history, the costs
 * are priced — riskier/cheaper tiers get smaller n* automatically. Clamped to
 * [1, 50]: even a near-free check shouldn't fire more than every step, and even a
 * near-riskless run must still checkpoint eventually. Pure.
 * @param {{pErr: number, tokensPerStep: number, costPerToken?: number, checkCost: number}} f
 *   pErr = per-step error hazard; tokensPerStep = tokens put at risk per step;
 *   checkCost priced in the same token-cost unit.
 * @returns {number} integer steps between checkpoints, in [1, 50]
 */
export function checkpointCadence({ pErr, tokensPerStep, costPerToken = 1, checkCost }) {
  const n = Math.ceil(checkCost / (pErr * tokensPerStep * costPerToken));
  // Degenerate inputs (NaN from bad measurements) fail SAFE: check every step.
  if (Number.isNaN(n)) return 1;
  return Math.min(50, Math.max(1, n)); // zero risk → Infinity → the 50-step ceiling
}

/**
 * Independent verification pass over the working change.
 * @param {{targetRoot?: string, base?: string}} [opts]
 * @returns {{ok: boolean, provenance: object, unknown: string[], tests: VerifyTests,
 *   changedFiles: string[], added: string}}
 *   `ok` is `tests.status === "PASS"` — TRUE only when a real verifier ran and passed, NEVER
 *   when nothing ran. `changedFiles` includes untracked files; `added` includes their contents.
 */
export function verify({ targetRoot = process.cwd(), base = "HEAD" } = {}) {
  const diff =
    git(["diff", "--unified=0", base], targetRoot) ||
    git(["diff", "--unified=0", "--cached"], targetRoot);
  const diffAdded = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  // Untracked (new, not-yet-added) files are part of the change too — a brand-new source file
  // and its call sites would be invisible to `git diff`. Fold their paths into changedFiles and
  // their contents into `added` so provenance and the hallucination check both see them.
  const untracked = git(["ls-files", "--others", "--exclude-standard"], targetRoot)
    .split("\n")
    .filter(Boolean);
  const changedFiles = [
    ...new Set([
      ...git(["diff", "--name-only", base], targetRoot).split("\n").filter(Boolean),
      ...untracked,
    ]),
  ];
  let added = diffAdded;
  for (const f of untracked) {
    try {
      added += `\n${readFileSync(join(targetRoot, f), "utf8")}`;
    } catch {}
  }

  // Verify runs AFTER edits — a cached, stale atlas would miss newly-added-but-undefined symbols
  // (false negatives) or flag just-defined ones (false positives). Rebuild when stale; the
  // incremental build only re-parses the files that changed, so this stays cheap.
  const cached = loadAtlas(targetRoot);
  const atlas = cached && !isStale(targetRoot, cached) ? cached : buildAtlas({ root: targetRoot });
  const symbols = extractCalledSymbols(added);
  // When the graph was capped (huge repo, files dropped), "defined nowhere" is unreliable — a
  // symbol may live in a dropped file — so don't assert hallucinations.
  const unknown = atlas.capped ? [] : findUnknownSymbols(atlas, symbols);
  const tests = runTests(targetRoot);

  const provenance = {
    base,
    changedFiles,
    untracked,
    tests,
    symbolsChecked: symbols.length,
    unknownSymbols: unknown,
  };
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "provenance.json"), JSON.stringify(provenance, null, 2));

  // Hard gate = the project's own tests, keyed off the honest four-state verdict. `ok` is TRUE
  // only when a real verifier PASSED — never when nothing ran (NOT_CONFIGURED/INCOMPLETE).
  // Unknown symbols stay advisory (heuristic).
  const ok = tests.status === "PASS";
  // `added` (added diff lines + untracked file bodies) rides along for the deep lenses
  // (consensus.js: secrets + reviewer read the same bytes this pass already parsed).
  return { ok, provenance, unknown, tests, changedFiles, added };
}

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
//   INCOMPLETE     — a runner was expected but couldn't complete (timeout, executor binary
//                    missing, or no built-in executor for the detected command)
// The DETECTED runner is what actually executes (a pnpm/yarn/bun repo runs its own package
// manager, never a hardcoded `npm`), via the executor whitelist below — shell-free spawn of
// a known bin only, never npx (it can download arbitrary packages).
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
// Bins forge is willing to execute directly. Everything else stays report-only.
const EXECUTORS = new Set(["npm", "pnpm", "yarn", "bun", "pytest"]);
// Fallback when a detectStack result has no `testRunners` field (older shape):
// rebuild descriptors from the command strings.
/** @param {string[]} cmds @returns {import("./stack.js").TestRunner[]} */
function parseRunnerStrings(cmds) {
  return cmds.map((c) => {
    const cmd = c.trim();
    const pm = /(^|\s)(npm|pnpm|yarn|bun)\s+test\b/.exec(cmd);
    if (pm) return { bin: pm[2], args: ["test"], label: `${pm[2]} test` };
    if (/\bpytest\b/.test(cmd)) return { bin: "pytest", args: ["-q"], label: "pytest -q" };
    return { label: cmd };
  });
}
/**
 * @param {string} cwd
 * @returns {VerifyTests}
 */
function runTests(cwd) {
  const timeout = Number(process.env.FORGE_VERIFY_TIMEOUT_MS) || 600000;
  const run = (cmd, args) =>
    execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe", timeout });
  // Detect the repo's real test runners (no test script → none → NOT_CONFIGURED, not a
  // forced npm-test failure).
  let stack = null;
  try {
    stack = detectStack(cwd);
  } catch {}
  const detected = stack?.testCommands ?? [];
  if (!detected.length) return { ran: false, status: "NOT_CONFIGURED" };
  const runners = stack?.testRunners?.length ? stack.testRunners : parseRunnerStrings(detected);
  // First whitelisted descriptor wins. A package-manager runner is only real when a
  // package.json exists (the guard the old npm-only path had).
  const candidate = runners.find(
    (r) =>
      r?.bin &&
      EXECUTORS.has(r.bin) &&
      (r.bin === "pytest" || existsSync(join(cwd, "package.json"))),
  );
  if (!candidate) {
    // Runners were detected but forge has no built-in executor for any of them —
    // expected, didn't complete. Never guess a different runner.
    const labels = runners.map((r) => r?.label).filter(Boolean);
    return {
      ran: false,
      status: "INCOMPLETE",
      detected,
      output: `detected "${labels.join('", "')}" — no built-in executor; run it yourself and re-verify`,
    };
  }
  try {
    run(candidate.bin, candidate.args ?? []);
    return { ran: true, passed: true, status: "PASS", runner: candidate.label };
  } catch (e) {
    if (e.code === "ENOENT") {
      // The detected runner's binary isn't installed here — nothing ran, and silently
      // substituting another package manager would verify the wrong thing.
      return {
        ran: false,
        status: "INCOMPLETE",
        detected,
        output: `detected "${candidate.label}", executor unavailable (${candidate.bin} not on PATH)`,
      };
    }
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      return {
        ran: true,
        passed: false,
        timedOut: true,
        status: "INCOMPLETE",
        runner: candidate.label,
        output: `test run (${candidate.label}) exceeded ${timeout}ms`,
      };
    }
    return {
      ran: true,
      passed: false,
      status: "FAIL",
      runner: candidate.label,
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
  // their contents into `added` so provenance and the hallucination check both see them (P0-09).
  const untracked = git(["ls-files", "--others", "--exclude-standard"], targetRoot)
    .split("\n")
    .filter(Boolean);
  // Mirror the diff's --cached fallback so the base file list is derived from the SAME diff that
  // produced `added` (a base whose worktree matches HEAD but whose index differs would otherwise
  // yield `added` from --cached while changedFiles stayed empty, weakening impact/docsdrift).
  const changedFiles = [
    ...new Set([
      ...(
        git(["diff", "--name-only", base], targetRoot) ||
        git(["diff", "--name-only", "--cached"], targetRoot)
      )
        .split("\n")
        .filter(Boolean),
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

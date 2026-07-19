// forge verify — the independent verification layer. Deterministic-first and
// cross-tool: it trusts the project's OWN tests (never a benchmark number) and
// reuses `atlas` to flag calls to symbols that exist nowhere in the codebase
// (a cheap, zero-LLM hallucination signal). It emits a provenance stamp so a
// reviewer reads WHAT was checked, not the authoring transcript.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

/**
 * A content fingerprint of the FULL working-tree change relative to HEAD — the unstaged
 * diff, the staged diff, and every untracked (non-ignored) file's bytes, sorted, sha256'd.
 * Two checkouts with the same `dirtyHash` have byte-identical pending changes, so a
 * `verify` stamp can be BOUND to the exact code state it validated (HI-02): at Stop the
 * gate recomputes this and only trusts the PASS when the hash still matches. Never throws;
 * `gitAvailable:false` / `dirtyHash:null` is the honest "cannot bind" signal (the gate then
 * refuses to count the stamp). Pure w.r.t. the tree — reads git + files, writes nothing.
 * @param {string} [cwd]
 * @returns {{head: string|null, dirtyHash: string|null, gitAvailable: boolean}}
 */
export function computeCodeState(cwd = process.cwd()) {
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], cwd).trim() !== "true")
      return { head: null, dirtyHash: null, gitAvailable: false };
    const head = git(["rev-parse", "HEAD"], cwd).trim() || null;
    // Exclude forge's OWN state dir: writing provenance.json / session files must never
    // perturb the fingerprint the stamp is bound to (self-reference), and it's ignored in
    // real repos anyway — this keeps the hash stable even if a user forgot to gitignore it.
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], cwd)
      .split("\0")
      .filter((f) => f && !f.startsWith(".forge/"))
      .sort();
    const h = createHash("sha256");
    h.update(git(["diff", "HEAD"], cwd));
    h.update(git(["diff", "--cached"], cwd));
    for (const f of untracked) {
      try {
        h.update(readFileSync(join(cwd, f)));
      } catch {}
    }
    return { head, dirtyHash: h.digest("hex"), gitAvailable: true };
  } catch {
    return { head: null, dirtyHash: null, gitAvailable: false };
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
 * One executed (or attempted) suite's per-suite detail (HI-01/ME-02).
 * @typedef {object} SuiteResult
 * @property {string} label            human-readable runner command
 * @property {"PASS"|"FAIL"|"INCOMPLETE"} status
 * @property {number|null} [exitCode]  process exit code (0 pass, non-zero fail, null if it never ran)
 * @property {string} [code]           spawn error code (ENOENT/EACCES/ENOEXEC/…) when it did not execute
 * @property {string} [signal]         terminating signal, if any
 * @property {boolean} [timedOut]      true when the suite was killed for exceeding the timeout
 * @property {string} [output]         tail of the suite's own output (failures)
 */
/**
 * @typedef {object} VerifyTests
 * @property {boolean} ran
 * @property {boolean} [passed]
 * @property {"PASS"|"FAIL"|"INCOMPLETE"|"NOT_CONFIGURED"} status
 * @property {string} [runner]
 * @property {boolean} [timedOut]
 * @property {string[]} [detected]
 * @property {SuiteResult[]} [executed]   every suite forge actually spawned, with its per-suite verdict
 * @property {string[]} [notExecuted]     labels of detected suites forge has no built-in executor for
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
/** Is this descriptor one forge can execute directly (whitelisted bin, and a
 *  package.json present for the package-manager runners)? Pure. */
function isExecutable(r, cwd) {
  return !!(
    r?.bin &&
    EXECUTORS.has(r.bin) &&
    (r.bin === "pytest" || existsSync(join(cwd, "package.json")))
  );
}

/**
 * Run EVERY detected executable suite (HI-01) — a polyglot repo where a passing
 * Node suite hides a failing pytest suite must NOT report PASS. Aggregate to an
 * honest four-state verdict:
 *   - all executed suites PASS and nothing was skipped → PASS
 *   - any executed suite FAILs (real non-zero exit)     → FAIL
 *   - a detected suite is non-executable, or a spawn never completed (ENOENT /
 *     EACCES / ENOEXEC / signal / timeout, ME-02)        → INCOMPLETE
 *   - no runners at all                                  → NOT_CONFIGURED
 * Only a real non-zero EXIT CODE from a suite that actually ran is a FAIL; a suite
 * that never executed is INCOMPLETE, never a false FAIL.
 * @param {string} cwd
 * @returns {VerifyTests}
 */
function runTests(cwd) {
  const timeout = Number(process.env.FORGE_VERIFY_TIMEOUT_MS) || 600000;
  // Detect the repo's real test runners (no test script → none → NOT_CONFIGURED, not a
  // forced npm-test failure).
  let stack = null;
  try {
    stack = detectStack(cwd);
  } catch {}
  const detected = stack?.testCommands ?? [];
  if (!detected.length) return { ran: false, status: "NOT_CONFIGURED" };
  const runners = stack?.testRunners?.length ? stack.testRunners : parseRunnerStrings(detected);

  /** @type {SuiteResult[]} */
  const executed = [];
  /** @type {string[]} */
  const notExecuted = [];
  for (const r of runners) {
    const label = r?.label ?? String(r?.bin ?? "unknown");
    if (!isExecutable(r, cwd)) {
      // No built-in executor (go/cargo/mvn/gradle/dotnet/rspec/phpunit/npx-runners) —
      // report-only. Its absence means a PASS can't be claimed for the whole repo.
      notExecuted.push(label);
      continue;
    }
    try {
      execFileSync(r.bin, r.args ?? [], {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
        timeout,
      });
      executed.push({ label, status: "PASS", exitCode: 0 });
    } catch (e) {
      if (e.code === "ENOENT") {
        // The detected runner's binary isn't installed here — nothing ran, and silently
        // substituting another package manager would verify the wrong thing.
        executed.push({
          label,
          status: "INCOMPLETE",
          exitCode: null,
          code: "ENOENT",
          output: `executor unavailable (${r.bin} not on PATH)`,
        });
      } else if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
        // Killed for running too long — it started but never reached a verdict.
        executed.push({
          label,
          status: "INCOMPLETE",
          exitCode: null,
          timedOut: true,
          signal: e.signal,
          output: `exceeded ${timeout}ms`,
        });
      } else if (typeof e.status === "number") {
        // A real, completed run that exited non-zero — the ONLY true FAIL.
        executed.push({
          label,
          status: "FAIL",
          exitCode: e.status,
          output: String(e.stdout || e.message || "").slice(-600),
        });
      } else {
        // EACCES / ENOEXEC / other spawn failure / signal termination: the suite did NOT
        // execute, so this is INCOMPLETE, never FAIL (ME-02).
        executed.push({
          label,
          status: "INCOMPLETE",
          exitCode: null,
          code: e.code,
          signal: e.signal,
          output: `did not execute (${e.code || e.signal || "spawn error"})`,
        });
      }
    }
  }

  // Aggregate. A PASS must mean every detected required suite ran and passed.
  const anyFail = executed.some((s) => s.status === "FAIL");
  const anyIncomplete = executed.some((s) => s.status === "INCOMPLETE");
  const ranToVerdict = executed.some((s) => s.status === "PASS" || s.status === "FAIL");
  const timedOut = executed.some((s) => s.timedOut);
  /** @type {"PASS"|"FAIL"|"INCOMPLETE"} */
  let status;
  if (anyFail) status = "FAIL";
  else if (anyIncomplete || notExecuted.length) status = "INCOMPLETE";
  else status = "PASS"; // executed non-empty (NOT_CONFIGURED short-circuits above), all PASS

  // Honest human-readable summary, aggregated across suites.
  const parts = [];
  if (notExecuted.length)
    parts.push(
      `detected "${notExecuted.join('", "')}" — no built-in executor; run it yourself and re-verify`,
    );
  for (const s of executed) {
    if (s.status === "INCOMPLETE") parts.push(`"${s.label}" ${s.output ?? "did not execute"}`);
    else if (s.status === "FAIL") parts.push(`"${s.label}" FAILED: ${s.output ?? ""}`);
  }
  const runnerLabels = executed.map((s) => s.label);
  const runner = runnerLabels.join(", ") || runners.map((r) => r?.label).filter(Boolean)[0];
  return {
    ran: ranToVerdict,
    passed: status === "PASS",
    status,
    runner,
    ...(timedOut ? { timedOut: true } : {}),
    detected,
    executed,
    notExecuted,
    ...(parts.length ? { output: parts.join("; ") } : {}),
  };
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
    // Bind the stamp to the exact code it was produced against (HI-02/ME-04): the Stop gate
    // recomputes this and only counts the PASS as test-evidence when the hash still matches.
    codeState: computeCodeState(targetRoot),
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

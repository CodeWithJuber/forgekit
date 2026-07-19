// forge imagine — the consequence simulator ĉ = g(a, C) (paper Eq. 4;
// docs/plans/substrate-v2/06-faculties-and-mechanisms.md §2). The atlas gives the
// exact-structure half: entities → blast radius → predicted breaks with confidence.
// This module adds impacted-test SELECTION — the minimal dry-run suite that makes
// pre-action simulation affordable at all (minutes → seconds vs "run everything") —
// and the sandboxed worktree runner (spec §2.2) that EXECUTES that suite: dryRun()
// checks out HEAD into an ephemeral `git worktree`, runs the suite there, parses the
// TAP summary, and always discards the sandbox. Selection stays useful on its own as
// "run these, in this order"; dryRun turns the prediction into measured evidence.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as buildAtlas, impact, load as loadAtlas } from "./atlas.js";
import { referencedEntities } from "./preflight.js";
import { isTestFile, predictFailingTests } from "./substrate.js";
import { hasBin, toPosix } from "./util.js";

/**
 * Weighted greedy set cover over the covers(test, source) relation: candidates are
 * substrate's predicted-failing tests plus any test files among the impacted set
 * (those cover themselves — they are predicted to break, so the suite must include
 * them). Weight = file size, a duration proxy until measured runtimes exist (P8).
 * Each round picks the test minimizing weight / newly-covered — the classical
 * greedy H(n) ≈ ln n approximation to weighted set cover (Chvátal 1979), and exact
 * on the tiny instances a single edit produces. Impacted sources with no covering
 * test simply can't constrain the suite; the gaps surface via selectTestsReport.
 * @param {string} root
 * @param {string[]} impactedFiles
 * @returns {string[]} minimal ordered dry-run suite (best value first)
 */
export function selectTests(root, impactedFiles) {
  return selectTestsReport(root, impactedFiles).tests;
}

/** selectTests plus the sources no known test covers (the honest gap in the cover). */
export function selectTestsReport(root, impactedFiles) {
  const files = [...new Set(impactedFiles.map(String))];
  const covers = new Map(); // test → Set of covered elements (sources + itself)
  const addCover = (test, el) => {
    if (!covers.has(test)) covers.set(test, new Set());
    covers.get(test).add(el);
  };
  for (const f of files) {
    if (isTestFile(f)) addCover(f, f);
    else for (const t of predictFailingTests(root, [f])) addCover(t, f);
  }
  const universe = new Set();
  for (const els of covers.values()) for (const el of els) universe.add(el);
  const weights = new Map(
    [...covers.keys()].map((t) => {
      // Unreadable candidate → weight 1, never a throw: selection must not die on a
      // just-deleted test file; running it later fails honestly instead.
      let w = 1;
      try {
        w = Math.max(1, statSync(join(root, t)).size);
      } catch {}
      return [t, w];
    }),
  );
  const tests = [];
  const covered = new Set();
  while (covered.size < universe.size) {
    let best = null;
    let bestRatio = Infinity;
    for (const [t, els] of covers) {
      let gain = 0;
      for (const el of els) if (!covered.has(el)) gain++;
      if (!gain) continue; // also skips already-chosen tests (their gain is 0)
      const ratio = weights.get(t) / gain;
      // Deterministic tie-break by path so the suite order is stable across runs.
      if (ratio < bestRatio || (ratio === bestRatio && best !== null && t < best)) {
        best = t;
        bestRatio = ratio;
      }
    }
    if (best === null) break;
    tests.push(best);
    for (const el of covers.get(best)) covered.add(el);
  }
  const uncovered = files.filter((f) => !isTestFile(f) && !covered.has(f)).sort();
  return { tests, uncovered };
}

/** Strip a TAP `location: '/abs/file.js:1:2'` diagnostic down to its file path. */
const locFile = (line) => {
  const m = /^\s+location:\s*'(.+):\d+:\d+'/.exec(line);
  return m ? m[1] : null;
};

/**
 * @typedef {{ok: boolean, reason?: string, passed?: number, failed?: number,
 *   perFile?: Record<string, "pass"|"fail">, durationMs?: number, runner?: string,
 *   output?: string, worktree?: string}} DryRunVerdict
 */

/**
 * Sandboxed dry-run of a selected suite — the simulation half of ĉ = g(a, C)
 * (spec §2.2): run the tests in an EPHEMERAL `git worktree` of HEAD and discard it.
 * The worktree is HEAD, not the working tree — worktrees share the object store,
 * never uncommitted files — so callers MUST surface that a dirty tree dry-runs the
 * last commit, not the in-flight proposal (the CLI refuses dirty trees by default).
 * ok means the RUN completed and produced a verdict; failing tests are ok:true with
 * failed>0 — that IS the imagined consequence, delivered as evidence. Never throws:
 * unmet preconditions return { ok:false, reason }.
 * @param {string} root
 * @param {{tests?: string[], timeoutMs?: number}} [opts] repo-relative test paths
 * @returns {DryRunVerdict}
 */
export function dryRun(root, { tests, timeoutMs = 120000 } = {}) {
  if (!Array.isArray(tests) || tests.length === 0)
    return { ok: false, reason: "no tests selected — nothing to dry-run" };
  if (!hasBin("git"))
    return {
      ok: false,
      reason: "git not found — the sandbox is a git worktree",
    };
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    return { ok: false, reason: `not a git repository: ${root}` };
  }
  // mkdtemp reserves a unique parent; the worktree goes one level down because
  // `git worktree add` wants to create its target path itself.
  const parent = mkdtempSync(join(tmpdir(), "forge-dryrun-"));
  const wt = join(parent, "wt");
  const started = Date.now();
  // The body runs in a closure so every exit path — verdict, timeout, crash — flows
  // through the same finally-cleanup AND the same verified `worktree` stamp below.
  /** @returns {DryRunVerdict} */
  const body = () => {
    try {
      execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], {
        cwd: root,
        stdio: "pipe",
      });
    } catch (e) {
      const msg = /** @type {{stderr?: Buffer}} */ (e).stderr?.toString().trim() || String(e);
      return { ok: false, reason: `git worktree add failed: ${msg}` };
    }
    // node --test reports each failure's `location:` as a canonical (realpath'd) path.
    // On platforms where tmpdir() itself is a symlink (macOS: /var → /private/var), the
    // raw `wt` path won't string-match those locations, so per-file attribution below
    // must compare against the canonicalized worktree root. On Linux (no symlink) this
    // is a no-op.
    const wtReal = realpathSync(wt);
    // Runner policy: always `node --test <files...>` — a custom package test script
    // (jest, vitest, …) is a WHOLE-SUITE command that can't be scoped per-file safely,
    // which would defeat minimal selection. We still run node --test and say so, so a
    // surprising verdict is attributable to the runner mismatch.
    let runner = "node --test";
    try {
      const pkg = JSON.parse(readFileSync(join(wt, "package.json"), "utf8"));
      const script = pkg?.scripts?.test;
      if (script && !/\bnode\s+(--[\w-]+\s+)*--test\b/.test(script))
        runner = `node --test (package.json test script is custom: ${String(script).slice(0, 60)})`;
    } catch {} // no/unreadable package.json → default runner
    // TAP reporter is forced: the default reporter depends on TTY-ness, and the
    // `# pass/# fail` summary below is the contract this parser relies on. The env
    // must NOT leak a parent test-runner's context — when dryRun itself runs under
    // `node --test` (our own tests, or an agent's), an inherited NODE_TEST_CONTEXT
    // makes the child speak the runner's internal protocol instead of TAP.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", ...tests.map(String)],
      {
        cwd: wt,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL", // node --test forks workers; SIGKILL is the reliable stop
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const combined = `${run.stdout ?? ""}${run.stderr ? `\n${run.stderr}` : ""}`.trim();
    const output = combined.length > 2000 ? `…${combined.slice(-2000)}` : combined;
    const durationMs = Date.now() - started;
    if (run.error || run.signal) {
      const reason =
        /** @type {{code?: string}} */ (run.error)?.code === "ETIMEDOUT" || run.signal
          ? `dry-run timed out after ${timeoutMs}ms (killed with ${run.signal ?? "SIGKILL"})`
          : `runner failed to start: ${run.error}`;
      return { ok: false, reason, durationMs, runner, output };
    }
    const mPass = /^# pass (\d+)$/m.exec(run.stdout ?? "");
    const mFail = /^# fail (\d+)$/m.exec(run.stdout ?? "");
    if (!mPass || !mFail) {
      // Non-zero exit with no TAP summary = the RUN failed (crash, bad flags), which
      // is a different fact than "the tests failed" — report it as one.
      return {
        ok: false,
        reason: `runner exited ${run.status} without a TAP summary`,
        durationMs,
        runner,
        output,
      };
    }
    // perFile is best-effort: node ≥20 TAP flattens per-TEST (no per-file points), but
    // every failure block carries a `location: '<abs path>:l:c'` diagnostic — map those
    // back to the requested files; anything never implicated passed. Omitted when a
    // failure can't be attributed (partial attribution would misassign blame).
    /** @type {Record<string, "pass"|"fail">} */
    const perFile = Object.fromEntries(tests.map((t) => [String(t), "pass"]));
    let attributable = true;
    for (const block of (run.stdout ?? "").split(/^not ok /m).slice(1)) {
      const file = block.split("\n").map(locFile).find(Boolean);
      // Compare in POSIX form: the TAP `location:` uses native `\` on Windows while the
      // requested test paths and join() results mix separators — normalizing both sides
      // makes attribution portable (no-op on Linux, where both are already `/`).
      const t = file && tests.find((c) => toPosix(file) === toPosix(join(wtReal, String(c))));
      if (t) perFile[String(t)] = "fail";
      else attributable = false;
    }
    return {
      ok: true,
      passed: Number(mPass[1]),
      failed: Number(mFail[1]),
      ...(attributable ? { perFile } : {}),
      durationMs,
      runner,
      output,
    };
  };
  let result;
  try {
    result = body();
  } finally {
    // ALWAYS discard the sandbox — a leaked worktree pins refs and litters
    // `git worktree list` forever. remove --force, prune the bookkeeping, then
    // belt-and-braces rm of the parent; the verdict below verifies, never assumes.
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {}
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {}
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {}
  }
  result.worktree = existsSync(wt) ? "leaked" : "removed";
  return result;
}

/**
 * Imagine the consequences of a task before acting: entities → impact() blast
 * radius → predicted breaks (per-file max confidence across targets), the minimal
 * dry-run suite, and riskScore = Σ confidence — the number spec §2.3 thresholds to
 * decide whether the (follow-up) sandboxed dry-run is worth paying for.
 * @param {string} root
 * @param {string} task
 * @param {{atlas?: object, threshold?: number}} [opts] inject `atlas` to skip the build.
 */
export function imagineTask(root, task, { atlas, threshold = 0.1 } = {}) {
  const graph = atlas || loadAtlas(root) || buildAtlas({ root });
  const entities = referencedEntities(task);
  const targets = [...new Set([...entities.symbols, ...entities.files])].slice(0, 8);
  const reports = targets.map((t) => impact(graph, t, { threshold }));
  const byFile = new Map();
  for (const r of reports) {
    for (const x of r.impacted) {
      const f = x.node?.file;
      if (f) byFile.set(f, Math.max(byFile.get(f) ?? 0, x.confidence));
    }
  }
  const predictedBreaks = [...byFile]
    .map(([file, confidence]) => ({ file, confidence }))
    .sort((a, b) => b.confidence - a.confidence || (a.file < b.file ? -1 : 1));
  const { tests, uncovered } = selectTestsReport(
    root,
    predictedBreaks.map((b) => b.file),
  );
  return {
    task: String(task),
    targets,
    found: reports.some((r) => r.found),
    predictedBreaks,
    tests,
    uncovered,
    riskScore: Number(predictedBreaks.reduce((s, b) => s + b.confidence, 0).toFixed(4)),
  };
}

/** @param {ReturnType<typeof imagineTask>} r
 *  @param {{footer?: boolean}} [opts] footer=false when the caller runs the dry-run itself */
export function renderImagine(r, { footer = true } = {}) {
  const lines = ["Forge imagine — consequence simulation (pre-action)", ""];
  lines.push(`  targets: ${r.targets.length ? r.targets.join(", ") : "(none named)"}`);
  if (!r.found) {
    lines.push("", "  nothing in the code graph matches this task — no consequences to predict.");
    return lines.join("\n");
  }
  lines.push(`  risk score: ${r.riskScore}  (Σ confidence over predicted breaks)`);
  lines.push("", `  predicted breaks (${r.predictedBreaks.length}):`);
  for (const b of r.predictedBreaks.slice(0, 12))
    lines.push(`    ${b.confidence.toFixed(2)}  ${b.file}`);
  if (r.predictedBreaks.length > 12) lines.push(`    … ${r.predictedBreaks.length - 12} more`);
  if (r.tests.length) {
    lines.push("", `  minimal dry-run suite (${r.tests.length}) — run these, in this order:`);
    for (const t of r.tests) lines.push(`    - ${t}`);
  } else {
    lines.push("", "  no covering tests found for the predicted breaks.");
  }
  if (r.uncovered.length)
    lines.push(
      "",
      `  ! no test covers: ${r.uncovered.slice(0, 6).join(", ")}${r.uncovered.length > 6 ? " …" : ""}`,
    );
  if (footer)
    lines.push("", "  (measure it: re-run with --run — sandboxed worktree dry-run of HEAD)");
  return lines.join("\n");
}

// forge imagine — the consequence simulator ĉ = g(a, C) (paper Eq. 4;
// docs/plans/substrate-v2/06-faculties-and-mechanisms.md §2). The atlas gives the
// exact-structure half: entities → blast radius → predicted breaks with confidence.
// This module adds impacted-test SELECTION — the minimal dry-run suite that makes
// pre-action simulation affordable at all (minutes → seconds vs "run everything").
// The sandboxed worktree runner that EXECUTES the suite against a proposed diff is
// the P5 follow-up (spec §2.2) — selection had to exist first, and it is useful on
// its own as "run these, in this order, before you touch anything".
import { statSync } from "node:fs";
import { join } from "node:path";
import { build as buildAtlas, impact, load as loadAtlas } from "./atlas.js";
import { referencedEntities } from "./preflight.js";
import { isTestFile, predictFailingTests } from "./substrate.js";

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

export function renderImagine(r) {
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
  lines.push("", "  (sandboxed worktree dry-run of this suite lands as the P5 follow-up)");
  return lines.join("\n");
}

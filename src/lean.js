// forge lean — M5 anti-over-engineering, made measurable. The paper flags φ(y) − φ*(x) > 0: the
// solution's footprint beyond the task's minimal sufficient footprint. The shipped substrate only
// had three keyword regexes; this measures the ACTUAL footprint from the working diff — files
// touched, lines added, and NEW abstractions introduced — against what the task NAMED, and flags
// the excess. Deterministic, git/diff-based, zero-dep. Advisory (never blocks); tests always win.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { referencedEntities } from "./preflight.js";

// A new top-level definition introduced on an added (+) diff line — the over-abstraction signal.
const NEW_DEF_RES = [
  /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  // const/let/var bound to a function value (a real new abstraction, not a scalar)
  /^\+\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\+\s*def\s+([A-Za-z_]\w*)/,
  /^\+\s*class\s+([A-Za-z_]\w*)/,
];

/** Pure: a unified diff → the actual footprint {files, linesAdded, newSymbols}. */
export function parseDiffFootprint(diff) {
  const files = new Set();
  const newSymbols = [];
  let linesAdded = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+++ ")) {
      const m = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (m && m[1] !== "/dev/null") files.add(m[1].trim());
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      linesAdded += 1;
      for (const re of NEW_DEF_RES) {
        const m = line.match(re);
        if (m) {
          newSymbols.push(m[1]);
          break;
        }
      }
    }
  }
  return { files: [...files], linesAdded, newSymbols };
}

/**
 * Pure: compare the actual footprint against what the task asked for and flag the excess.
 * @param {string} task
 * @param {{files:string[], linesAdded:number, newSymbols:string[]}} actual
 */
export function assessFootprint(task, actual, { maxLinesForShortTask = 120 } = {}) {
  const { symbols: named, files: namedFiles } = referencedEntities(task);
  const namedSymbols = new Set(named.map((s) => s.toLowerCase()));
  const words = String(task).trim().split(/\s+/).filter(Boolean).length;
  const warnings = [];

  // Abstractions the task never named — the core φ(y) − φ*(x) signal.
  const unrequested = [...new Set(actual.newSymbols)].filter(
    (s) => !namedSymbols.has(s.toLowerCase()),
  );
  if (unrequested.length >= 3) {
    warnings.push(
      `${unrequested.length} new abstractions the task didn't ask for (${unrequested.slice(0, 5).join(", ")}) — is each one necessary, or is this over-built?`,
    );
  }

  // A short ask that produced a large diff.
  if (words <= 12 && actual.linesAdded > maxLinesForShortTask) {
    warnings.push(
      `${actual.linesAdded} lines added for a ${words}-word task — confirm the scope matches the request.`,
    );
  }

  // Touched far more files than the task named.
  if (namedFiles.length) {
    const extra = actual.files.filter(
      (f) => !namedFiles.some((nf) => f.endsWith(nf) || nf.endsWith(f)),
    );
    if (extra.length > Math.max(2, namedFiles.length * 2)) {
      warnings.push(
        `Touched ${actual.files.length} files but the task named ${namedFiles.length} — ${extra.length} are beyond the stated scope.`,
      );
    }
  }

  return {
    warnings,
    footprint: {
      files: actual.files.length,
      linesAdded: actual.linesAdded,
      newAbstractions: [...new Set(actual.newSymbols)],
      unrequestedAbstractions: unrequested,
    },
  };
}

// A brand-new file is INVISIBLE to `git diff HEAD` until it is staged — and a new file is
// exactly where over-engineering lives (review C10: a 6-class, 212-line "framework" next to
// a one-line fix measured as 1 file, +1 line, 0 warnings). Untracked files are rendered as
// what they are: an all-added diff. Binary and very large files are counted as touched files
// without inventing added lines.
const UNTRACKED_LINE_CAP = 20000;

function untrackedDiff(root, run, only) {
  const listed = run(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((f) => f && (!only || only.has(f)));
  const parts = [];
  for (const rel of listed) {
    let text = "";
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      text = "";
    }
    const lines = text.includes("\0") ? [] : text.split(/\r?\n/).slice(0, UNTRACKED_LINE_CAP);
    if (lines.length && lines.at(-1) === "") lines.pop();
    parts.push(`--- /dev/null\n+++ b/${rel}\n${lines.map((l) => `+${l}`).join("\n")}`);
  }
  return parts.length ? `${parts.join("\n")}\n` : "";
}

// `files` (optional) restricts the diff to those repo-relative paths — the session-scoped
// footprint. Literal pathspecs: a file named `*.ts` or `:(glob)x` is a path, not a pattern.
function gitDiff(root, base, files) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  if (files && !files.length) return "";
  const pre = files ? ["--literal-pathspecs"] : [];
  const spec = files ? ["--", ...files] : [];
  try {
    const tracked =
      run([...pre, "diff", "--unified=0", base, ...spec]) ||
      run([...pre, "diff", "--unified=0", "--cached", ...spec]);
    return tracked + untrackedDiff(root, run, files ? new Set(files) : null);
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge lean gitDiff: ${err?.message ?? err}\n`);
    return "";
  }
}

/**
 * Repo wrapper: measure the working-tree footprint against a task. `diff` injectable for tests.
 * With `files` (the session-scoped view, session.js sessionChanges) only those paths are
 * measured, against `base` (the session baseline): other agents' uncommitted work and the
 * dirt that predates the session are not this task's footprint. `scope` says which view.
 * @param {string} root
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.diff]
 * @param {string[]} [opts.files]
 */
export function leanRepo(root, task, { base = "HEAD", diff, files } = {}) {
  const d = diff ?? gitDiff(root, base, files);
  return {
    ...assessFootprint(String(task || ""), parseDiffFootprint(d)),
    hasDiff: Boolean(d.trim()),
    scope: files ? "session" : "worktree",
  };
}

export function renderLean(r) {
  const lines = ["Forge lean — scope minimality (M5)", ""];
  if (!r.hasDiff && r.scope === "session")
    return `${lines.join("\n")}  this session has not changed anything yet — any other working diff predates it or belongs to another agent (not measured).`;
  if (!r.hasDiff) return `${lines.join("\n")}  no diff vs HEAD yet — nothing to measure.`;
  const f = r.footprint;
  lines.push(
    `  footprint: ${f.files} file(s), +${f.linesAdded} line(s), ${f.newAbstractions.length} new abstraction(s)`,
  );
  if (r.warnings.length) {
    lines.push("", "  possible over-engineering:");
    for (const w of r.warnings) lines.push(`    - ${w}`);
  } else {
    lines.push("", "  ✓ footprint looks proportionate to the task.");
  }
  return lines.join("\n");
}

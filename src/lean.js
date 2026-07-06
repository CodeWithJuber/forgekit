// forge lean — M5 anti-over-engineering, made measurable. The paper flags φ(y) − φ*(x) > 0: the
// solution's footprint beyond the task's minimal sufficient footprint. The shipped substrate only
// had three keyword regexes; this measures the ACTUAL footprint from the working diff — files
// touched, lines added, and NEW abstractions introduced — against what the task NAMED, and flags
// the excess. Deterministic, git/diff-based, zero-dep. Advisory (never blocks); tests always win.
import { execFileSync } from "node:child_process";
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

function gitDiff(root, base) {
  try {
    const staged = execFileSync("git", ["diff", "--unified=0", base], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (
      staged ||
      execFileSync("git", ["diff", "--unified=0", "--cached"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return "";
  }
}

/**
 * Repo wrapper: measure the working-tree footprint against a task. `diff` injectable for tests.
 * @param {string} root
 * @param {string} task
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.diff]
 */
export function leanRepo(root, task, { base = "HEAD", diff } = {}) {
  const d = diff ?? gitDiff(root, base);
  return {
    ...assessFootprint(String(task || ""), parseDiffFootprint(d)),
    hasDiff: Boolean(d.trim()),
  };
}

export function renderLean(r) {
  const lines = ["Forge lean — scope minimality (M5)", ""];
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

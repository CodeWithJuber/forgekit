// forge cortex features — turn a real edit into the predictor's feature vector. The pure
// computeFeatures() is fully testable; featuresForEdit() fills it from actual repo state
// (lessons + git) with graceful degradation. caller_fanout / no_caller_update are SEAMS: a
// zero-dep grep gives a rough fan-out today; adopting a graph MCP (agent-lsp/Serena) drops
// a precise call graph straight in without touching the predictor.
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { mergedLessons } from "./ledger_read.js";
import { confidenceOf, matchScore } from "./lessons.js";
import { toPosix } from "./util.js";

/**
 * Pure: edit + gathered signals → the predictor feature vector (all features in [0,1]).
 * @param {{file?:string, symbol?:string}} edit
 * @param {{callerCount?:number, churnCommits?:number, hasTest?:boolean, signatureChange?:boolean, callersInDiff?:boolean, activeLessons?:object[], nowDay?:number}} deps
 */
export function computeFeatures(edit, deps = {}) {
  const {
    callerCount = 0,
    churnCommits = 0,
    hasTest = true,
    signatureChange = false,
    callersInDiff = true,
    activeLessons = [],
    nowDay = 0,
  } = deps;
  const ctx = {
    files: edit.file ? [edit.file] : [],
    symbols: edit.symbol ? [edit.symbol] : [],
  };
  const matched = activeLessons.filter((l) => matchScore(l, ctx) > 0);
  const lessonMatch = matched.reduce((m, l) => Math.max(m, confidenceOf(l, nowDay)), 0);
  return {
    caller_fanout: Math.min(1, callerCount / 10), // >10 callers = maxed out
    lesson_match: lessonMatch,
    churn: Math.min(1, churnCommits / 10),
    test_coverage_gap: hasTest ? 0 : 1,
    signature_change: signatureChange ? 1 : 0,
    no_caller_update: signatureChange && !callersInDiff ? 1 : 0,
    past_mistake_here: matched.some((l) => (l.evidenceCount ?? 0) > 0) ? 1 : 0,
  };
}

const tryExec = (bin, args, root) => {
  try {
    return execFileSync(bin, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 1500, // bound latency — this runs in a PreToolUse hook on every edit
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
};

// Churn is RECENT activity: commits in the last CHURN_DAYS days. Without a window, `-n 50`
// counted a file's whole history, so a file untouched since 2015 scored as maximally hot.
export const CHURN_DAYS = 90;

/** How many commits touched this file in the last `days` days (git churn) — 0 if not a git repo. */
export function gitChurn(root, file, { days = CHURN_DAYS } = {}) {
  if (!file) return 0;
  const out = tryExec(
    "git",
    ["log", `--since=${days} days ago`, "--oneline", "-n", "50", "--", file],
    root,
  );
  return out ? out.trim().split("\n").filter(Boolean).length : 0;
}

/** Rough fan-out: how many files mention the symbol as a WHOLE WORD (git grep -w, fixed
 *  string — "get" no longer counts every "target"). SEAM for a real call graph. */
export function grepFanout(root, symbol) {
  if (!symbol) return 0;
  const out = tryExec("git", ["grep", "-l", "-w", "-F", "-e", symbol], root);
  return out ? out.trim().split("\n").filter(Boolean).length : 0;
}

export const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;
export const CALLER_EXT_RE =
  /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|vue|svelte)$/i;

/**
 * The name a module is referenced BY: its file stem, or its directory for the
 * conventional entry names (`src/auth/index.js` is imported as `auth`). A stem under 3
 * characters is too noisy to grep for and is refused ("" — no fan-out rather than a
 * wrong one).
 * @param {string} file repo-relative or absolute path
 */
export function moduleStem(file) {
  if (!file) return "";
  const rel = toPosix(file);
  let stem = basename(rel).replace(/\.[^.]+$/, "");
  if (/^(index|__init__|mod|main)$/i.test(stem)) stem = basename(dirname(rel));
  return stem.length >= 3 ? stem : "";
}

/**
 * Files that name this module as a whole word, split into code `callers` and `tests`
 * (the file itself always excluded). One bounded `git grep`; outside a git work tree
 * both lists are empty — absent evidence is never inferred as signal. SEAM: a real call
 * graph drops in here without touching either caller.
 * @param {string} root
 * @param {string} file repo-relative or absolute path
 * @returns {{callers:string[], tests:string[], rel:string}}
 */
export function referencingFiles(root, file) {
  const abs = !file ? "" : isAbsolute(file) ? file : join(root, file);
  const rel = abs ? toPosix(relative(root, abs)) : "";
  const stem = moduleStem(rel);
  if (!stem) return { callers: [], tests: [], rel };
  const hits = tryExec("git", ["grep", "-l", "-I", "-w", "-F", "-e", stem], root)
    .split("\n")
    .map((f) => toPosix(f.trim()))
    .filter((f) => f && f !== rel);
  return {
    callers: hits.filter((f) => !TEST_PATH_RE.test(f) && CALLER_EXT_RE.test(f)),
    tests: hits.filter((f) => TEST_PATH_RE.test(f)),
    rel,
  };
}

/** Build the feature vector for a real edit from actual repo state (best-effort, degrades). */
export function featuresForEdit(root, edit, { nowDay = 0 } = {}) {
  // Ledger-aware read: the merged view (legacy ∪ ledger) so this works under
  // FORGE_LEDGER_ONLY (no legacy files) and also sees merged teammate lessons.
  const activeLessons = mergedLessons(root, nowDay).filter((l) => l.status === "active");
  // caller_fanout from the SYMBOL when the caller knows one, else from the FILE. Callers
  // that only have a path (every hook fired on an edit event) used to get grepFanout
  // (root, undefined) === 0, so the feature was dead for them: a file with 20 importers
  // scored the same as one nobody references. The file's own fan-out — how many modules
  // name this one — is the honest answer the caller CAN have.
  const callerCount = edit.symbol
    ? grepFanout(root, edit.symbol)
    : referencingFiles(root, edit.file).callers.length;
  return computeFeatures(edit, {
    activeLessons,
    nowDay,
    callerCount,
    churnCommits: gitChurn(root, edit.file),
    // hasTest / signatureChange / callersInDiff need the diff or a graph — left at safe
    // defaults until a graph MCP is wired; the predictor already handles missing signal.
  });
}

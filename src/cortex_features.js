// forge cortex features — turn a real edit into the predictor's feature vector. The pure
// computeFeatures() is fully testable; featuresForEdit() fills it from actual repo state
// (lessons + git) with graceful degradation. caller_fanout / no_caller_update are SEAMS: a
// zero-dep grep gives a rough fan-out today; adopting a graph MCP (agent-lsp/Serena) drops
// a precise call graph straight in without touching the predictor.
import { execFileSync } from "node:child_process";
import { confidenceOf, matchScore } from "./lessons.js";
import { load } from "./lessons_store.js";

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
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
};

/** How many commits recently touched this file (git churn) — 0 if not a git repo. */
export function gitChurn(root, file) {
  if (!file) return 0;
  const out = tryExec("git", ["log", "--oneline", "-n", "50", "--", file], root);
  return out ? out.trim().split("\n").filter(Boolean).length : 0;
}

/** Rough fan-out: how many files mention the symbol (grep). SEAM for a real call graph. */
export function grepFanout(root, symbol) {
  if (!symbol) return 0;
  const out = tryExec("git", ["grep", "-l", "--", symbol], root);
  return out ? out.trim().split("\n").filter(Boolean).length : 0;
}

/** Build the feature vector for a real edit from actual repo state (best-effort, degrades). */
export function featuresForEdit(root, edit, { nowDay = 0 } = {}) {
  const activeLessons = load(root).filter((l) => l.status === "active");
  const callerCount = grepFanout(root, edit.symbol);
  return computeFeatures(edit, {
    activeLessons,
    nowDay,
    callerCount,
    churnCommits: gitChurn(root, edit.file),
    // hasTest / signatureChange / callersInDiff need the diff or a graph — left at safe
    // defaults until a graph MCP is wired; the predictor already handles missing signal.
  });
}

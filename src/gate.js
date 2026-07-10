// forge gate — the completion gate: a deterministic floor under "done". Instructions and
// lessons raise the PROBABILITY that code ships with its docs/state; this Stop hook
// guarantees a floor: a session that changed code but moved no doc/state artifact is
// blocked ONCE, with the exact repair procedure as the reason. P(silent miss) =
// (1−p)·∏(1−cⱼ) — the gate is the cⱼ≈1 layer for the structural signal "code moved,
// nothing followed". Loop-safe (stop_hook_active + once-per-session marker), fail-open
// on every error path, kill switch FORGE_STOPGATE=0.
//
// Classification derives from the SAME registries the atlas is built from (CODE_EXTS/
// DOC_EXTS/config rules) + the shared test-file predicate — no parallel regex lists that
// could drift. Deliberate deviation from the reference kit: test-only changes do NOT
// block (a regression-test-only session owes no prose), and .forge/state.md — invisible
// to git because .forge/ is gitignored — counts as the doc signal via its mtime against
// the session baseline (the baseline file's mtime IS the session-start timestamp).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cusum } from "./anchor.js";
import { CODE_EXTS, DOC_EXTS, impact, isConfigFile, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { readSession, sessionPath } from "./cortex_hook.js";
import { decisionsPath } from "./decide.js";
import { statePath } from "./handoff.js";
import { readBaseline } from "./session.js";
import { isTestFile } from "./substrate.js";

// gitRaw keeps the exact bytes — porcelain's first column is a SPACE for unstaged
// entries, and a trim() would eat it and shift the path slice by one.
function gitRaw(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

const git = (root, args) => gitRaw(root, args).trim();

export const CLASSES = ["code", "docs", "config", "test", "internal", "other"];

/** Total function path → class. Order matters: the state/decisions snapshots are doc
 *  artifacts FIRST (the minimum-bar trick), then everything else under .forge/ and the
 *  generated instruction files are internal (never owed docs). */
export function classifyPath(rel) {
  const p = String(rel).replace(/\\/g, "/");
  const name = p.split("/").pop() || "";
  if (p === ".forge/state.md" || p === ".forge/decisions.md") return "docs";
  if (p.startsWith(".forge/") || /^(AGENTS|CLAUDE|GEMINI)\.md$/i.test(name)) return "internal";
  if (DOC_EXTS.has(extname(name))) return "docs";
  if (isTestFile(p)) return "test";
  // Config BEFORE code: `vite.config.ts` is wiring, not logic — same dispatch order the
  // atlas uses, so the gate and the graph agree on every path.
  if (isConfigFile(name)) return "config";
  if (CODE_EXTS.has(extname(name))) return "code";
  return "other";
}

/** Everything changed this session: diff against the recorded baseline ∪ the working
 *  tree (staged + unstaged + untracked file-by-file, renames as both paths). */
export function changedSet(root, baseHead) {
  const out = new Set();
  if (baseHead && git(root, ["rev-parse", "--verify", `${baseHead}^{commit}`]))
    for (const f of git(root, ["diff", "--name-only", baseHead]).split("\n").filter(Boolean))
      out.add(f);
  for (const line of gitRaw(root, ["status", "--porcelain", "-uall"]).split("\n").filter(Boolean)) {
    for (const part of line.slice(3).split(" -> ")) {
      const p = part.replace(/^"(.*)"$/, "$1").trim();
      if (p) out.add(p);
    }
  }
  return [...out].sort();
}

/**
 * PURE decision table (the kit's ten rows, minus the impure guards the orchestrator
 * handles). First match wins; returns {allow, row, classes}.
 */
export function gateDecision({
  stopHookActive = false,
  isRepo = true,
  markerExists = false,
  killSwitch = false,
  changed = [],
  stateTouched = false,
} = {}) {
  if (stopHookActive) return { allow: true, row: "stop-hook-active" };
  if (!isRepo) return { allow: true, row: "not-a-repo" };
  if (markerExists) return { allow: true, row: "already-blocked" };
  if (killSwitch) return { allow: true, row: "kill-switch" };
  const classes = Object.fromEntries(CLASSES.map((c) => [c, []]));
  for (const f of changed) classes[classifyPath(f)].push(f);
  const external = changed.length - classes.internal.length;
  if (!external && !stateTouched) return { allow: true, row: "no-changes", classes };
  if (classes.docs.length || stateTouched) return { allow: true, row: "docs-touched", classes };
  if (classes.code.length) return { allow: false, row: "code-without-docs", classes };
  return { allow: true, row: "no-code-class", classes };
}

/** The block reason IS the repair procedure — its consumer is the agent itself, and a
 *  checklist converts a failure into a same-turn fix. Stale-doc candidates come from the
 *  CACHED atlas only (a hook never builds). */
export function repairReason(root, { codeFiles = [], driftAlarm = false } = {}) {
  let likelyDocs = [];
  try {
    const atlas = loadAtlas(root);
    if (atlas) {
      const docs = new Set();
      for (const f of codeFiles.slice(0, 10))
        for (const d of impact(atlas, f, { maxHops: 2 }).impactedFiles)
          if (d.endsWith(".md")) docs.add(d);
      likelyDocs = [...docs].slice(0, 5);
    }
  } catch {}
  const shown = codeFiles.slice(0, 10).join(", ");
  const more = codeFiles.length > 10 ? ` (+${codeFiles.length - 10} more)` : "";
  const lines = [
    "END-TO-END COMPLETENESS: code changed this session but no doc or state artifact moved with it.",
    `Changed code: ${shown}${more}`,
    "Do what applies before finishing:",
    `1. \`${BRAND.cli} docs sync\` — sweep the diff for stale doc mentions${
      likelyDocs.length ? ` (graph suggests: ${likelyDocs.join(", ")})` : ""
    } and update every hit.`,
    `2. \`${BRAND.cli} handoff "<what you did>" --next "<what's next>"\` — rewrite the session snapshot the next session resumes from (this alone satisfies the gate).`,
    `3. \`${BRAND.cli} decide "<choice — reason>"\` if a non-obvious decision was made.`,
  ];
  if (driftAlarm)
    lines.push(
      `4. Sustained goal drift this session (CUSUM alarm) — re-read the goal: \`${BRAND.cli} anchor\`.`,
    );
  lines.push(
    `If genuinely no doc is affected, tell the user why in one line and still run \`${BRAND.cli} handoff\`.`,
    "(Blocks once per session — stopping again proceeds. Kill switch: FORGE_STOPGATE=0.)",
  );
  return lines.join("\n");
}

/**
 * The impure orchestrator the Stop hook calls. Every step is guarded; ANY internal
 * error resolves to allow — the gate must never brick a session.
 */
export function stopGate(root, sid, hook = {}) {
  try {
    if (hook.stop_hook_active === true || hook.stop_hook_active === "true")
      return { allow: true, row: "stop-hook-active" };
    if (process.env.FORGE_STOPGATE === "0") return { allow: true, row: "kill-switch" };
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true")
      return { allow: true, row: "not-a-repo" };
    const marker = sessionPath(root, sid, "blocked");
    if (existsSync(marker)) return { allow: true, row: "already-blocked" };
    const base = readBaseline(root, sid);
    // Session-start timestamp: the baseline file's mtime; degraded fallback = the event
    // log's birth time (hooks installed mid-session). Without either, mtime signals
    // can't be trusted — stateTouched stays false and the block-once marker caps cost.
    let startedAt = base?.t ?? null;
    if (startedAt == null) {
      try {
        startedAt = statSync(sessionPath(root, sid)).birthtimeMs || null;
      } catch {}
    }
    const stateTouched =
      startedAt != null &&
      [statePath(root), decisionsPath(root)].some((p) => {
        try {
          return statSync(p).mtimeMs > startedAt;
        } catch {
          return false;
        }
      });
    const changed = changedSet(root, base?.head);
    const decision = gateDecision({ changed, stateTouched });
    if (decision.allow) return decision;
    let driftAlarm = false;
    try {
      const scores = readSession(root, sid)
        .filter((e) => e.type === "drift")
        .map((e) => Number(e.score))
        .filter(Number.isFinite);
      if (scores.length >= 3) driftAlarm = cusum(scores).alarm;
    } catch {}
    const reason = repairReason(root, { codeFiles: decision.classes.code, driftAlarm });
    try {
      mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
      writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {}
    return { allow: false, row: decision.row, reason, classes: decision.classes };
  } catch {
    return { allow: true, row: "internal-error" };
  }
}

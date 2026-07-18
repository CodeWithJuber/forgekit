// forge gate — the completion gate: a deterministic floor under "done". Instructions and
// lessons raise the PROBABILITY that code ships with its docs/state; this Stop hook
// guarantees a floor: a session that changed code but produced no TEST EVIDENCE (a test
// file moved, or a fresh passing `verify` provenance stamp) or moved no doc/state
// artifact is blocked ONCE, with the exact repair procedure as the reason. P(silent miss) =
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { cusum } from "./anchor.js";
import { CODE_EXTS, DOC_EXTS, impact, isConfigFile, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { readSession, sessionPath } from "./cortex_hook.js";
import { decisionsPath } from "./decide.js";
import { statePath } from "./handoff.js";
import { readBaseline, readDirtySnapshot } from "./session.js";
import { isTestFile } from "./substrate.js";
import { IGNORE_DIRS } from "./util.js";

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

// All -z (NUL-separated) parsing: git's C-quoting of unicode/space/quote paths never
// reaches us, so `Änderungen.md` classifies as docs instead of `other` (a review-found
// false block) and a file literally named `plan -> v2.md` can't be split in two.
function statusEntriesZ(root) {
  const raw = gitRaw(root, ["status", "--porcelain", "-z", "-uall"]);
  const tokens = raw.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.length < 4 || t[2] !== " ") continue;
    paths.push(t.slice(3));
    if (/[RC]/.test(t[0])) paths.push(tokens[++i] ?? ""); // rename/copy: next token is the source
  }
  return paths.filter(Boolean);
}

// Files committed DURING the session: commits in base..HEAD whose committer time is at
// or after session start. A branch switch or `git pull` moves HEAD onto commits made
// long before the session — a plain baseline diff would attribute all of them to the
// agent (review-found false block). Merge commits list no files (correct: the merged
// work predates the session); the 2s slack absorbs clock granularity.
function committedSince(root, baseHead, sinceMs) {
  if (!baseHead || !git(root, ["rev-parse", "--verify", `${baseHead}^{commit}`])) return [];
  const since = new Date(Math.max(0, (sinceMs ?? 0) - 2000)).toISOString();
  const raw = gitRaw(root, [
    "log",
    "--name-only",
    "-z",
    "--pretty=format:",
    `--since=${since}`,
    `${baseHead}..HEAD`,
  ]);
  return raw
    .split("\0")
    .flatMap((chunk) => chunk.split("\n"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Vendor/build trees that are somehow not gitignored must never be pinned on the agent.
const IGNORED_PREFIX = (p) => IGNORE_DIRS.has(String(p).split("/")[0]);

/**
 * Everything attributable to THIS session: files from session-time commits ∪ the
 * working tree minus whatever was already dirty at session start. Pre-existing dirt,
 * pulled-in commits, and vendor trees stay out — near-zero false blocks is the gate's
 * credibility. Degraded mode (no baseline/snapshot): the full worktree, still bounded
 * by the block-once marker.
 * @param {string} root
 * @param {string|null} [baseHead]
 * @param {{sinceMs?: number, preDirty?: Set<string>}} [opts]
 */
export function changedSet(root, baseHead, { sinceMs, preDirty } = {}) {
  const out = new Set(committedSince(root, baseHead, sinceMs));
  for (const p of statusEntriesZ(root)) {
    if (preDirty?.has(p)) continue; // already dirty before the session began
    out.add(p);
  }
  return [...out].filter((p) => !IGNORED_PREFIX(p)).sort();
}

/**
 * PURE decision table (first match wins; returns {allow, row, classes}). The teeth
 * (RA-10): a code change owes TEST EVIDENCE — a test-class file moved with it, or a
 * fresh passing `verify` run (provenance stamp newer than session start) — AND a
 * doc/state artifact. A handoff/state touch alone still counts as the continuity
 * (docs) leg, but it can no longer satisfy the gate by itself when code moved; only
 * a config-only change keeps that lighter bar.
 * @param {{stopHookActive?: boolean, isRepo?: boolean, markerExists?: boolean,
 *   killSwitch?: boolean, changed?: string[], stateTouched?: boolean,
 *   verifyEvidence?: {fresh: boolean, status: string} | null}} [input]
 */
export function gateDecision({
  stopHookActive = false,
  isRepo = true,
  markerExists = false,
  killSwitch = false,
  changed = [],
  stateTouched = false,
  verifyEvidence = null,
} = {}) {
  if (stopHookActive) return { allow: true, row: "stop-hook-active" };
  if (!isRepo) return { allow: true, row: "not-a-repo" };
  if (markerExists) return { allow: true, row: "already-blocked" };
  if (killSwitch) return { allow: true, row: "kill-switch" };
  const classes = Object.fromEntries(CLASSES.map((c) => [c, []]));
  for (const f of changed) classes[classifyPath(f)].push(f);
  const external = changed.length - classes.internal.length;
  if (!external && !stateTouched) return { allow: true, row: "no-changes", classes };
  const testEvidence =
    classes.test.length > 0 ||
    (verifyEvidence?.fresh === true && verifyEvidence?.status === "PASS");
  const docEvidence = classes.docs.length > 0 || stateTouched;
  if (classes.code.length) {
    if (!testEvidence) return { allow: false, row: "code-without-test-evidence", classes };
    if (!docEvidence) return { allow: false, row: "code-without-docs", classes };
    return { allow: true, row: "code-with-evidence", classes };
  }
  // Test-only sessions (a regression test owes no prose) pass; config-only still owes
  // at least the lighter continuity bar (docs or a state/handoff touch).
  if (classes.test.length && !classes.config.length)
    return { allow: true, row: "test-only", classes };
  if (classes.config.length && !docEvidence)
    return { allow: false, row: "config-without-docs", classes };
  return {
    allow: true,
    row: docEvidence ? "docs-touched" : "no-code-class",
    classes,
  };
}

/** The change-type obligation matrix (P1-05): what evidence each kind of change owes, so
 *  the gate points at the RIGHT artifact instead of treating any doc/state touch as done.
 *  Derived from the classes already computed — a pure function so it's easy to test.
 *  @param {{code?: string[], config?: string[], test?: string[]}} classes */
export function obligationsFor(classes = {}) {
  const out = [];
  if (classes.code?.length)
    out.push(
      "Code changed → update the docs it affects AND add/adjust a test that exercises the new behaviour (a handoff note alone is not the obligation).",
    );
  if (classes.config?.length)
    out.push("Config changed → update the config/deployment docs that describe it.");
  return out;
}

/** The block reason IS the repair procedure — its consumer is the agent itself, and a
 *  checklist converts a failure into a same-turn fix. Parameterized by the blocked row
 *  so it leads with the MISSING leg (test evidence vs docs vs config docs); the old
 *  "handoff alone satisfies the gate" claim survives only on the config-only row, where
 *  that lighter bar is real. Stale-doc candidates come from the CACHED atlas only (a
 *  hook never builds).
 *  @param {string} root
 *  @param {{codeFiles?: string[], driftAlarm?: boolean,
 *    classes?: {code?: string[], config?: string[], test?: string[]}, row?: string}} [opts] */
export function repairReason(
  root,
  { codeFiles = [], driftAlarm = false, classes = {}, row = "code-without-docs" } = {},
) {
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
  const cited = codeFiles.length ? codeFiles : (classes.config ?? []);
  const shown = cited.slice(0, 10).join(", ");
  const more = cited.length > 10 ? ` (+${cited.length - 10} more)` : "";
  const obligations = obligationsFor(classes);
  const docsSyncStep = `\`${BRAND.cli} docs sync\` — sweep the diff for stale doc mentions${
    likelyDocs.length ? ` (graph suggests: ${likelyDocs.join(", ")})` : ""
  } and update every hit.`;
  const handoffStep = (suffix = "") =>
    `\`${BRAND.cli} handoff "<what you did>" --next "<what's next>"\` — rewrite the session snapshot the next session resumes from${suffix}.`;
  const decideStep = `\`${BRAND.cli} decide "<choice — reason>"\` if a non-obvious decision was made.`;
  let headline;
  const steps = [];
  if (row === "code-without-test-evidence") {
    headline = `END-TO-END COMPLETENESS: code changed this session with NO test evidence — no test file moved with it and no fresh passing \`${BRAND.cli} verify\` run backs the change.`;
    steps.push(
      `\`${BRAND.cli} verify\` — run the project's own tests against this change (or add/adjust a test that exercises the new behaviour).`,
      docsSyncStep,
      handoffStep(),
      decideStep,
    );
  } else if (row === "config-without-docs") {
    headline =
      "END-TO-END COMPLETENESS: config changed this session but no doc or state artifact moved with it.";
    steps.push(
      docsSyncStep,
      handoffStep(" (this alone satisfies the gate for a config-only change)"),
      decideStep,
    );
  } else {
    headline =
      "END-TO-END COMPLETENESS: code changed this session but no doc or state artifact moved with it.";
    steps.push(docsSyncStep, handoffStep(), decideStep);
  }
  if (driftAlarm)
    steps.push(
      `Sustained goal drift this session (CUSUM alarm) — re-read the goal: \`${BRAND.cli} anchor\`.`,
    );
  const lines = [
    headline,
    ...(shown ? [`Changed ${codeFiles.length ? "code" : "config"}: ${shown}${more}`] : []),
    ...(obligations.length
      ? ["Obligations for this change:", ...obligations.map((o) => `- ${o}`)]
      : []),
    "Do what applies before finishing:",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    `If genuinely no doc is affected, tell the user why in one line and still run \`${BRAND.cli} handoff\`.`,
    "(Blocks once per session — stopping again proceeds. Kill switch: FORGE_STOPGATE=0.)",
  ];
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
    // No session identity → no per-session marker/baseline is trustworthy; a shared
    // "default" would leak one session's block/allow into every other (review-found).
    if (!hook.session_id) return { allow: true, row: "no-session" };
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
    const changed = changedSet(root, base?.head, {
      sinceMs: startedAt ?? undefined,
      preDirty: readDirtySnapshot(root, sid) ?? undefined,
    });
    // Test evidence for the RA-10 rows: a `verify` provenance stamp written THIS session
    // (mtime after session start) whose tests verdict is PASS — the exact field verify.js
    // writes. Parse-guarded: any trouble → null → the evidence leg simply fails, and the
    // block-once marker still caps the cost (second stop always proceeds — cannot brick).
    let verifyEvidence = null;
    try {
      const provPath = join(root, ".forge", "provenance.json");
      const mtime = statSync(provPath).mtimeMs;
      const status = JSON.parse(readFileSync(provPath, "utf8"))?.tests?.status;
      if (typeof status === "string")
        verifyEvidence = {
          fresh: startedAt != null && mtime > startedAt,
          status,
        };
    } catch {}
    const decision = gateDecision({ changed, stateTouched, verifyEvidence });
    if (decision.allow) return decision;
    // Marker FIRST: if it can't be persisted, the block-once promise can't be kept —
    // on a read-only checkout that would mean an unsatisfiable block every turn, so
    // the honest move is to stand down (fail-open, review-found).
    try {
      mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
      writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {
      return { allow: true, row: "marker-unwritable" };
    }
    let driftAlarm = false;
    try {
      const scores = readSession(root, sid)
        .filter((e) => e.type === "drift")
        .map((e) => Number(e.score))
        .filter(Number.isFinite);
      if (scores.length >= 3) driftAlarm = cusum(scores).alarm;
    } catch {}
    const reason = repairReason(root, {
      codeFiles: decision.classes.code,
      driftAlarm,
      classes: decision.classes,
      row: decision.row,
    });
    return {
      allow: false,
      row: decision.row,
      reason,
      classes: decision.classes,
    };
  } catch {
    return { allow: true, row: "internal-error" };
  }
}

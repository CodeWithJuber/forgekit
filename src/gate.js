// forge gate — the completion gate: a deterministic floor under "done". Instructions and
// lessons raise the PROBABILITY that code ships with its docs/state; this Stop hook
// guarantees a floor: a session that changed code but produced no TEST EVIDENCE (a test
// file moved, or a fresh passing `verify` provenance stamp) or moved no doc/state
// artifact is blocked ONCE, with the exact repair procedure as the reason. P(silent miss) =
// (1−p)·P(no check fires | miss) (formal synthesis Theorem D, corrected 2026-09-21). On
// its proxy, "code moved, nothing followed", the first stop fires exactly (T3). Its catch
// rate on real misses depends on the agent (touching state.md satisfies the docs leg, and
// the block fires once per session) and has not been measured. The same classifier re-run
// at pre-commit or in CI is a NESTED check on the same diff: (1−p)(1−c_max), not a
// product. Loop-safe (stop_hook_active + once-per-session marker), fail-open on every
// error path, kill switch FORGE_STOPGATE=0.
//
// Classification derives from the SAME registries the atlas is built from (CODE_EXTS/
// DOC_EXTS/config rules) + the shared test-file predicate — no parallel regex lists that
// could drift. Deliberate deviation from the reference kit: test-only changes do NOT
// block (a regression-test-only session owes no prose), and .forge/state.md — invisible
// to git because .forge/ is gitignored — counts as the doc signal via its mtime against
// the session baseline (the baseline file's mtime IS the session-start timestamp).
//
// UI-only changes are their own class. A stylesheet edit, or a JS/TS edit whose every
// change is presentational (className/class/style values, cva-style variant strings, JSX
// text — see uidiff.js), owes a design/state record OR a UI check (a fresh `forge uicheck
// design|visual` PASS, a passing e2e run, or a fresh `forge verify`), not a unit test.
// In a checkout several agents share, a changed file another live session's trail claims
// (and this session's does not) is named but not weighed (session.js attributeChanges);
// every change no trail accounts for is weighed, exactly as the tree-wide diff always was.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { cusum } from "./anchor.js";
import {
  byRelation,
  CODE_EXTS,
  DOC_EXTS,
  fileRelations,
  IMPACT_RELATIONS,
  impact,
  isConfigFile,
  load as loadAtlas,
} from "./atlas.js";
import { BRAND } from "./brand.js";
import { readSession, sessionPath } from "./cortex_hook.js";
import { decisionsPath } from "./decide.js";
import { statePath } from "./handoff.js";
import {
  attributeChanges,
  changedSet,
  readBaseline,
  readDirtySnapshot,
  readTrail,
} from "./session.js";
import { isTestFile } from "./substrate.js";
import { presentationalOnly } from "./uidiff.js";
import { computeCodeState, evidenceMac, provenanceMac } from "./verify.js";

// changedSet moved to session.js (the pre-action checks scope by it too); re-exported so
// existing importers keep working.
export { changedSet };

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

export const CLASSES = ["code", "ui", "docs", "config", "test", "internal", "other"];

// Stylesheets: pure presentation. The same visual change a className edit makes, so it
// owes what a UI-only code change owes (see gateDecision), where it used to owe nothing.
const STYLE_EXTS = new Set([".css", ".scss", ".sass", ".less"]);
// JS/TS sources the presentational-diff check can read (uidiff.js speaks JS/TS/JSX).
const UI_SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const UI_DIFF_MAX_BYTES = 512 * 1024;
// Past this many code files the change is not treated as UI-only (it stays code): the
// per-file check costs a git read each, and a sweep that wide is not a styling tweak.
const UI_DIFF_MAX_FILES = 50;

/** Total function path → class. Order matters: the state/decisions snapshots are doc
 *  artifacts FIRST (the minimum-bar trick), then everything else under .forge/ and the
 *  generated instruction files are internal (never owed docs). A JS/TS file is "code" by
 *  path; stopGate reclassifies it to "ui" when its diff is presentational only. */
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
  if (STYLE_EXTS.has(extname(name))) return "ui";
  return "other";
}

// Blank lines and comment-only lines are not test code — a `// touched` line appended to an
// existing test file is a touch, not a test (B7). Deliberately language-agnostic: `//`, `#`,
// `*`, `/*`, `--`, `<!--` cover every stack the atlas classifies.
const COMMENT_LINE = /^\s*($|\/\/|#|\*|\/\*|--|<!--)/;

/**
 * Was this block-once marker written by the gate itself? It carries the MAC of its session
 * id; a marker the agent dropped in ahead of time does not, and is ignored (B7). With no key
 * available at all (unwritable state dir) every marker counts, as before.
 * @param {string} sid @param {string} marker
 */
function markerIsAuthentic(sid, marker) {
  const mac = evidenceMac(["block", sid]);
  if (mac == null) return true;
  try {
    return readFileSync(marker, "utf8").includes(mac);
  } catch {
    return false;
  }
}

/**
 * The lines this session ADDED to `file`: the diff against the session baseline (or HEAD),
 * falling back to the whole file for a brand-new untracked one. Comment/blank lines are
 * dropped, so the caller sees real code only.
 * @param {string} root @param {string} file @param {string|null} [baseHead]
 * @returns {string[]}
 */
function addedCodeLines(root, file, baseHead) {
  const args = [
    "--literal-pathspecs",
    "diff",
    "--unified=0",
    "--no-color",
    "--text",
    "--no-ext-diff",
    "--no-textconv",
  ];
  const raw =
    gitRaw(root, [...args, ...(baseHead ? [baseHead] : []), "--", file]) ||
    gitRaw(root, [...args, "HEAD", "--", file]);
  let lines;
  if (raw.trim()) {
    lines = raw
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1));
  } else {
    // Untracked (new) file: every line is added. Unreadable → no evidence.
    try {
      lines = readFileSync(join(root, file), "utf8").split("\n");
    } catch {
      return [];
    }
  }
  return lines.filter((l) => !COMMENT_LINE.test(l));
}

/**
 * Code files (by path) whose diff against the session baseline is PRESENTATIONAL only:
 * the file existed at the baseline, still exists, and its uidiff skeleton did not move.
 * Any doubt (a new or deleted file, an unreadable blob, a huge file) keeps it code.
 * @param {string} root @param {string[]} files @param {string|null} [baseHead]
 * @returns {string[]}
 */
function presentationalFiles(root, files, baseHead) {
  const rev = baseHead || "HEAD";
  return files.filter((f) => {
    if (!UI_SOURCE_EXTS.has(extname(f))) return false;
    try {
      const abs = join(root, f);
      if (statSync(abs).size > UI_DIFF_MAX_BYTES) return false;
      const before = execFileSync("git", ["cat-file", "blob", `${rev}:${f}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: UI_DIFF_MAX_BYTES * 2,
      });
      // A .ts file cannot hold JSX (`<T>` there is a type); object keys count as props only
      // in .jsx/.tsx, where `className:`/`style: {…}` is a props table, not `Intl`'s `style`.
      const ext = extname(f);
      return presentationalOnly(before, readFileSync(abs, "utf8"), {
        tags: ext !== ".ts",
        keys: ext === ".jsx" || ext === ".tsx",
      });
    } catch {
      return false;
    }
  });
}

const UI_STAMP = (root) => join(root, ".forge", "uicheck.json");
const uiCheckMac = (stamp) =>
  evidenceMac([
    "uicheck",
    stamp?.check,
    stamp?.status,
    stamp?.codeState?.dirtyHash,
    (Array.isArray(stamp?.files) ? stamp.files : []).join("\n"),
  ]);

/**
 * Record a `forge uicheck design|visual` verdict as UI evidence for the completion gate:
 * the status, the files a `design` check read, the code state it ran against, and a MAC (a
 * hand-written stamp is not evidence, B7). A FAIL is recorded too, so it replaces an
 * earlier PASS. `cwd` is where the command ran: `files` resolve against it, and the stamp
 * lands at the git toplevel with toplevel-relative paths (the gate reads it there and
 * compares it with `git status` paths), even when the check ran from a subdirectory.
 * Outside a git work tree there is no code state to bind to (and no gate to feed):
 * nothing is written.
 * @param {string} cwd
 * @param {{check: string, pass: boolean, files?: string[]}} verdict
 * @returns {boolean} whether the stamp was written
 */
export function recordUiCheck(cwd, { check, pass, files = [] }) {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!root) return false;
    const codeState = computeCodeState(root);
    if (!codeState.gitAvailable || !codeState.dirtyHash) return false;
    // git prints the toplevel with symlinks resolved; resolve cwd the same way.
    const here = realpathSync(cwd);
    const stamp = {
      check: String(check),
      status: pass ? "PASS" : "FAIL",
      files: files.map((f) => relative(root, resolve(here, f)).replace(/\\/g, "/")).sort(),
      codeState,
    };
    const mac = uiCheckMac(stamp);
    mkdirSync(join(root, ".forge"), { recursive: true });
    writeFileSync(UI_STAMP(root), JSON.stringify(mac ? { ...stamp, signature: mac } : stamp));
    return true;
  } catch {
    return false;
  }
}

/**
 * PURE decision table (first match wins; returns {allow, row, classes}). The teeth
 * (RA-10): a code change owes TEST EVIDENCE — a test-class file moved with it, a fresh
 * passing `verify` run (provenance stamp newer than session start), or a passing e2e run
 * bound to the current code — AND a doc/state artifact. A handoff/state touch alone still
 * counts as the continuity (docs) leg, but it can no longer satisfy the gate by itself
 * when code moved. A UI-only change (stylesheets, and code files listed in `uiOnly`)
 * owes ONE of: a doc/state artifact, a UI check (a fresh `forge uicheck` PASS), or test
 * evidence; a config-only change keeps the lighter docs/state bar.
 * @param {{stopHookActive?: boolean, isRepo?: boolean, markerExists?: boolean,
 *   killSwitch?: boolean, changed?: string[], stateTouched?: boolean,
 *   verifyEvidence?: {fresh: boolean, status: string, codeStateMatches?: boolean, authentic?: boolean} | null,
 *   substantiveTests?: string[] | null, uiOnly?: string[] | null,
 *   uiCheckEvidence?: boolean, e2eEvidence?: boolean}} [input]
 *   verifyEvidence.codeStateMatches — the stamp's stored code-state fingerprint still
 *     equals the code as it stands now (HI-02); a fresh PASS only counts when this is true.
 *   verifyEvidence.authentic — the stamp carries the MAC `forge verify` writes (B7);
 *     `false` means it was hand-written. Absent (pure-table callers) counts as authentic.
 *   substantiveTests — the FS-filtered subset of changed test files that still exist and
 *     are non-empty (HI-04); null (pure-table callers) falls back to raw classification.
 *   uiOnly — code-class paths whose diff is presentational only (stopGate computes it);
 *     they move to the ui class.
 *   uiCheckEvidence — a fresh, signed `forge uicheck design|visual` PASS bound to the
 *     current code state. Satisfies a UI-only change, never a code change.
 *   e2eEvidence — a passing e2e run this session, bound to the current code state. Test
 *     evidence for code and UI alike.
 */
export function gateDecision({
  stopHookActive = false,
  isRepo = true,
  markerExists = false,
  killSwitch = false,
  changed = [],
  stateTouched = false,
  verifyEvidence = null,
  substantiveTests = null,
  uiOnly = null,
  uiCheckEvidence = false,
  e2eEvidence = false,
} = {}) {
  if (stopHookActive) return { allow: true, row: "stop-hook-active" };
  if (!isRepo) return { allow: true, row: "not-a-repo" };
  if (markerExists) return { allow: true, row: "already-blocked" };
  if (killSwitch) return { allow: true, row: "kill-switch" };
  const classes = Object.fromEntries(CLASSES.map((c) => [c, []]));
  const presentational = new Set(uiOnly ?? []);
  for (const f of changed) {
    const c = classifyPath(f);
    classes[c === "code" && presentational.has(f) ? "ui" : c].push(f);
  }
  const external = changed.length - classes.internal.length;
  if (!external && !stateTouched) return { allow: true, row: "no-changes", classes };
  // Test evidence has three legs. STRONG (HI-02): a fresh `verify` PASS whose stored code
  // state still matches the tree NOW — proof the tests ran against the FINAL code, not a
  // since-mutated one. The same binding makes a passing e2e run strong too. WEAKER
  // (HI-04): a substantive test file moved with the change (added/modified and non-empty
  // — a deleted or emptied test is an obligation signal, never proof). `substantiveTests`
  // is the caller's FS-filtered set; absent it (pure callers) we trust the raw classes.
  const strongVerify =
    verifyEvidence?.fresh === true &&
    verifyEvidence?.status === "PASS" &&
    verifyEvidence?.codeStateMatches === true &&
    verifyEvidence?.authentic !== false; // B7: a hand-written stamp carries no valid MAC
  const hasTestFile =
    substantiveTests == null ? classes.test.length > 0 : substantiveTests.length > 0;
  const testEvidence = strongVerify || e2eEvidence === true || hasTestFile;
  const docEvidence = classes.docs.length > 0 || stateTouched;
  if (classes.code.length) {
    if (!testEvidence) return { allow: false, row: "code-without-test-evidence", classes };
    if (!docEvidence) return { allow: false, row: "code-without-docs", classes };
    return { allow: true, row: "code-with-evidence", classes };
  }
  // UI-only (styling, class/style/variant strings, JSX text): a unit test cannot see it,
  // so ANY one of a design/state record, a UI check, or test evidence covers it. Config
  // that moved alongside still owes its own docs/state bar below.
  if (classes.ui.length) {
    if (!docEvidence && uiCheckEvidence !== true && !testEvidence)
      return { allow: false, row: "ui-without-evidence", classes };
    if (!classes.config.length || docEvidence)
      return { allow: true, row: "ui-with-evidence", classes };
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
 *  @param {{code?: string[], ui?: string[], config?: string[], test?: string[]}} classes */
export function obligationsFor(classes = {}) {
  const out = [];
  if (classes.code?.length)
    out.push(
      "Code changed → update the docs it affects AND add/adjust a test that exercises the new behaviour (a handoff note alone is not the obligation).",
    );
  if (classes.ui?.length)
    out.push(
      `UI-only change (styling, class/style/variant strings, JSX text) → a unit test is not owed: record it (design doc or handoff) OR check it (\`${BRAND.cli} uicheck design|visual\`, the e2e suite, or \`${BRAND.cli} verify\`).`,
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
 *  hook never builds). The same walk names the code files the graph predicts should
 *  co-change but the session never touched, tagged by relation — the reverse-only walk
 *  missed the sibling files that were 94.7% of the empirical refutation's misses, so the
 *  default walks IMPACT_RELATIONS; `relations: ["reverse"]` is the reverse-only option.
 *  A UI-only block cites the UI files and leads with the UI check; its graph walk looks
 *  for docs only (a className tweak owes no co-change sweep). `unattributed` counts the
 *  changed files another live session's trail claims and this one's does not — named, not
 *  weighed.
 *  @param {string} root
 *  @param {{codeFiles?: string[], driftAlarm?: boolean,
 *    classes?: {code?: string[], ui?: string[], config?: string[], test?: string[], docs?: string[]},
 *    row?: string, relations?: readonly string[], unattributed?: number}} [opts] */
export function repairReason(
  root,
  {
    codeFiles = [],
    driftAlarm = false,
    classes = {},
    row = "code-without-docs",
    relations = IMPACT_RELATIONS,
    unattributed = 0,
  } = {},
) {
  const uiRow = row === "ui-without-evidence";
  const walked = codeFiles.length ? codeFiles : uiRow ? (classes.ui ?? []) : [];
  let likelyDocs = [];
  /** @type {string[]} */
  let coChange = [];
  try {
    const atlas = loadAtlas(root);
    if (atlas) {
      const docs = new Set();
      const reports = walked.slice(0, 10).map((f) => impact(atlas, f, { maxHops: 2, relations }));
      for (const r of reports) for (const d of r.impactedFiles) if (d.endsWith(".md")) docs.add(d);
      likelyDocs = [...docs].slice(0, 5);
      const touched = new Set(Object.values(classes).flat());
      for (const f of codeFiles) touched.add(f);
      const rels = fileRelations(reports);
      if (codeFiles.length)
        coChange = byRelation(
          Object.keys(rels).filter((f) => !touched.has(f) && classifyPath(f) === "code"),
          rels,
        ).map((f) => `${f} (${rels[f]})`);
    }
  } catch {}
  const cited = codeFiles.length ? codeFiles : uiRow ? (classes.ui ?? []) : (classes.config ?? []);
  const citedKind = codeFiles.length ? "code" : uiRow ? "UI" : "config";
  const shown = cited.slice(0, 10).join(", ");
  const more = cited.length > 10 ? ` (+${cited.length - 10} more)` : "";
  const obligations = obligationsFor(classes);
  const docsSyncStep = `\`${BRAND.cli} docs sync\` — sweep the diff for stale doc mentions${
    likelyDocs.length ? ` (graph suggests: ${likelyDocs.join(", ")})` : ""
  } and update every hit.`;
  const handoffStep = (suffix = "") =>
    `\`${BRAND.cli} handoff "<what you did>" --next "<what's next>"\` — rewrite the session snapshot the next session resumes from${suffix}.`;
  const decideStep = `\`${BRAND.cli} decide "<choice — reason>"\` if a non-obvious decision was made.`;
  const coChangeStep = coChange.length
    ? `Co-change candidates the graph predicts but this session never touched — confirm each needs no change: ${coChange
        .slice(0, 8)
        .join(
          ", ",
        )}${coChange.length > 8 ? ` (+${coChange.length - 8} more)` : ""}. (reverse = depends on the change · sibling = shares a dependency with it · forward = the change depends on it)`
    : "";
  let headline;
  const steps = [];
  if (row === "code-without-test-evidence") {
    headline = `END-TO-END COMPLETENESS: code changed this session with NO test evidence — no substantive test file (added or modified, non-empty; a deleted or empty test does not count) moved with it, and no fresh passing \`${BRAND.cli} verify\` run (or e2e run) bound to the CURRENT code state backs the change (a verify that ran BEFORE your last edit is stale — re-run it after the final change).`;
    steps.push(
      `\`${BRAND.cli} verify\` — run the project's own tests against this change AFTER your final edit (a verify from before the last change no longer matches the code; a passing e2e run such as \`npm run e2e\` after the final edit counts too), or add/adjust a real test that exercises the new behaviour.`,
      docsSyncStep,
      handoffStep(),
      decideStep,
    );
  } else if (uiRow) {
    headline =
      "END-TO-END COMPLETENESS: a UI-only change this session (styling, class/style/variant strings, or JSX text) with no design/state record and no UI check. A unit test is not owed — one of the steps below is.";
    steps.push(
      `\`${BRAND.cli} uicheck design <the files above>\` (or \`${BRAND.cli} uicheck visual <url>\`) — a PASS after your final edit counts; so does a passing e2e run (\`npm run e2e\`) or \`${BRAND.cli} verify\`.`,
      docsSyncStep,
      handoffStep(" (this alone satisfies the gate for a UI-only change)"),
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
  // Second, right after the row's lead step: the files the diff may still owe a change.
  if (coChangeStep) steps.splice(1, 0, coChangeStep);
  if (driftAlarm)
    steps.push(
      `Sustained goal drift this session (CUSUM alarm) — re-read the goal: \`${BRAND.cli} anchor\`.`,
    );
  const lines = [
    headline,
    ...(shown ? [`Changed ${citedKind}: ${shown}${more}`] : []),
    ...(unattributed > 0
      ? [
          `(${unattributed} other changed file(s) in the tree are another agent's work — another live session's trail names them and this session's does not — and are not counted.)`,
        ]
      : []),
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
    // The block-once marker is a file in `.forge/` too, so it is MAC'd like the stamp: a
    // marker the agent writes ahead of time must not switch the gate off (B7).
    const marker = sessionPath(root, sid, "blocked");
    if (existsSync(marker) && markerIsAuthentic(sid, marker))
      return { allow: true, row: "already-blocked" };
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
    const all = changedSet(root, base?.head, {
      sinceMs: startedAt ?? undefined,
      preDirty: readDirtySnapshot(root, sid) ?? undefined,
    });
    // Multi-agent checkouts: a file another live session's trail claims, and this session's
    // trail does not, is that agent's work. Only positive evidence sets a file aside, so a
    // write no trail saw (a glob, a heredoc script, an MCP tool) stays with this session,
    // and without an authoritative trail (hooks installed mid-session, no tool call yet)
    // the tree-wide view stands, as before.
    const trail = readTrail(root, sid);
    const { mine: changed, others } = attributeChanges(root, sid, all, {
      sinceMs: startedAt,
    });
    // Every evidence stamp is bound to the code state it ran against (HI-02); compute the
    // state NOW once, and only if some stamp needs it.
    /** @type {{head: string|null, dirtyHash: string|null, gitAvailable: boolean} | null} */
    let nowState = null;
    const matchesNow = (stored) => {
      try {
        nowState ??= computeCodeState(root);
        return (
          !!stored &&
          stored.gitAvailable !== false &&
          nowState.gitAvailable === true &&
          typeof stored.dirtyHash === "string" &&
          typeof nowState.dirtyHash === "string" &&
          stored.dirtyHash === nowState.dirtyHash
        );
      } catch {
        return false;
      }
    };
    // Test evidence for the RA-10 rows: a `verify` provenance stamp written THIS session
    // (mtime after session start) whose tests verdict is PASS — the exact field verify.js
    // writes. Parse-guarded: any trouble → null → the evidence leg simply fails, and the
    // block-once marker still caps the cost (second stop always proceeds — cannot brick).
    let verifyEvidence = null;
    try {
      const provPath = join(root, ".forge", "provenance.json");
      const mtime = statSync(provPath).mtimeMs;
      const prov = JSON.parse(readFileSync(provPath, "utf8"));
      const status = prov?.tests?.status;
      if (typeof status === "string") {
        // HI-02: the PASS only counts if the code has NOT moved since verification — the
        // stamp's stored codeState.dirtyHash must still equal the code state recomputed
        // NOW. Any doubt (git unavailable, null hash on either side, or a throw) → the
        // stamp is NON-authoritative and does not count (fail toward a test-file change).
        const codeStateMatches =
          prov?.codeState?.gitAvailable === true && matchesNow(prov?.codeState);
        const mac = provenanceMac(prov);
        verifyEvidence = {
          fresh: startedAt != null && mtime > startedAt,
          status,
          codeStateMatches,
          // No key available anywhere (unwritable state dir) → degrade to unsigned rather
          // than blocking a session that can never produce a signed stamp.
          authentic: mac == null || prov?.signature === mac,
        };
      }
    } catch {}
    // HI-04 + B7: a changed test file is an OBLIGATION signal, not proof. It counts toward
    // the weaker evidence leg only if it still EXISTS, is NON-EMPTY, and this session added
    // at least one line of real test CODE to it — a comment-only touch (`// touched`) used
    // to satisfy the gate. The strong leg is the code-state-bound, MAC'd verify PASS.
    const substantiveTests = changed.filter((p) => {
      if (classifyPath(p) !== "test") return false;
      try {
        if (statSync(join(root, p)).size <= 0) return false;
      } catch {
        return false;
      }
      return addedCodeLines(root, p, base?.head).length > 0;
    });
    // UI evidence: a `forge uicheck design|visual` PASS written this session, signed, and
    // bound to the current code (recordUiCheck writes it). Any doubt → no evidence.
    /** @type {{check: string, files: string[]} | null} */
    let uiStamp = null;
    try {
      const mtime = statSync(UI_STAMP(root)).mtimeMs;
      const stamp = JSON.parse(readFileSync(UI_STAMP(root), "utf8"));
      const mac = uiCheckMac(stamp);
      if (
        startedAt != null &&
        mtime > startedAt &&
        stamp?.status === "PASS" &&
        (mac == null || stamp?.signature === mac) &&
        matchesNow(stamp?.codeState)
      )
        uiStamp = {
          check: String(stamp.check),
          files: Array.isArray(stamp.files) ? stamp.files : [],
        };
    } catch {}
    // A `design` check covers only the files it read (checking some other file proves
    // nothing about this change); a `visual` check renders the page, so it covers the UI.
    const uiCheckCovers = (/** @type {string[]} */ uiFiles) =>
      !!uiStamp && (uiStamp.check !== "design" || uiFiles.every((f) => uiStamp?.files.includes(f)));
    // A passing e2e run this session (the trail records one per successful run), MAC'd
    // and bound to the code state it ran against — the same binding as verify.
    const e2eEvidence = !!trail?.e2e.some((e) => {
      const mac = evidenceMac(["e2e", sid, e.code]);
      return (mac == null || e.mac === mac) && matchesNow({ dirtyHash: e.code });
    });
    const decide = (/** @type {string[]} */ uiOnly) =>
      gateDecision({
        changed,
        stateTouched,
        verifyEvidence,
        substantiveTests,
        uiOnly,
        uiCheckEvidence: uiCheckCovers([
          ...changed.filter((p) => classifyPath(p) === "ui"),
          ...uiOnly,
        ]),
        e2eEvidence,
      });
    let decision = decide([]);
    // A code file whose every change is presentational owes what a stylesheet owes. Only
    // a BLOCKED code row can change when such files move to ui, so the per-file git reads
    // run only then (and never past UI_DIFF_MAX_FILES, where the change stays code).
    const codeFiles = decision.classes?.code ?? [];
    if (!decision.allow && codeFiles.length && codeFiles.length <= UI_DIFF_MAX_FILES) {
      const uiOnly = presentationalFiles(root, codeFiles, base?.head);
      if (uiOnly.length) decision = decide(uiOnly);
    }
    const unattributed = others.length;
    if (decision.allow) return { ...decision, unattributed };
    // Marker FIRST: if it can't be persisted, the block-once promise can't be kept —
    // on a read-only checkout that would mean an unsatisfiable block every turn, so
    // the honest move is to stand down (fail-open, review-found).
    try {
      mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
      writeFileSync(marker, `${new Date().toISOString()} ${evidenceMac(["block", sid]) ?? ""}\n`);
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
      unattributed,
    });
    return {
      allow: false,
      row: decision.row,
      reason,
      classes: decision.classes,
      unattributed,
    };
  } catch {
    return { allow: true, row: "internal-error" };
  }
}

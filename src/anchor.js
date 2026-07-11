// forge anchor — M4 goal-anchoring (the paper's continuous goal-drift check, made
// deterministic). Given the original objective, compare the files you've ACTUALLY
// changed (git) against the area the goal named. Flags work that has wandered off it.
// Advisory — a stated goal is re-read against real diffs, not trusted to stay in view.
import { execFileSync } from "node:child_process";
import { adjudicate, asText, buildRunner, llmEnabled } from "./adjudicate.js";
import { load as loadAtlas, query as queryAtlas } from "./atlas.js";
import { referencedEntities } from "./preflight.js";

const STOP = new Set(
  "the a an to of in on for and or add fix make use update change new it its into with from this that be is are so all any".split(
    " ",
  ),
);

function goalKeywords(goal) {
  const { symbols, files } = referencedEntities(goal);
  // Strip path/file tokens (src/auth.js) so their generic parts (src, js) don't become
  // keywords that match every file — the files themselves are matched via goalTargetFiles.
  const prose = String(goal)
    .toLowerCase()
    .replace(/\S*[/.]\S*/g, " ");
  const words = prose.match(/[a-z][a-z0-9_-]{2,}/g) || [];
  const keywords = new Set(words.filter((w) => !STOP.has(w)));
  for (const s of symbols) keywords.add(s.toLowerCase());
  return { keywords: [...keywords], symbols, files };
}

// Split an identifier or path into lowercase concept tokens: break camelCase and any
// non-alphanumeric boundary, keep tokens ≥3 chars that aren't stopwords. `verifyToken`
// → {verify, token}; `src/authGuard.js` → {auth, guard} (src/js are stopword-length noise
// that the goal set never contains anyway, so they cost nothing).
function tokenize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function goalConceptTokens(keywords, symbols) {
  const g = new Set();
  for (const k of keywords) for (const t of tokenize(k)) g.add(t);
  for (const s of symbols) for (const t of tokenize(s)) g.add(t);
  return g;
}

function sameFile(a, b) {
  if (!a || !b) return false;
  const na = a.replace(/^\.?\//, "");
  const nb = b.replace(/^\.?\//, "");
  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

// The token set that stands in for a changed file: its path components PLUS the identifiers
// it actually defines (from the atlas, when built). The identifier channel is the load-bearing
// upgrade — a file that IMPLEMENTS the goal but whose path never spells a goal word (e.g.
// src/throttle.js defining rateLimiter for a "rate limiting" goal) is now caught deterministically,
// where before only the opt-in LLM pass could rescue it.
function fileConceptTokens(atlas, file) {
  const toks = new Set(tokenize(file));
  if (atlas)
    for (const s of atlas.symbols || [])
      if (sameFile(s.file, file)) for (const t of tokenize(s.name)) toks.add(t);
  return toks;
}

// Per-hit on-goal probability for the noisy-OR below. One shared concept is decent evidence a
// file serves the goal; each additional independent hit raises confidence with diminishing
// returns. 0.6 keeps a single hit clearly on-goal (matching the old "any keyword ⇒ on-goal"
// bias) while letting magnitude grow toward 1.
export const ON_GOAL_P = 0.6;

/**
 * Graded on-goal score for one file: a noisy-OR over how many DISTINCT goal concepts the file
 * exhibits (in its path or its defined identifiers). 0 hits → 0 (off-goal); k hits →
 * 1 − (1 − p)^k, saturating below 1. Same estimator lessons.js uses for multi-signal evidence.
 * This replaces the old binary `path.includes(keyword)` verdict with a continuous signal, so
 * the CUSUM drift chart accumulates a true Dₜ ∈ [0,1] instead of a quantized off/on count.
 * @param {Set<string>} goalTokens concept tokens of the goal
 * @param {Set<string>} fileTokens concept tokens of the file (path ∪ identifiers)
 * @param {string} rawPathLower lowercased raw path, for substring hits tokenization can miss
 *   (goal "auth" in file "authentication.js") — preserves the old match's recall as one channel
 * @returns {number} on-goal confidence in [0,1]
 */
export function onGoalScore(goalTokens, fileTokens, rawPathLower = "") {
  let hits = 0;
  // Exact token match counts at any length; the fuzzy path-substring channel (which preserves
  // "auth" ⊂ "authentication") is gated to ≥4 chars so a 3-letter token can't spuriously match
  // inside an unrelated word ("log" ⊂ "dialog") and quietly suppress a real drift signal.
  for (const g of goalTokens)
    if (fileTokens.has(g) || (g.length >= 4 && rawPathLower.includes(g)))
      hits++;
  return hits ? 1 - (1 - ON_GOAL_P) ** hits : 0;
}

// Machine-generated / tool-config noise that isn't the developer's own work: forge's
// cache and every config file `forge init` emits (dot-paths + AGENTS/CLAUDE).
// ponytail: this also hides drift in genuine dot-dir edits (.github/*) — fine for an
// advisory coarse check; widen to a managed-file manifest if that ever matters.
const NOISE =
  /(^|\/)\.forge\/|(^|\/)\.[^/]+\/|^\.[^/]+$|(^|\/)(AGENTS|CLAUDE)\.md$/i;

function gitFiles(root) {
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return "";
    }
  };
  const out =
    run(["diff", "--name-only", "HEAD"]) +
    run(["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].filter((f) => !NOISE.test(f));
}

// Files the goal's named symbols actually live in, so a symbol-named goal anchors to its
// file (e.g. "change verifyToken" anchors to src/auth.js, which the name alone wouldn't match).
function goalTargetFiles(root, symbols, files) {
  const targets = new Set(files.map((f) => f.replace(/^\.?\//, "")));
  const atlas = loadAtlas(root);
  if (atlas)
    for (const s of symbols)
      for (const hit of queryAtlas(atlas, s))
        if (hit.name === s) targets.add(hit.file);
  return [...targets];
}

// M4 goal-drift — LLM proposer. Semantically classifies the files the coarse keyword match
// flagged as off-goal. PROPOSER ONLY, and one-directional: the model may only move a file
// off→on (never on→off), and only with a reason that references the goal — so it can quiet a
// false drift flag but can never hide a real one. Preserves the "errs toward on-goal" invariant.
export function buildDriftPrompt(goal, offGoalFiles) {
  const list = offGoalFiles
    .slice(0, 40)
    .map((f) => `- ${f}`)
    .join("\n");
  return `A developer's stated goal is: """${String(goal).slice(0, 400)}"""
These changed files did NOT obviously match the goal by name:
${list}
For each, decide if the change is plausibly IN SERVICE of that goal. Answer with STRICT JSON and
nothing else, listing only files from above that genuinely serve the goal:
{"onGoal":[{"file":"<path>","reason":"<why it serves the goal>"}]}
Omit files that do not serve the goal. No text outside the JSON object.`;
}

export function parseDriftProposal(obj) {
  const onGoal = Array.isArray(obj.onGoal)
    ? obj.onGoal
        .map((e) => ({
          file: asText(e?.file, 240),
          reason: asText(e?.reason, 200),
        }))
        .filter((e) => e.file && e.reason)
    : [];
  return { onGoal };
}

export function driftLLM(goal, offGoalFiles, { run = buildRunner() } = {}) {
  if (!offGoalFiles.length) return { onGoal: [] };
  return adjudicate({
    prompt: buildDriftPrompt(goal, offGoalFiles),
    parse: parseDriftProposal,
    run,
  });
}

/**
 * @param {string} root
 * @param {string} goal
 * @param {{ changed?: string[], llm?:boolean, run?:(p:string)=>string, model?:string, timeoutMs?:number, atlas?:object|null }} [opts]
 *   inject `changed` to skip git; inject `atlas`/`run` to stub the graph/model (used in tests).
 */
export function goalDrift(root, goal, opts = {}) {
  const { keywords, symbols, files } = goalKeywords(goal);
  const changedFiles = opts.changed || gitFiles(root);
  const targets = goalTargetFiles(root, symbols, files).map((t) =>
    t.toLowerCase(),
  );
  const atlas = opts.atlas !== undefined ? opts.atlas : loadAtlas(root);
  const goalTokens = goalConceptTokens(keywords, symbols);
  const onGoal = [];
  const offGoal = [];
  // Per-file on-goal confidence in [0,1] — the graded signal. A file is classified on-goal iff
  // its score clears the single-hit floor (ON_GOAL_P), preserving the old "any match ⇒ on-goal"
  // bias, but the magnitude (path + identifier evidence, noisy-OR) is what feeds driftScore.
  const score = new Map();
  for (const f of changedFiles) {
    const lf = f.toLowerCase();
    const named = targets.some((t) => lf === t || lf.endsWith(`/${t}`));
    const s = named
      ? 1
      : onGoalScore(goalTokens, fileConceptTokens(atlas, f), lf);
    score.set(f, s);
    (s >= ON_GOAL_P ? onGoal : offGoal).push(f);
  }

  // Opt-in semantic pass: rescue files the keyword match missed, but only off→on and only when
  // the model gives a goal-referencing reason. Verified, not trusted; fail-safe on any error.
  let provenance = { path: "deterministic" };
  if (llmEnabled({ llm: opts.llm }) && offGoal.length) {
    const goalTerms = new Set([
      ...keywords,
      ...symbols.map((s) => s.toLowerCase()),
    ]);
    const grounded = (reason) => {
      const words = String(reason).toLowerCase();
      return (
        goalTerms.size === 0 || [...goalTerms].some((t) => words.includes(t))
      );
    };
    const proposal = driftLLM(goal, offGoal, {
      run:
        opts.run ||
        buildRunner({ model: opts.model, timeoutMs: opts.timeoutMs }),
    });
    const rescued = new Set(
      (proposal?.onGoal || [])
        .filter((e) => offGoal.includes(e.file) && grounded(e.reason))
        .map((e) => e.file),
    );
    if (rescued.size) {
      for (const f of [...offGoal]) {
        if (rescued.has(f)) {
          offGoal.splice(offGoal.indexOf(f), 1);
          onGoal.push(f);
          // A verified rescue is on-goal at the single-hit floor, so driftScore reflects it too.
          score.set(f, Math.max(score.get(f) ?? 0, ON_GOAL_P));
        }
      }
      provenance = { path: "llm-verified", rescued: [...rescued] };
    } else if (proposal) {
      provenance = { path: "llm-agreed" };
    }
  }

  const drift =
    changedFiles.length > 0 && (offGoal.length > 0 || onGoal.length === 0);
  // Graded drift magnitude Dₜ ∈ [0,1] — the mean off-goal-ness (1 − on-goal confidence) across
  // this checkpoint's changes. This is the signal cusum() below expects: the binary `drift` flag
  // answers "any drift now?", the score accumulates into "sustained drift?". It strictly
  // generalizes the old off-goal fraction — identical when every score is 0/1, graded otherwise,
  // so a weakly-on-goal file adds less drift than an unrelated one instead of counting the same.
  const driftScore = changedFiles.length
    ? changedFiles.reduce((a, f) => a + (1 - (score.get(f) ?? 0)), 0) /
      changedFiles.length
    : 0;
  return {
    goal: String(goal),
    keywords,
    changed: changedFiles,
    onGoal,
    offGoal,
    drift,
    driftScore,
    provenance,
  };
}

/**
 * M4 — one-sided CUSUM control chart over a drift-signal series (spec §5:
 * docs/plans/substrate-v2/06-faculties-and-mechanisms.md). A raw threshold on a
 * single checkpoint's drift Dₜ is noisy — one exploratory step legitimately wanders.
 * CUSUM accumulates only the excess over the allowance k (Cₜ = max(0, Cₜ₋₁ + Dₜ − k))
 * and alarms at Cₜ > h, which detects SUSTAINED small drift with provably minimal
 * detection delay for a given false-alarm rate (classical sequential analysis),
 * while a single within-tolerance spike drains back to zero instead of alarming.
 * Defaults k = 0.35, h = 1.0 per the spec (calibration lands in P8). Pure.
 * @param {number[]} signals drift per checkpoint, Dₜ ∈ [0, 1] (non-numeric → 0)
 * @param {{k?: number, h?: number}} [opts]
 * @returns {{alarm: boolean, C: number[], firstAlarm: number}} firstAlarm = index of
 *   the first checkpoint whose statistic crossed h, or -1 if none did.
 */
export function cusum(signals, { k = 0.35, h = 1.0 } = {}) {
  const C = [];
  let c = 0;
  let firstAlarm = -1;
  for (let i = 0; i < signals.length; i++) {
    const d = Number(signals[i]);
    c = Math.max(0, c + (Number.isFinite(d) ? d : 0) - k);
    C.push(c);
    if (firstAlarm < 0 && c > h) firstAlarm = i;
  }
  return { alarm: firstAlarm >= 0, C, firstAlarm };
}

export function renderAnchor(r) {
  const lines = ["Forge anchor — goal-drift check", ""];
  if (!r.changed.length)
    return `${lines.join("\n")}\n  no changes yet vs HEAD — nothing to check against the goal.`;
  lines.push(
    `  changed: ${r.changed.length} file(s) · on-goal ${r.onGoal.length} · off-goal ${r.offGoal.length}`,
  );
  if (r.offGoal.length) {
    lines.push(
      "",
      "  off-goal (unrelated to the stated goal — intended, or drift?):",
    );
    for (const f of r.offGoal.slice(0, 12)) lines.push(`    - ${f}`);
  }
  if (r.drift && !r.offGoal.length)
    lines.push(
      "",
      "  ! no changed file matches the goal — are you working on the right thing?",
    );
  if (!r.drift)
    lines.push(
      "",
      "  ✓ on goal — every change maps to what you set out to do.",
    );
  return lines.join("\n");
}

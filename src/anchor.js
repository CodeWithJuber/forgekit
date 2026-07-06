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

// Machine-generated / tool-config noise that isn't the developer's own work: forge's
// cache and every config file `forge init` emits (dot-paths + AGENTS/CLAUDE).
// ponytail: this also hides drift in genuine dot-dir edits (.github/*) — fine for an
// advisory coarse check; widen to a managed-file manifest if that ever matters.
const NOISE = /(^|\/)\.forge\/|(^|\/)\.[^/]+\/|^\.[^/]+$|(^|\/)(AGENTS|CLAUDE)\.md$/i;

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
    run(["diff", "--name-only", "HEAD"]) + run(["ls-files", "--others", "--exclude-standard"]);
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
      for (const hit of queryAtlas(atlas, s)) if (hit.name === s) targets.add(hit.file);
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
        .map((e) => ({ file: asText(e?.file, 240), reason: asText(e?.reason, 200) }))
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
 * @param {{ changed?: string[], llm?:boolean, run?:(p:string)=>string, model?:string, timeoutMs?:number }} [opts]
 *   inject `changed` to skip git; inject `run` to stub the model (used in tests).
 */
export function goalDrift(root, goal, opts = {}) {
  const { keywords, symbols, files } = goalKeywords(goal);
  const changedFiles = opts.changed || gitFiles(root);
  const targets = goalTargetFiles(root, symbols, files).map((t) => t.toLowerCase());
  const onGoal = [];
  const offGoal = [];
  for (const f of changedFiles) {
    const lf = f.toLowerCase();
    // ponytail: path/keyword match, not semantic — coarse on purpose (are you in the
    // right AREA?), and errs toward "on-goal" so it never cries drift on a match.
    const named = targets.some((t) => lf === t || lf.endsWith(`/${t}`));
    (named || keywords.some((k) => lf.includes(k)) ? onGoal : offGoal).push(f);
  }

  // Opt-in semantic pass: rescue files the keyword match missed, but only off→on and only when
  // the model gives a goal-referencing reason. Verified, not trusted; fail-safe on any error.
  let provenance = { path: "deterministic" };
  if (llmEnabled({ llm: opts.llm }) && offGoal.length) {
    const goalTerms = new Set([...keywords, ...symbols.map((s) => s.toLowerCase())]);
    const grounded = (reason) => {
      const words = String(reason).toLowerCase();
      return goalTerms.size === 0 || [...goalTerms].some((t) => words.includes(t));
    };
    const proposal = driftLLM(goal, offGoal, {
      run: opts.run || buildRunner({ model: opts.model, timeoutMs: opts.timeoutMs }),
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
        }
      }
      provenance = { path: "llm-verified", rescued: [...rescued] };
    } else if (proposal) {
      provenance = { path: "llm-agreed" };
    }
  }

  const drift = changedFiles.length > 0 && (offGoal.length > 0 || onGoal.length === 0);
  return {
    goal: String(goal),
    keywords,
    changed: changedFiles,
    onGoal,
    offGoal,
    drift,
    provenance,
  };
}

export function renderAnchor(r) {
  const lines = ["Forge anchor — goal-drift check", ""];
  if (!r.changed.length)
    return `${lines.join("\n")}\n  no changes yet vs HEAD — nothing to check against the goal.`;
  lines.push(
    `  changed: ${r.changed.length} file(s) · on-goal ${r.onGoal.length} · off-goal ${r.offGoal.length}`,
  );
  if (r.offGoal.length) {
    lines.push("", "  off-goal (unrelated to the stated goal — intended, or drift?):");
    for (const f of r.offGoal.slice(0, 12)) lines.push(`    - ${f}`);
  }
  if (r.drift && !r.offGoal.length)
    lines.push("", "  ! no changed file matches the goal — are you working on the right thing?");
  if (!r.drift) lines.push("", "  ✓ on goal — every change maps to what you set out to do.");
  return lines.join("\n");
}

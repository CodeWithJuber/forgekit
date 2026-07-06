// forge anchor — M4 goal-anchoring (the paper's continuous goal-drift check, made
// deterministic). Given the original objective, compare the files you've ACTUALLY
// changed (git) against the area the goal named. Flags work that has wandered off it.
// Advisory — a stated goal is re-read against real diffs, not trusted to stay in view.
import { execFileSync } from "node:child_process";
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

/**
 * @param {string} root
 * @param {string} goal
 * @param {{ changed?: string[] }} [opts] inject changed to skip git (used in tests)
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
  const drift = changedFiles.length > 0 && (offGoal.length > 0 || onGoal.length === 0);
  return { goal: String(goal), keywords, changed: changedFiles, onGoal, offGoal, drift };
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

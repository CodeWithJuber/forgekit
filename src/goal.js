// forge goal — the persistent active goal for a repo. `forge anchor` was per-invocation
// only: the goal lived in one command's argv and vanished with the session, so the next
// session re-assumed. Storing it in .forge/goal.md lets SessionStart re-inject it, lets
// goalDrift default to it, and makes "what are we actually doing" survive context loss.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasSecret } from "./secrets.js";

const goalPath = (root) => join(root, ".forge", "goal.md");

/** Persist the active goal. Refuses secrets (same rule as every forge store). */
export function setGoal(root, text, { t = Date.now() } = {}) {
  const goal = String(text ?? "").trim();
  if (!goal) return { ok: false, reason: "empty goal — state what you are working toward" };
  if (hasSecret(goal))
    return { ok: false, reason: "refused: goal looks like it contains a secret/credential" };
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    goalPath(root),
    `# Goal\n\n${goal}\n\n<!-- set ${new Date(t).toISOString()} — forge anchor set -->\n`,
  );
  return { ok: true, goal };
}

/** The active goal text, or null when none is set. */
export function getGoal(root) {
  const p = goalPath(root);
  if (!existsSync(p)) return null;
  try {
    const goal = readFileSync(p, "utf8")
      .replace(/^# Goal\s*/, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    return goal || null;
  } catch {
    return null;
  }
}

export function clearGoal(root) {
  try {
    rmSync(goalPath(root), { force: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** SessionStart injection block — empty string when no goal is set (low-nag). */
export function goalBlock(root) {
  const goal = getGoal(root);
  if (!goal) return "";
  return [
    "## Active goal (Forge Anchor)",
    `The stated goal for current work in this repo: **${goal}**`,
    "Stay on it. `forge anchor` checks your changes against it; `forge anchor clear` when done.",
    "",
  ].join("\n");
}

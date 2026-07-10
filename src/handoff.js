// forge handoff — the bounded session-state checkpoint. goal.md holds the objective and
// lessons hold corrections, but "what got done, what's next, what bit us" died with each
// session — the next one re-derived it or, worse, assumed. state.md is a REWRITTEN
// (never appended) snapshot injected at every session start: bounded compression, so the
// loader's token cost stays constant over the project's life while total knowledge grows.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { getGoal } from "./goal.js";
import { hasSecret } from "./secrets.js";

export const statePath = (root) => join(root, ".forge", "state.md");

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Branch, dirty files (capped), recent commits — empty-safe outside a git repo. */
export function gatherGitFacts(root, { statusCap = 20 } = {}) {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(root, ["status", "--short"]).split("\n").filter(Boolean);
  const log = git(root, ["log", "--oneline", "-5"]).split("\n").filter(Boolean);
  return {
    branch,
    status: status.slice(0, statusCap),
    overflow: Math.max(0, status.length - statusCap),
    log,
  };
}

/** Assumption events recorded this session (preflight appends them when it proceeds
 *  without asking) — surfaced here so the handoff carries what was GUESSED, not
 *  just what was done. Empty-safe when no session log exists. */
export function gatherAssumptions(root) {
  try {
    const dir = join(root, ".forge", "sessions");
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return [];
    const out = [];
    for (const line of readFileSync(join(dir, newest.f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "assumption") out.push(e);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

const arr = (v) =>
  (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

const section = (title, rows, fallback = "- (none)") => [
  `## ${title}`,
  ...(rows.length ? rows.map((r) => `- ${r}`) : [fallback]),
  "",
];

/**
 * Rewrite the whole snapshot from this session's fields + auto-gathered git facts.
 * Refuses secrets in the human-supplied fields (same rule as every forge store) and
 * truncates to `maxLines` so the session-start injection can never balloon.
 * @param {string} root
 * @param {{done?:string[]|string, next?:string[]|string, gotchas?:string[]|string,
 *          criteria?:string[]|string, goal?:string, phase?:string}} fields
 */
export function writeState(root, fields = {}, { t = Date.now(), maxLines = 150 } = {}) {
  const done = arr(fields.done);
  const next = arr(fields.next);
  const gotchas = arr(fields.gotchas);
  const criteria = arr(fields.criteria);
  if (!done.length && !next.length && !gotchas.length && !criteria.length)
    return { ok: false, reason: "empty handoff — say what was done and what comes next" };
  const supplied = [...done, ...next, ...gotchas, ...criteria, fields.goal, fields.phase]
    .filter(Boolean)
    .join("\n");
  if (hasSecret(supplied))
    return { ok: false, reason: "refused: handoff looks like it contains a secret/credential" };
  const goal = fields.goal || getGoal(root) || `(none set — \`${BRAND.cli} anchor set "…"\`)`;
  const facts = gatherGitFacts(root);
  const assumptions = gatherAssumptions(root).map(
    (a) =>
      `proceeded without asking — missing: ${(a.missing || []).join(", ") || "?"}${
        (a.questions || []).length ? ` (${a.questions[0]})` : ""
      }`,
  );
  const progress = facts.status.length
    ? [...facts.status, ...(facts.overflow ? [`(+${facts.overflow} more dirty files)`] : [])]
    : [];
  const lines = [
    "# Session state",
    "",
    ...section("Goal / Phase", [`${goal}${fields.phase ? ` — phase: ${fields.phase}` : ""}`]),
    ...section("Acceptance criteria", criteria),
    ...section("Done this session", done),
    ...section("Next steps", next),
    ...section("Gotchas", gotchas),
    ...section("Open assumptions", assumptions),
    ...section("In-progress files (git, at handoff)", progress, "- (clean tree)"),
    "## Decisions",
    `- append-only log: \`.forge/decisions.md\` (\`${BRAND.cli} decide\`)`,
    "",
  ];
  const provenance = `<!-- written ${new Date(t).toISOString()} — ${BRAND.cli} handoff${
    facts.branch ? ` on ${facts.branch}` : ""
  } -->`;
  const kept =
    lines.length + 1 > maxLines
      ? [...lines.slice(0, maxLines - 2), "- (truncated to stay bounded)"]
      : lines;
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(statePath(root), [...kept, provenance, ""].join("\n"));
  return { ok: true, path: statePath(root), lines: kept.length + 1 };
}

/** The snapshot text minus provenance, or null when none exists. */
export function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8");
    const cut = raw.indexOf("<!--");
    const text = (cut === -1 ? raw : raw.slice(0, cut)).trim();
    return text || null;
  } catch {
    return null;
  }
}

/** SessionStart injection block — empty string when no snapshot exists (low-nag). */
export function stateBlock(root, { maxLines = 80 } = {}) {
  const text = readState(root);
  if (!text) return "";
  const body = text.split("\n").filter((l) => l.trim() !== "# Session state");
  const capped =
    body.length > maxLines
      ? [...body.slice(0, maxLines), `_(truncated — read \`.forge/state.md\` for the rest)_`]
      : body;
  return [
    `## Session state (${BRAND.brand} Handoff)`,
    ...capped,
    `Keep it current: \`${BRAND.cli} handoff "<done>" --next "<next>"\` before stopping.`,
    "",
  ].join("\n");
}

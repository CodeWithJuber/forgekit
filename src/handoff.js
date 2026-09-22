// forge handoff — the bounded session-state checkpoint. goal.md holds the objective and
// lessons hold corrections, but "what got done, what's next, what bit us" died with each
// session — the next one re-derived it or, worse, assumed. state.md is a REWRITTEN
// (never appended) snapshot injected at every session start: bounded compression, so the
// loader's token cost stays constant over the project's life while total knowledge grows.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { getGoal } from "./goal.js";
import { hasSecret } from "./secrets.js";
import { git } from "./util.js";

export const statePath = (root) => join(root, ".forge", "state.md");

/**
 * The ONE size budget for the snapshot, shared by the writer (writeState) and the loader
 * (stateBlock), in one unit: UTF-8 bytes of the snapshot body (the provenance line, which
 * the loader strips, is not counted). The formal synthesis's T4 correction (2026-09-21)
 * found its handoff bounded LINES while its loader injected at most 8 KB, so a valid
 * snapshot could be cut at session start; forge had reproduced that mismatch in lines
 * (150 written, 80 injected), silently dropping everything past line 80. The writer now
 * selects rows until the body fits this budget, so the loader never truncates what the
 * writer wrote. 8192 is the synthesis's A5 cap (roughly 2k tokens per session start).
 */
export const STATE_BUDGET_BYTES = 8192;

const byteLen = (s) => Buffer.byteLength(s, "utf8");
/** Bytes of `lines` joined by newlines — the measure both sides apply. */
const bodyBytes = (lines) =>
  lines.reduce((n, l) => n + byteLen(l), 0) + Math.max(0, lines.length - 1);

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
 *  without asking) — surfaced here so the handoff carries what was GUESSED, not just
 *  what was done. Deduped by content and capped: a constraint missing on every prompt
 *  appends one event per prompt, and 30 identical rows would eat the bounded snapshot.
 *  Empty-safe when no session log exists. */
export function gatherAssumptions(root, { cap = 5 } = {}) {
  try {
    const dir = join(root, ".forge", "sessions");
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return [];
    const seen = new Set();
    const out = [];
    for (const line of readFileSync(join(dir, newest.f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "assumption") continue;
        const key = JSON.stringify([e.missing ?? [], e.questions ?? []]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch {}
    }
    return out.slice(0, cap);
  } catch {
    return [];
  }
}

const arr = (v) =>
  (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

const omitted = (n, budget) => `- (+${n} more not kept — over the ${budget}-byte snapshot budget)`;

/**
 * Choose rows in PRIORITY order until the snapshot fits `budget` bytes. `sections` arrive
 * in priority order, which is also the display order, so even a loader cut of a
 * hand-edited file loses the least important rows first. Every header stays; a section
 * whose rows did not all fit ends with an explicit "(+N more not kept)" row, so a drop is
 * never silent. Within a section rows keep their given order; a row that does not fit is
 * dropped (with the rest of its section) and later, smaller sections may still fit.
 * @param {{title: string, rows: string[], fallback?: string}[]} sections
 * @param {number} budget
 * @returns {string[]}
 */
export function selectSnapshot(sections, budget = STATE_BUDGET_BYTES) {
  const head = ["# Session state", ""];
  // Fixed cost first: every header, its blank line, and one reserved line per section —
  // its fallback when empty, else the worst-case omission marker.
  const reserve = sections.map((sec) =>
    sec.rows.length ? omitted(sec.rows.length, budget) : sec.fallback || "- (none)",
  );
  let used = bodyBytes([
    ...head,
    ...sections.flatMap((sec, i) => [`## ${sec.title}`, reserve[i], ""]),
  ]);
  const kept = sections.map(() => /** @type {string[]} */ ([]));
  sections.forEach((sec, i) => {
    for (const r of sec.rows) {
      const line = `- ${r}`;
      const cost = byteLen(line) + 1; // the row plus its newline
      if (used + cost > budget) break;
      used += cost;
      kept[i].push(line);
    }
  });
  const out = [...head];
  sections.forEach((sec, i) => {
    const dropped = sec.rows.length - kept[i].length;
    out.push(`## ${sec.title}`, ...kept[i]);
    if (!sec.rows.length) out.push(sec.fallback || "- (none)");
    else if (dropped) out.push(omitted(dropped, budget));
    out.push("");
  });
  return out;
}

/**
 * Rewrite the whole snapshot from this session's fields + auto-gathered git facts.
 * Refuses secrets in the human-supplied fields (same rule as every forge store) and
 * selects rows in the synthesis's A4 priority order (goal, next, decisions, gotchas,
 * in-progress, done) until the body fits `budget` — the SAME budget stateBlock injects,
 * so the next session reads back exactly what was written.
 * @param {string} root
 * @param {{done?:string[]|string, next?:string[]|string, gotchas?:string[]|string,
 *          criteria?:string[]|string, goal?:string, phase?:string}} fields
 * @param {{t?: number, budget?: number}} [opts]
 */
export function writeState(
  root,
  fields = {},
  { t = Date.now(), budget = STATE_BUDGET_BYTES } = {},
) {
  const done = arr(fields.done);
  const next = arr(fields.next);
  const gotchas = arr(fields.gotchas);
  const criteria = arr(fields.criteria);
  if (!done.length && !next.length && !gotchas.length && !criteria.length)
    return {
      ok: false,
      reason: "empty handoff — say what was done and what comes next",
    };
  const supplied = [...done, ...next, ...gotchas, ...criteria, fields.goal, fields.phase]
    .filter(Boolean)
    .join("\n");
  if (hasSecret(supplied))
    return {
      ok: false,
      reason: "refused: handoff looks like it contains a secret/credential",
    };
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
  // A4 priority: goal (with its acceptance criteria), next, decisions, gotchas (with the
  // open assumptions — both are "what could bite the next session"), in-progress, done.
  const kept = selectSnapshot(
    [
      {
        title: "Goal / Phase",
        rows: [`${goal}${fields.phase ? ` — phase: ${fields.phase}` : ""}`],
      },
      { title: "Acceptance criteria", rows: criteria },
      { title: "Next steps", rows: next },
      {
        title: "Decisions",
        rows: [`append-only log: \`.forge/decisions.md\` (\`${BRAND.cli} decide\`)`],
      },
      { title: "Gotchas", rows: gotchas },
      { title: "Open assumptions", rows: assumptions },
      { title: "In-progress files (git, at handoff)", rows: progress, fallback: "- (clean tree)" },
      { title: "Done this session", rows: done },
    ],
    budget,
  );
  const provenance = `<!-- written ${new Date(t).toISOString()} — ${BRAND.cli} handoff${
    facts.branch ? ` on ${facts.branch}` : ""
  } -->`;
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(statePath(root), [...kept, provenance, ""].join("\n"));
  return { ok: true, path: statePath(root), lines: kept.length + 1, bytes: bodyBytes(kept) };
}

// Only the EXACT provenance line is stripped — a naive slice at the first "<!--" would
// silently truncate a snapshot whose rows mention HTML comments ("strip <!-- markers
// from templates"), losing every later section from the next session's injection.
const PROVENANCE_RE = /^<!-- written .* -->\s*$/;

/** The snapshot text minus provenance, or null when none exists. */
export function readState(root) {
  const p = statePath(root);
  if (!existsSync(p)) return null;
  try {
    const text = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !PROVENANCE_RE.test(l))
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * SessionStart injection block — empty string when no snapshot exists (low-nag). Applies
 * the same STATE_BUDGET_BYTES the writer selects against, so a snapshot `forge handoff`
 * wrote always arrives whole; only a hand-edited (or pre-budget) file can overflow, and
 * then the cut is explicit and points at the file.
 * @param {string} root
 * @param {{budget?: number}} [opts]
 */
export function stateBlock(root, { budget = STATE_BUDGET_BYTES } = {}) {
  const text = readState(root);
  if (!text) return "";
  const all = text.split("\n");
  /** @type {string[]} */
  let kept = all;
  if (byteLen(text) > budget) {
    kept = [];
    let used = 0;
    for (const l of all) {
      used += byteLen(l) + 1;
      if (used > budget) break;
      kept.push(l);
    }
  }
  const body = kept.filter((l) => l.trim() !== "# Session state");
  const capped =
    kept.length < all.length
      ? [...body, `_(truncated at ${budget} bytes — read \`.forge/state.md\` for the rest)_`]
      : body;
  return [
    `## Session state (${BRAND.brand} Handoff)`,
    ...capped,
    `Keep it current: \`${BRAND.cli} handoff "<done>" --next "<next>"\` before stopping.`,
    "",
  ].join("\n");
}

// forge learn-consolidate — DETERMINISTIC consolidation of the legacy learned-lessons store
// (~/.claude/skills/learned: `lessons-YYYY-MM.md`, appended by the opt-in session-learner
// guard, plus the `CONSOLIDATED.md` a previous run wrote). bin/learn-consolidate.sh used to
// send every lesson to a model with "DROP anything … contradicted" and rewrite the store
// from its answer: pruning memory by the model's own judgment, which the research rejects
// (white paper §3, memory residual gap; §7.1, val = validity from an external oracle).
// Here nothing is judged, reworded or invented:
//  - MERGE: an exact duplicate (normalized text) or a near-duplicate (MinHash Jaccard ≥ τ,
//    the ledger's own consolidation threshold, ledger.clusters) within one project
//    collapses into its first occurrence — but only when the semantic guard finds no
//    behaviour-bearing difference (review F16): "Enable authentication…" and "Disable
//    authentication…" overlap almost entirely and are OPPOSITE rules, so they are kept apart
//    and reported as a conflict for a person to resolve.
//  - DROP: only on ledger ground truth. A lesson is dropped when its best-matching ledger
//    claim (lesson/fact, Jaccard ≥ τ against claimText, and not reversed by polarity,
//    operators, numbers or literals) is dormant (ledger.isDormant: its oracle-evidenced val
//    fell below DORMANT_VAL and no confirmation restored it) or retracted (tombstoned). An
//    ARCHIVED claim is not a refuted one (review F15): the attic also holds claims archived for
//    idleness or as duplicates, so an attic claim refutes only when its own logs say so
//    (tombstone/dormant), and a deduplicated one defers to the claim that survived it.
//    A lesson with no matching claim is KEPT: absence of evidence is not refutation.
// Claims are matched only within the lesson's project (a repo whose directory name is the
// project), so a lesson refuted in one repo is not dropped from another.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimText, isDormant, jaccard, sketch } from "./ledger.js";
import { archiveRecord, getClaimByPrefix, loadClaims, repoLedger } from "./ledger_store.js";
import {
  describeConflicts,
  FLIP_KINDS,
  sameSemantics,
  semanticConflicts,
} from "./semantic_guard.js";
import { epochDay } from "./util.js";

/** Same τ as ledger.clusters — "these two say the same thing". */
export const CONSOLIDATE_TAU = 0.7;
export const GENERAL = "General";
/** Where the session learner writes: `$HOME/.claude/skills/learned` (it is a bash hook, and
 *  the `--llm` path is bash too). On POSIX `homedir()` already follows HOME; on Windows it
 *  reads USERPROFILE instead, so a Git Bash HOME that differs from USERPROFILE made this
 *  path read a different folder than the one the lessons were written to. */
export const learnedDir = () => join(process.env.HOME || homedir(), ".claude", "skills", "learned");

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[`*_"'.,;:!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parse learned-lesson markdown into `{project, text}` entries. Understands both shapes:
 * the session-learner's `## 2026-07-04 12:00 — <project>` headers and a consolidated
 * file's `## <project>` headers. Bullets are `- ` / `* ` lines; an indented non-bullet
 * line continues the bullet above it. Everything else (titles, prose) is ignored.
 * @param {string} text
 * @returns {{project: string, text: string}[]}
 */
export function parseLearned(text) {
  const out = [];
  let project = GENERAL;
  let last = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const dated = /^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s+[—–-]\s+(.+)$/.exec(h[1]);
      project = (dated ? dated[1] : h[1]).trim() || GENERAL;
      last = null;
      continue;
    }
    const b = /^\s{0,3}[-*]\s+(.+?)\s*$/.exec(line);
    if (b) {
      last = { project, text: b[1] };
      out.push(last);
      continue;
    }
    if (last && /^\s{2,}\S/.test(line)) last.text += ` ${line.trim()}`;
    else if (!line.trim()) last = null;
  }
  return out;
}

/**
 * @typedef {{project: string, text: string}} Learned
 * @typedef {{id?: string, kind?: string, body?: any, tombstone?: any, attic?: boolean,
 *   archive?: {cause?: string, survivor?: string} | null, project?: string}} LedgerClaim
 */

/**
 * Why a claim refutes the lessons that match it, or null when it does not. Truth comes from
 * the claim's own logs (a tombstone, or oracle evidence that made it dormant) — never from
 * where it is stored: an archived claim that was merely idle refutes nothing, and one archived
 * as a duplicate refutes only if the claim that survived it does (review F15).
 * @param {LedgerClaim} claim
 * @param {number} nowDay
 * @param {Map<string, LedgerClaim>} [byId] every known claim, to follow a duplicate's survivor
 * @param {number} [depth]
 * @returns {string|null}
 */
function refutation(claim, nowDay, byId = new Map(), depth = 0) {
  if (claim.tombstone) return "retracted in the ledger";
  try {
    if (isDormant(claim, nowDay)) return "dormant in the ledger (oracle evidence refuted it)";
  } catch {}
  if (claim.attic && claim.archive?.cause === "duplicate" && claim.archive.survivor && depth < 8) {
    const survivor = byId.get(claim.archive.survivor);
    const why = survivor ? refutation(survivor, nowDay, byId, depth + 1) : null;
    return why ? `${why} (via the claim it was deduplicated into)` : null;
  }
  return null; // live, or archived for idleness / unknown reason: not a refutation
}

/**
 * Consolidate deterministically: merge duplicates, drop only ledger-refuted lessons.
 * @param {Learned[]} entries
 * @param {{claims?: LedgerClaim[], nowDay?: number, tau?: number}} [opts] each claim may
 *   carry `project` (the repo directory name); a claim without one matches any project.
 * @returns {{kept: Learned[], merged: {text: string, into: string}[],
 *   dropped: {project: string, text: string, claim: string, reason: string}[],
 *   conflicts: {project: string, text: string, other: string, conflicts: string}[]}}
 */
export function consolidateLearned(
  entries,
  { claims = [], nowDay = epochDay(), tau = CONSOLIDATE_TAU } = {},
) {
  const byId = new Map(claims.filter((c) => c?.id).map((c) => [String(c.id), c]));
  const usable = claims
    .filter((c) => c && (c.kind === "lesson" || c.kind === "fact"))
    .map((c) => ({
      c,
      text: claimText(c),
      s: sketch(claimText(c)),
      why: refutation(c, nowDay, byId),
    }));
  /** @type {(Learned & {s: any, n: string})[]} */
  const kept = [];
  const merged = [];
  const dropped = [];
  /** @type {{project: string, text: string, other: string, conflicts: string}[]} */
  const conflicts = [];
  for (const e of entries) {
    const text = String(e.text || "").trim();
    if (!text) continue;
    const project = e.project || GENERAL;
    const s = sketch(text);
    const n = norm(text);
    // Similar is not the same (F16): a close pair that differs in polarity, operators,
    // numbers, literals, identifiers or paths is two rules — keep both, report the conflict.
    let dup = null;
    for (const k of kept) {
      if (k.project !== project || (k.n !== n && jaccard(k.s, s) < tau)) continue;
      const differs = semanticConflicts(k.text, text);
      if (!differs.length) {
        dup = k;
        break;
      }
      conflicts.push({ project, text, other: k.text, conflicts: describeConflicts(differs) });
    }
    if (dup) {
      merged.push({ text, into: dup.text });
      continue;
    }
    let best = null;
    for (const u of usable) {
      if (u.c.project && project !== GENERAL && u.c.project !== project) continue;
      const j = jaccard(u.s, s);
      // A claim saying the OPPOSITE (a flipped polarity/operator/number/literal) is not this
      // lesson's evidence, however similar the words.
      if (j >= tau && (!best || j > best.j) && sameSemantics(u.text, text, { kinds: FLIP_KINDS }))
        best = { ...u, j };
    }
    if (best?.why) {
      dropped.push({
        project,
        text,
        claim: String(best.c.id ?? "").slice(0, 12),
        reason: best.why,
      });
      continue;
    }
    kept.push({ project, text, s, n });
  }
  return {
    kept: kept.map(({ project, text }) => ({ project, text })),
    merged,
    dropped,
    conflicts,
  };
}

/**
 * The consolidated file: one `## <project>` section per project in first-seen order
 * (General first when present), one bullet per kept lesson, in input order.
 * @param {Learned[]} kept
 * @param {{date?: string}} [opts]
 */
export function renderConsolidated(kept, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const order = [...new Set(kept.map((k) => k.project))].sort((a, b) =>
    a === GENERAL ? -1 : b === GENERAL ? 1 : 0,
  );
  const lines = [`# Learned — consolidated ${date}`, ""];
  for (const p of order) {
    lines.push(`## ${p}`);
    for (const k of kept) if (k.project === p) lines.push(`- ${k.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Ledger claims of each repo (live + attic), tagged with the repo's directory name as
 * their project. Unreadable ledgers contribute nothing.
 * @param {string[]} repos
 * @returns {LedgerClaim[]}
 */
export function ledgerClaimsFor(repos) {
  const out = [];
  for (const root of repos) {
    const dir = repoLedger(root);
    if (!existsSync(dir)) continue;
    const project = basename(resolve(root));
    try {
      for (const c of loadClaims(dir)) out.push({ ...c, project });
    } catch {}
    try {
      // Attic claims WITH their logs (evidence, tombstones) and the recorded archive reason —
      // the raw JSON alone cannot tell an idle claim from a refuted one (F15).
      const attic = join(dir, "attic");
      for (const f of existsSync(attic) ? readdirSync(attic) : []) {
        if (!f.endsWith(".json")) continue;
        const id = f.replace(/\.json$/, "");
        const view = getClaimByPrefix(dir, id, { attic: true });
        if (view) out.push({ ...view, attic: true, archive: archiveRecord(dir, id), project });
      }
    } catch {}
  }
  return out;
}

/**
 * The whole job over a learned-lessons directory. Originals are archived under
 * `archive/` before anything is rewritten; `dryRun` reports without writing.
 * @param {{dir?: string, repos?: string[], nowDay?: number, dryRun?: boolean, date?: string}} [opts]
 */
export function consolidateDir({
  dir = learnedDir(),
  repos = [],
  nowDay = epochDay(),
  dryRun = false,
  date,
} = {}) {
  const monthly = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^lessons-.*\.md$/.test(f))
        .sort()
    : [];
  const inputs = [
    ...(existsSync(join(dir, "CONSOLIDATED.md")) ? ["CONSOLIDATED.md"] : []),
    ...monthly,
  ];
  const none = { kept: [], merged: [], dropped: [], conflicts: [] };
  if (!inputs.length) return { ok: true, row: "nothing", dir, inputs, ...none };
  const entries = inputs.flatMap((f) => parseLearned(readFileSync(join(dir, f), "utf8")));
  if (!entries.length) return { ok: true, row: "empty", dir, inputs, ...none };
  const r = consolidateLearned(entries, { claims: ledgerClaimsFor(repos), nowDay });
  const result = { ok: true, row: dryRun ? "dry-run" : "written", dir, inputs, ...r };
  if (dryRun) return result;
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  mkdirSync(join(dir, "archive"), { recursive: true });
  for (const f of inputs) copyFileSync(join(dir, f), join(dir, "archive", `${f}.${ts}.bak`));
  writeFileSync(join(dir, "CONSOLIDATED.md"), renderConsolidated(r.kept, { date }));
  for (const f of monthly) unlinkSync(join(dir, f));
  return result;
}

/** @param {ReturnType<typeof consolidateDir>} r */
export function renderReport(r) {
  if (r.row === "nothing") return `nothing to consolidate in ${r.dir}`;
  if (r.row === "empty") return "no lesson content";
  const head =
    r.row === "dry-run"
      ? `(dry run) would keep ${r.kept.length} lesson(s) — nothing written`
      : `✓ consolidated → ${join(r.dir, "CONSOLIDATED.md")} (${r.kept.length} lesson(s); originals archived in ${join(r.dir, "archive")}/)`;
  const lines = [
    head,
    `  merged duplicates: ${r.merged.length}`,
    `  dropped on ledger evidence: ${r.dropped.length}`,
  ];
  for (const d of r.dropped.slice(0, 20))
    lines.push(`    - [${d.project}] ${d.text.slice(0, 80)} — ${d.reason} (claim ${d.claim})`);
  const conflicts = r.conflicts ?? [];
  if (conflicts.length) {
    lines.push(`  kept apart — similar but conflicting (review these): ${conflicts.length}`);
    for (const c of conflicts.slice(0, 20))
      lines.push(
        `    ! [${c.project}] ${c.text.slice(0, 60)} ↔ ${c.other.slice(0, 60)} — ${c.conflicts}`,
      );
  }
  return lines.join("\n");
}

/** CLI: node src/learn_consolidate.js [--dir <d>] [--repo <root>]… [--dry-run] [--json] */
export function main(argv = process.argv.slice(2)) {
  const repos = [];
  let dir;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--repo") repos.push(argv[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
  }
  // Default ledger: the current directory's, when it has one.
  if (!repos.length && existsSync(repoLedger(process.cwd()))) repos.push(process.cwd());
  const r = consolidateDir({ dir: dir || learnedDir(), repos: repos.filter(Boolean), dryRun });
  console.log(json ? JSON.stringify(r, null, 2) : renderReport(r));
  return r;
}

// Run as a script (bin/learn-consolidate.sh execs this file); importing it has no effect.
// realpath: node resolves the main module through symlinks (/tmp → /private/tmp on macOS).
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};
if (isMain()) {
  try {
    main();
  } catch (e) {
    console.error(`learn-consolidate: ${e instanceof Error ? e.message : e} — originals kept`);
    process.exitCode = 1;
  }
}

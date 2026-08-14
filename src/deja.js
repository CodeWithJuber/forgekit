// forge deja — anti-repetition memory. The user's "why do I keep re-doing solved
// tasks across sessions" root cause: a session's solved-task trace is thrown away at
// clearSession unless a MISTAKE fired (cortex only mints on correction episodes). So a
// clean, first-try success leaves no durable memory — the next session starts blind.
//
// Two halves, both reuse the shipped PCM machinery (no new protocol, no new kind):
//   1. recordSessionSummary — at Stop, mint ONE `summary` claim (existing KIND) whose
//      body is a deterministic, secret-redacted gist of the session (first prompt +
//      files touched). If the session's own tests passed, attach ONE `test.run` confirm
//      outcome — so `val` (ledger.js) separates solved-AND-verified from merely-attempted.
//   2. dejaLookup — rank prior summary/lesson/diagnosis claims for a new task with the
//      SAME Eq.3 retrieve() the ledger query uses (rel × rec × val). A hit above the
//      noise floor surfaces as a one-line preflight advisory. With `forge ledger sync`
//      the summaries travel between machines, so anti-repetition works across surfaces.
//
// Kill switch FORGE_DEJA=0 (read here and in the cortex hook). Best-effort everywhere:
// a failure to summarize or look up must never break a Stop hook or a CLI command.
import { BRAND } from "./brand.js";
import { claimText, mintClaim, outcomeRecord, retrieve, val } from "./ledger.js";
import { appendEvidence, loadClaims, putClaim, reindex, repoLedger } from "./ledger_store.js";
import { redactSecrets } from "./secrets.js";
import { epochDay, gitAuthor } from "./util.js";

/** Durable, task-shaped claim kinds worth checking for a repeat (summaries of solved
 *  work, corrected-behavior lessons, doom-loop diagnoses). Ephemeral kinds (facts,
 *  edges, fingerprints) are not "have I done this task before" memory. */
export const DEJA_KINDS = ["summary", "lesson", "diagnosis"];

/** Retrieval score below which a hit is noise, not a déjà vu — calibrated against the
 *  REAL range of retrieve() for repo-scoped `summary` claims. score() = σ(a·rel+b·rec+g·val)
 *  × SCOPE_WEIGHT.repo (ledger.js): with a+b+g=1 the σ term is < 0.7311 and the 0.6 repo
 *  weight caps a same-day identical-task hit at ≈0.42, while an unrelated task sits ≈0.34.
 *  The floor must live in that band — 0.55 (the old value) exceeded the ceiling, so the
 *  advisory could NEVER fire. 0.39 clears the noise floor with margin and still catches a
 *  strong match. A test drives the full path so this stays inside the achievable range. */
export const DEJA_FLOOR = 0.39;

// Same test-command grammar cortex_hook.js keys its S1 signal on — a passing run here
// is exactly what "this session's work was verified" means. Kept local (one small
// regex) so deja is a self-contained leaf module.
const TEST_RE = /\b(npm\s+(run\s+)?test|node\s+--test|jest|vitest|pytest|go\s+test|cargo\s+test)\b/;

/**
 * Distill a session's normalized event log into a deterministic summary body, or null
 * when there is nothing worth remembering (no prompt and no edits). The gist is the
 * first user prompt, secret-redacted (redactSecrets — one truth, two verbs) and
 * whitespace-collapsed; files are the sorted unique edit targets. `tested` reports
 * whether a test command exited 0 this session (drives the confirm outcome, NOT the body
 * — verification must be evidence, never a self-asserted flag).
 * @param {{type?:string, text?:string, file?:string, command?:string, exitCode?:number}[]} events
 * @returns {{text:string, files:string[], tested:boolean}|null}
 */
export function buildSummary(events = []) {
  const files = [
    ...new Set(events.filter((e) => e.type === "edit" && e.file).map((e) => e.file)),
  ].sort();
  const first = events.find(
    (e) => e.type === "prompt" && typeof e.text === "string" && e.text.trim(),
  );
  const gist = first ? redactSecrets(first.text).replace(/\s+/g, " ").trim().slice(0, 280) : "";
  if (!gist && !files.length) return null;
  const text = gist || `touched ${files.join(", ")}`;
  const tested = events.some(
    (e) => e.type === "bash" && e.exitCode === 0 && TEST_RE.test(e.command || ""),
  );
  return { text, files, tested };
}

/**
 * Mint one `summary` claim for a finished session and persist it into the repo ledger.
 * Best-effort: returns {ok:false, reason} instead of throwing, so a Stop hook is never
 * broken by a summarization failure. Two sessions with the identical (gist, files)
 * converge on ONE content-addressed claim — repeated identical work consolidates its
 * evidence rather than duplicating. A passing test run attaches a single `test.run`
 * confirm outcome (ref = the session id) so retrieval can rank verified work above
 * merely-attempted work.
 * @param {string} root repo root
 * @param {string} sid session id (used as the evidence ref)
 * @param {object[]} events the session's normalized events
 * @param {number} [nowDay] mint day (epoch days)
 * @returns {{ok:boolean, reason?:string, id?:string, tested?:boolean}}
 */
export function recordSessionSummary(root, sid, events, nowDay = epochDay()) {
  try {
    const s = buildSummary(events);
    if (!s) return { ok: false, reason: "nothing to summarize" };
    const dir = repoLedger(root);
    const minted = mintClaim({
      kind: "summary",
      body: { files: s.files, text: s.text },
      scope: { level: "repo" },
      provenance: { agent: "deja", author: gitAuthor() },
      t: nowDay,
    });
    if (!minted.ok)
      return {
        ok: false,
        reason: "reason" in minted ? minted.reason : "mint failed",
      };
    const put = putClaim(dir, minted.claim);
    if (!put.ok) return put;
    if (s.tested) {
      const o = outcomeRecord({
        oracle: "test.run",
        result: "confirm",
        ref: `session:${sid}`,
        author: gitAuthor(),
        t: nowDay,
      });
      if (o.ok) appendEvidence(dir, minted.claim.id, o.outcome);
    }
    reindex(dir, nowDay);
    return { ok: true, id: minted.claim.id, tested: s.tested };
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge deja: ${err?.message ?? err}\n`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * Rank prior task-shaped claims for a new task, via the SAME Eq.3 retrieve() the ledger
 * query uses (relevance × recency × validity). Pure over the supplied claim set — no fs,
 * unit-testable with in-memory claims.
 * @param {any[]} claims live claims (loadClaims output)
 * @param {string} task the task about to be started
 * @param {{nowDay?:number, budget?:number}} [opts]
 * @returns {{claim:any, score:number}[]}
 */
export function dejaLookup(claims, task, { nowDay = 0, budget = 5 } = {}) {
  const kinds = new Set(DEJA_KINDS);
  const pool = (claims ?? []).filter((c) => kinds.has(c.kind));
  return retrieve(String(task ?? ""), pool, { nowDay, budget });
}

/** Load the repo ledger and rank it for a task (the fs-backed wrapper around
 *  dejaLookup). Best-effort: an unreadable ledger yields no hits, never a throw. */
export function dejaFromLedger(root, task, { nowDay = epochDay(), budget = 5 } = {}) {
  try {
    return dejaLookup(loadClaims(repoLedger(root)), task, { nowDay, budget });
  } catch {
    return [];
  }
}

/**
 * The one-line advisory for the top hit, or "" when it is below the noise floor (so an
 * unrelated task stays silent). "verified" appears only when the claim carries a
 * confirming oracle outcome (val > 0.5 — a fresh, evidence-free summary sits exactly at
 * the 0.5 prior).
 * @param {{claim:any, score:number}} [top] the highest-ranked hit
 * @param {number} [nowDay]
 * @returns {string}
 */
export function dejaLine(top, nowDay = 0) {
  if (!top || top.score < DEJA_FLOOR) return "";
  const { claim } = top;
  const verified = val(claim, nowDay) > 0.5;
  const day = claim.provenance?.t ?? 0;
  const gist = claimText(claim).replace(/\s+/g, " ").trim().slice(0, 120);
  return `${BRAND.brand} déjà vu — similar task seen day ${day}${verified ? " (verified)" : ""}: ${gist}`;
}

/**
 * Full best-effort advisory for a task: kill-switch check (FORGE_DEJA=0), load, rank,
 * format. Returns "" for a disabled switch, an empty query, no hits, or any failure —
 * safe to call from a hook or a preflight path.
 * @param {string} root
 * @param {string} task
 * @param {number} [nowDay]
 * @returns {string}
 */
export function dejaAdvisory(root, task, nowDay = epochDay()) {
  if (process.env.FORGE_DEJA === "0") return "";
  if (!task || !String(task).trim()) return "";
  try {
    const hits = dejaFromLedger(root, task, { nowDay, budget: 3 });
    return dejaLine(hits[0], nowDay);
  } catch {
    return "";
  }
}

// forge diagnose — doom-loop root-cause diagnosis (docs/plans/substrate-v2/
// 06-faculties-and-mechanisms.md §5). A repeated failure SIGNATURE — the same error
// hitting the same place — is thrash, not progress: retrying burns tokens on a loop
// the paper documents as unrecoverable without new information. The control here is
// mechanical: normalize the error (volatile parts out), hash it into a signature,
// count recurrences in a ring buffer, and at the k-th hit mint a `diagnosis` claim
// and tell the agent to stop and escalate WITH the diagnosis — diagnosis-carrying
// escalation, never "try again but more expensive". The claim rides the team ledger,
// so the same doom loop is a one-per-team event instead of one-per-session.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lastRouteEscalation } from "./cost_report.js";
import { hasSecret, mintClaim } from "./ledger.js";
import { putClaim, repoLedger } from "./ledger_store.js";
import { contentHash, epochDay, gitAuthor } from "./util.js";

/** Same-signature recurrences before the loop is declared thrash (spec §5, k = 3). */
export const THRASH_K = 3;

/** Recurrence window: only the most recent entries count, so an old, since-fixed
 *  failure can never re-trigger a diagnosis weeks later. */
export const RING_SIZE = 50;

export const failuresPath = (root = process.cwd()) =>
  join(root, ".forge", "trace", "failures.jsonl");

/**
 * Strip the parts of an error that vary between otherwise-identical failures —
 * line/col numbers, hex addresses, timestamps, absolute paths (machine-specific
 * prefixes go; the basename stays, it IS signal). Two runs of the same broken code
 * must normalize to the same text or the recurrence count never accumulates.
 * Order matters: timestamps before the generic `:<digits>` pass would eat them.
 * @param {string} errorText
 */
export function normalizeError(errorText) {
  return String(errorText)
    .replace(/\r\n/g, "\n")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "<addr>")
    .replace(/(?:\/[\w.~-]+)+\/([\w.-]+)/g, "$1") // /home/x/src/a.js → a.js
    .replace(/\b[A-Za-z]:\\(?:[\w.~ -]+\\)*([\w.-]+)/g, "$1") // C:\x\a.js → a.js
    .replace(/:\d+(?::\d+)?\b/g, ":<n>") // a.js:12:5 → a.js:<n>
    .replace(/\bline \d+/gi, "line <n>")
    .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, "<dur>") // 65951.17ms / 3 s durations
    .trim();
}

/**
 * The failure signature — sha256(normalized error ‖ file ‖ symbol). Pure. The file
 * and symbol are part of the identity on purpose: the same TypeError in two different
 * functions is two different problems, not one recurring one.
 * @param {string} errorText
 * @param {{file?: string, symbol?: string}} [where]
 */
export function failureSignature(errorText, { file = "", symbol = "" } = {}) {
  return contentHash(`${normalizeError(errorText)}\0${file}\0${symbol}`);
}

/** All recorded failures, oldest first — corrupt-line tolerant like metrics.read
 *  (a truncated append from a killed process must never break the next one). */
export function readFailures(root) {
  const path = failuresPath(root);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/**
 * Append one failure to the session trace and count its signature's recurrences in
 * the last RING_SIZE entries (this one included). `t` defaults to wall-clock ms —
 * the trace is telemetry, not content-addressed protocol state (same rule as
 * metrics.js). The stored head is for human triage only; the signature is the key.
 * @param {string} root
 * @param {{errorText: string, file?: string, symbol?: string, t?: number}} f
 * @returns {{signature: string, count: number, head: string}}
 */
export function recordFailure(root, { errorText, file = "", symbol = "", t = Date.now() }) {
  const signature = failureSignature(errorText, { file, symbol });
  let head = normalizeError(errorText).split("\n")[0].slice(0, 160);
  // The ledger refuses secret-shaped claim bodies; keep the trace clean too so a
  // later mint built from this head can never be refused (or worse, leak).
  if (hasSecret(head)) head = "(redacted: secret-like content)";
  const dir = join(root, ".forge", "trace");
  mkdirSync(dir, { recursive: true });
  appendFileSync(failuresPath(root), `${JSON.stringify({ t, signature, file, symbol, head })}\n`);
  const recent = readFailures(root).slice(-RING_SIZE);
  return { signature, count: recent.filter((e) => e.signature === signature).length, head };
}

/**
 * Record a failure and, at the THRASH_K-th recurrence, mint the `diagnosis` claim
 * (body: {signature, note, triedFixes}) into the repo ledger and return the
 * escalation directive. Idempotent by construction: the claim is content-addressed,
 * so the 4th/5th hit re-resolves to the SAME claim instead of minting duplicates.
 * @param {string} root
 * @param {{errorText: string, file?: string, symbol?: string, note?: string, task?: string,
 *          t?: number, nowDay?: number}} opts
 *   `note` is the human root-cause statement if the caller has one; defaults to the
 *   normalized error head. `task` is the task text this failure came out of — when it
 *   matches a routing decision this repo recorded, the directive names that decision's
 *   escalation tier instead of saying "one tier" (see `escalationTier` below).
 *   `nowDay` (epoch days) is the claim's mint day.
 * @returns {{thrash: boolean, signature: string, count: number, claimId?: string,
 *            escalate?: string, escalateTo?: string, reason?: string}}
 */
export function diagnose(
  root,
  { errorText, file = "", symbol = "", note = "", task = "", t, nowDay },
) {
  const rec = recordFailure(root, { errorText, file, symbol, ...(t !== undefined && { t }) });
  const { signature, count, head } = rec;
  if (count < THRASH_K) return { thrash: false, signature, count };
  const minted = mintClaim({
    kind: "diagnosis",
    // file/symbol are already baked into the signature — the body stays exactly the
    // spec'd triple so two sessions hitting the same loop mint the SAME claim id.
    body: { note: note || head, signature, triedFixes: [] },
    scope: { level: "repo" },
    provenance: { agent: "doomloop", author: gitAuthor() },
    t: nowDay ?? epochDay(),
  });
  if (!minted.ok)
    return { thrash: true, signature, count, reason: "reason" in minted ? minted.reason : "" };
  const put = putClaim(repoLedger(root), minted.claim);
  if (!put.ok) return { thrash: true, signature, count, reason: put.reason };
  const short = minted.claim.id.slice(0, 8);
  const tier = escalationTier(root, task);
  return {
    thrash: true,
    signature,
    count,
    claimId: minted.claim.id,
    ...(tier ? { escalateTo: tier } : {}),
    escalate:
      `Same failure signature ${signature.slice(0, 12)} hit ${count}× — this is thrash, not progress. ` +
      `STOP retrying this fix. State the diagnosis out loud (claim ${short} — \`forge ledger show ${short}\`, ` +
      `add what you already tried to its triedFixes), then escalate ${
        tier ? `to ${tier} (the tier routing already flagged for this task)` : "ONE model tier"
      } with the diagnosis as ` +
      `the head of the new prompt. The escalation must carry the diagnosis — never just "try again, but more expensive".`,
  };
}

/**
 * Which tier to escalate to, when routing already answered that question for this task.
 *
 * Whitepaper §5.1: spend more only when an EXTERNAL check on the output fails, never on a
 * model's self-assessment. `reconcileRoute()` enforces the first half — a proposer that
 * votes for a higher band does NOT get it; the tier that vote would have picked is parked
 * as an advisory `escalateTo` and metered with the task's `ref` (`meterRoute`). This is
 * the second half, and the only consumer: THRASH_K recurrences of one failure signature IS
 * an external check failing, repeatedly, so an escalation has been earned HERE, by the
 * failure — the vote never triggers one, it only answers "to which tier" once the failure
 * has. Without that record the directive says "ONE model tier", exactly as before.
 *
 * Fail-safe and non-widening: no task text, no matching route record, or any read error →
 * "" → today's behaviour byte for byte.
 * @param {string} root
 * @param {string} task
 * @returns {string} a tier key, or "" for "the caller decides, as before"
 */
function escalationTier(root, task) {
  try {
    return lastRouteEscalation(root, task);
  } catch {
    return "";
  }
}

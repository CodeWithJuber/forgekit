// forge decide — the append-only, human-readable decision log. Lessons capture
// corrections and the ledger captures machine claims, but "we picked X over Y because Z"
// had no home the NEXT session reads — so sessions re-decided (or contradicted) settled
// choices. .forge/decisions.md is ADR-lite: one line per decision, append-only. Append
// is one syscall, merge-friendly, and never rewrites history — a decision that stops
// being true gets a new entry, not an edit.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { mintClaim } from "./ledger.js";
import { putClaim } from "./ledger_store.js";
import { hasSecret } from "./secrets.js";
import { gitAuthor } from "./util.js";

export const decisionsPath = (root) => join(root, ".forge", "decisions.md");

const LINE_RE = /^- \*\*D-(\d{4,})\*\* \((\d{4}-\d{2}-\d{2})\): (.*)$/;

/** Parse decision entries out of the log; unparseable lines are ignored, never fatal. */
export function parseDecisions(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (m) out.push({ n: Number(m[1]), id: `D-${m[1]}`, date: m[2], text: m[3] });
  }
  return out;
}

/** The most recent `limit` decisions, oldest→newest (chronological log order). */
export function listDecisions(root, { limit = 10 } = {}) {
  try {
    const p = decisionsPath(root);
    if (!existsSync(p)) return [];
    return parseDecisions(readFileSync(p, "utf8")).slice(-limit);
  } catch {
    return [];
  }
}

// mkdir is the one atomic zero-dep mutex: the D-#### number is read-then-append, and
// two concurrent processes (a review demonstrated 12) would mint duplicate ids and
// interleave headers without it. Held for milliseconds; a lock older than 5s is a
// crashed holder and is stolen; total wait is bounded (~300ms) then we proceed anyway —
// a duplicate id under pathological contention beats a lost decision.
function withDecisionLock(root, fn) {
  const lock = join(root, ".forge", "decisions.lock");
  let held = false;
  for (let i = 0; i < 60 && !held; i += 1) {
    try {
      mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) rmdirSync(lock);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    if (held)
      try {
        rmdirSync(lock);
      } catch {}
  }
}

/**
 * Append one decision ("<what was decided> — <why>"). Refuses secrets (same rule as
 * every forge store). Also mints a `decision` ledger claim — the machine-readable twin —
 * best-effort only: the markdown line is the source of truth and must never fail
 * because the ledger couldn't be written.
 */
export function appendDecision(root, text, { t = Date.now() } = {}) {
  const body = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!body) return { ok: false, reason: "empty decision — say what was decided and why" };
  if (hasSecret(body))
    return { ok: false, reason: "refused: decision looks like it contains a secret/credential" };
  mkdirSync(join(root, ".forge"), { recursive: true });
  const p = decisionsPath(root);
  const appended = withDecisionLock(root, () => {
    let existing = "";
    try {
      existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {}
    const prior = parseDecisions(existing);
    const n = prior.length ? Math.max(...prior.map((d) => d.n)) + 1 : 1;
    const id = `D-${String(n).padStart(4, "0")}`;
    const date = new Date(t).toISOString().slice(0, 10);
    const header = existing.trim()
      ? ""
      : `# Decisions\n\nAppend-only — supersede an old choice with a NEW entry (\`${BRAND.cli} decide\`), never an edit.\n\n`;
    try {
      appendFileSync(p, `${header}- **${id}** (${date}): ${body}\n`);
    } catch (err) {
      return { ok: false, reason: `could not write ${p}: ${err?.code ?? "error"}` };
    }
    return { ok: true, id };
  });
  if (!appended.ok) return appended;
  const { id } = appended;
  try {
    const minted = mintClaim({
      kind: "decision",
      body: { id, text: body },
      scope: { level: "repo" },
      provenance: { author: gitAuthor() },
      t: Math.floor(t / 86_400_000),
    });
    if (minted.ok) putClaim(join(root, ".forge", "ledger"), minted.claim);
  } catch {}
  return { ok: true, id, text: body };
}

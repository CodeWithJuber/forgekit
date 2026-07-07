// forge ledger bridge — the P1 migration seam between the legacy stores (lessons/*.md,
// recall facts) and the PCM ledger. Legacy files stay the READ path (every existing
// test, hook, and guard keeps working unchanged); the ledger shadows every write as
// the new canonical, and `forge ledger import` back-fills history. P2 flips the read
// path once merge/verify tooling lands. Spec: docs/plans/substrate-v2/01-pcm-protocol.md §7.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mintClaim, outcomeRecord } from "./ledger.js";
import { appendEvidence, putClaim, reindex, repoLedger } from "./ledger_store.js";
import { load as loadLessons } from "./lessons_store.js";
import { list as listFacts } from "./recall.js";

/** A lesson's claim: body = the CONTENT (trigger + texts); counts/status are evidence-
 *  derived in the ledger, not body — so confirm/contradict never changes the id.
 *  @returns {{ok:boolean, reason?:string, claim?:any}} */
export function lessonClaim(lesson, t = 0) {
  return mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: lesson.correctedBehavior ?? "",
      legacyId: lesson.id, // join key back to .forge/lessons/<id>.md during the bridge
      trigger: {
        action: lesson.trigger?.action ?? "",
        files: lesson.trigger?.files ?? [],
        keywords: lesson.trigger?.keywords ?? [],
        symbols: lesson.trigger?.symbols ?? [],
      },
      whatWentWrong: lesson.whatWentWrong ?? "",
    },
    scope: { level: lesson.scope ?? "repo" },
    provenance: { agent: "cortex", author: "" },
    t,
  });
}

/** A recall fact's claim.
 *  @returns {{ok:boolean, reason?:string, claim?:any}} */
export function factClaim(name, text, t = 0) {
  return mintClaim({
    kind: "fact",
    body: { name, text },
    scope: { level: "repo" },
    provenance: { agent: "recall", author: "" },
    t,
  });
}

/**
 * Shadow-write one lesson event into the repo ledger. Best-effort by design: the
 * legacy store is still canonical in P1, so a bridge failure must never break the
 * hook path — it returns {ok:false} instead of throwing.
 * @param {string} root repo root
 * @param {object} lesson the (already saved) lesson object
 * @param {{result?:"confirm"|"contradict", oracle?:string, ref?:string, t?:number}} ev
 *   evidence for this event; omit result for mint-only (a freshly created lesson has
 *   zero evidence — creation is not confirmation). `ref` is required whenever a
 *   result is given (outcomeRecord enforces it).
 */
export function recordLessonEvent(root, lesson, ev = {}) {
  try {
    const dir = repoLedger(root);
    const minted = lessonClaim(lesson, ev.t ?? 0);
    if (!minted.ok) return minted;
    const put = putClaim(dir, minted.claim);
    if (!put.ok) return put;
    if (ev.result) {
      const o = outcomeRecord({
        oracle: ev.oracle ?? "cortex.episode",
        result: ev.result,
        ref: ev.ref,
        t: ev.t ?? 0,
      });
      if (!o.ok) return o;
      const a = appendEvidence(dir, minted.claim.id, o.outcome);
      if (!a.ok) return a;
    }
    return { ok: true, id: minted.claim.id };
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge ledger bridge: ${err?.message ?? err}\n`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/** Shadow-write one recall fact into the ledger that lives beside the recall store.
 *  @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean}} */
export function recordFactEvent(ledgerDir, name, text, t = 0) {
  try {
    const minted = factClaim(name, text, t);
    if (!minted.ok) return { ok: false, reason: minted.reason };
    return putClaim(ledgerDir, minted.claim);
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge ledger bridge: ${err?.message ?? err}\n`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * One-shot back-fill: import every existing lesson (with its evidence/contradiction
 * counts as conservative `legacy.import` outcomes) and every recall fact into the
 * ledger. Idempotent — content addressing dedupes claims, outcome hashes dedupe
 * evidence — so re-running an import is always safe.
 * @param {string} root repo root (lessons + repo ledger)
 * @param {{recallStore?:string, recallLedger?:string, nowDay?:number}} opts
 * @returns {{lessons:number, facts:number, outcomes:number, refused:string[]}}
 */
export function importLegacy(root, { recallStore, recallLedger, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  const refused = [];
  let lessons = 0;
  let facts = 0;
  let outcomes = 0;

  for (const lesson of loadLessons(root)) {
    const minted = lessonClaim(lesson, lesson.createdDay ?? 0);
    if (!minted.ok) {
      refused.push(`lesson ${lesson.id}: ${minted.reason}`);
      continue;
    }
    const put = putClaim(dir, minted.claim);
    if (!put.ok) {
      refused.push(`lesson ${lesson.id}: ${put.reason}`);
      continue;
    }
    if (!put.existed) lessons++;
    // Aggregate counts become individual, decay-dated outcomes: confirms carry the
    // last-confirmed day (what freshness keyed on), contradictions the created day
    // (the legacy store kept no per-contradiction date — documented approximation).
    /** @type {{result:"confirm"|"contradict", t:number, n:number}[]} */
    const synth = [];
    for (let i = 0; i < (lesson.evidenceCount ?? 0); i++)
      synth.push({ result: "confirm", t: lesson.lastConfirmedDay ?? 0, n: i });
    for (let i = 0; i < (lesson.contradictionCount ?? 0); i++)
      synth.push({ result: "contradict", t: lesson.createdDay ?? 0, n: i });
    for (const s of synth) {
      const o = outcomeRecord({
        oracle: "legacy.import",
        result: s.result,
        ref: `legacy:${lesson.id}#${s.result}${s.n}`,
        t: s.t,
      });
      if (!o.ok) continue;
      const a = appendEvidence(dir, minted.claim.id, o.outcome);
      if (a.ok && !a.deduped) outcomes++;
    }
  }

  if (recallStore) {
    const ledgerDir = recallLedger ?? dir;
    for (const slug of listFacts(recallStore)) {
      const r = importFact(recallStore, ledgerDir, slug, nowDay);
      if (r.ok && !r.existed) facts++;
      else if (!r.ok) refused.push(`fact ${slug}: ${r.reason}`);
    }
  }

  reindex(dir, nowDay);
  return { lessons, facts, outcomes, refused };
}

function importFact(store, ledgerDir, slug, t) {
  try {
    const raw = readFileSync(join(store, "facts", `${slug}.md`), "utf8");
    const m = raw.match(/^# (.*)\n\n([\s\S]*)$/);
    const name = m ? m[1] : slug;
    const text = (m ? m[2] : raw).trim();
    return recordFactEvent(ledgerDir, name, text, t);
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

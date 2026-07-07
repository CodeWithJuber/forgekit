// forge ledger bridge — the P1 migration seam between the legacy stores (lessons/*.md,
// recall facts) and the PCM ledger. Legacy files stay the READ path (every existing
// test, hook, and guard keeps working unchanged); the ledger shadows every write as
// the new canonical, and `forge ledger import` back-fills pre-ledger history. P2 flips
// the read path once merge/verify tooling lands. Spec: docs/plans/substrate-v2/01-pcm-protocol.md §7.
//
// Every entry point here is BEST-EFFORT by design: the legacy store is still
// canonical in P1, so a bridge failure returns {ok:false} and must never break a
// hook or CLI write that already succeeded.
import { mintClaim, outcomeRecord } from "./ledger.js";
import {
  appendEvidence,
  loadClaims,
  putClaim,
  readEvidence,
  reindex,
  repoLedger,
  tombstone,
} from "./ledger_store.js";
import { load as loadLessons } from "./lessons_store.js";
import { list as listFacts, readFact } from "./recall.js";
import { epochDay } from "./util.js";

/** One best-effort policy for the whole bridge (never throws into a caller). */
const bestEffort = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge ledger bridge: ${err?.message ?? err}\n`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
};

/** A lesson's claim: body = the CONTENT (trigger + texts) only. Counts/status are
 *  evidence-derived and the legacy file id rides in PROVENANCE (excluded from the
 *  content address) — so teammates who learn the same lesson mint the same id even
 *  if their legacy filenames differ, and confirm/contradict never re-mints.
 *  @returns {{ok:boolean, reason?:string, claim?:any}} */
export function lessonClaim(lesson, t = 0) {
  return mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: lesson.correctedBehavior ?? "",
      trigger: {
        action: lesson.trigger?.action ?? "",
        files: lesson.trigger?.files ?? [],
        keywords: lesson.trigger?.keywords ?? [],
        symbols: lesson.trigger?.symbols ?? [],
      },
      whatWentWrong: lesson.whatWentWrong ?? "",
    },
    scope: { level: lesson.scope ?? "repo" },
    provenance: { agent: "cortex", author: "", task: lesson.id ?? "" },
    t,
  });
}

/** A recall fact's claim. Name/text are trimmed so the shadow-write path and the
 *  file-parse import path mint the SAME id for the same fact.
 *  @returns {{ok:boolean, reason?:string, claim?:any}} */
export function factClaim(name, text, t = 0) {
  return mintClaim({
    kind: "fact",
    body: { name: String(name).trim(), text: String(text).trim() },
    scope: { level: "repo" },
    provenance: { agent: "recall", author: "" },
    t,
  });
}

/**
 * Shadow-write one lesson event into the repo ledger.
 * @param {string} root repo root
 * @param {object} lesson the (already saved) lesson object
 * @param {{result?:"confirm"|"contradict", oracle?:string, ref?:string, t?:number}} ev
 *   evidence for this event; omit result for mint-only (a freshly created lesson has
 *   zero evidence — creation is not confirmation). `ref` is required whenever a
 *   result is given (outcomeRecord enforces it).
 */
export function recordLessonEvent(root, lesson, ev = {}) {
  return bestEffort(() => {
    const dir = repoLedger(root);
    const minted = lessonClaim(lesson, ev.t ?? 0);
    if (!minted.ok) return { ok: false, reason: minted.reason };
    const put = putClaim(dir, minted.claim);
    if (!put.ok) return put;
    if (ev.result) {
      const o = outcomeRecord({
        oracle: ev.oracle ?? "cortex.episode",
        result: ev.result,
        ref: ev.ref,
        t: ev.t ?? 0,
      });
      if (!o.ok) return { ok: false, reason: "reason" in o ? o.reason : "invalid outcome" };
      const a = appendEvidence(dir, minted.claim.id, o.outcome);
      if (!a.ok) return a;
    }
    return { ok: true, id: minted.claim.id };
  });
}

/**
 * A lesson's body was rewritten (distillation) — content addressing means a NEW claim
 * id, so carry the history across: mint the new claim, copy the old claim's evidence
 * to it, and tombstone the old claim as superseded. Without this, evidence splits
 * between an orphaned template claim and the distilled one.
 */
export function supersedeLessonClaim(root, before, after, t = epochDay()) {
  return bestEffort(() => {
    const dir = repoLedger(root);
    const oldC = lessonClaim(before, t);
    const newC = lessonClaim(after, t);
    if (!newC.ok) return { ok: false, reason: newC.reason };
    const put = putClaim(dir, newC.claim);
    if (!put.ok) return put;
    if (oldC.ok && oldC.claim.id !== newC.claim.id) {
      for (const o of readEvidence(dir, oldC.claim.id)) appendEvidence(dir, newC.claim.id, o);
      tombstone(dir, oldC.claim.id, {
        reason: `superseded-by:${newC.claim.id}`,
        t,
      });
    }
    return { ok: true, id: newC.claim.id };
  });
}

/**
 * Shadow one fact into a ledger, superseding any live fact claim with the same name
 * but different content — so `forge remember api-base <new>` retires the old value
 * instead of leaving a stale phantom the P2 read-flip would resurrect.
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean}}
 */
export function shadowFact(ledgerDir, name, text, t = epochDay()) {
  return bestEffort(() => {
    const minted = factClaim(name, text, t);
    if (!minted.ok) return { ok: false, reason: minted.reason };
    const put = putClaim(ledgerDir, minted.claim);
    if (!put.ok) return put;
    for (const c of loadClaims(ledgerDir)) {
      if (
        c.kind === "fact" &&
        !c.tombstone &&
        c.id !== minted.claim.id &&
        c.body?.name === minted.claim.body.name
      )
        tombstone(ledgerDir, c.id, { reason: `superseded-by:${minted.claim.id}`, t });
    }
    reindex(ledgerDir, t);
    return { ...put, id: minted.claim.id };
  });
}

/**
 * Re-align a ledger's fact claims with the store they shadow: any live fact claim
 * whose (name, text) no longer exists as a stored fact is tombstoned. Called after
 * `forge recall consolidate` (which rm's duplicate files) so deleted memories don't
 * survive as live claims.
 */
export function reconcileFacts(store, ledgerDir, t = epochDay()) {
  return bestEffort(() => {
    const current = new Set();
    for (const slug of listFacts(store)) {
      const f = readFact(store, slug);
      if (f) {
        const minted = factClaim(f.name, f.text, t);
        if (minted.ok) current.add(minted.claim.id);
      }
    }
    let removed = 0;
    for (const c of loadClaims(ledgerDir)) {
      if (c.kind === "fact" && !c.tombstone && !current.has(c.id)) {
        tombstone(ledgerDir, c.id, { reason: "removed-from-store", t });
        removed++;
      }
    }
    if (removed) reindex(ledgerDir, t);
    return { ok: true, removed };
  });
}

/**
 * Import every fact in a recall/brain store into a ledger (idempotent; supersedes
 * stale same-name claims via shadowFact).
 * @returns {{facts:number, refused:string[]}}
 */
export function importFacts(store, ledgerDir, nowDay = 0) {
  const refused = [];
  let facts = 0;
  for (const slug of listFacts(store)) {
    const f = readFact(store, slug);
    if (!f) {
      refused.push(`fact ${slug}: unreadable`);
      continue;
    }
    const r = shadowFact(ledgerDir, f.name, f.text, nowDay);
    if (r.ok && !r.existed) facts++;
    else if (!r.ok) refused.push(`fact ${slug}: ${r.reason}`);
  }
  return { facts, refused };
}

/**
 * One-shot back-fill of PRE-LEDGER history. A lesson whose claim already exists in
 * the ledger is skipped entirely — its live shadow-writes are already tracking it,
 * and re-synthesizing evidence from the (still-moving) legacy counters would double-
 * count and break idempotence. Only never-seen claims get their aggregate counts
 * expanded into conservative `legacy.import` outcomes.
 * @param {string} root repo root (lessons + repo ledger)
 * @param {{recallStore?:string, recallLedger?:string, nowDay?:number}} opts
 * @returns {{lessons:number, facts:number, outcomes:number, refused:string[]}}
 */
export function importLegacy(root, { recallStore, recallLedger, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  const refused = [];
  let lessons = 0;
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
    if (put.existed) continue; // already tracked live — never re-synthesize
    lessons++;
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

  let facts = 0;
  if (recallStore) {
    const r = importFacts(recallStore, recallLedger ?? dir, nowDay);
    facts = r.facts;
    refused.push(...r.refused);
  }

  reindex(dir, nowDay);
  return { lessons, facts, outcomes, refused };
}

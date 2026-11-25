// Write lesson observations, revisions and facts through the authoritative PCM ledger.
import { signCorrectionOutcome } from "./correction_receipt.js";
import { mintClaim, outcomeRecord } from "./ledger.js";
import {
  appendEvidence,
  getClaimByPrefix,
  loadClaims,
  putClaim,
  readEvidence,
  reindex,
  repoLedger,
  tombstone,
} from "./ledger_store.js";
import { describeConflicts, sameSemantics, semanticConflicts } from "./semantic_guard.js";
import { epochDay, gitAuthor, slug } from "./util.js";

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
export function lessonClaim(lesson, t = 0, lineage = {}) {
  return mintClaim({
    kind: "lesson",
    body: {
      ...(lesson.provenance?.correctionVersion === 2 ? { correctionVersion: 2 } : {}),
      ...(lesson.provenance?.check ? { check: lesson.provenance.check } : {}),
      ...(lesson.provenance?.operatorText ? { operatorText: true } : {}),
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
    // `lineage` (supersedes/rewrite/conflicts) rides in PROVENANCE — never the content address.
    provenance: {
      agent: "cortex",
      author: gitAuthor(),
      task: lesson.id ?? "",
      ...(lesson.provenance?.episodes?.length ? { episodes: lesson.provenance.episodes } : {}),
      ...(lesson.provenance?.signals?.length ? { signals: lesson.provenance.signals } : {}),
      ...lineage,
    },
    t,
  });
}

/** A recall fact's claim. Name/text are trimmed so the shadow-write path and the
 *  file-parse import path mint the SAME id for the same fact. `rev` (≥1) re-asserts a value
 *  whose rev-0 claim was retracted — see shadowFact; rev 0 keeps the historical id.
 *  @returns {{ok:boolean, reason?:string, claim?:any}} */
export function factClaim(name, text, t = 0, rev = 0, provenance = {}) {
  return mintClaim({
    kind: "fact",
    body: { name: String(name).trim(), text: String(text).trim(), ...(rev ? { rev } : {}) },
    scope: { level: "repo" },
    provenance: { agent: "recall", author: gitAuthor(), ...provenance },
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
    const minted = lessonClaim(
      lesson,
      lesson.provenance?.correctionVersion === 2 ? lesson.createdDay : (ev.t ?? 0),
    );
    if (!minted.ok) return { ok: false, reason: minted.reason };
    let outcome;
    if (ev.result) {
      const o = outcomeRecord({
        oracle: ev.oracle ?? "cortex.episode",
        result: ev.result,
        ref: ev.ref,
        author: gitAuthor(),
        t: ev.t ?? 0,
      });
      if (!o.ok)
        return {
          ok: false,
          reason: "reason" in o ? o.reason : "invalid outcome",
        };
      outcome =
        lesson.provenance?.correctionVersion === 2
          ? signCorrectionOutcome(root, minted.claim.id, lesson.id, o.outcome)
          : o.outcome;
      if (!outcome) return { ok: false, reason: "Local correction evidence could not be signed" };
    }
    const existing = getClaimByPrefix(dir, minted.claim.id, { attic: true });
    if (existing?.archived || existing?.tombstone)
      return { ok: false, reason: "This lesson was retired" };
    if (!existing) {
      const put = putClaim(dir, minted.claim);
      if (!put.ok) return put;
    }
    if (outcome) {
      const a = appendEvidence(dir, minted.claim.id, outcome);
      if (!a.ok) return a;
    }
    return { ok: true, id: minted.claim.id };
  });
}

// The narrow equivalence rule for carrying evidence across a rewrite (review F07): the two
// texts differ at most in a sentence's opening capital, prose punctuation and edge whitespace
// (plainText folds more; the semantic guard's spelling and layout checks then refuse a case
// change inside a sentence or an extra space), AND the guard finds no
// behaviour-bearing difference (polarity, operators, numbers, literals, identifiers, paths).
const plainText = (s) =>
  String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}<>=!]+/gu, " ")
    .trim();
const sameText = (a, b) => plainText(a) === plainText(b) && sameSemantics(a, b);

/**
 * Whether a lesson rewrite keeps the lesson's MEANING by the narrow, verifiable rule: both
 * `whatWentWrong` and `correctedBehavior` equal up to a sentence's capital and punctuation, with no
 * semantic-guard conflict. Anything else is a different proposition.
 * @param {object} before
 * @param {object} after
 */
export function equivalentLesson(before, after) {
  return (
    sameText(before?.whatWentWrong, after?.whatWentWrong) &&
    sameText(before?.correctedBehavior, after?.correctedBehavior)
  );
}

/**
 * A lesson's body was rewritten (distillation) — content addressing means a NEW claim id.
 * Evidence is carried across ONLY when the rewrite is equivalent by the narrow rule above
 * (review F07): proof earned by "Validate request signatures…" must not transfer to "Skip
 * request signature validation." A changed meaning starts as an unproven claim at the 0.5
 * prior (below every serving bar) and earns its own evidence; the old claim is tombstoned as
 * its parent (`superseded-by:`), and its evidence stays inspectable there (`forge ledger
 * blame`) without counting as confirmation of the new text. The new claim's provenance names
 * its parent (`supersedes`) and the semantic conflicts, if any.
 * @returns {{ok:boolean, reason?:string, id?:string, carried?:boolean, conflicts?:string}}
 */
export function supersedeLessonClaim(root, before, after, t = epochDay()) {
  return bestEffort(() => {
    const dir = repoLedger(root);
    const oldC = lessonClaim(before, t);
    const equivalent = equivalentLesson(before, after);
    const conflicts = describeConflicts(
      semanticConflicts(
        `${before?.whatWentWrong ?? ""} ${before?.correctedBehavior ?? ""}`,
        `${after?.whatWentWrong ?? ""} ${after?.correctedBehavior ?? ""}`,
      ),
    );
    const newC = lessonClaim(after, t, {
      ...(oldC.ok ? { supersedes: oldC.claim.id } : {}),
      rewrite: equivalent ? "equivalent" : "unverified",
      ...(conflicts ? { conflicts } : {}),
    });
    if (!newC.ok) return { ok: false, reason: newC.reason };
    const put = putClaim(dir, newC.claim);
    if (!put.ok) return put;
    let carried = false;
    if (oldC.ok && oldC.claim.id !== newC.claim.id) {
      if (equivalent) {
        for (const o of readEvidence(dir, oldC.claim.id)) appendEvidence(dir, newC.claim.id, o);
        carried = true;
      }
      tombstone(dir, oldC.claim.id, {
        author: gitAuthor(),
        reason: `superseded-by:${newC.claim.id}`,
        t,
      });
    }
    return { ok: true, id: newC.claim.id, carried, ...(conflicts ? { conflicts } : {}) };
  });
}

/**
 * Shadow one fact into a ledger, superseding any live fact claim with the same name
 * but different content — so `forge remember api-base <new>` retires the old value
 * instead of leaving a stale phantom the P2 read-flip would resurrect.
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean}}
 */
export function shadowFact(ledgerDir, name, text, t = epochDay(), { replace = true } = {}) {
  return bestEffort(() => {
    // Tombstones are permanent and ids are content-addressed, so restoring a value that
    // was superseded (v1 → v2 → v1) would land on v1's RETIRED id and leave no live fact
    // (review C4). A retired value is re-asserted as the next revision instead — the lowest
    // `rev` whose claim is not tombstoned — deterministic, so teammates doing the same
    // sequence still converge on one id. Unretired values keep the rev-0 id.
    const observed = loadClaims(ledgerDir);
    const retired = new Set(
      observed.filter((c) => c.kind === "fact" && c.tombstone).map((c) => c.id),
    );
    let minted = factClaim(name, text, t);
    const unusable = (id) =>
      retired.has(id) || getClaimByPrefix(ledgerDir, id, { attic: true })?.archived;
    for (let rev = 1; minted.ok && unusable(minted.claim.id); rev++)
      minted = factClaim(name, text, t, rev);
    if (!minted.ok) return { ok: false, reason: minted.reason };
    const put = putClaim(ledgerDir, minted.claim);
    if (!put.ok) return put;
    for (const c of replace ? observed : []) {
      if (
        c.kind === "fact" &&
        !c.tombstone &&
        c.id !== minted.claim.id &&
        (slug(c.body?.name ?? "") || "fact") === (slug(minted.claim.body.name) || "fact")
      )
        tombstone(ledgerDir, c.id, {
          author: gitAuthor(),
          reason: `superseded-by:${minted.claim.id}`,
          t,
        });
    }
    reindex(ledgerDir, t);
    return { ...put, id: minted.claim.id };
  });
}

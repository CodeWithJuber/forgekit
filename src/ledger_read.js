// Project the content-addressed ledger into the lesson and fact shapes used by all hosts.
import { existsSync } from "node:fs";
import { trustedCorrectionOutcome } from "./correction_receipt.js";
import {
  claimId,
  DEFAULT_HALF_LIFE_DAYS,
  evidenceEvents,
  isDormant,
  sticky,
  val,
  validOutcome,
} from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { slug } from "./util.js";

/**
 * Map a ledger `lesson` claim onto the legacy lesson shape (lessons.js), so every
 * existing consumer — matchScore, selectForInjection, confidenceOf, summary — can rank
 * a teammate's claim without knowing the ledger exists. Inverse-ish of
 * ledger_bridge.lessonClaim: body carries trigger/whatWentWrong/correctedBehavior, and
 * the legacy lesson id rides in provenance.task (it is excluded from the content
 * address so teammates converge on one claim id).
 *
 * Version 2 counts distinct local receipts authenticated for this content and checkout. The historical shape
 * below retains the earlier rules.
 * The legacy lifecycle (candidate/active/quarantined/retired) is local mutable state
 * the ledger deliberately does not store, so status is DERIVED from evidence:
 *
 * | claim state                          | derived status | rationale |
 * |--------------------------------------|----------------|-----------|
 * | tombstoned                           | "retired"      | a retraction is the ledger's retirement |
 * | sticky(≥ LESSON_ACTIVE_VAL, stays ≥ LESSON_KEEP_VAL) | "active" | one fresh confirm (bridge oracle w=0.5 → val 0.6) clears the bar — mirrors confirm()'s promote-on-recurrence — and it STAYS active until a contradiction or ~a half-life of silence pulls it under the lower bar |
 * | val < 0.45 and ≥ 1 contradiction     | "quarantined"  | net-negative outcome evidence — mirrors contradict()'s demotion |
 * | otherwise                            | "candidate"    | a fresh claim sits at the 0.5 prior, exactly newLesson() |
 *
 * The two activation bars are what stops the lifecycle FLAPPING: one confirm put val at
 * exactly 0.6 against a single `active` bar of 0.6, so ONE day of decay (0.5988) retired the
 * lesson and it was never injected again (review C6).
 *
 * Count/date fields are rebuilt from the evidence log: evidenceCount = valid confirm
 * outcomes, contradictionCount = valid contradict outcomes, lastConfirmedDay = latest
 * confirm t (else the mint day), createdDay = the mint day (provenance.t).
 * @param {any} claim a materialized lesson claim (ledger_store.loadClaims view)
 * @param {number} [nowDay] epoch day used for the val() decay clock
 * @returns {object} a legacy-shaped lesson
 */
/** Activation bars for a ledger-derived lesson (hysteresis, review C6): a confirm lifts a
 *  lesson to "active" at 0.6, and it stays active while val ≥ 0.55 — about one half-life of
 *  silence after a single bridge-oracle confirm, or until a contradiction pulls it under. */
export const LESSON_ACTIVE_VAL = 0.6;
export const LESSON_KEEP_VAL = 0.55;

export function claimToLesson(claim, nowDay = 0, root = undefined) {
  const body = claim.body ?? {};
  const observed = body.correctionVersion === 2;
  const id = String(claim.provenance?.task || "") || `lsn_${claim.id.slice(0, 8)}`;
  // Filter before event deduplication. An unsigned copy of a receipt may have an earlier date.
  let evidence = (claim.evidence ?? []).filter(validOutcome);
  if (observed) {
    evidence =
      root && claim.id === claimId(claim.kind, body, claim.scope)
        ? evidenceEvents(evidence.filter((e) => trustedCorrectionOutcome(root, claim.id, id, e)))
        : [];
  }
  const confirms = evidence.filter((e) => e.result === "confirm");
  const contradictions = evidence.length - confirms.length;
  const createdDay = claim.provenance?.t ?? 0;
  let status = "candidate";
  if (claim.tombstone) status = "retired";
  else if (observed) {
    if (confirms.length > contradictions) status = "active";
    else if (contradictions) status = "quarantined";
  } else if (sticky(claim, { high: LESSON_ACTIVE_VAL, low: LESSON_KEEP_VAL, nowDay }))
    status = "active";
  else if (contradictions && val(claim, nowDay) < 0.45) status = "quarantined";
  return {
    id,
    trigger: {
      files: body.trigger?.files ?? [],
      symbols: body.trigger?.symbols ?? [],
      keywords: body.trigger?.keywords ?? [],
      action: body.trigger?.action || undefined,
    },
    scope: claim.scope?.level ?? "repo",
    whatWentWrong: body.whatWentWrong ?? "",
    correctedBehavior: body.correctedBehavior ?? "",
    evidenceCount: confirms.length,
    contradictionCount: contradictions,
    quarantineReconfirms: 0,
    status,
    createdDay,
    lastConfirmedDay: confirms.length ? Math.max(...confirms.map((e) => e.t ?? 0)) : createdDay,
    halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    // The claim id is the audit pointer back to the ledger (`forge ledger blame <id>`).
    provenance: {
      ...(observed ? { correctionVersion: 2 } : {}),
      ...(body.check ? { check: body.check } : {}),
      ...(body.operatorText ? { operatorText: true } : {}),
      episodes: [
        ...new Set([
          ...(Array.isArray(claim.provenance?.episodes) ? claim.provenance.episodes : []),
          ...evidence.flatMap((e) => {
            const match = /^episode:(.+?)(?:#[nc]\d+)?$/.exec(e.ref);
            return match ? [match[1]] : [];
          }),
        ]),
      ],
      signals: Array.isArray(claim.provenance?.signals) ? claim.provenance.signals : [],
      claim: claim.id,
    },
  };
}

/** Every lesson claim of the repo ledger, mapped to legacy shape. [] when there is no
 *  ledger or it is unreadable (best-effort — hooks call this on every event). */
export function ledgerLessons(root, nowDay = 0, candidates = undefined) {
  try {
    if (!candidates && !existsSync(repoLedger(root))) return [];
    return (candidates ?? loadClaims(repoLedger(root)))
      .filter((c) => c.kind === "lesson")
      .map((c) => claimToLesson(c, nowDay, root));
  } catch {
    return [];
  }
}

// Within the ledger, two claims can map to one legacy id (a distillation supersedes its
// template claim; both carry the same provenance.task). Prefer the live one, then the
// most recently confirmed; ties keep the first in claim-id order (loadClaims is sorted),
// so the pick is deterministic across replicas.
const preferred = (a, b) => {
  if ((a.status === "retired") !== (b.status === "retired")) return a.status === "retired" ? b : a;
  return b.lastConfirmedDay > a.lastConfirmedDay ? b : a;
};

/** Materialize one current claim per lesson ID after a rewrite or a merge. */
export function mergedLessons(root, nowDay = 0, candidates = undefined) {
  const byId = new Map();
  for (const l of ledgerLessons(root, nowDay, candidates)) {
    const prev = byId.get(l.id);
    byId.set(l.id, prev ? preferred(prev, l) : l);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Live (non-tombstoned) `fact` claims of one ledger as {slug, name, text} — the fact
 *  counterpart of ledgerLessons. Best-effort: [] when the ledger is missing/corrupt. */
export function ledgerFacts(dir) {
  try {
    return loadClaims(dir)
      .filter((c) => c.kind === "fact" && !c.tombstone)
      .map((c) => ({
        slug: slug(c.body?.name ?? "") || "fact",
        name: String(c.body?.name ?? ""),
        text: String(c.body?.text ?? ""),
      }));
  } catch {
    return [];
  }
}

/** Deterministic multi-value register for independent same-name edits. Retain every
 * distinct live value until a human chooses one with forge remember. */
export function factConflicts(dir) {
  const groups = new Map();
  for (const f of ledgerFacts(dir)) {
    if (!groups.has(f.slug)) groups.set(f.slug, new Map());
    groups.get(f.slug).set(JSON.stringify([f.name, f.text]), f);
  }
  return new Map(
    [...groups]
      .filter(([, values]) => values.size > 1)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, values]) => [
        name,
        [...values.values()].sort(
          (a, b) => a.text.localeCompare(b.text) || a.name.localeCompare(b.name),
        ),
      ]),
  );
}

/** Slugs of fact claims the evidence has SUNK below the dormancy floor — facts the ledger no
 *  longer believes. The claim is kept (audit), but a consumer that BROADCASTS facts (the
 *  brain index inlined into AGENTS.md, read by every other tool) must stop publishing them:
 *  a fact contradicted by three CI runs was still shipped verbatim, because the index never
 *  asked the ledger what it was worth. Best-effort: empty on any failure.
 *  @param {string} dir
 *  @param {number} [nowDay]
 *  @returns {Set<string>} */
export function dormantFactSlugs(dir, nowDay = 0) {
  try {
    return new Set(
      loadClaims(dir)
        .filter((c) => c.kind === "fact" && !c.tombstone && isDormant(c, nowDay))
        .map((c) => slug(c.body?.name ?? "") || "fact"),
    );
  } catch {
    return new Set();
  }
}

/**
 * Merged fact slugs for a file store + its ledger: the file store's slugs win on
 * collision (a stored file is the canonical local value; shadowFact tombstones stale
 * same-name claims, so a surviving collision means the file is newer). Sorted, unique.
 * @param {string[]} fileSlugs slugs of the file-backed facts (already the store's truth)
 * @param {string} dir the ledger directory that shadows this store
 * @returns {string[]}
 */
export function mergeFactSlugs(fileSlugs, dir) {
  const seen = new Set(fileSlugs);
  for (const f of ledgerFacts(dir)) seen.add(f.slug);
  for (const key of factConflicts(dir).keys()) seen.delete(key);
  return [...seen].sort();
}

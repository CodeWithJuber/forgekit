// forge ledger read — the P2 read-path flip (docs/plans/substrate-v2/01-pcm-protocol.md §7).
// Since P1 the PCM ledger has been the convergent WRITE store while the legacy stores
// (lessons/*.md, recall/brain facts) served every read. This module turns reads into a
// MERGED VIEW (legacy ∪ ledger) so knowledge that arrives via `forge ledger merge`
// actually reaches injection and retrieval. The legacy file is still the canonical
// LOCAL state — the ledger only ADDS what teammates know — so the merge dedupes by the
// legacy id with the legacy record winning. Retiring the legacy formats entirely is the
// next step (ROADMAP.md).
//
// Everything here is READ-ONLY and best-effort by design: hooks call these on every
// session start / pre-edit, so a missing or corrupt ledger degrades to legacy-only —
// never an error, never a write.
import { DEFAULT_HALF_LIFE_DAYS, val, validOutcome } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { load } from "./lessons_store.js";
import { slug } from "./util.js";

/**
 * Map a ledger `lesson` claim onto the legacy lesson shape (lessons.js), so every
 * existing consumer — matchScore, selectForInjection, confidenceOf, summary — can rank
 * a teammate's claim without knowing the ledger exists. Inverse-ish of
 * ledger_bridge.lessonClaim: body carries trigger/whatWentWrong/correctedBehavior, and
 * the legacy lesson id rides in provenance.task (it is excluded from the content
 * address so teammates converge on one claim id).
 *
 * The legacy lifecycle (candidate/active/quarantined/retired) is local mutable state
 * the ledger deliberately does not store, so status is DERIVED from evidence:
 *
 * | claim state                          | derived status | rationale |
 * |--------------------------------------|----------------|-----------|
 * | tombstoned                           | "retired"      | a retraction is the ledger's retirement |
 * | val(claim, nowDay) ≥ 0.6             | "active"       | one fresh confirm (bridge oracle w=0.5 → val 0.6) clears it — mirrors confirm()'s promote-on-recurrence |
 * | val < 0.45 and ≥ 1 contradiction     | "quarantined"  | net-negative outcome evidence — mirrors contradict()'s demotion |
 * | otherwise                            | "candidate"    | a fresh claim sits at the 0.5 prior, exactly newLesson() |
 *
 * Count/date fields are rebuilt from the evidence log: evidenceCount = valid confirm
 * outcomes, contradictionCount = valid contradict outcomes, lastConfirmedDay = latest
 * confirm t (else the mint day), createdDay = the mint day (provenance.t).
 * @param {any} claim a materialized lesson claim (ledger_store.loadClaims view)
 * @param {number} [nowDay] epoch day used for the val() decay clock
 * @returns {object} a legacy-shaped lesson
 */
export function claimToLesson(claim, nowDay = 0) {
  const body = claim.body ?? {};
  const evidence = (claim.evidence ?? []).filter(validOutcome);
  const confirms = evidence.filter((e) => e.result === "confirm");
  const contradictions = evidence.length - confirms.length;
  const createdDay = claim.provenance?.t ?? 0;
  const v = val(claim, nowDay);
  const status = claim.tombstone
    ? "retired"
    : v >= 0.6
      ? "active"
      : v < 0.45 && contradictions >= 1
        ? "quarantined"
        : "candidate";
  return {
    id: String(claim.provenance?.task || "") || `lsn_${claim.id.slice(0, 8)}`,
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
    provenance: { episodes: [], signals: [], claim: claim.id },
  };
}

/** Every lesson claim of the repo ledger, mapped to legacy shape. [] when there is no
 *  ledger or it is unreadable (best-effort — hooks call this on every event). */
export function ledgerLessons(root, nowDay = 0) {
  try {
    return loadClaims(repoLedger(root))
      .filter((c) => c.kind === "lesson")
      .map((c) => claimToLesson(c, nowDay));
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

/**
 * The merged lesson read: legacy `load(root)` ∪ ledger lessons, deduped by the LEGACY
 * id with the legacy file winning — the legacy store is still the canonical local
 * state (recordMistake/confirm/contradict edit it), so a local lesson's own shadow
 * claim (same provenance.task) is invisible here, while a teammate's claim (different
 * task, no local file) surfaces. Order is deterministic: legacy lessons in file order,
 * then ledger-only lessons sorted by lesson id.
 * @param {string} root
 * @param {number} [nowDay]
 * @returns {object[]}
 */
export function mergedLessons(root, nowDay = 0) {
  const legacy = load(root);
  const local = new Set(legacy.map((l) => l.id));
  const byId = new Map();
  for (const l of ledgerLessons(root, nowDay)) {
    if (local.has(l.id)) continue; // legacy wins — the local file is canonical
    const prev = byId.get(l.id);
    byId.set(l.id, prev ? preferred(prev, l) : l);
  }
  return [...legacy, ...[...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))];
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
  return [...seen].sort();
}

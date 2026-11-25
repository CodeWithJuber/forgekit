// Turn observed corrections into private proposals, and corroborated proposals into ledger evidence.
import { trustedCorrectionOutcome } from "./correction_receipt.js";
import { pendingCorrections, withCorrection } from "./cortex_observations.js";

export { pendingCorrections } from "./cortex_observations.js";

import {
  equivalentLesson,
  lessonClaim,
  recordLessonEvent,
  supersedeLessonClaim,
} from "./ledger_bridge.js";
import { mergedLessons } from "./ledger_read.js";
import { readEvidence, recordUse, repoLedger } from "./ledger_store.js";
import {
  confidenceOf,
  matchScore,
  newLesson,
  SIGNALS,
  scoreMistake,
  selectForInjection,
} from "./lessons.js";
import { lessonIsSafe } from "./lessons_store.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { contentHash, slug } from "./util.js";

const sorted = (values = []) =>
  [...new Set(values.filter((v) => typeof v === "string" && v))].sort();
const lessonIdFor = (ctx) => {
  const locations = [sorted(ctx.files), sorted(ctx.symbols), ctx.check ?? ""];
  const label = slug(locations[1][0] || locations[0][0]) || "correction";
  return `lsn_${label.slice(0, 48)}_${contentHash(JSON.stringify(locations)).slice(0, 16)}`;
};

/** Two contexts overlap if they share any file or symbol. */
const overlaps = (a, b) => {
  const files = new Set(a.files ?? []);
  const symbols = new Set(a.symbols ?? []);
  return (b.files ?? []).some((f) => files.has(f)) || (b.symbols ?? []).some((s) => symbols.has(s));
};

/** Lessons whose trigger overlaps the current context, in the given lifecycle states. */
export function matchingLessons(
  lessons,
  context,
  statuses = ["active", "candidate", "quarantined"],
) {
  return lessons.filter((l) => statuses.includes(l.status) && matchScore(l, context) > 0);
}

// Stable evidence references make retries and cross-checkout ledger merges idempotent.
const receiptKey = (kind, id) => contentHash(JSON.stringify([kind, id]));
const validReceipt = (id) => typeof id === "string" && /^[a-zA-Z0-9_.-]{1,160}$/.test(id);
function propose(id, context, observed, episodeId, nowDay, distilled) {
  const location = context.symbols?.[0] || context.files?.[0];
  const descriptions = observed.signals
    .filter((s) => SIGNALS[s].family !== "inferred")
    .map((s) => SIGNALS[s].label);
  return newLesson(
    {
      id,
      scope: context.symbols?.length ? "symbol" : "repo",
      trigger: {
        files: sorted(context.files),
        symbols: sorted(context.symbols),
        keywords: sorted(context.keywords),
        action: "edit",
      },
      whatWentWrong:
        distilled?.whatWentWrong ?? `At \`${location}\`, ${descriptions.join(" and ")}.`,
      correctedBehavior:
        distilled?.correctedBehavior ??
        `Review the previous correction when editing \`${location}\`.`,
      provenance: {
        correctionVersion: 2,
        ...(distilled ? { operatorText: true } : {}),
        episodes: [episodeId],
        signals: observed.signals,
        ...(context.check ? { check: context.check } : {}),
      },
    },
    nowDay,
  );
}

// If a process stopped between writing the ledger and replacing its private file, retrying
// finds the same receipt, even on a later day. A retired or superseded claim stays retired.
function publishReceipt(root, lesson, nowDay, result, oracle, ref) {
  const known = mergedLessons(root, nowDay).find((l) => l.id === lesson.id);
  const version2 = lesson.provenance?.correctionVersion === 2;
  if (known) {
    const same = version2
      ? known.provenance.claim === lessonClaim(lesson).claim?.id
      : equivalentLesson(known, lesson);
    if (known.status === "retired" || !same) return null;
  }
  const evidence = known ? readEvidence(repoLedger(root), known.provenance.claim) : [];
  const alreadyRecorded = evidence.some(
    (e) =>
      e.oracle === oracle &&
      e.result === result &&
      e.ref === ref &&
      (!version2 || trustedCorrectionOutcome(root, known.provenance.claim, lesson.id, e)),
  );
  if (!alreadyRecorded) {
    if (
      !lessonIsSafe(lesson) ||
      !recordLessonEvent(root, lesson, { t: nowDay, result, oracle, ref }).ok
    )
      return null;
  }
  return mergedLessons(root, nowDay).find((l) => l.id === lesson.id);
}

/** The first supported episode proposes a lesson locally. Another distinct recovery in
 * the same context, or the operator confirming the specific text, can publish it. */
export function recordMistake(
  root,
  { signals, context, nowDay, episodeId, distilled = undefined },
) {
  root = sourceWorkspaceRoot(root);
  const observed = scoreMistake(signals);
  if (
    !observed.fires ||
    !validReceipt(episodeId) ||
    !Number.isSafeInteger(nowDay) ||
    (!context?.files?.length && !context?.symbols?.length)
  )
    return { action: "abstained", observed };
  const id = lessonIdFor(context);
  const proposed = propose(id, context, observed, episodeId, nowDay, distilled);
  if (!lessonIsSafe(proposed)) return { action: "refused", observed };
  return withCorrection(root, id, (row) => {
    const key = receiptKey("mistake", episodeId);
    const observation = {
      day: nowDay,
      signals: observed.signals,
      ...(context.versions ? { versions: context.versions } : {}),
    };
    if (row.observations[key]) return { action: "duplicate", id, observed };
    const shared = mergedLessons(root, nowDay).find((l) => l.id === id);
    if (shared?.status === "retired" || (row.published && !shared))
      return { action: "abstained", id, observed };
    const needsLocalEvidence =
      shared?.provenance.correctionVersion === 2 && shared.status === "candidate";
    if (!row.lesson && (!shared || needsLocalEvidence)) {
      row.lesson = proposed;
      row.needsReview = Boolean(distilled);
      row.observations[key] = observation;
      return { action: "created", id, status: "candidate", visibility: "private", observed };
    }
    if (row.needsReview) {
      row.observations[key] = observation;
      return { action: "pending-review", id, status: "candidate", visibility: "private", observed };
    }
    const lesson = needsLocalEvidence ? row.lesson : (shared ?? row.lesson);
    if (lesson.provenance.episodes.includes(episodeId)) {
      if (shared?.status === "active") row.published = true;
      return { action: "duplicate", id, observed };
    }
    if (lesson.provenance.operatorText) {
      row.observations[key] = observation;
      return { action: "observed", id, status: lesson.status, observed };
    }
    const published = publishReceipt(
      root,
      lesson,
      nowDay,
      "confirm",
      "cortex.episode",
      `episode:${episodeId}`,
    );
    if (!published) return { action: "refused", id, observed };
    row.published = true;
    row.observations[key] = observation;
    return { action: "confirmed", id, status: published.status, visibility: "project", observed };
  });
}

function ratifyCorrection(root, lesson, nowDay) {
  const receipt = receiptKey("operator-confirmation", [
    lesson.id,
    lesson.whatWentWrong,
    lesson.correctedBehavior,
  ]);
  const published = publishReceipt(
    root,
    lesson,
    nowDay,
    "confirm",
    "human.accept",
    `human:operator@${receipt}`,
  );
  return published
    ? {
        ok: true,
        action: "confirmed",
        id: lesson.id,
        status: published.status,
        visibility: "project",
      }
    : { ok: false, reason: "The reviewed correction could not be published" };
}

export function confirmCorrection(root, id, nowDay) {
  root = sourceWorkspaceRoot(root);
  if (/^[0-9a-f]{64}$/.test(id)) {
    const shared = mergedLessons(root, nowDay).find((l) => l.provenance.claim === id);
    if (shared?.provenance.correctionVersion !== 2 || shared.status === "retired")
      return { ok: false, reason: "No current v2 correction with that claim ID" };
    if (shared.status === "active") return { ok: true, action: "already-published", id: shared.id };
    return withCorrection(root, shared.id, () => ratifyCorrection(root, shared, nowDay));
  }
  if (!pendingCorrections(root).some((l) => l.id === id)) {
    const shared = mergedLessons(root, nowDay).find((l) => l.id === id);
    if (shared?.provenance.correctionVersion === 2 && shared.status === "active")
      return { ok: true, action: "already-published", id };
    return { ok: false, reason: "No pending correction with that ID in this checkout" };
  }
  return withCorrection(root, id, (row) => {
    if (row.published) return { ok: true, action: "already-published", id };
    const lesson = row.lesson;
    if (row.previousClaim) {
      const current = mergedLessons(root, nowDay).find((l) => l.id === id);
      if (!current || current.status === "retired")
        return { ok: false, reason: "The reviewed parent was retired" };
      if (current.provenance.claim === row.previousClaim) {
        lesson.createdDay = nowDay;
        if (!supersedeLessonClaim(root, current, lesson, nowDay).ok)
          return { ok: false, reason: "The reviewed revision could not supersede its parent" };
      } else if (!equivalentLesson(current, lesson)) {
        return {
          ok: false,
          reason: "The published lesson changed; review the new parent before confirming",
        };
      }
    }
    const result = ratifyCorrection(root, lesson, nowDay);
    if (!result.ok) return result;
    row.needsReview = false;
    row.published = true;
    delete row.previousClaim;
    return result;
  });
}

/** Only an observed reversal on a matching target contributes contradictory evidence. */
export function recordContradiction(root, { context, nowDay, episodeId }) {
  root = sourceWorkspaceRoot(root);
  if (!validReceipt(episodeId) || !Number.isSafeInteger(nowDay))
    return { action: "abstained", results: [] };
  const targets = mergedLessons(root, nowDay).filter(
    (l) => ["active", "quarantined"].includes(l.status) && overlaps(l.trigger, context),
  );
  const results = targets.map((lesson) =>
    withCorrection(root, lesson.id, (row) => {
      const key = receiptKey("contradict", episodeId);
      if (context.reversedVersions) {
        const matched = lesson.trigger.files.some(
          (file) =>
            context.reversedVersions[file] &&
            Object.values(row.observations).some((e) =>
              e.versions?.includes(context.reversedVersions[file]),
            ),
        );
        if (!matched) return null;
      }
      if (row.observations[key])
        return { id: lesson.id, status: lesson.status, saved: false, duplicate: true };
      const published = publishReceipt(
        root,
        lesson,
        nowDay,
        "contradict",
        "cortex.episode",
        `episode:${episodeId}`,
      );
      if (!published) return { id: lesson.id, status: lesson.status, saved: false };
      row.observations[key] = { day: nowDay, signals: ["S4"] };
      return { id: lesson.id, status: published.status, saved: true };
    }),
  );
  const attributed = results.filter(Boolean);
  return { action: attributed.length ? "contradicted" : "abstained", results: attributed };
}

/** The injection block for the current context — what a SessionStart/PreToolUse hook emits.
 *  Reads the MERGED view (P2 read flip): teammate lessons that arrived via
 *  `forge ledger merge` inject alongside local ones. */
export function lessonsForContext(root, context, opts = {}) {
  root = sourceWorkspaceRoot(root);
  return selectForInjection(mergedLessons(root, opts.nowDay ?? 0), context, opts);
}

/** Log that these lessons were served (ledger retention learns from it). Only lessons
 *  backed by a ledger claim have an id to log; best-effort, never throws.
 *  @param {string} root
 *  @param {{provenance?: {claim?: string}}[]} lessons
 *  @param {{via: string, t: number}} opts */
export function recordServedLessons(root, lessons, { via, t }) {
  recordUse(
    repoLedger(root),
    lessons.map((l) => l?.provenance?.claim).filter((id) => typeof id === "string"),
    { via, t },
  );
}

/** Repo-wide top active lessons — what a SessionStart hook injects (no file context yet).
 *  Merged view: a teammate's outcome-confirmed lesson surfaces here too. `record` logs the
 *  shown lessons as served; only the hook sets it (AGENTS.md emission is not a use).
 *  @param {string} root
 *  @param {number} [nowDay]
 *  @param {number} [budget]
 *  @param {{record?: boolean}} [opts] */
export function startupBlock(root, nowDay = 0, budget = 8, { record = false } = {}) {
  root = sourceWorkspaceRoot(root);
  const active = mergedLessons(root, nowDay).filter((l) => l.status === "active");
  if (!active.length) return "";
  const ranked = active
    .map((l) => ({ lesson: l, conf: confidenceOf(l, nowDay) }))
    .sort(
      (a, b) =>
        b.conf - a.conf ||
        b.lesson.evidenceCount - a.lesson.evidenceCount ||
        b.lesson.lastConfirmedDay - a.lesson.lastConfirmedDay ||
        a.lesson.id.localeCompare(b.lesson.id),
    );
  const shown = ranked.slice(0, budget);
  if (record)
    recordServedLessons(
      root,
      shown.map((x) => x.lesson),
      { via: "session-start", t: nowDay },
    );
  const rows = shown.map((x) =>
    `- **${x.lesson.id}** — ${x.lesson.correctedBehavior}`.slice(0, 200),
  );
  const overflow = active.length - shown.length;
  if (overflow > 0) rows.push(`- _(+${overflow} more active lessons — run \`forge cortex\`)_`);
  return [
    "## Lessons learned on this repo (Forge Cortex)",
    "Background context from past corrections on this repo — verify before acting, don't blindly obey.",
    "",
    ...rows,
    "",
  ].join("\n");
}

/** Replace a lesson's body with a model-distilled version (false if not found or the save was
 *  refused — e.g. the distilled text tripped secret-refusal). */
export function applyDistillation(root, lessonId, distilled) {
  root = sourceWorkspaceRoot(root);
  if (!distilled) return false;
  const lesson = mergedLessons(root, 0).find((l) => l.id === lessonId);
  if (
    lesson?.provenance.correctionVersion === 2 ||
    pendingCorrections(root).some((l) => l.id === lessonId)
  ) {
    return withCorrection(root, lessonId, (row) => {
      const shared = mergedLessons(root, 0).find((l) => l.id === lessonId);
      if (shared?.status === "retired" || (row.published && !shared)) return false;
      const before = (!row.published && row.lesson) || shared;
      if (!before) return false;
      const updated = {
        ...before,
        whatWentWrong: distilled.whatWentWrong,
        correctedBehavior: distilled.correctedBehavior,
      };
      if (!lessonIsSafe(updated)) return false;
      if (equivalentLesson(before, updated)) {
        if (shared && row.published) return true;
      } else {
        row.needsReview = true;
        updated.provenance = { ...updated.provenance, operatorText: true };
      }
      if (shared) {
        row.previousClaim = shared.provenance.claim;
        row.published = false;
        updated.status = "candidate";
        updated.evidenceCount = 0;
        updated.contradictionCount = 0;
        updated.provenance = { ...updated.provenance, episodes: [] };
      }
      row.lesson = updated;
      return true;
    });
  }
  if (!lesson) return false;
  const rewritten = {
    ...lesson,
    whatWentWrong: distilled.whatWentWrong,
    correctedBehavior: distilled.correctedBehavior,
  };
  // A model rewrite is a PROPOSAL (review F07): unless it is equivalent by the narrow rule
  // (same words in the same order, up to a sentence's capital and its punctuation — no semantic conflict), the lesson's earned
  // standing does not carry over to the new wording — it restarts as a candidate that has to
  // earn its own confirmations. What it earned before stays inspectable in provenance and on
  // the ledger's superseded parent claim.
  const hadEvidence =
    (lesson.evidenceCount ?? 0) > 0 ||
    (lesson.contradictionCount ?? 0) > 0 ||
    lesson.status === "active";
  const updated =
    equivalentLesson(lesson, rewritten) || !hadEvidence
      ? rewritten
      : {
          ...rewritten,
          status: "candidate",
          evidenceCount: 0,
          contradictionCount: 0,
          quarantineReconfirms: 0,
          lastConfirmedDay: lesson.createdDay ?? lesson.lastConfirmedDay,
          provenance: {
            ...(lesson.provenance ?? {}),
            rewrittenFrom: {
              whatWentWrong: lesson.whatWentWrong,
              correctedBehavior: lesson.correctedBehavior,
              status: lesson.status,
              evidenceCount: lesson.evidenceCount ?? 0,
              contradictionCount: lesson.contradictionCount ?? 0,
            },
          },
        };
  return lessonIsSafe(updated) && supersedeLessonClaim(root, lesson, updated).ok;
}

/** The lessons block to inline into AGENTS.md so non-Claude tools see them (empty if none). */
export function cortexBlock(targetRoot = process.cwd()) {
  return startupBlock(targetRoot, Math.floor(Date.now() / 86400000));
}

/** Auditable snapshot for `forge cortex status` — merged view, like every read surface. */
export function summary(root, nowDay = 0, { includePrivate = false } = {}) {
  root = sourceWorkspaceRoot(root);
  const lessons = mergedLessons(root, nowDay);
  const by = (s) => lessons.filter((l) => l.status === s).length;
  return {
    total: lessons.length,
    active: by("active"),
    candidate: by("candidate"),
    ...(includePrivate ? { provisional: pendingCorrections(root).length } : {}),
    quarantined: by("quarantined"),
    retired: by("retired"),
    topActive: lessons
      .filter((l) => l.status === "active")
      .map((l) => ({
        id: l.id,
        confidence: Number(confidenceOf(l, nowDay).toFixed(2)),
        confirmed: l.evidenceCount,
        contradicted: l.contradictionCount,
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10),
  };
}

// forge cortex — orchestration that ties the pure core (lessons.js) to storage
// (lessons_store.js). This is what the hooks (Layer 0) call: a scored signal-cluster
// becomes a created/confirmed lesson; an independent human reversal becomes a
// contradiction. Kept fs-thin and deterministic (day + ids passed in) so it's testable
// without any hook wiring.

import { recordLessonEvent, supersedeLessonClaim } from "./ledger_bridge.js";
import { ledgerLessons, mergedLessons } from "./ledger_read.js";
import {
  confidenceOf,
  confirm,
  contradict,
  matchScore,
  newLesson,
  scoreMistake,
  selectForInjection,
} from "./lessons.js";
import { appendEpisode, load, readEpisodes, save } from "./lessons_store.js";
import { ledgerOnly, slug } from "./util.js";

// The lesson set the confirm-vs-create dedup compares against. Normally the legacy
// files (canonical local state); under FORGE_LEDGER_ONLY there are none, so the ledger's
// own materialized lessons (same legacy ids via provenance.task) are the dedup source —
// a recurring local mistake then appends confirm evidence to its existing claim instead
// of minting a duplicate.
const localLessons = (root, nowDay) => (ledgerOnly() ? ledgerLessons(root, nowDay) : load(root));

const lessonIdFor = (ctx) => `lsn_${slug(ctx.symbols?.[0] || ctx.files?.[0] || "ctx") || "ctx"}`;

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

// Deterministic fallback when no LLM distiller ran (the Stop-hook distiller replaces this).
function templateDistill(context) {
  const sym = context.symbols?.[0];
  const where = sym ? `\`${sym}\`` : context.files?.[0] ? `\`${context.files[0]}\`` : "this code";
  return {
    whatWentWrong: `An edit to ${where} was corrected (repeated / reverted / broke a check).`,
    correctedBehavior: sym
      ? `Before editing ${where}, check its callers and tests first.`
      : `Slow down on ${where}: re-read and check impact before editing.`,
  };
}

/**
 * Record a correction episode. If the signals clear the mistake bar, create a new
 * candidate lesson (first occurrence) or confirm the matching one (a recurrence — the
 * only thing that promotes a lesson toward `active`). Always logs the episode.
 * @param {string} root
 * @param {{signals:{signal:string}[], context:object, nowDay:number, episodeId:string, distilled?:{whatWentWrong:string, correctedBehavior:string}}} opts
 * @returns {{action:string, id?:string, status?:string, p:number, fires:boolean}}
 */
export function recordMistake(root, { signals, context, nowDay, episodeId, distilled }) {
  const { p, fires } = scoreMistake(signals);
  // A weak-but-firing episode (0.4–0.7) only earns a lesson if the same context already
  // misfired before — recurrence, not a single shot. Check BEFORE logging this episode.
  const recurredWeak = readEpisodes(root).some(
    (e) => e.kind === "mistake" && overlaps(e.context ?? {}, context),
  );
  appendEpisode(root, {
    id: episodeId,
    kind: "mistake",
    signals: signals.map((s) => s.signal),
    p,
    context,
    day: nowDay,
  });
  const strong = fires && p >= 0.7;
  const accumulated = fires && p >= 0.4 && recurredWeak;
  if (!strong && !accumulated) return { action: "logged", p, fires };

  // Deliberately LEGACY-ONLY (not mergedLessons): this lookup decides confirm-vs-create
  // for a LOCAL write. A teammate's merged ledger claim has no local file, and letting it
  // match would swallow a fresh local mistake into confirm() — which edits a legacy file
  // that doesn't exist — and hang the shadow evidence ref (#n<count>) off counters this
  // repo never owned. Creating locally is correct AND convergent: the new lesson's shadow
  // claim content-addresses to the teammate's claim, so both sides' evidence lands on ONE
  // claim at the next `forge ledger merge`.
  const existing = matchingLessons(localLessons(root, nowDay), context)[0];
  if (existing) {
    const c = confirm(existing, nowDay);
    const updated = {
      ...c,
      provenance: {
        ...c.provenance,
        episodes: [...(c.provenance?.episodes ?? []), episodeId],
      },
    };
    if (!save(root, updated).ok) return { action: "refused", p, fires };
    // Shadow the confirmation into the PCM ledger (best-effort by design, never blocks
    // the hook — reads are merged via ledger_read.js since P2). The evidence counter
    // rides in the ref because episode ids reset per session (ep_m0_…) — without it,
    // two same-day sessions confirming via the same file would hash identically and
    // the second real confirmation would be silently deduped away.
    recordLessonEvent(root, updated, {
      result: "confirm",
      ref: `episode:${episodeId}#n${updated.evidenceCount}`,
      t: nowDay,
    });
    return {
      action: "confirmed",
      id: updated.id,
      status: updated.status,
      p,
      fires,
    };
  }

  const d = distilled ?? templateDistill(context);
  const lesson = newLesson(
    {
      id: lessonIdFor(context),
      trigger: {
        symbols: context.symbols ?? [],
        files: context.files ?? [],
        keywords: context.keywords ?? [],
        action: "edit",
      },
      scope: context.symbols?.length ? "symbol" : "repo",
      whatWentWrong: d.whatWentWrong,
      correctedBehavior: d.correctedBehavior,
      provenance: {
        episodes: [episodeId],
        signals: signals.map((s) => s.signal),
      },
    },
    nowDay,
  );
  // Report "created" only when the write actually landed — a refused save (e.g. secret-bearing
  // body) must not make the hook believe a lesson exists and try to distill a phantom.
  if (!save(root, lesson).ok) return { action: "refused", p, fires };
  // Mint-only shadow: a freshly created lesson has zero evidence (creation is not
  // confirmation — the ledger's val starts at the 0.5 prior, same as newLesson).
  recordLessonEvent(root, lesson, { t: nowDay });
  return { action: "created", id: lesson.id, status: lesson.status, p, fires };
}

/**
 * An independent human reversal (e.g. `git revert` of what a lesson advised) contradicts
 * every matching active/quarantined lesson — the anti-self-reinforcement path.
 */
export function recordContradiction(root, { context, nowDay, episodeId }) {
  appendEpisode(root, {
    id: episodeId,
    kind: "contradiction",
    context,
    day: nowDay,
  });
  // Legacy-only for the same reason as recordMistake: contradict() saves the legacy
  // file, so only lessons that HAVE one are targets. A teammate's claim still converges
  // — the same reversal, recurring locally, mints the local twin whose evidence merges.
  const targets = matchingLessons(localLessons(root, nowDay), context, ["active", "quarantined"]);
  const results = targets.map((l) => {
    const updated = contradict(l, nowDay);
    const saved = save(root, updated).ok;
    // Shadowed at the conservative bridge weight, NOT human.revert (w=1.0): the hook's
    // revert detection is regex-based and matches routine `git restore`s, and a
    // full-weight contradiction would permanently anchor the claim near dormancy in an
    // append-only log. The counter in the ref keeps distinct same-day events distinct.
    if (saved)
      recordLessonEvent(root, updated, {
        result: "contradict",
        ref: `episode:${episodeId}#c${updated.contradictionCount}`,
        t: nowDay,
      });
    return { id: updated.id, status: updated.status, saved };
  });
  return { action: "contradicted", results };
}

/** The injection block for the current context — what a SessionStart/PreToolUse hook emits.
 *  Reads the MERGED view (P2 read flip): teammate lessons that arrived via
 *  `forge ledger merge` inject alongside local ones. */
export function lessonsForContext(root, context, opts = {}) {
  return selectForInjection(mergedLessons(root, opts.nowDay ?? 0), context, opts);
}

/** Repo-wide top active lessons — what a SessionStart hook injects (no file context yet).
 *  Merged view: a teammate's outcome-confirmed lesson surfaces here too. */
export function startupBlock(root, nowDay = 0, budget = 8) {
  const active = mergedLessons(root, nowDay).filter((l) => l.status === "active");
  if (!active.length) return "";
  const ranked = active
    .map((l) => ({ lesson: l, conf: confidenceOf(l, nowDay) }))
    .sort((a, b) => b.conf - a.conf);
  const shown = ranked.slice(0, budget);
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
  if (!distilled) return false;
  // Normally EDITS the legacy file, so read the file-backed lessons; under
  // FORGE_LEDGER_ONLY there are none, so resolve the target from the ledger and let the
  // supersede below rewrite it there (save() is a ledger-only no-op that still succeeds).
  const lesson = localLessons(root, 0).find((l) => l.id === lessonId);
  if (!lesson) return false;
  const updated = {
    ...lesson,
    whatWentWrong: distilled.whatWentWrong,
    correctedBehavior: distilled.correctedBehavior,
  };
  const ok = save(root, updated).ok;
  // A body rewrite changes the content-addressed claim id — supersede in the ledger
  // (mint the distilled claim, carry the evidence over, tombstone the template claim)
  // or the lesson's history splits across two disjoint claims.
  if (ok) supersedeLessonClaim(root, lesson, updated);
  return ok;
}

/** The lessons block to inline into AGENTS.md so non-Claude tools see them (empty if none). */
export function cortexBlock(targetRoot = process.cwd()) {
  return startupBlock(targetRoot, Math.floor(Date.now() / 86400000));
}

/** Auditable snapshot for `forge cortex status` — merged view, like every read surface. */
export function summary(root, nowDay = 0) {
  const lessons = mergedLessons(root, nowDay);
  const by = (s) => lessons.filter((l) => l.status === s).length;
  return {
    total: lessons.length,
    active: by("active"),
    candidate: by("candidate"),
    quarantined: by("quarantined"),
    retired: by("retired"),
    topActive: lessons
      .filter((l) => l.status === "active")
      .map((l) => ({
        id: l.id,
        confidence: Number(confidenceOf(l, nowDay).toFixed(2)),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10),
  };
}

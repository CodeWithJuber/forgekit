// forge cortex — orchestration that ties the pure core (lessons.js) to storage
// (lessons_store.js). This is what the hooks (Layer 0) call: a scored signal-cluster
// becomes a created/confirmed lesson; an independent human reversal becomes a
// contradiction. Kept fs-thin and deterministic (day + ids passed in) so it's testable
// without any hook wiring.
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
import { slug } from "./util.js";

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

  const existing = matchingLessons(load(root), context)[0];
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
  const targets = matchingLessons(load(root), context, ["active", "quarantined"]);
  const results = targets.map((l) => {
    const updated = contradict(l, nowDay);
    const saved = save(root, updated).ok;
    return { id: updated.id, status: updated.status, saved };
  });
  return { action: "contradicted", results };
}

/** The injection block for the current context — what a SessionStart/PreToolUse hook emits. */
export function lessonsForContext(root, context, opts = {}) {
  return selectForInjection(load(root), context, opts);
}

/** Repo-wide top active lessons — what a SessionStart hook injects (no file context yet). */
export function startupBlock(root, nowDay = 0, budget = 8) {
  const active = load(root).filter((l) => l.status === "active");
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
  const lesson = load(root).find((l) => l.id === lessonId);
  if (!lesson) return false;
  return save(root, {
    ...lesson,
    whatWentWrong: distilled.whatWentWrong,
    correctedBehavior: distilled.correctedBehavior,
  }).ok;
}

/** The lessons block to inline into AGENTS.md so non-Claude tools see them (empty if none). */
export function cortexBlock(targetRoot = process.cwd()) {
  return startupBlock(targetRoot, Math.floor(Date.now() / 86400000));
}

/** Auditable snapshot for `forge cortex status`. */
export function summary(root, nowDay = 0) {
  const lessons = load(root);
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

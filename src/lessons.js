// forge lessons — the self-correcting core. PURE logic only (no fs/hooks here, so it's
// fully unit-testable): observed correction sources, versioned lesson lifecycles, and an
// injection selector that never overflows a tool's context cap.
//
// Design invariants (why this isn't just Reflexion):
//  - A lesson is trusted because it keeps being RE-CONFIRMED against fresh outcomes,
//    never because it exists. Injection is NOT confirmation — only the storage/hook
//    layer feeds independent outcome signals in here, never the act of injecting.
//  - A mistake is defined by a BAD OUTCOME, not by "differs from a lesson", so a
//    developer changing their mind retires a lesson instead of fighting it.

// S1–S7 are existing event identifiers. Their source describes what an event
// can attest to. Repetition in one source does not create independent evidence.
export const SIGNALS = Object.freeze({
  S1: { family: "outcome", label: "the same command failed before the edit and later succeeded" },
  S2: { family: "behavioral", label: "the file was edited more than once" },
  S3: { family: "behavioral", label: "the file received repeated edits" },
  S4: { family: "outcome", label: "a change to the file was reverted" },
  S5: { family: "inferred", label: "a possible concern was inferred from wording" },
  S6: { family: "human", label: "a user explicitly recorded a correction" },
  S7: { family: "outcome", label: "a check reported a regression" },
});

import { setOverlap } from "./math.js";

export { SCOPE_WEIGHT } from "./ledger.js";

/** Return observed signals and their distinct sources. A damped legacy event
 * was marked ambiguous. It can remain in an old audit log without contributing proof. */
export function scoreMistake(events) {
  const signals = [
    ...new Set(
      (Array.isArray(events) ? events : [])
        .filter(
          (e) => e && Object.hasOwn(SIGNALS, e.signal) && (e.anti === undefined || e.anti === 1),
        )
        .map((e) => e.signal),
    ),
  ].sort();
  const families = [
    ...new Set(signals.map((s) => SIGNALS[s].family).filter((f) => f !== "inferred")),
  ].sort();
  const explicit = families.includes("human");
  const corroborated = families.includes("outcome") && families.includes("behavioral");
  return { signals, families, explicit, corroborated, fires: explicit || corroborated };
}

export function classify(events) {
  const observation = scoreMistake(events);
  if (observation.fires) return "distill";
  return observation.families.length ? "accumulate" : "discard";
}

/** A fresh lesson candidate. confidence starts at 0.5 (evidence 0, contradiction 0 → α=β=1). */
export function newLesson(fields, nowDay = 0) {
  return {
    id: fields.id,
    trigger: fields.trigger ?? {}, // {files:[glob], symbols:[], action, keywords:[]}
    scope: fields.scope ?? "repo", // symbol | dir | repo | global
    whatWentWrong: fields.whatWentWrong ?? "",
    correctedBehavior: fields.correctedBehavior ?? "",
    evidenceCount: 0,
    contradictionCount: 0,
    quarantineReconfirms: 0,
    status: "candidate", // candidate | active | quarantined | retired
    createdDay: nowDay,
    lastConfirmedDay: nowDay,
    halfLifeDays: fields.halfLifeDays ?? 45,
    provenance: fields.provenance ?? { episodes: [], signals: [] },
  };
}

/**
 * Validity — the paper's `val` term (Eq. retrieve, §7.1). The Laplace-smoothed Beta posterior
 * mean over GROUND-TRUTH outcomes: how much independent evidence upholds this lesson vs.
 * contradicts it, with NO time decay. This is what makes a memory pruned by whether its
 * prediction later held (a test/commit), not by the model's own say-so.
 */
export function validity(lesson) {
  const alpha = 1 + (lesson.evidenceCount ?? 0);
  const beta = 1 + (lesson.contradictionCount ?? 0);
  return alpha / (alpha + beta);
}

/** Freshness — the paper's `rec` term: exponential recency decay since last confirmation. */
export function freshness(lesson, nowDay) {
  const age = Math.max(0, nowDay - lesson.lastConfirmedDay);
  return 0.5 ** (age / lesson.halfLifeDays);
}

/** Observed corrections report the share of independent receipts that confirmed the lesson.
 * Earlier lessons use their historical time-decayed posterior. */
export function confidenceOf(lesson, nowDay) {
  if (lesson.provenance?.correctionVersion === 2) {
    const total = lesson.evidenceCount + lesson.contradictionCount;
    return total ? lesson.evidenceCount / total : 0;
  }
  return freshness(lesson, nowDay) * validity(lesson);
}

/** Historical v1 lifecycle, retained for evaluating pre-receipt lesson records. */
export function confirm(lesson, nowDay) {
  const next = {
    ...lesson,
    evidenceCount: lesson.evidenceCount + 1,
    lastConfirmedDay: nowDay,
  };
  if (lesson.status === "quarantined") {
    const reconfirms = lesson.quarantineReconfirms + 1;
    const back = reconfirms >= 2;
    return {
      ...next,
      quarantineReconfirms: back ? 0 : reconfirms,
      status: back ? "active" : "quarantined",
    };
  }
  return { ...next, status: "active" };
}

/** An independent outcome contradicted this lesson. Contradiction is cheaper than confirmation. */
export function contradict(lesson, nowDay) {
  const next = { ...lesson, contradictionCount: lesson.contradictionCount + 1 };
  if (lesson.status === "quarantined") return { ...next, status: "retired" };
  if (confidenceOf(next, nowDay) < 0.3) return { ...next, status: "quarantined" };
  return next;
}

/** Compile a `*` / `**` glob to an anchored RegExp (no sentinel chars — single pass).
 *  Memoized: matchScore runs per (lesson × file) on every PreToolUse hook, and the
 *  cache is bounded in practice by the distinct trigger globs in the lesson set. */
const GLOB_RE_CACHE = new Map();
export const globToRe = (glob) => {
  let re = GLOB_RE_CACHE.get(glob);
  if (!re) {
    const body = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
    re = new RegExp(`^${body}$`);
    GLOB_RE_CACHE.set(glob, re);
  }
  return re;
};

/** Represent paths by adjacent components, so a shared layout root or extension alone
 * cannot match unrelated files. Prose contributes its observed Unicode word tokens. */
const keywordGrams = (words) => {
  const grams = new Set();
  for (const word of words ?? []) {
    const value = String(word).normalize("NFC").toLowerCase().replaceAll("\\", "/");
    const parts = value.split("/").filter(Boolean);
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) grams.add(JSON.stringify([parts[i - 1], parts[i]]));
    } else if (value.includes(".") && !/\s/.test(value)) grams.add(JSON.stringify([value]));
    else for (const term of value.match(/[\p{L}\p{N}]+/gu) ?? []) grams.add(term);
  }
  return grams;
};

/** Fraction of a recorded trigger matched on the best available channel. */
export function matchScore(lesson, context) {
  const t = lesson.trigger;
  const matches = [];
  const symbols = new Set(context.symbols ?? []);
  if (symbols.size)
    matches.push(
      (t.symbols ?? []).filter((s) => symbols.has(s)).length / Math.max(1, t.symbols?.length ?? 0),
    );
  if (context.files?.length)
    matches.push(
      (t.files ?? []).filter((g) => context.files.some((f) => globToRe(g).test(f))).length /
        Math.max(1, t.files?.length ?? 0),
    );
  if (context.keywords?.length)
    matches.push(setOverlap(keywordGrams(t.keywords), keywordGrams(context.keywords)));
  return Math.max(0, ...matches);
}

/**
 * Select the lessons worth injecting for the current files/symbols — relevance-ranked and
 * hard-capped. Overflow becomes a POINTER, never a silent drop (the #39811 cliff lesson).
 * @returns {{selected:object[], overflow:number, block:string}}
 */
export function selectForInjection(lessons, context, { budget = 12, nowDay = 0 } = {}) {
  const ranked = lessons
    .filter((l) => l.status === "active")
    .map((l) => ({ lesson: l, m: matchScore(l, context) }))
    .filter((x) => x.m > 0)
    .map((x) => {
      const score = x.m * confidenceOf(x.lesson, nowDay);
      return { lesson: x.lesson, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.lesson.evidenceCount - a.lesson.evidenceCount ||
        b.lesson.lastConfirmedDay - a.lesson.lastConfirmedDay ||
        (a.lesson.id < b.lesson.id ? -1 : a.lesson.id > b.lesson.id ? 1 : 0),
    );

  const selected = ranked.slice(0, budget).map((x) => x.lesson);
  const overflow = Math.max(0, ranked.length - selected.length);
  const rows = selected.map((l) => `- **${l.id}** — ${l.correctedBehavior}`.slice(0, 200));
  if (overflow)
    rows.push(`- _(+${overflow} more matched lessons in the project ledger — see forge cortex)_`);
  const block = selected.length
    ? [
        "## Lessons for the files in play (Forge Cortex)",
        "Background context from past mistakes on this repo — verify before acting.",
        "",
        ...rows,
        "",
      ].join("\n")
    : "";
  return { selected, overflow, block };
}

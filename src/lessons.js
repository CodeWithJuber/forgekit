// forge lessons — the self-correcting core. PURE logic only (no fs/hooks here, so it's
// fully unit-testable): a mistake scorer that won't fire on normal iteration, a
// confidence lifecycle that lets wrong lessons die faster than right ones grow, and an
// injection selector that never overflows a tool's context cap.
//
// Design invariants (why this isn't just Reflexion):
//  - A lesson is trusted because it keeps being RE-CONFIRMED against fresh outcomes,
//    never because it exists. Injection is NOT confirmation — only the storage/hook
//    layer feeds independent outcome signals in here, never the act of injecting.
//  - A mistake is defined by a BAD OUTCOME, not by "differs from a lesson", so a
//    developer changing their mind retires a lesson instead of fighting it.

/** Signal taxonomy: weight = prior that a real mistake occurred; family gates false positives. */
// `solo: true` = trustworthy enough to fire a lesson on its own (only an explicit human
// undo qualifies). Everything else needs a second signal from a different family — this is
// what stops a stray "no problem" (S5) or a lone thrash (S3) from minting a false lesson.
export const SIGNALS = {
  S1: { weight: 0.45, family: "outcome" }, // test-fail then pass on same files
  S2: { weight: 0.25, family: "behavioral" }, // agent edits code it just wrote
  S3: { weight: 0.3, family: "behavioral" }, // repeated edits to same symbol
  S4: { weight: 0.4, family: "outcome" }, // file/hunk reverted
  S5: { weight: 0.35, family: "human" }, // user negative utterance (weak, noisy — never solo)
  S6: { weight: 0.5, family: "human", solo: true }, // explicit undo (git revert/checkout) — trusted solo
  S7: { weight: 0.35, family: "outcome" }, // lint/type/build regression introduced
};

// One source of truth for scope weighting — the PCM ledger core owns it now, so the
// legacy injection path and Eq.-3 retrieval can never rank the same memory with
// silently different weights during the bridge window.
import { SCOPE_WEIGHT } from "./ledger.js";
import { setOverlap } from "./math.js";

export { SCOPE_WEIGHT };

/**
 * Score whether a cluster of signals reflects a real mistake.
 * noisy-OR (bounded in [0,1)) so three weak signals can't fake one strong one; a
 * cross-family gate so a lone behavioral signal (thrash) never fires a lesson.
 * @param {{signal:string, anti?:number}[]} events - anti in [0,1] scales a signal down.
 * @returns {{p:number, fires:boolean, families:string[]}}
 */
export function scoreMistake(events) {
  const valid = events.filter((e) => SIGNALS[e.signal]);
  const product = valid.reduce((acc, e) => {
    const w = SIGNALS[e.signal].weight * (e.anti ?? 1);
    return acc * (1 - w);
  }, 1);
  const p = 1 - product;
  const families = [...new Set(valid.map((e) => SIGNALS[e.signal].family))];
  const soloOk = valid.some((e) => SIGNALS[e.signal].solo);
  const fires = families.length >= 2 || soloOk;
  return { p, fires, families };
}

/** Route a scored cluster: distill a lesson now, accumulate for later, or discard as variation. */
export function classify(events) {
  const { p, fires } = scoreMistake(events);
  if (fires && p >= 0.7) return "distill";
  if (p >= 0.4) return "accumulate";
  return "discard";
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

/** Time-decayed Beta posterior mean = freshness × validity. Unconfirmed lessons fade out. */
export function confidenceOf(lesson, nowDay) {
  return freshness(lesson, nowDay) * validity(lesson);
}

/** Independent outcome re-confirmed this lesson. Raises confidence with diminishing returns. */
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

/** Compile a `*` / `**` glob to an anchored RegExp (no sentinel chars — single pass). */
const globToRe = (glob) => {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${body}$`);
};

// Tokens every path shares — matching on them would make a lesson keyed to
// src/auth/login.js "relevant" to every .js file under src/ (review-verified bug:
// the shared {src, js} tokens alone scored 0.15, injecting unrelated lessons and
// mis-attributing outcomes). Extensions and layout boilerplate carry no topic.
const GENERIC_PATH_TOKENS = new Set(
  "src lib app test tests spec specs index main utils util js ts jsx tsx mjs cjs py go rs java rb php md json yml yaml".split(
    " ",
  ),
);

/** Content-token footprint of a keyword list ("src/auth/login.js" → {auth, login})
 *  so two keywords about the same module overlap even when the strings differ. */
const keywordGrams = (words) => {
  const grams = new Set();
  for (const w of words ?? []) {
    for (const t of String(w)
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (t.length > 1 && !GENERIC_PATH_TOKENS.has(t)) grams.add(t);
    }
  }
  return grams;
};

/**
 * Trigger overlap with the current context, in [0,1]: symbol hit beats file-glob
 * beats keyword. The keyword tier is GRADED — 0.3 × token-overlap coefficient —
 * so an exact keyword match keeps its historical 0.3 while a same-module partial
 * match ("src/auth/login.js" vs "src/auth/session.js") earns partial credit
 * instead of the old all-or-nothing string equality.
 */
export function matchScore(lesson, context) {
  const t = lesson.trigger;
  if (t.symbols?.some((s) => context.symbols?.includes(s))) return 1.0;
  if (t.files?.some((g) => context.files?.some((f) => globToRe(g).test(f)))) return 0.6;
  return 0.3 * setOverlap(keywordGrams(t.keywords), keywordGrams(context.keywords));
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
      // The paper's retrieval score, decomposed into named terms: relevance (match) ×
      // freshness (rec) × validity (val, ground-truth outcomes) × scope, with a small recency
      // boost. Making `val` explicit ranks outcome-confirmed lessons above merely-recent ones.
      const rel = x.m;
      const rec = freshness(x.lesson, nowDay);
      const val = validity(x.lesson);
      const scopeW = SCOPE_WEIGHT[x.lesson.scope] ?? 0.5;
      const recencyBoost = 1 + (nowDay - x.lesson.lastConfirmedDay <= 14 ? 0.2 : 0);
      return { lesson: x.lesson, score: rel * rec * val * scopeW * recencyBoost };
    })
    .sort((a, b) => b.score - a.score);

  const selected = ranked.slice(0, budget).map((x) => x.lesson);
  const overflow = Math.max(0, ranked.length - selected.length);
  const rows = selected.map((l) => `- **${l.id}** — ${l.correctedBehavior}`.slice(0, 200));
  if (overflow) rows.push(`- _(+${overflow} more matched lessons in .forge/lessons/ — not shown)_`);
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

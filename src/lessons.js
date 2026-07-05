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

export const SCOPE_WEIGHT = { symbol: 1.0, dir: 0.8, repo: 0.6, global: 0.4 };

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

/** Time-decayed Beta posterior mean. Unconfirmed lessons fade out of the injection set. */
export function confidenceOf(lesson, nowDay) {
  const alpha = 1 + lesson.evidenceCount;
  const beta = 1 + lesson.contradictionCount;
  const mean = alpha / (alpha + beta);
  const age = Math.max(0, nowDay - lesson.lastConfirmedDay);
  const decay = 0.5 ** (age / lesson.halfLifeDays);
  return decay * mean;
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

/** Trigger overlap with the current context, in [0,1]: symbol hit beats file beats keyword. */
export function matchScore(lesson, context) {
  const t = lesson.trigger;
  if (t.symbols?.some((s) => context.symbols?.includes(s))) return 1.0;
  if (t.files?.some((g) => context.files?.some((f) => globToRe(g).test(f)))) return 0.6;
  if (t.keywords?.some((k) => context.keywords?.includes(k))) return 0.3;
  return 0;
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
      const conf = confidenceOf(x.lesson, nowDay);
      const recency = 1 + (nowDay - x.lesson.lastConfirmedDay <= 14 ? 0.2 : 0);
      const scopeW = SCOPE_WEIGHT[x.lesson.scope] ?? 0.5;
      return { lesson: x.lesson, score: conf * x.m * recency * scopeW };
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

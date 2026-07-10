import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classify,
  confidenceOf,
  confirm,
  contradict,
  freshness,
  matchScore,
  newLesson,
  scoreMistake,
  selectForInjection,
  validity,
} from "../src/lessons.js";

test("scoreMistake: a lone behavioral signal never fires (thrash is not a lesson)", () => {
  const r = scoreMistake([{ signal: "S3" }]);
  assert.equal(r.fires, false, "one behavioral family cannot create a lesson");
});

test("scoreMistake: two families fire; S6 solo fires; weak S5 solo does NOT", () => {
  assert.equal(
    scoreMistake([{ signal: "S1" }, { signal: "S2" }]).fires,
    true,
    "outcome+behavioral",
  );
  assert.equal(scoreMistake([{ signal: "S6" }]).fires, true, "explicit undo trusted solo");
  assert.equal(scoreMistake([{ signal: "S5" }]).fires, false, "a stray 'no' never mints a lesson");
  assert.equal(
    scoreMistake([{ signal: "S5" }, { signal: "S1" }]).fires,
    true,
    "human + outcome (2 families) fires",
  );
});

test("scoreMistake: noisy-OR is bounded and monotonic, anti-signal scales down", () => {
  const strong = scoreMistake([{ signal: "S1" }, { signal: "S4" }]).p;
  const damped = scoreMistake([
    { signal: "S1", anti: 0.3 },
    { signal: "S4", anti: 0.3 },
  ]).p;
  assert.ok(strong < 1 && strong > 0, "bounded in (0,1)");
  assert.ok(damped < strong, "experiment marker (anti) lowers mistake probability");
});

test("classify routes distill / accumulate / discard", () => {
  assert.equal(classify([{ signal: "S6" }, { signal: "S1" }]), "distill"); // p high + fires
  // two behavioral signals: enough mistake-probability to accumulate, but gated from distilling
  assert.equal(classify([{ signal: "S2" }, { signal: "S3" }]), "accumulate");
  assert.equal(classify([{ signal: "S2", anti: 0.3 }]), "discard"); // damped, below 0.4
});

test("anti-self-reinforcement: injection never confirms; sustained contradiction quarantines", () => {
  let lesson = newLesson({ id: "lsn_x" }, 0);
  // NOTE: only confirm() (independent outcomes) is called here — the injector never does.
  lesson = confirm(lesson, 1);
  lesson = confirm(lesson, 2);
  assert.equal(lesson.status, "active");
  const grown = confidenceOf(lesson, 2);
  assert.ok(grown > 0.6, "two confirmations push confidence above 0.6");
  // sustained contradiction drops confidence and quarantines (never hard-deletes)
  let hit = lesson;
  while (hit.status === "active") hit = contradict(hit, 2);
  assert.ok(confidenceOf(hit, 2) < grown, "contradictions lower confidence");
  assert.equal(hit.status, "quarantined", "first crosses into quarantine, not deletion");
  // a quarantined lesson contradicted AGAIN retires (tombstone, kept for audit)
  assert.equal(contradict(hit, 2).status, "retired");
});

test("decay: an unconfirmed lesson fades over time", () => {
  const lesson = confirm(newLesson({ id: "lsn_d", halfLifeDays: 30 }, 0), 0);
  const fresh = confidenceOf(lesson, 0);
  const stale = confidenceOf(lesson, 60); // two half-lives later
  assert.ok(stale < fresh / 3, "≈quartered after two half-lives");
});

test("matchScore: symbol hit beats file-glob beats keyword", () => {
  const l = newLesson({
    id: "m",
    trigger: {
      symbols: ["validateToken"],
      files: ["src/auth/*.ts"],
      keywords: ["jwt"],
    },
  });
  assert.equal(matchScore(l, { symbols: ["validateToken"] }), 1.0);
  assert.equal(matchScore(l, { files: ["src/auth/session.ts"] }), 0.6);
  assert.equal(matchScore(l, { keywords: ["jwt"] }), 0.3);
  assert.equal(matchScore(l, { files: ["src/db/index.ts"] }), 0);
});

test("matchScore: keyword tier is graded — same-module partial overlap earns partial credit", () => {
  const l = newLesson({ id: "g", trigger: { keywords: ["src/auth/login.js"] } });
  const exact = matchScore(l, { keywords: ["src/auth/login.js"] });
  const sibling = matchScore(l, { keywords: ["src/auth/session.js"] });
  const unrelated = matchScore(l, { keywords: ["docs/readme.md"] });
  assert.equal(exact, 0.3, "full overlap keeps the historical tier value");
  assert.ok(sibling > 0 && sibling < exact, "same module scores between 0 and exact");
  assert.equal(unrelated, 0, "no shared tokens → no match");
});

test("selectForInjection: relevance-ranked, capped, overflow becomes a pointer (never silent)", () => {
  const ctx = { symbols: ["foo"], files: [], keywords: [] };
  const lessons = Array.from({ length: 5 }, (_, i) => {
    let l = newLesson(
      {
        id: `lsn_${i}`,
        trigger: { symbols: ["foo"] },
        correctedBehavior: `do thing ${i}`,
      },
      0,
    );
    l = confirm(l, 0); // make active
    return l;
  });
  const { selected, overflow, block } = selectForInjection(lessons, ctx, {
    budget: 3,
    nowDay: 0,
  });
  assert.equal(selected.length, 3, "hard cap respected");
  assert.equal(overflow, 2, "the rest are counted");
  assert.match(block, /\+2 more matched lessons/, "overflow surfaced as a pointer, not dropped");
});

test("selectForInjection: candidates and non-matching lessons are excluded; empty → no block", () => {
  const candidate = newLesson({ id: "c", trigger: { symbols: ["foo"] } }, 0); // still 'candidate'
  const { block } = selectForInjection([candidate], { symbols: ["foo"] }, {});
  assert.equal(block, "", "only active lessons inject; no noise when nothing qualifies");
});

test("validity/freshness decompose confidence (val = ground truth, rec = decay)", () => {
  const l = newLesson({ id: "v", trigger: { symbols: ["foo"] } }, 0);
  // Laplace-smoothed Beta mean starts at 0.5; confidence = freshness × validity.
  assert.equal(validity(l), 0.5);
  assert.equal(freshness(l, 0), 1);
  assert.ok(Math.abs(confidenceOf(l, 0) - validity(l) * freshness(l, 0)) < 1e-9);
});

test("val term ranks an outcome-confirmed lesson above a merely-recent one", () => {
  const ctx = { symbols: ["foo"] };
  let confirmed = newLesson({ id: "confirmed", trigger: { symbols: ["foo"] } }, 0);
  confirmed = confirm(confirmed, 0); // one independent outcome → higher validity
  confirmed = confirm(confirmed, 0);
  let recentOnly = newLesson({ id: "recent", trigger: { symbols: ["foo"] } }, 0);
  recentOnly = confirm(recentOnly, 0); // active but minimally confirmed
  const { selected } = selectForInjection([recentOnly, confirmed], ctx, { budget: 2, nowDay: 0 });
  assert.equal(selected[0].id, "confirmed", "ground-truth validity wins the ranking");
});

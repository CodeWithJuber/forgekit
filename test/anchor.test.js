import assert from "node:assert/strict";
import test from "node:test";
import { cusum, goalDrift, ON_GOAL_P, onGoalScore, renderAnchor } from "../src/anchor.js";

// changed[] is injected so these are pure (no git needed).
test("goalDrift flags a changed file unrelated to the goal", () => {
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js", "src/reports.js"],
  });
  assert.ok(r.onGoal.includes("src/login.js"));
  assert.ok(r.offGoal.includes("src/reports.js"));
  assert.equal(r.drift, true);
});

test("goalDrift is quiet when every change maps to the goal", () => {
  const r = goalDrift("/nope", "fix login validation", {
    changed: ["src/login.js"],
  });
  assert.equal(r.drift, false);
  assert.deepEqual(r.offGoal, []);
});

test("goalDrift is quiet with no changes yet", () => {
  const r = goalDrift("/nope", "anything at all", { changed: [] });
  assert.equal(r.drift, false);
  assert.match(renderAnchor(r), /nothing to check/);
});

test("goalDrift flags pure drift — changes exist but none match the goal", () => {
  const r = goalDrift("/nope", "update the billing invoice totals", {
    changed: ["src/auth.js"],
  });
  assert.equal(r.onGoal.length, 0);
  assert.equal(r.drift, true);
});

test("goalDrift (llm on): rescues an off-goal file only with a goal-referencing reason", () => {
  // src/throttle.js shares no keyword with the goal, so the coarse match flags it off-goal.
  const run = () =>
    '{"onGoal":[{"file":"src/throttle.js","reason":"implements the rate limiting token bucket"}]}';
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js", "src/throttle.js"],
    llm: true,
    run,
  });
  assert.ok(r.onGoal.includes("src/throttle.js"), "grounded reason moves it off→on");
  assert.ok(!r.offGoal.includes("src/throttle.js"));
  assert.equal(r.provenance.path, "llm-verified");
});

test("goalDrift (llm on): a reason that never references the goal is rejected (verify, don't trust)", () => {
  const run = () => '{"onGoal":[{"file":"src/reports.js","reason":"just tidying up"}]}';
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/reports.js"],
    llm: true,
    run,
  });
  assert.ok(r.offGoal.includes("src/reports.js"), "ungrounded rescue rejected");
  assert.equal(r.drift, true);
});

test("goalDrift (llm on): the model can never move a file on→off", () => {
  const run = () => '{"onGoal":[]}'; // model says nothing is on-goal
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js"], // keyword-matched on-goal deterministically
    llm: true,
    run,
  });
  assert.ok(r.onGoal.includes("src/login.js"), "deterministic on-goal is never demoted");
});

test("goalDrift (llm on): a throwing runner falls back to the deterministic split", () => {
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js", "src/reports.js"],
    llm: true,
    run: () => {
      throw new Error("no cli");
    },
  });
  assert.ok(r.offGoal.includes("src/reports.js"));
  assert.equal(r.drift, true);
});

// ---------------------------------------------------------------------------
// M4 — graded on-goal score (noisy-OR over concept hits), the CUSUM input.
// ---------------------------------------------------------------------------

test("onGoalScore: 0 hits → 0, and each extra hit raises confidence with diminishing returns", () => {
  const goal = new Set(["rate", "limit", "login"]);
  assert.equal(
    onGoalScore(goal, new Set(["reports", "billing"])),
    0,
    "no shared concept → off-goal",
  );
  const one = onGoalScore(goal, new Set(["login"]));
  const two = onGoalScore(goal, new Set(["login", "rate"]));
  const three = onGoalScore(goal, new Set(["login", "rate", "limit"]));
  assert.ok(Math.abs(one - ON_GOAL_P) < 1e-9, "a single hit sits at the on-goal floor");
  assert.ok(two > one && three > two, "more independent evidence ⇒ higher, monotone");
  assert.ok(three < 1, "noisy-OR saturates below 1, never false-certain");
});

test("onGoalScore: the ≥4-char prefix channel matches morphological variants but not collisions", () => {
  // "auth" is a prefix of the file token "authentication" → a hit (recall preserved). But
  // "port" is NOT a prefix of "report" (only a raw substring) → NO hit, so an unrelated file
  // can't be wrongly scored on-goal and hide real drift.
  assert.ok(onGoalScore(new Set(["auth"]), new Set(["authentication"])) >= ON_GOAL_P);
  assert.ok(onGoalScore(new Set(["valid"]), new Set(["validation"])) >= ON_GOAL_P);
  assert.equal(onGoalScore(new Set(["port"]), new Set(["report"])), 0, "substring ≠ prefix");
});

test("goalDrift: an atlas identifier rescues an implement-the-goal file the PATH never names", () => {
  // src/throttle.js's path shares no goal word, but it DEFINES rateLimiter — the identifier
  // channel catches it deterministically (no LLM), the exact gap the audit flagged.
  const atlas = {
    symbols: [
      { name: "rateLimiter", file: "src/throttle.js", kind: "function" },
      { name: "renderReport", file: "src/reports.js", kind: "function" },
    ],
  };
  const r = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/throttle.js", "src/reports.js"],
    atlas,
  });
  assert.ok(r.onGoal.includes("src/throttle.js"), "identifier match ⇒ on-goal without the LLM");
  assert.ok(r.offGoal.includes("src/reports.js"), "a genuinely unrelated file still drifts");
  assert.equal(r.provenance.path, "deterministic");
});

test("goalDrift: an on-goal file contributes NO drift; a fully off-goal checkpoint drifts at 1.0", () => {
  // driftScore is the off-goal FRACTION (the cusum operating point), so a classified-on-goal
  // file must drain the chart, not accrue residual drift — the regression the review caught.
  const on = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js"], // one concept hit → on-goal
    atlas: null,
  });
  const off = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/reports.js"], // zero hits → off-goal
    atlas: null,
  });
  assert.equal(on.driftScore, 0, "an on-goal checkpoint scores exactly 0 (drains the cusum chart)");
  assert.equal(off.driftScore, 1, "a fully off-goal checkpoint drifts at 1.0");
});

test("goalDrift: driftScore is the off-goal fraction (1 on-goal + 1 off-goal → 0.5)", () => {
  const r = goalDrift("/nope", "billing invoice totals", {
    changed: ["src/billing.js", "src/reports.js"], // billing → on-goal (1 hit); reports → off-goal
    atlas: null,
  });
  assert.ok(r.onGoal.includes("src/billing.js") && r.offGoal.includes("src/reports.js"));
  assert.ok(Math.abs(r.driftScore - 0.5) < 1e-9, "1 of 2 files off-goal → 0.5");
});

test("goalDrift: a goal that NAMES a file classifies that file on-goal (named target ⇒ score 1)", () => {
  const r = goalDrift("/nope", "update src/pay.js", {
    changed: ["src/pay.js", "src/reports.js"], // pay.js is the named target; reports is unrelated
    atlas: null,
  });
  assert.ok(r.onGoal.includes("src/pay.js"), "the named file anchors on-goal");
  assert.ok(r.offGoal.includes("src/reports.js"));
  assert.ok(Math.abs(r.driftScore - 0.5) < 1e-9, "1 of 2 off-goal → 0.5");
});

// ---------------------------------------------------------------------------
// M4 — one-sided CUSUM drift control (pure).
// ---------------------------------------------------------------------------

test("cusum alarms on sustained small drift (the decaying-anchor failure)", () => {
  // Each checkpoint drifts 0.6, only 0.25 over the allowance — no single step is
  // alarming, but the excess accumulates: C = 0.25, 0.5, 0.75, 1.0, 1.25 → alarm.
  const r = cusum([0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
  assert.equal(r.alarm, true);
  assert.equal(r.firstAlarm, 4, "alarms at the first checkpoint where C exceeds h");
  assert.equal(r.C.length, 6);
  assert.ok(Math.abs(r.C[0] - 0.25) < 1e-9);
});

test("cusum does not alarm on a single spike within tolerance", () => {
  const r = cusum([0.1, 1.2, 0.1, 0.1, 0.1, 0.1]);
  assert.equal(r.alarm, false);
  assert.equal(r.firstAlarm, -1);
  assert.equal(r.C.at(-1), 0, "the statistic drains back to zero after the spike");
});

test("cusum is quiet on on-goal signals and on an empty series", () => {
  assert.equal(cusum([0.1, 0.2, 0.3, 0.1]).alarm, false);
  assert.deepEqual(cusum([]), { alarm: false, C: [], firstAlarm: -1 });
});

test("cusum honors custom k and h", () => {
  // With a zero allowance every step accumulates fully; h=0.5 trips on step 2.
  const r = cusum([0.3, 0.3, 0.3], { k: 0, h: 0.5 });
  assert.equal(r.firstAlarm, 1);
  // A generous h absorbs the same series entirely.
  assert.equal(cusum([0.3, 0.3, 0.3], { k: 0, h: 2 }).alarm, false);
});

test("cusum treats non-numeric signals as zero drift (never NaN-poisons the chart)", () => {
  const r = cusum([0.6, Number.NaN, 0.6]);
  assert.ok(r.C.every((c) => Number.isFinite(c)));
  assert.equal(r.alarm, false);
});

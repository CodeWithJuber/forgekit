import assert from "node:assert/strict";
import test from "node:test";
import {
  cusum,
  goalDrift,
  ON_GOAL_P,
  onGoalScore,
  renderAnchor,
} from "../src/anchor.js";

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
  assert.ok(
    r.onGoal.includes("src/throttle.js"),
    "grounded reason moves it off→on",
  );
  assert.ok(!r.offGoal.includes("src/throttle.js"));
  assert.equal(r.provenance.path, "llm-verified");
});

test("goalDrift (llm on): a reason that never references the goal is rejected (verify, don't trust)", () => {
  const run = () =>
    '{"onGoal":[{"file":"src/reports.js","reason":"just tidying up"}]}';
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
  assert.ok(
    r.onGoal.includes("src/login.js"),
    "deterministic on-goal is never demoted",
  );
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
  assert.ok(
    Math.abs(one - ON_GOAL_P) < 1e-9,
    "a single hit sits at the on-goal floor",
  );
  assert.ok(
    two > one && three > two,
    "more independent evidence ⇒ higher, monotone",
  );
  assert.ok(three < 1, "noisy-OR saturates below 1, never false-certain");
});

test("onGoalScore: substring channel preserves the old match's recall (auth ⊂ authentication)", () => {
  const goal = new Set(["auth"]);
  // tokenize would keep 'authentication' whole, so token-equality misses it; the raw-path
  // substring channel still counts the hit, so we never regress below the old behaviour.
  assert.ok(
    onGoalScore(goal, new Set(["authentication"]), "src/authentication.js") >=
      ON_GOAL_P,
  );
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
  assert.ok(
    r.onGoal.includes("src/throttle.js"),
    "identifier match ⇒ on-goal without the LLM",
  );
  assert.ok(
    r.offGoal.includes("src/reports.js"),
    "a genuinely unrelated file still drifts",
  );
  assert.equal(r.provenance.path, "deterministic");
});

test("goalDrift: driftScore is graded — a weak match drifts less than an unrelated file", () => {
  const weak = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/login.js"], // one concept hit (login)
    atlas: null,
  });
  const off = goalDrift("/nope", "add rate limiting to the login route", {
    changed: ["src/reports.js"], // zero hits
    atlas: null,
  });
  assert.ok(
    weak.driftScore < off.driftScore,
    "a partial match accrues less drift than none",
  );
  assert.ok(
    Math.abs(off.driftScore - 1) < 1e-9,
    "a fully off-goal checkpoint drifts at 1.0",
  );
});

test("goalDrift: on a partial (0.6) + off (0) checkpoint, driftScore is the graded mean of 1−score", () => {
  const r = goalDrift("/nope", "billing invoice totals", {
    changed: ["src/billing.js", "src/reports.js"], // billing → 1 concept hit = 0.6; reports → 0
    atlas: null,
  });
  // graded, not quantized: mean(1−s) = (0.4 + 1)/2 = 0.7, where the legacy off/n would say 0.5.
  assert.ok(Math.abs(r.driftScore - 0.7) < 1e-9);
});

test("goalDrift: driftScore reduces EXACTLY to the legacy off-goal fraction on genuinely binary scores", () => {
  // A goal that NAMES a file scores it exactly 1.0 (named target), and an unrelated file scores 0
  // — a real {0,1} checkpoint. Here the graded mean(1−score) must equal the old offGoal/changed.
  const r = goalDrift("/nope", "update src/pay.js", {
    changed: ["src/pay.js", "src/reports.js"], // pay.js is the named target → 1; reports → 0
    atlas: null,
  });
  assert.ok(
    r.onGoal.includes("src/pay.js") && r.offGoal.includes("src/reports.js"),
  );
  // mean(1−score) = (0 + 1)/2 = 0.5 = legacy offGoal(1)/changed(2). Exact reduction on 0/1 scores.
  assert.ok(Math.abs(r.driftScore - 0.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// M4 — one-sided CUSUM drift control (pure).
// ---------------------------------------------------------------------------

test("cusum alarms on sustained small drift (the decaying-anchor failure)", () => {
  // Each checkpoint drifts 0.6, only 0.25 over the allowance — no single step is
  // alarming, but the excess accumulates: C = 0.25, 0.5, 0.75, 1.0, 1.25 → alarm.
  const r = cusum([0.6, 0.6, 0.6, 0.6, 0.6, 0.6]);
  assert.equal(r.alarm, true);
  assert.equal(
    r.firstAlarm,
    4,
    "alarms at the first checkpoint where C exceeds h",
  );
  assert.equal(r.C.length, 6);
  assert.ok(Math.abs(r.C[0] - 0.25) < 1e-9);
});

test("cusum does not alarm on a single spike within tolerance", () => {
  const r = cusum([0.1, 1.2, 0.1, 0.1, 0.1, 0.1]);
  assert.equal(r.alarm, false);
  assert.equal(r.firstAlarm, -1);
  assert.equal(
    r.C.at(-1),
    0,
    "the statistic drains back to zero after the spike",
  );
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

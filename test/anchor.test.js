import assert from "node:assert/strict";
import test from "node:test";
import { goalDrift, renderAnchor } from "../src/anchor.js";

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
  const r = goalDrift("/nope", "fix login validation", { changed: ["src/login.js"] });
  assert.equal(r.drift, false);
  assert.deepEqual(r.offGoal, []);
});

test("goalDrift is quiet with no changes yet", () => {
  const r = goalDrift("/nope", "anything at all", { changed: [] });
  assert.equal(r.drift, false);
  assert.match(renderAnchor(r), /nothing to check/);
});

test("goalDrift flags pure drift — changes exist but none match the goal", () => {
  const r = goalDrift("/nope", "update the billing invoice totals", { changed: ["src/auth.js"] });
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

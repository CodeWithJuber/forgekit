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

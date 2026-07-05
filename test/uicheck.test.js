import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSERTABLE_CHECKS, contrastRatio, relativeLuminance, wcagLevel } from "../src/uicheck.js";

test("relativeLuminance: black=0, white=1", () => {
  assert.equal(Math.round(relativeLuminance("#000000") * 1000), 0);
  assert.equal(Math.round(relativeLuminance("#ffffff") * 1000), 1000);
});

test("contrastRatio: black-on-white is the max 21:1; identical colors are 1:1", () => {
  assert.equal(Math.round(contrastRatio("#000", "#fff")), 21);
  assert.equal(Math.round(contrastRatio("#777", "#777")), 1);
});

test("wcagLevel: #999 on white FAILS AA (~2.85); #595959 passes AA; #000 is AAA", () => {
  assert.equal(wcagLevel(contrastRatio("#999999", "#ffffff")).level, "fail");
  assert.equal(wcagLevel(contrastRatio("#595959", "#ffffff")).passesAA, true);
  assert.equal(wcagLevel(contrastRatio("#000000", "#ffffff")).level, "AAA");
});

test("wcagLevel: the large-text threshold is looser (3:1)", () => {
  const r = contrastRatio("#949494", "#ffffff"); // ~3.0
  assert.equal(wcagLevel(r, { large: true }).passesAA, true);
  assert.equal(wcagLevel(r, { large: false }).passesAA, false);
});

test("bad hex throws (never silently mis-report a color)", () => {
  assert.throws(() => contrastRatio("nope", "#fff"));
});

test("the assertable checklist is exposed for the verifier + docs", () => {
  assert.ok(ASSERTABLE_CHECKS.some((c) => c.id === "contrast"));
  assert.ok(ASSERTABLE_CHECKS.some((c) => c.id === "focus-visible"));
});

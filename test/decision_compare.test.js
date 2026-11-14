import assert from "node:assert/strict";
import test from "node:test";
import { compareChoices } from "../src/decision_compare.js";

const now = new Date("2026-11-14T12:30:00Z");
const gates = Object.fromEntries(
  [
    "licenseCompatible",
    "maintained",
    "noCriticalVulnerability",
    "stackCompatible",
    "withinBudget",
  ].map((k) => [k, { value: k === "maintained" ? "2025-11-14" : true, evidence: "proof.txt:23" }]),
);
const scores = Object.fromEntries(
  ["fit", "maturity", "maintenance", "performance", "documentation", "exitCost", "community"].map(
    (k) => [k, { value: 4, evidence: "bench.csv:3" }],
  ),
);
const candidate = (name, patch = {}) => ({ name, gates, scores, ...patch });
const compare = (items, weights = {}) =>
  compareChoices({ question: "Select a parser", candidates: items, weights }, now);
test("hard failures retain their source and exclude even high-scoring options", () => {
  const r = compare([
    candidate("A"),
    candidate("B", {
      gates: { ...gates, maintained: { value: "2025-11-13", evidence: "releases" } },
    }),
  ]);
  assert.equal(r.winner, "A");
  assert.equal(r.candidates[1].score, null);
  assert.deepEqual(r.candidates[1].reasons, ["maintained"]);
});
test("missing or future evidence keeps the choice open", () => {
  for (const patch of [
    { gates: { ...gates, maintained: { value: "2026-11-15", evidence: "test" } } },
    { gates: { ...gates, stackCompatible: { value: true } } },
    { scores: { ...scores, fit: { value: 4 } } },
  ]) {
    const r = compare([candidate("A"), candidate("B", patch)]);
    assert.equal(r.winner, null);
    assert.equal(r.status, "needs-evidence");
  }
});
test("weighted results, ties and invalid input have separate outcomes", () => {
  const b = candidate("B", { scores: { ...scores, fit: { value: 5, evidence: "test.log:2" } } });
  assert.equal(compare([candidate("A"), b], { fit: 2 }).candidates[1].score, 4.25);
  assert.equal(compare([candidate("A"), candidate("B")]).status, "tie");
  assert.throws(() => compare([candidate("A"), b], { fit: -1 }));
  assert.throws(() => compare([candidate("A"), candidate("A")]));
});

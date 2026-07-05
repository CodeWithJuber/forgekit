import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build, impact } from "../src/atlas.js";
import { assessTask, preflightRepo } from "../src/preflight.js";
import { routeTask, rubricComplexity } from "../src/route.js";
import { substrateCheck } from "../src/substrate.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "forge-substrate-"));
  writeFileSync(join(root, "math.js"), "export function computeTax(x){ return x * 0.2 }\n");
  writeFileSync(
    join(root, "invoice.js"),
    "import { computeTax } from './math.js'\nexport function invoiceTotal(x){ return x + computeTax(x) }\n",
  );
  return root;
}

test("assumption gate asks on under-specified work", () => {
  const r = assessTask("Fix the bug.");
  assert.equal(r.shouldAsk, true);
  assert.equal(r.risk, "high");
  assert.ok(r.questions.length > 0);
});

test("routing rubric separates trivial, moderate, and premium tasks", () => {
  assert.equal(rubricComplexity("Write is_prime(n). is_prime(7) -> True. Python.").band, "cheap");
  assert.equal(
    rubricComplexity("Implement an LRU cache class with O(1) get/put. Python.").band,
    "mid",
  );
  assert.equal(
    rubricComplexity(
      "Design and implement a thread-safe bounded blocking queue with condition-variable signaling.",
    ).band,
    "premium",
  );
});

test("atlas impact follows reverse dependencies", () => {
  const root = repo();
  const atlas = build({ root });
  const r = impact(atlas, "computeTax");
  assert.equal(r.found, true);
  assert.ok(r.impactedFiles.includes("invoice.js"), JSON.stringify(r, null, 2));
});

test("substrateCheck returns one professional pre-action contract", () => {
  const root = repo();
  const r = substrateCheck(
    root,
    "Update `computeTax` in `math.js` so computeTax(100) -> 25 and tests pass.",
  );
  assert.equal(typeof r.okToProceed, "boolean");
  assert.ok(r.assumption);
  assert.ok(r.route.model.id);
  assert.ok(Array.isArray(r.impact.impactedFiles));
  assert.ok(Array.isArray(r.verification.checklist));
});

test("routeTask uses text rubric to avoid under-routing moderate standalone tasks", () => {
  const root = repo();
  const r = routeTask(root, "Implement an LRU cache class with O(1) get and put. JavaScript.");
  assert.ok(["sonnet", "opus", "fable"].includes(r.key), `got ${r.key}`);
});

test("preflightRepo includes assumption report", () => {
  const root = repo();
  const r = preflightRepo(root, "Optimize it.");
  assert.equal(r.assumption.shouldAsk, true);
});

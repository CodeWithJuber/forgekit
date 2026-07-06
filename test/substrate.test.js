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

test("impact (llm on): a proposed edge is kept only if it is a real file AND grep-verified", () => {
  const root = repo();
  const atlas = build({ root });
  // Model proposes a real repo file (invoice.js) plus a fabricated one (ghost.js).
  const run = () => '{"files":["invoice.js","ghost.js"]}';
  const verify = (file) => file === "invoice.js"; // grep only confirms the real reference
  const r = impact(atlas, "computeTax", { llm: true, run, verify });
  assert.ok(r.llmVerified.includes("invoice.js") || r.impactedFiles.includes("invoice.js"));
  assert.ok(!r.impactedFiles.includes("ghost.js"), "a fabricated file is never added");
});

test("impact (llm on): without a verify predicate, nothing is added blind", () => {
  const root = repo();
  const atlas = build({ root });
  const run = () => '{"files":["invoice.js"]}';
  const r = impact(atlas, "computeTax", { llm: true, run }); // no verify → cannot confirm
  assert.deepEqual(r.llmVerified, [], "no external check available → no blind edges");
});

test("impact (llm off): behavior is unchanged and carries no llm fields effect", () => {
  const root = repo();
  const atlas = build({ root });
  const base = impact(atlas, "computeTax");
  const off = impact(atlas, "computeTax", { llm: false, run: () => '{"files":["ghost.js"]}' });
  assert.deepEqual(off.impactedFiles, base.impactedFiles);
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

test("substrateCheck (llm off by default): provenance is deterministic across faculties", () => {
  const root = repo();
  const r = substrateCheck(root, "Refactor computeTax in math.js", { allowBuild: true });
  assert.equal(r.llm.enabled, false);
  assert.equal(r.llm.provenance.assumption, "deterministic");
  assert.equal(r.llm.provenance.route, "deterministic");
  assert.ok(Array.isArray(r.guarantees.llmVerified), "llmVerified bucket is present");
});

test("substrateCheck (llm on, explicit): opt-in flag threads through and stays fail-safe", () => {
  const root = repo();
  // No `run` injection reaches the real CLI here, but the substrate must not throw and must
  // still return a coherent contract regardless of whether the CLI exists.
  const r = substrateCheck(root, "Update computeTax in math.js", { llm: true });
  assert.equal(r.llm.enabled, true);
  assert.ok(r.route.model.id, "still returns a routed model");
  assert.equal(typeof r.okToProceed, "boolean");
  assert.ok(["deterministic", "llm-verified", "llm-agreed"].includes(r.llm.provenance.goalAnchor));
});

test("substrateCheck: surfaces llm.bidirectional (defaults true from config)", () => {
  const root = repo();
  const r = substrateCheck(root, "Refactor computeTax in math.js");
  assert.equal(r.llm.bidirectional, true, "config default is bidirectional");
  assert.equal(typeof r.llm.provenance.assumption, "string");
});

test("substrateCheck: an explicit bidirectional:false threads through", () => {
  const root = repo();
  const r = substrateCheck(root, "Refactor computeTax in math.js", { bidirectional: false });
  assert.equal(r.llm.bidirectional, false, "explicit override wins over the config default");
});

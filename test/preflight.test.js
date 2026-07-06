import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ambiguityMarkers,
  assessTask,
  assessTaskLLM,
  clarifyBlock,
  informationGap,
  preflightRepo,
  reconcileAssumption,
  referencedEntities,
} from "../src/preflight.js";

test("referencedEntities pulls backtick symbols, file paths, and bare camelCase", () => {
  const r = referencedEntities(
    "refactor `validateToken` and update `src/auth.ts`, call computeTax",
  );
  assert.ok(r.symbols.includes("validateToken"));
  assert.ok(r.symbols.includes("computeTax"));
  assert.ok(r.files.includes("src/auth.ts"));
});

test("referencedEntities ignores plain English (no false identifiers)", () => {
  const r = referencedEntities("add a dark mode toggle to the settings page");
  assert.deepEqual(r.symbols, []);
  assert.deepEqual(r.files, []);
});

test("ambiguityMarkers catches vague wording", () => {
  const m = ambiguityMarkers("handle errors somehow and add several validations, etc.");
  assert.ok(m.includes("somehow") || m.includes("handle errors"));
  assert.ok(m.includes("several"));
  assert.ok(m.includes("etc"));
});

test("informationGap: all references resolve → gap 0 (silent)", () => {
  const has = (n) => n === "computeTax";
  const r = informationGap("refactor `computeTax`", { hasSymbol: has });
  assert.equal(r.gap, 0);
  assert.equal(clarifyBlock(r), "", "no clarify block when everything is grounded");
});

test("informationGap: an unresolved symbol drives the gap up and always clarifies", () => {
  const r = informationGap("wire `DatabasePool` into the handler", {
    hasSymbol: () => false,
  });
  assert.ok(r.gap > 0.9);
  assert.deepEqual(r.unresolved.symbols, ["DatabasePool"]);
  const block = clarifyBlock(r);
  assert.match(block, /DatabasePool/);
  assert.match(block, /not found/);
});

test("clarifyBlock stays silent for a fully-grounded task even with mild wording", () => {
  // one resolved symbol, no ambiguity → gap 0
  const r = informationGap("update `computeTax` to round half-up", {
    hasSymbol: () => true,
  });
  assert.equal(clarifyBlock(r), "");
});

test("preflightRepo grounds against a real repo (missing file/symbol → clarify)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-preflight-"));
  writeFileSync(join(root, "tax.js"), "export function computeTax(x){ return x }\n");
  // computeTax exists; `ledgerSync` and src/missing.ts do not
  const r = preflightRepo(root, "call `computeTax` then `ledgerSync` in `src/missing.ts`");
  assert.ok(r.entities.symbols.includes("computeTax"));
  assert.ok(r.unresolved.symbols.includes("ledgerSync"));
  assert.ok(r.unresolved.files.includes("src/missing.ts"));
  assert.ok(!r.unresolved.symbols.includes("computeTax"), "resolved symbol is not flagged");
});

test("assessTaskLLM: parses a completeness reading, rejects junk", () => {
  const p = assessTaskLLM("do a thing", {
    run: () => '{"completeness":0.3,"missing":["target_scope"],"questions":["Which file?"]}',
  });
  assert.equal(p.completeness, 0.3);
  assert.deepEqual(p.missing, ["target_scope"]);
  assert.equal(assessTaskLLM("x", { run: () => "not json" }), null);
  assert.equal(assessTaskLLM("x", { run: () => '{"completeness":"nope"}' }), null);
});

test("reconcileAssumption: model can only move completeness within ±band of the rubric", () => {
  const det = assessTask("Fix the bug."); // under-specified, low completeness, shouldAsk
  // Model claims fully specified — bounded, cannot flip a clearly-vague task to 1.0.
  const r = reconcileAssumption(
    det,
    { completeness: 1, missing: [], questions: [] },
    { band: 0.25 },
  );
  assert.ok(r.completeness <= det.completeness + 0.25 + 1e-9, "clamped to +band");
  assert.equal(r.provenance.path, "llm-verified");
});

test("reconcileAssumption: never clears a deterministic / hard-underspecified ask", () => {
  const det = assessTask("Fix it."); // hardUnderspecified
  assert.equal(det.shouldAsk, true);
  const r = reconcileAssumption(det, { completeness: 0.95, missing: [], questions: [] });
  assert.equal(r.shouldAsk, true, "the gate only tightens; the model cannot open it");
});

test("reconcileAssumption: extra questions survive only if grounded or on a flagged dimension", () => {
  const det = assessTask("optimize the pipeline"); // flags success_criteria/constraints dims
  const r = reconcileAssumption(
    det,
    {
      completeness: det.completeness,
      missing: det.missing.map((m) => m.key), // maps to a flagged dimension → kept
      questions: ["What is the acceptance benchmark?"],
    },
    { grounded: () => false },
  );
  assert.ok(
    r.questions.some((q) => /benchmark/.test(q)) || det.questions.length === 0,
    "a question on a flagged dimension is kept",
  );
  // An ungrounded question tied to no flagged dimension is dropped.
  const r2 = reconcileAssumption(
    det,
    { completeness: det.completeness, missing: [], questions: ["Unrelated musing?"] },
    { grounded: () => false },
  );
  assert.ok(!r2.questions.includes("Unrelated musing?"), "ungrounded extra question dropped");
});

test("reconcileAssumption: null proposal is a pure passthrough (deterministic path)", () => {
  const det = assessTask("Change verifyToken in src/auth.js to require length > 20; update tests");
  const r = reconcileAssumption(det, null);
  assert.equal(r.provenance.path, "deterministic");
  assert.equal(r.completeness, det.completeness);
  assert.equal(r.shouldAsk, det.shouldAsk);
});

test("preflightRepo (llm on): fail-safe — a throwing runner keeps the deterministic reading", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  const task = "Fix the bug.";
  const base = preflightRepo(root, task);
  const withLlm = preflightRepo(root, task, {
    llm: true,
    run: () => {
      throw new Error("no cli");
    },
  });
  assert.equal(withLlm.assumption.shouldAsk, base.assumption.shouldAsk);
  assert.equal(withLlm.assumption.provenance.path, "deterministic");
});

// --- Bidirectional M2 reconcile: clearing a false ask, guarded by hard floors ---
const detStub = (over = {}) => ({
  completeness: 0.5,
  risk: "medium",
  shouldAsk: true,
  hardUnderspecified: false,
  missing: [],
  questions: ["What exactly should this produce?"],
  reasons: [],
  ...over,
});

test("bidirectional: a verified raise clears a borderline false ask", () => {
  const det = detStub({ completeness: 0.5, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.85, missing: [], questions: [] },
    { bidirectional: true, hasUnresolved: false },
  );
  assert.equal(r.shouldAsk, false, "bounded raise crosses the threshold → gate clears");
  assert.equal(r.provenance.path, "llm-cleared");
});

test("bidirectional: a hard-underspecified task is NEVER cleared", () => {
  const det = detStub({ completeness: 0.5, shouldAsk: true, hardUnderspecified: true });
  const r = reconcileAssumption(det, { completeness: 1, missing: [], questions: [] }, {});
  assert.equal(r.shouldAsk, true, "no concrete anchor → the model can't wave it through");
});

test("bidirectional: an unresolved-entity task is NEVER cleared (repo grounding floor)", () => {
  const det = detStub({ completeness: 0.55, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.95, missing: [], questions: [] },
    { hasUnresolved: true },
  );
  assert.equal(r.shouldAsk, true, "names symbols/files the repo lacks → still asks");
});

test("bidirectional: a genuinely vague task can't be lifted over the line (band clamp)", () => {
  const det = detStub({ completeness: 0.2, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 1, missing: [], questions: [] },
    { band: 0.25 },
  );
  assert.ok(r.completeness <= 0.45 + 1e-9, "clamped to det+band");
  assert.equal(r.shouldAsk, true, "0.45 < 0.6 threshold → still asks");
});

test("bidirectional: the model can still TIGHTEN a rubric-proceed task into an ask", () => {
  const det = detStub({ completeness: 0.7, shouldAsk: false, questions: [] });
  const r = reconcileAssumption(
    det,
    { completeness: 0.4, missing: [], questions: [] },
    { band: 0.25 },
  );
  assert.equal(r.shouldAsk, true, "lowered below threshold → now asks");
  assert.equal(r.provenance.path, "llm-tightened");
});

test("bidirectional:false — the model can never clear a deterministic ask", () => {
  const det = detStub({ completeness: 0.5, shouldAsk: true });
  const r = reconcileAssumption(
    det,
    { completeness: 0.95, missing: [], questions: [] },
    { bidirectional: false, hasUnresolved: false },
  );
  assert.equal(r.shouldAsk, true, "raise-only/tighten-only mode keeps the rubric's ask");
});

test("preflightRepo (bidirectional, integration): unresolved symbol floor blocks a clear", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  // Task names `ghostSymbol`, which the (empty) repo doesn't define → the grounding floor holds
  // even though the model votes fully specified.
  const r = preflightRepo(root, "refactor `ghostSymbol` to be faster", {
    llm: true,
    run: () => '{"completeness":0.95,"missing":[],"questions":[]}',
  });
  assert.equal(r.assumption.shouldAsk, true, "unresolved entity keeps the gate closed");
});

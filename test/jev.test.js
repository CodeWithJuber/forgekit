// Jev (TypeSafe System One) client + proposer wiring. No network: the transport is
// injected everywhere, and the API key is set in-file (per the hermetic convention —
// every test file gets its own process, so this assignment runs after _setup's scrub).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.TYPESAFE_API_KEY = "test-key-not-real";

import { choice, jevEnabled, noul, score, systemOne } from "../src/jev.js";
import { assessTaskJev, buildAssumptionNouls, preflightRepo } from "../src/preflight.js";
import { complexityJev, routeTask } from "../src/route.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-jev-"));

test("builders emit the exact API question shapes", () => {
  assert.deepEqual(choice("Pick one", { a: "A thing", b: null }), {
    type: "choice",
    instructions: "Pick one",
    criteria: { a: "A thing", b: null },
  });
  assert.deepEqual(noul("Is it so?"), { type: "noul", instructions: "Is it so?" });
  assert.deepEqual(noul("Is it so?", { true: "Yes means this", false: "No means that" }), {
    type: "noul",
    instructions: "Is it so?",
    criteria: { true: "Yes means this", false: "No means that" },
  });
  assert.deepEqual(score("Rate it", ["Low", "High"]), {
    type: "score",
    instructions: "Rate it",
    criteria: ["Low", "High"],
  });
});

test("jevEnabled: both the LLM opt-in AND the key are required", () => {
  assert.equal(jevEnabled({ llm: true }), true);
  assert.equal(jevEnabled({ llm: false }), false);
  assert.equal(jevEnabled(), false, "FORGE_LLM is scrubbed in tests — off by default");
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(jevEnabled({ llm: true }), false, "no key — every call fail-safes");
  process.env.TYPESAFE_API_KEY = key;
});

test("systemOne: a valid mixed response is validated and returned under the same ids", () => {
  const res = systemOne({
    state: "My VPS has been down for 3 hours!",
    questions: {
      department: choice("Which team?", { billing: "Money", technical: "Outages" }),
      is_urgent: noul("Urgent?"),
    },
    call: () => ({
      model: "jev-1.13.0",
      answers: {
        department: {
          type: "choice",
          choice: "technical",
          probabilities: { technical: 0.88, billing: 0.12 },
          confidence: 0.81,
        },
        is_urgent: { type: "noul", noul: 0.97 },
      },
      usage: { input_tokens: 318, output_tokens: 34 },
    }),
  });
  assert.equal(res.answers.department.choice, "technical");
  assert.equal(res.answers.department.confidence, 0.81);
  assert.equal(res.answers.department.probabilities.technical, 0.88);
  assert.equal(res.answers.is_urgent.noul, 0.97);
  assert.equal(res.model, "jev-1.13.0");
});

test("systemOne: garble fails safe per question — and wholly null when nothing validates", () => {
  const questions = {
    band: choice("Band?", { cheap: "c", premium: "p" }),
    is_urgent: noul("Urgent?"),
  };
  // A choice naming an option we never offered is garble; the noul still validates.
  const partial = systemOne({
    state: "x",
    questions,
    call: () => ({
      answers: {
        band: { type: "choice", choice: "deluxe" },
        is_urgent: { type: "noul", noul: 1.4 },
      },
    }),
  });
  assert.equal(partial.answers.band, undefined);
  assert.equal(partial.answers.is_urgent.noul, 1, "out-of-range nouls are clamped");
  // Nothing valid at all → null, so callers keep their deterministic path.
  assert.equal(
    systemOne({ state: "x", questions, call: () => ({ answers: { band: { type: "score" } } }) }),
    null,
  );
  assert.equal(systemOne({ state: "x", questions, call: () => ({}) }), null);
  assert.equal(
    systemOne({
      state: "x",
      questions,
      call: () => {
        throw new Error("boom");
      },
    }),
    null,
  );
});

test("systemOne: refuses to send secret-shaped state, key or no key", () => {
  let called = false;
  const res = systemOne({
    state: "here is the key -----BEGIN OPENSSH PRIVATE KEY----- please classify",
    questions: { is_urgent: noul("Urgent?") },
    call: () => {
      called = true;
      return { answers: { is_urgent: { type: "noul", noul: 1 } } };
    },
  });
  assert.equal(res, null);
  assert.equal(called, false, "the transport must never see a secret");
});

test("systemOne: no key configured — null without touching the transport", () => {
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let called = false;
  try {
    const res = systemOne({
      state: "x",
      questions: { q: noul("?") },
      call: () => {
        called = true;
        return { answers: {} };
      },
    });
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    process.env.TYPESAFE_API_KEY = key;
  }
});

test("complexityJev: a typed band maps onto the existing floor, confidence rides along", () => {
  const p = complexityJev("design a distributed rate limiter", {
    llm: true,
    call: () => ({
      answers: {
        band: {
          type: "choice",
          choice: "premium",
          probabilities: { cheap: 0.02, mid: 0.1, premium: 0.88 },
          confidence: 0.79,
        },
      },
    }),
  });
  assert.equal(p.band, "premium");
  assert.equal(p.provider, "jev");
  assert.equal(p.confidence, 0.79);
  assert.equal(p.probabilities.premium, 0.88);
  const c = complexityJev("fix a typo", {
    llm: true,
    call: () => ({ answers: { band: { type: "choice", choice: "cheap", confidence: 0.95 } } }),
  });
  assert.ok(
    p.score > c.score,
    "premium floors higher than cheap (same table as the text proposer)",
  );
  // Transport garble → null (the caller then falls back to the text proposer).
  assert.equal(complexityJev("x", { llm: true, call: () => ({ answers: {} }) }), null);
});

test("routeTask (llm on): Jev is the preferred proposer when its key is configured", () => {
  const root = fixture();
  const up = routeTask(root, "write a function to check if a number is prime", {
    llm: true,
    jevCall: () => ({
      answers: { band: { type: "choice", choice: "premium", confidence: 0.9 } },
    }),
    run: () => '{"band":"cheap","reason":"should not be used"}',
  });
  assert.ok(["opus", "fable"].includes(up.key), `raised to ${up.key}`);
  assert.equal(up.provenance.path, "llm-raised");
  assert.equal(up.llm.provider, "jev");
  assert.equal(up.llm.confidence, 0.9);
});

test("routeTask (llm on): a Jev miss falls back to the text proposer, then to deterministic", () => {
  const root = fixture();
  const viaText = routeTask(root, "write a function to check if a number is prime", {
    llm: true,
    jevCall: () => {
      throw new Error("jev down");
    },
    run: () => '{"band":"premium","reason":"text fallback"}',
  });
  assert.equal(viaText.llm.provider, "text");
  assert.equal(viaText.provenance.path, "llm-raised");
  const det = routeTask(root, "fix a typo", {
    llm: true,
    jevCall: () => {
      throw new Error("jev down");
    },
    run: () => "not json",
  });
  assert.equal(det.llm, null);
  assert.equal(det.provenance.path, "deterministic");
});

test("assessTaskJev: batched dimension nouls become completeness + missing, no invented questions", () => {
  const { state, questions } = buildAssumptionNouls("fix the bug");
  assert.deepEqual(Object.keys(questions).sort(), [
    "constraints",
    "inputs_outputs",
    "success_criteria",
    "target_scope",
  ]);
  assert.ok(typeof state === "string" && state.includes("fix the bug"));
  const p = assessTaskJev("fix the bug", {
    llm: true,
    call: () => ({
      answers: {
        inputs_outputs: { type: "noul", noul: 0.2 },
        target_scope: { type: "noul", noul: 0.9 },
        success_criteria: { type: "noul", noul: 0.3 },
        constraints: { type: "noul", noul: 0.8 },
      },
    }),
  });
  assert.ok(
    Math.abs(p.completeness - 0.55) < 1e-9,
    `mean of the four nouls, got ${p.completeness}`,
  );
  assert.deepEqual(p.missing.sort(), ["inputs_outputs", "success_criteria"]);
  assert.deepEqual(p.questions, [], "System One judges; it does not author clarifying questions");
  assert.equal(p.provider, "jev");
  // A dimension the API dropped → the whole reading fails safe.
  assert.equal(
    assessTaskJev("x", {
      llm: true,
      call: () => ({ answers: { inputs_outputs: { type: "noul", noul: 0.5 } } }),
    }),
    null,
  );
});

test("preflightRepo (llm on): the Jev reading flows through reconcileAssumption with provenance", () => {
  const root = fixture();
  const r = preflightRepo(root, "fix the login bug", {
    allowBuild: false,
    llm: true,
    jevCall: () => ({
      answers: {
        inputs_outputs: { type: "noul", noul: 0.9 },
        target_scope: { type: "noul", noul: 0.9 },
        success_criteria: { type: "noul", noul: 0.9 },
        constraints: { type: "noul", noul: 0.9 },
      },
    }),
  });
  assert.equal(r.assumption.provenance.provider, "jev");
  // Verify-don't-trust: the Jev reading (0.9) is bounded to within ±band of the
  // deterministic completeness — it lifts, but can never flip the gate on its own.
  const det = preflightRepo(root, "fix the login bug", { allowBuild: false, llm: false });
  assert.ok(
    r.assumption.completeness > det.assumption.completeness,
    `lifts past deterministic ${det.assumption.completeness}, got ${r.assumption.completeness}`,
  );
  assert.ok(
    r.assumption.completeness <= det.assumption.completeness + 0.25 + 1e-9,
    "but never beyond the reconcile band",
  );
});

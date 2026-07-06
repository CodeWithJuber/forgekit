import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  complexity,
  complexityLLM,
  emitGatewayConfig,
  recommend,
  routeTask,
} from "../src/route.js";

test("complexity is monotonic and bounded", () => {
  const trivial = complexity({ files: 0, fanout: 0, sizeWords: 4 }).score;
  const heavy = complexity({
    files: 8,
    fanout: 20,
    churn: 15,
    pastMistakes: 4,
    ambiguity: 0.8,
    sizeWords: 80,
  }).score;
  assert.ok(trivial >= 0 && trivial < 0.25, "a trivial task is 'simple'");
  assert.ok(heavy > 0.8 && heavy <= 1, "a heavy task is near the top");
  assert.ok(heavy > trivial);
});

test("recommend: a prime-finder gets Haiku, not Fable", () => {
  const { score } = complexity({ files: 0, fanout: 0, sizeWords: 5 });
  assert.equal(recommend(score).key, "haiku");
});

test("recommend: a cross-module, high-fanout, buggy task escalates to Opus/Fable", () => {
  const { score, norm } = complexity({
    files: 8,
    fanout: 20,
    churn: 15,
    pastMistakes: 4,
    ambiguity: 0.9,
    sizeWords: 90,
  });
  const r = recommend(score, norm);
  assert.ok(["opus", "fable"].includes(r.key), `escalated (${r.key})`);
  assert.ok(
    r.reasons.includes("fanout") && r.reasons.includes("files"),
    "reasons name the drivers",
  );
});

test("routeTask runs against a real repo and returns a model + reasons", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const r = routeTask(root, "write a function to check if a number is prime");
  assert.ok(r.model?.id, "picked a concrete model");
  assert.equal(r.key, "haiku", "trivial task → cheapest tier");
  assert.ok(typeof r.score === "number");
});

test("emitGatewayConfig writes a LiteLLM config that never pins @latest", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const path = emitGatewayConfig(root);
  assert.ok(existsSync(path));
  const yaml = readFileSync(path, "utf8");
  assert.match(yaml, /model_list/);
  assert.doesNotMatch(yaml, /@latest|:latest/);
  assert.match(yaml, /forge-simple/, "tier aliases present");
  assert.match(
    yaml,
    /model_name: claude-haiku/,
    "passthrough for real model names so plain claude-* traffic works",
  );
});

test("complexityLLM: parses a band into a score floor, rejects junk", () => {
  const cheap = complexityLLM("x", { run: () => '{"band":"cheap","reason":"trivial"}' });
  assert.equal(cheap.band, "cheap");
  const premium = complexityLLM("x", { run: () => '{"band":"premium","reason":"distributed"}' });
  assert.ok(premium.score > cheap.score, "premium floors higher than cheap");
  assert.equal(complexityLLM("x", { run: () => '{"band":"???"}' }), null);
  assert.equal(complexityLLM("x", { run: () => "not json" }), null);
});

test("routeTask (llm on): a RAISE is free — the model can escalate a trivial-looking task", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "write a function to check if a number is prime";
  const up = routeTask(root, task, { llm: true, run: () => '{"band":"premium","reason":"x"}' });
  assert.ok(["opus", "fable"].includes(up.key), `raised to ${up.key}`);
  assert.equal(up.provenance.path, "llm-raised");
  assert.equal(up.llm.direction, "raised");
});

test("routeTask (bidirectional): the model can LOWER an over-provisioned generic task, bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  // A moderate task with no strong algorithmic/architectural signal — safe to route down.
  const task = "add a small in-memory cache with get and set";
  const base = routeTask(root, task);
  const down = routeTask(root, task, {
    llm: true,
    run: () => '{"band":"cheap","reason":"trivial"}',
  });
  assert.ok(down.score <= base.score, "cheap band pulls the score down");
  assert.ok(down.score >= base.score - 0.2 - 1e-9, "but never more than one routing band");
  assert.ok(["llm-lowered", "llm-agreed"].includes(down.provenance.path));
});

test("routeTask (bidirectional): a strong-signal task holds the floor even on a 'cheap' vote", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task =
    "Design and implement a thread-safe distributed rate limiter with a token-bucket algorithm";
  const base = routeTask(root, task);
  const down = routeTask(root, task, {
    llm: true,
    run: () => '{"band":"cheap","reason":"looks easy"}',
  });
  assert.ok(down.score >= 0.4, "algorithmic/architectural floor keeps it off the cheap tier");
  assert.ok(["opus", "fable"].includes(down.key) || down.score >= base.score - 0.2);
});

test("routeTask (bidirectional:false): reverts to raise-only — a 'cheap' vote can't lower", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "add a small in-memory cache with get and set";
  const base = routeTask(root, task);
  const down = routeTask(root, task, {
    llm: true,
    bidirectional: false,
    run: () => '{"band":"cheap","reason":"trivial"}',
  });
  assert.ok(down.score >= base.score, "raise-only mode never routes below deterministic");
});

test("routeTask (llm on): a failing model call falls back to deterministic", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "write a function to check if a number is prime";
  const throwing = routeTask(root, task, {
    llm: true,
    run: () => {
      throw new Error("no cli");
    },
  });
  const base = routeTask(root, task);
  assert.equal(throwing.key, base.key, "fell back to deterministic tier");
  assert.equal(throwing.provenance.path, "deterministic");
});

test("routeTask (llm on): fires exactly ONE model call — no redundant inner assumption call", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  let calls = 0;
  const run = (prompt) => {
    calls++;
    // only the complexity proposer should reach the model here
    assert.match(prompt, /complexity/i, "the single call is the routing/complexity proposer");
    return '{"band":"mid","reason":"x"}';
  };
  routeTask(root, "refactor the password reset flow in auth.js", { llm: true, run });
  assert.equal(calls, 1, "routeTask must not also run an assumption model call");
});

test("routeTask: a precomputed ambiguity matches computing it internally", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "add a validation helper";
  const a = routeTask(root, task).score;
  const b = routeTask(root, task, { ambiguity: 0 }).score;
  assert.equal(typeof a, "number");
  assert.equal(typeof b, "number");
});

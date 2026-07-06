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

test("routeTask (llm on): the model may only RAISE the tier, never lower it", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "write a function to check if a number is prime";
  // Model says 'premium' on a trivial task → routing escalates (safe direction).
  const up = routeTask(root, task, { llm: true, run: () => '{"band":"premium","reason":"x"}' });
  assert.ok(["opus", "fable"].includes(up.key), `raised to ${up.key}`);
  assert.equal(up.provenance.path, "llm-verified");
  assert.equal(up.llm.raised, true);
  // Model says 'cheap' → cannot pull a task below the deterministic floor.
  const down = routeTask(root, task, { llm: true, run: () => '{"band":"cheap","reason":"x"}' });
  const base = routeTask(root, task);
  assert.ok(down.score >= base.score, "cheap band never routes below deterministic");
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

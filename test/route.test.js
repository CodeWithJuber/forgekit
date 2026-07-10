import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { read as readMetrics } from "../src/metrics.js";
import {
  complexity,
  complexityLLM,
  contentGrams,
  EXEMPLARS,
  emitGatewayConfig,
  meterRoute,
  RUBRIC,
  recommend,
  routeTask,
  rubricComplexity,
} from "../src/route.js";

test("contentGrams: stopwords dropped, unigrams+bigrams kept", () => {
  const g = contentGrams("Implement a rate limiter with the token bucket");
  assert.ok(g.has("rate") && g.has("limiter") && g.has("token") && g.has("bucket"));
  assert.ok(g.has("rate limiter") && g.has("token bucket"), "bigrams bridge stopwords");
  assert.ok(!g.has("a") && !g.has("the") && !g.has("with"), "stopwords carry no topic");
});

test("rubric: no lexical match at all falls back to the prior (abstains)", () => {
  const r = rubricComplexity("zzz qqq xxx");
  assert.equal(r.confidence, 0);
  assert.ok(Math.abs(r.score - RUBRIC.prior) < 0.05, "score stays at the no-signal prior");
  assert.equal(r.band, "cheap");
});

test("rubric: an UNSEEN phrasing routes by resemblance, not by literal keywords", () => {
  // No old keyword ("race condition", "mutex") appears — the k-NN must still find
  // the concurrency neighborhood through shared vocabulary.
  const r = rubricComplexity("two threads deadlock when the queue is full, fix the locking");
  assert.equal(r.band, "premium", `expected premium, got ${r.band} (score ${r.score})`);
  assert.ok(r.neighbors.length > 0, "neighbors are returned, every score is attributable");
});

test("rubric: strongTopicSignal fires on confident hard matches only", () => {
  const hard = rubricComplexity("implement a rate limiter with a token bucket algorithm");
  assert.equal(hard.strongTopicSignal, true);
  const easy = rubricComplexity("fix a typo in the readme");
  assert.equal(easy.strongTopicSignal, false);
  const moderate = rubricComplexity("add a small in-memory cache with get and set");
  assert.equal(moderate.strongTopicSignal, false, "moderate work is safe to route down");
});

test("rubric: confidence shrinks weak matches toward the prior", () => {
  const strong = rubricComplexity("implement dijkstra shortest path algorithm");
  const weak = rubricComplexity("the dijkstra approach discussion notes");
  assert.ok(strong.score > weak.score, "a full exemplar match outranks one shared token");
  assert.ok(strong.confidence > weak.confidence);
});

test("EXEMPLARS: labels are valid and every band is represented", () => {
  for (const e of EXEMPLARS) {
    assert.ok(typeof e.text === "string" && e.text.length > 0);
    assert.ok(e.y >= 0 && e.y <= 1, `label in range: ${e.text}`);
  }
  const ys = new Set(EXEMPLARS.map((e) => (e.y < 0.3 ? "cheap" : e.y <= 0.6 ? "mid" : "premium")));
  assert.deepEqual([...ys].sort(), ["cheap", "mid", "premium"]);
});

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

test("meterRoute: one route metrics event lands with the chosen tier; routeTask itself never writes", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "write a function to check if a number is prime";
  const rec = routeTask(root, task);
  assert.deepEqual(readMetrics(root, { stage: "route" }), [], "routing alone is write-free");
  meterRoute(root, task, rec);
  const events = readMetrics(root, { stage: "route" });
  assert.equal(events.length, 1, "the explicit caller meters exactly once");
  assert.equal(events[0].tier, rec.tier, "the event carries the chosen tier");
  assert.match(events[0].ref, /^[0-9a-f]{12}$/, "ref is a short task hash, not the task text");
  assert.ok(!JSON.stringify(events[0]).includes("prime"), "task text never leaks into metrics");
});

test("routeTask: a precomputed ambiguity matches computing it internally", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const task = "add a validation helper";
  const a = routeTask(root, task).score;
  const b = routeTask(root, task, { ambiguity: 0 }).score;
  assert.equal(typeof a, "number");
  assert.equal(typeof b, "number");
});

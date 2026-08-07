import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collideReport, collisions } from "../src/collide.js";
import { mintClaim } from "../src/ledger.js";
import { putClaim } from "../src/ledger_store.js";
import { importGraph } from "../src/scope.js";

const dir = () => mkdtempSync(join(tmpdir(), "forge-collide-"));

const summary = (files, author, t) =>
  mintClaim({
    kind: "summary",
    body: { files, text: `session by ${author}` },
    scope: { level: "repo" },
    provenance: { agent: "deja", author },
    t,
  }).claim;

const graphOf = (edges) => ({
  nodes: [...new Set(Object.keys(edges))],
  edges: new Map(Object.entries(edges).map(([k, v]) => [k, new Set(v)])),
});

test("collisions flags direct overlap full-strength and import-coupled overlap at half", () => {
  const g = graphOf({ "a.js": ["b.js"], "b.js": ["a.js"], "c.js": [] });
  const direct = collisions([summary(["a.js"], "amina", 10)], ["a.js"], g, {
    nowDay: 10,
  });
  const coupled = collisions([summary(["b.js"], "amina", 10)], ["a.js"], g, {
    nowDay: 10,
  });
  assert.equal(direct.sessions[0].direct.length, 1);
  assert.equal(coupled.sessions[0].coupled.length, 1);
  assert.ok(
    direct.risk > coupled.risk,
    "touching my exact file is riskier than touching its import neighbor",
  );
  const unrelated = collisions([summary(["c.js"], "amina", 10)], ["a.js"], g, {
    nowDay: 10,
  });
  assert.equal(unrelated.sessions.length, 0, "an uncoupled file is no collision at all");
});

test("collisions decays with recency and skips my own sessions and tombstoned summaries", () => {
  const g = graphOf({ "a.js": [] });
  const fresh = collisions([summary(["a.js"], "amina", 10)], ["a.js"], g, {
    nowDay: 10,
  });
  const stale = collisions([summary(["a.js"], "amina", 10)], ["a.js"], g, {
    nowDay: 40,
  });
  assert.ok(fresh.risk > stale.risk, "a month-old session is barely a collision");
  const mine = collisions([summary(["a.js"], "me", 10)], ["a.js"], g, {
    nowDay: 10,
    author: "me",
  });
  assert.equal(mine.sessions.length, 0, "my own past session is not a collision");
  const dead = { ...summary(["a.js"], "amina", 10), tombstone: { t: 11 } };
  assert.equal(
    collisions([dead], ["a.js"], g, { nowDay: 10 }).sessions.length,
    0,
    "retracted summaries are ignored",
  );
});

test("collisions relativizes absolute hook-minted paths against root (production shape)", () => {
  const g = graphOf({ "src/a.js": [] });
  const abs = summary(["/home/u/repo/src/a.js"], "amina", 10);
  const r = collisions([abs], ["src/a.js"], g, {
    nowDay: 10,
    root: "/home/u/repo",
  });
  assert.equal(r.sessions.length, 1, "the absolute claim path matches after relativization");
  assert.deepEqual(r.sessions[0].direct, ["src/a.js"]);
});

test("risk composes by noisy-OR — two half-risks beat either alone but stay under 1", () => {
  const g = graphOf({ "a.js": [], "x.js": [] });
  // mine = 2 files, each session touches 1 → strength 0.5 per session
  const mine = ["a.js", "x.js"];
  const two = collisions([summary(["a.js"], "amina", 10), summary(["x.js"], "sami", 10)], mine, g, {
    nowDay: 10,
  });
  const one = collisions([summary(["a.js"], "amina", 10)], mine, g, {
    nowDay: 10,
  });
  assert.equal(one.risk, 0.5, "one half-strength session → risk 0.5");
  assert.equal(two.risk, 0.75, "noisy-OR: 1 − (1−0.5)² — compounds, never counts");
  assert.ok(two.risk < 1, "risk is a probability, not a count");
});

test("collideReport is fail-open end-to-end and finds a real ledger session on disk", () => {
  const root = dir();
  writeFileSync(join(root, "a.js"), 'import "./b.js";\nexport const a = 1;\n');
  writeFileSync(join(root, "b.js"), "export const b = 1;\n");
  assert.deepEqual(
    collideReport(root, { files: [] }).sessions ?? [],
    [],
    "no git, no ledger → quiet empty report, never a throw",
  );
  const today = 20670;
  putClaim(join(root, ".forge", "ledger"), summary(["b.js"], "amina", today));
  const r = collideReport(root, { files: ["a.js"] });
  assert.equal(r.mine.length, 1);
  assert.ok(
    r.sessions.some((s) => s.coupled.includes("b.js")),
    "the teammate's session on the imported file is surfaced as coupled",
  );
  assert.ok(importGraph(root).edges.get("a.js").has("b.js"), "via the real import graph");
});

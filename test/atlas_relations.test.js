// Review finding A2: the impact traversal was reverse-only (the empirical refutation's
// Defect 2). These pin the ported SIBLING and FORWARD relations and their FROZEN
// parameters (sibling: 1 forward + 1 reverse hop, weight 0.7, bridge in-degree cap 100;
// forward: ≤2 hops, weight 0.5 — research/empirical-refutation replication package,
// FROZEN_PARAMETERS.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, IMPACT_RELATIONS, impact } from "../src/atlas.js";

// These pin the sibling/forward CAPABILITY, so they ask for it explicitly: the shipped
// DEFAULT is reverse-only (the wide walk quadruples the radius — see the default test at
// the end of this file and `forge impact --all-relations`).
const ALL = IMPACT_RELATIONS;

import { sibFiles, writeRepo } from "./fixtures/impact_repos.mjs";

const mod = (name) => ({ id: `module:${name}`, name, kind: "module", file: `${name}.js` });
const imp = (a, b) => ({
  source: `module:${a}`,
  target: `module:${b}`,
  kind: "imports",
  confidence: 1,
});
const graph = (names, edges) => ({ nodes: names.map(mod), edges, symbols: [] });
const item = (r, file) => r.impacted.find((x) => x.node.file === file);
const near = (a, b) => Math.abs(a - b) < 1e-3;
// one hop at edge confidence 1: imports weight 0.85 × decay 0.85
const HOP = 0.85 * 0.85;

test("A2: serializer.js finds its sibling deserializer.js through the shared wire_format.js", () => {
  const atlas = build({ root: writeRepo(sibFiles) });
  const r = impact(atlas, "src/serializer.js", { relations: ALL });
  assert.equal(item(r, "src/app.js")?.relation, "reverse");
  assert.equal(item(r, "src/deserializer.js")?.relation, "sibling", JSON.stringify(r.relations));
  assert.equal(item(r, "src/wire_format.js")?.relation, "forward");
  const reverseOnly = impact(atlas, "src/serializer.js", { relations: ["reverse"] });
  assert.deepEqual(
    reverseOnly.impactedFiles.filter((f) => f !== "src/serializer.js"),
    ["src/app.js"],
    "relations:['reverse'] reproduces the old reverse-only answer",
  );
});

test("A2: sibling and forward confidences use the frozen weights", () => {
  // a → c ← b (b is a's sibling via c); c → d → f (forward chain from a)
  const atlas = graph(
    ["a", "b", "c", "d", "f"],
    [imp("a", "c"), imp("b", "c"), imp("c", "d"), imp("d", "f")],
  );
  const r = impact(atlas, "a.js", { threshold: 0.01, relations: ALL });
  const b = item(r, "b.js");
  assert.equal(b?.relation, "sibling");
  assert.ok(near(b.confidence, HOP * HOP * 0.7), `sibling ${b.confidence}`);
  assert.ok(near(item(r, "c.js").confidence, HOP * 0.5), "forward hop 1 × 0.5");
  assert.ok(near(item(r, "d.js").confidence, HOP * HOP * 0.5), "forward hop 2 × 0.5");
  assert.equal(item(r, "f.js"), undefined, "forward stops at 2 hops");
  assert.equal(b.hopDistance, null, "hopDistance stays the REVERSE distance");
  assert.equal(b.relationHops, 2);
});

test("A2: sibling and forward nodes are terminal — never expanded further", () => {
  // e depends on sibling b; g depends on forward-reached d. Neither is in a's radius.
  const atlas = graph(
    ["a", "b", "c", "d", "e", "g"],
    [imp("a", "c"), imp("b", "c"), imp("a", "d"), imp("e", "b"), imp("g", "d")],
  );
  const r = impact(atlas, "a.js", { threshold: 0.01, relations: ALL });
  assert.ok(item(r, "b.js"), "sibling found");
  assert.ok(item(r, "d.js"), "forward found");
  assert.equal(item(r, "e.js"), undefined, "a sibling's dependents are not expanded");
  assert.equal(item(r, "g.js")?.relation, "sibling", "g shares d with a: a sibling, not more");
});

test("A2: a bridge used by more than 100 other files is a hub and yields no siblings", () => {
  const withUsers = (n) => {
    const names = ["a", "hub", ...Array.from({ length: n }, (_, i) => `u${i}`)];
    const edges = [imp("a", "hub"), ...names.slice(2).map((u) => imp(u, "hub"))];
    return impact(graph(names, edges), "a.js", { threshold: 0.01, relations: ALL });
  };
  const under = withUsers(99); // hub in-degree 100 (a + 99): at the cap → still a bridge
  assert.equal(under.relations.sibling, 99);
  const over = withUsers(100); // in-degree 101 → hub, skipped
  assert.equal(over.relations.sibling ?? 0, 0);
  assert.ok(item(over, "hub.js"), "the hub itself is still a forward dependency");
});

test("A2: docs and configs are never siblings", () => {
  const atlas = graph(["a", "c"], [imp("a", "c")]);
  atlas.nodes.push({ id: "doc:README.md", name: "README.md", kind: "doc", file: "README.md" });
  atlas.edges.push({
    source: "doc:README.md",
    target: "module:c",
    kind: "references",
    confidence: 1,
  });
  const r = impact(atlas, "a.js", { threshold: 0.01, relations: ALL });
  assert.equal(item(r, "README.md"), undefined);
});

test("the DEFAULT walk is reverse-only — the wide relations are opt-in", () => {
  // The sibling/forward rules are a recall instrument: on forgekit itself they take the
  // median answer from 15 files to 78 of ~450. `forge impact` stays focused by default.
  const atlas = build({ root: writeRepo(sibFiles) });
  const byDefault = impact(atlas, "src/serializer.js").impactedFiles.filter(
    (f) => f !== "src/serializer.js",
  );
  assert.deepEqual(byDefault, ["src/app.js"], "default names only real importers");
  const wide = impact(atlas, "src/serializer.js", { relations: ALL }).impactedFiles;
  assert.ok(wide.includes("src/deserializer.js"), "the sibling is still reachable on request");
});

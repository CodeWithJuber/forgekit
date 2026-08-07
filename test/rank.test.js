import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "../src/atlas.js";
import { mintClaim } from "../src/ledger.js";
import { appendEvidence, putClaim, repoLedger } from "../src/ledger_store.js";
import { centrality, chokepoints, cycles, history, pagerank, rankReport } from "../src/rank.js";
import { directedImportGraph, importGraph } from "../src/scope.js";

// Synthetic atlas: three modules all call into util — util must out-rank everything.
const hubAtlas = () => ({
  nodes: [
    { id: "a.js::fa", name: "fa", kind: "function", file: "a.js" },
    { id: "b.js::fb", name: "fb", kind: "function", file: "b.js" },
    { id: "c.js::fc", name: "fc", kind: "function", file: "c.js" },
    { id: "util.js::help", name: "help", kind: "function", file: "util.js" },
  ],
  edges: [
    { source: "a.js::fa", target: "util.js::help", kind: "calls" },
    { source: "b.js::fb", target: "util.js::help", kind: "calls" },
    { source: "c.js::fc", target: "util.js::help", kind: "calls" },
  ],
  symbols: [],
});

test("pagerank ranks the symbol every module depends on above the leaves, scores sum to 1", () => {
  const scores = pagerank(hubAtlas());
  const util = scores.get("util.js::help");
  for (const leaf of ["a.js::fa", "b.js::fb", "c.js::fc"])
    assert.ok(util > scores.get(leaf), `depended-upon hub out-ranks ${leaf}`);
  const sum = [...scores.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `scores form a distribution (sum=${sum})`);
});

test("pagerank is deterministic — two runs are identical and symmetric nodes tie exactly", () => {
  const a = pagerank(hubAtlas());
  const b = pagerank(hubAtlas());
  assert.deepEqual([...a.entries()], [...b.entries()], "identical input → identical output");
  assert.equal(a.get("a.js::fa"), a.get("b.js::fb"), "structurally symmetric nodes score equal");
});

test("centrality aggregates node scores per file and keeps only definition symbols", () => {
  const atlas = hubAtlas();
  atlas.nodes.push({
    id: "module:util.js",
    name: "util.js",
    kind: "module",
    file: "util.js",
  });
  const { files, symbols } = centrality(atlas);
  assert.equal(files[0].file, "util.js", "hub file ranks first");
  assert.ok(
    symbols.every((s) => s.name !== "util.js"),
    "module nodes stay out of the symbol view",
  );
  assert.equal(symbols[0].name, "help", "hub symbol ranks first");
});

test("cycles finds the a⇄b import cycle and leaves the acyclic file out", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-rank-"));
  writeFileSync(join(root, "a.js"), 'import "./b.js";\nexport const a = 1;\n');
  writeFileSync(join(root, "b.js"), 'import "./a.js";\nexport const b = 1;\n');
  writeFileSync(join(root, "c.js"), 'import "./a.js";\nexport const c = 1;\n');
  const comps = cycles(directedImportGraph(root));
  assert.deepEqual(comps, [["a.js", "b.js"]], "exactly the mutual-import pair, sorted");
});

test("chokepoints flags the bridge file between two clusters, not the leaves", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-rank-"));
  // a ↔ bridge ↔ b : removing bridge.js disconnects a.js from b.js.
  writeFileSync(join(root, "a.js"), 'import "./bridge.js";\nexport const a = 1;\n');
  writeFileSync(join(root, "bridge.js"), 'import "./b.js";\nexport const bridge = 1;\n');
  writeFileSync(join(root, "b.js"), "export const b = 1;\n");
  const points = chokepoints(importGraph(root));
  assert.deepEqual(
    points.map((p) => p.file),
    ["bridge.js"],
    "only the articulation point is a chokepoint",
  );
  assert.ok(points[0].splits >= 1, "it splits off at least one subtree");
});

test("history weighs files named by lesson globs and summary file lists; empty ledger → zeros", () => {
  const lesson = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: "never edit generated files by hand",
      trigger: {
        action: "edit",
        files: ["src/gen/*.js"],
        keywords: [],
        symbols: [],
      },
      whatWentWrong: "hand-edited a generated file",
    },
    scope: { level: "repo" },
    provenance: { author: "amina" },
    t: 10,
  }).claim;
  lesson.evidence = [
    {
      oracle: "test.run",
      result: "confirm",
      ref: "test:unit",
      t: 10,
      author: "sami",
    },
  ];
  const summary = mintClaim({
    kind: "summary",
    body: { files: ["src/app.js"], text: "fixed the login flow" },
    scope: { level: "repo" },
    provenance: { author: "amina" },
    t: 10,
  }).claim;
  const files = ["src/gen/out.js", "src/app.js", "src/quiet.js"];
  const h = history([lesson, summary], files, 10);
  assert.ok(h.get("src/gen/out.js").weight > 0, "glob-matched file carries lesson weight");
  assert.equal(h.get("src/gen/out.js").hits, 1);
  assert.ok(h.get("src/app.js").weight > 0, "summary-listed file carries weight");
  assert.equal(h.get("src/quiet.js").weight, 0, "unnamed file carries none");
  const empty = history([], files, 10);
  assert.ok(
    files.every((f) => empty.get(f).weight === 0),
    "no claims → all zeros (fail-open)",
  );
});

test("rankReport without an atlas reports built:false", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-rank-"));
  assert.deepEqual(rankReport(root), { built: false });
});

test("rankReport ranks a historied file above an equally-central clean one (the hazard join)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-rank-"));
  // Two symmetric leaf files import the same hub — identical centrality by construction.
  writeFileSync(join(root, "hub.js"), "export const hub = 1;\n");
  writeFileSync(join(root, "left.js"), 'import "./hub.js";\nexport function leftFn(){}\n');
  writeFileSync(join(root, "right.js"), 'import "./hub.js";\nexport function rightFn(){}\n');
  build({ root });
  // A verified lesson names left.js — the join must break the structural tie.
  const minted = mintClaim({
    kind: "lesson",
    body: {
      correctedBehavior: "guard the left path",
      trigger: {
        action: "edit",
        files: ["left.js"],
        keywords: [],
        symbols: [],
      },
      whatWentWrong: "left.js regressed twice",
    },
    scope: { level: "repo" },
    provenance: { author: "amina" },
    t: 1,
  });
  putClaim(repoLedger(root), minted.claim);
  appendEvidence(repoLedger(root), minted.claim.id, {
    oracle: "test.run",
    result: "confirm",
    ref: "test:left",
    t: 1,
    author: "sami",
  });
  const r = rankReport(root, { top: 10 });
  const left = r.topFiles.find((f) => f.file === "left.js");
  const right = r.topFiles.find((f) => f.file === "right.js");
  assert.ok(left && right, "both leaves are in the report");
  assert.equal(left.score, right.score, "structure alone cannot tell them apart");
  assert.ok(left.history > 0 && right.history === 0, "history is the discriminator");
  assert.ok(left.hazard > right.hazard, "the historied file carries the higher hazard");
  assert.ok(
    r.topFiles.findIndex((f) => f.file === "left.js") <
      r.topFiles.findIndex((f) => f.file === "right.js"),
    "hazard ordering surfaces the historied file first",
  );
});

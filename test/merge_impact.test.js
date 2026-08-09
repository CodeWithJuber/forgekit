import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMergeImpact } from "../src/merge_impact.js";

const artifact = (id, kind = "source", criticality = 0) => ({ id, kind, criticality });
const relation = (from, to, kind, confidence = 1) => ({ from, to, kind, confidence });

test("ForgeKit 98ce7ece formatting-only test edit stays low risk", () => {
  const result = analyzeMergeImpact({
    artifacts: [artifact("test/cortex_mcp.test.js", "test")],
    changes: [
      {
        artifact: "test/cortex_mcp.test.js",
        kind: "formatting",
        linesChanged: 4,
      },
    ],
  });
  assert.equal(result.level, "low");
  assert.ok(result.risk < 0.12, `risk=${result.risk}`);
  assert.deepEqual(result.obligations.docs, []);
});

test("single-line public API edit fans into consumers, tests, and docs", () => {
  const artifacts = [
    artifact("src/atlas.js", "source", 0.9),
    artifact("src/substrate.js", "source", 0.8),
    artifact("src/imagine.js", "source", 0.5),
    artifact("test/atlas.test.js", "test"),
    artifact("docs/GUIDE.md", "documentation"),
    artifact("README.md", "documentation"),
  ];
  const relations = [
    relation("src/atlas.js", "src/substrate.js", "imports", 0.98),
    relation("src/atlas.js", "src/imagine.js", "imports", 0.95),
    relation("src/atlas.js", "test/atlas.test.js", "verified_by"),
    relation("src/atlas.js", "docs/GUIDE.md", "documented_by", 0.95),
    relation("src/atlas.js", "README.md", "documented_by", 0.8),
  ];
  const result = analyzeMergeImpact({
    artifacts,
    relations,
    changes: [{ artifact: "src/atlas.js", kind: "public_api", linesChanged: 1 }],
  });
  const ids = new Set(result.impacted.map((item) => item.id));
  for (const id of artifacts.map((item) => item.id)) assert.ok(ids.has(id), id);
  assert.ok(result.obligations.tests.includes("test/atlas.test.js"));
  assert.ok(result.obligations.docs.includes("docs/GUIDE.md"));
  assert.ok(
    result.impacted.find((item) => item.id === "test/atlas.test.js").dimensions.verification > 0.7,
  );
  assert.ok(result.impacted.find((item) => item.id === "docs/GUIDE.md").dimensions.docs > 0.6);
});

test("ForgeKit d0f11aa docs renderer change predicts generated MDX surfaces and its test", () => {
  const docs = [
    "ARCHITECTURE.md",
    "mintlify/cli/overview.mdx",
    "mintlify/concepts/config-compiler.mdx",
    "mintlify/concepts/pre-action-gate.mdx",
    "mintlify/concepts/proof-carrying-memory.mdx",
    "mintlify/guides/team-memory.mdx",
    "mintlify/guides/zero-config-onboarding.mdx",
  ];
  const artifacts = [
    artifact("src/docs_render.js", "source", 0.65),
    artifact("src/docs_check.js", "source", 0.6),
    artifact("test/docs_render.test.js", "test"),
    ...docs.map((id) => artifact(id, "documentation")),
  ];
  const relations = [
    relation("src/docs_render.js", "test/docs_render.test.js", "verified_by"),
    ...docs.map((id) => relation("src/docs_render.js", id, "generates", 0.96)),
    ...docs.map((id) => relation("src/docs_check.js", id, "documented_by", 0.72)),
  ];
  const result = analyzeMergeImpact({
    artifacts,
    relations,
    changes: [
      {
        artifact: "src/docs_render.js",
        kind: "logic",
        linesChanged: 5,
        signal: { docs: 0.65 },
      },
      {
        artifact: "src/docs_check.js",
        kind: "logic",
        linesChanged: 6,
        signal: { docs: 0.55 },
      },
    ],
  });
  for (const id of docs) assert.ok(result.obligations.docs.includes(id), id);
  assert.ok(result.obligations.tests.includes("test/docs_render.test.js"));
  assert.ok(result.breadth > 0.4, `breadth=${result.breadth}`);
});

test("independent changed roots combine with noisy-OR instead of max-only propagation", () => {
  const artifacts = [artifact("a.js"), artifact("b.js"), artifact("consumer.js")];
  const relations = [
    relation("a.js", "consumer.js", "historical_coupling"),
    relation("b.js", "consumer.js", "historical_coupling"),
  ];
  const one = analyzeMergeImpact({
    artifacts,
    relations,
    changes: [{ artifact: "a.js", kind: "logic" }],
  });
  const two = analyzeMergeImpact({
    artifacts,
    relations,
    changes: [
      { artifact: "a.js", kind: "logic" },
      { artifact: "b.js", kind: "logic" },
    ],
  });
  const oneProbability = one.impacted.find(
    (item) => item.id === "consumer.js",
  ).dimensions.runtime;
  const twoProbability = two.impacted.find(
    (item) => item.id === "consumer.js",
  ).dimensions.runtime;
  assert.ok(twoProbability > oneProbability, `${twoProbability} <= ${oneProbability}`);
});

test("cycle cannot self-amplify a single seed", () => {
  const artifacts = [artifact("a.js"), artifact("b.js")];
  const relations = [
    relation("a.js", "b.js", "imports"),
    relation("b.js", "a.js", "imports"),
  ];
  const result = analyzeMergeImpact({
    artifacts,
    relations,
    changes: [{ artifact: "a.js", kind: "logic" }],
    decay: 0.9,
  });
  const a = result.impacted.find((item) => item.id === "a.js").dimensions.runtime;
  const b = result.impacted.find((item) => item.id === "b.js").dimensions.runtime;
  assert.ok(a < 0.9 && b < a, `a=${a} b=${b}`);
  assert.equal(result.truncated, false);
});

test("high-severity orphan is uncertainty, never declared safe", () => {
  const result = analyzeMergeImpact({
    artifacts: [artifact("unknown/schema.json", "schema")],
    changes: [{ artifact: "unknown/schema.json", kind: "schema", linesChanged: 1 }],
  });
  assert.ok(result.uncertainty > 0.5, `uncertainty=${result.uncertainty}`);
  assert.notEqual(result.level, "low");
});

test("documentation relation creates docs risk without pretending runtime execution", () => {
  const result = analyzeMergeImpact({
    artifacts: [artifact("src/api.js"), artifact("README.md", "documentation")],
    changes: [{ artifact: "src/api.js", kind: "public_api", linesChanged: 1 }],
    relations: [relation("src/api.js", "README.md", "documented_by")],
  });
  const doc = result.impacted.find((item) => item.id === "README.md");
  assert.ok(doc.dimensions.docs > 0.7);
  assert.equal(doc.dimensions.runtime, 0);
});

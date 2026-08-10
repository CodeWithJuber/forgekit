import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeDiffImpact,
  artifactKind,
  atlasEvidence,
  classifyChangedFile,
} from "../src/merge_impact_adapter.js";

const node = (id, file, kind = "module") => ({ id, file, kind, name: id });

test("real ForgeKit formatting commit is classified as formatting", () => {
  const change = classifyChangedFile({
    filename: "test/cortex_mcp.test.js",
    additions: 3,
    deletions: 1,
    patch:
      '@@ -1 +1,3 @@\n-const body = readFileSync(file, "utf8");\n+const body = readFileSync(\n+  file,\n+  "utf8",\n+);',
  });
  assert.equal(change.kind, "formatting");
  assert.ok(change.confidence > 0.95);
});

test("one exported-line delta becomes a public contract signal", () => {
  const change = classifyChangedFile({
    filename: "src/atlas.js",
    additions: 1,
    deletions: 1,
    patch:
      "@@ -1 +1 @@\n-export function impact(atlas, target) {\n+export function impact(atlas, target, options = {}) {",
  });
  assert.equal(change.kind, "public_api");
  assert.ok(change.confidence >= 0.85);
});

test("atlas dependency direction is inverted into consequence direction", () => {
  const atlas = {
    nodes: [
      node("module:src.atlas", "src/atlas.js"),
      node("module:src.substrate", "src/substrate.js"),
      node("module:test.atlas", "test/atlas.test.js"),
      node("doc:README.md", "README.md", "doc"),
    ],
    edges: [
      {
        source: "module:src.substrate",
        target: "module:src.atlas",
        kind: "imports",
        confidence: 0.9,
      },
      {
        source: "module:test.atlas",
        target: "module:src.atlas",
        kind: "imports",
        confidence: 0.95,
      },
      {
        source: "doc:README.md",
        target: "module:src.atlas",
        kind: "references",
        confidence: 0.8,
      },
    ],
  };
  const evidence = atlasEvidence(atlas);
  assert.ok(
    evidence.relations.some(
      (item) =>
        item.from === "src/atlas.js" &&
        item.to === "src/substrate.js" &&
        item.kind === "imports",
    ),
  );
  assert.ok(
    evidence.relations.some(
      (item) =>
        item.from === "src/atlas.js" &&
        item.to === "test/atlas.test.js" &&
        item.kind === "verified_by",
    ),
  );
  assert.ok(
    evidence.relations.some(
      (item) =>
        item.from === "src/atlas.js" &&
        item.to === "README.md" &&
        item.kind === "documented_by",
    ),
  );
});

test("automatic diff plus atlas produces test and docs obligations", () => {
  const atlas = {
    nodes: [
      node("module:src.atlas", "src/atlas.js"),
      node("module:src.substrate", "src/substrate.js"),
      node("module:test.atlas", "test/atlas.test.js"),
      node("doc:README.md", "README.md", "doc"),
    ],
    edges: [
      {
        source: "module:src.substrate",
        target: "module:src.atlas",
        kind: "imports",
        confidence: 0.98,
      },
      {
        source: "module:test.atlas",
        target: "module:src.atlas",
        kind: "imports",
        confidence: 0.98,
      },
      {
        source: "doc:README.md",
        target: "module:src.atlas",
        kind: "references",
        confidence: 0.9,
      },
    ],
  };
  const result = analyzeDiffImpact({
    atlas,
    files: [
      {
        filename: "src/atlas.js",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -1 +1 @@\n-export function impact(atlas, target) {\n+export function impact(atlas, target, options = {}) {",
      },
    ],
  });
  assert.equal(result.changes[0].kind, "public_api");
  assert.ok(result.obligations.tests.includes("test/atlas.test.js"));
  assert.ok(result.obligations.docs.includes("README.md"));
  assert.ok(result.impacted.some((item) => item.id === "src/substrate.js"));
});

test("generator evidence carries registry changes into generated documentation", () => {
  const atlas = {
    nodes: [
      node("module:src.commands", "src/commands.js"),
      node("module:src.docs_render", "src/docs_render.js"),
      node("module:test.docs_render", "test/docs_render.test.js"),
    ],
    edges: [
      {
        source: "module:src.docs_render",
        target: "module:src.commands",
        kind: "imports",
        confidence: 0.98,
      },
      {
        source: "module:test.docs_render",
        target: "module:src.docs_render",
        kind: "imports",
        confidence: 0.98,
      },
    ],
  };
  const result = analyzeDiffImpact({
    atlas,
    generatedTargets: {
      "src/docs_render.js": ["README.md", "docs/GUIDE.md"],
    },
    files: [
      {
        filename: "src/commands.js",
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1,2 @@\n export const GROUPS = {\n+  Memory: ["impact"],',
      },
    ],
  });
  assert.ok(result.obligations.docs.includes("README.md"));
  assert.ok(result.obligations.docs.includes("docs/GUIDE.md"));
  assert.ok(result.obligations.tests.includes("test/docs_render.test.js"));
});

test("workflow and manifest paths get distinct change semantics", () => {
  assert.equal(artifactKind(".github/workflows/ci.yml"), "workflow");
  assert.equal(artifactKind("package.json"), "manifest");
  assert.equal(
    classifyChangedFile({ filename: ".github/workflows/ci.yml", patch: "+  run: npm test" }).kind,
    "ci",
  );
  assert.equal(
    classifyChangedFile({
      filename: "package.json",
      patch: '-  "dependencies": {}\n+  "dependencies": {"x":"1.0.0"}',
    }).kind,
    "dependency",
  );
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { components, decompose, importGraph } from "../src/scope.js";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "forge-scope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // src/a.js imports src/b.js  (coupled);  src/c.js is standalone (independent)
  writeFileSync(
    join(root, "src/a.js"),
    'import { b } from "./b.js";\nexport const a = () => b();\n',
  );
  writeFileSync(join(root, "src/b.js"), "export const b = () => 1;\n");
  writeFileSync(join(root, "src/c.js"), "export const c = () => 2;\n");
  return root;
}

test("importGraph links a file to what it imports; components separate the islands", () => {
  const g = importGraph(repo());
  assert.ok(g.edges.get("src/a.js").has("src/b.js"), "a→b edge");
  assert.ok(g.edges.get("src/b.js").has("src/a.js"), "undirected");
  const comps = components(g);
  const sizes = comps.map((c) => c.length).sort();
  assert.deepEqual(sizes, [1, 2], "{a,b} coupled + {c} alone");
});

test("decompose: two unrelated files → two clusters (run as separate sessions)", () => {
  const root = repo();
  const d = decompose(root, ["src/a.js", "src/c.js"]);
  assert.equal(d.independentGroups, 2, "a and c are independent");
});

test("decompose: editing a.js surfaces the coupled file you didn't mention (b.js)", () => {
  const root = repo();
  const d = decompose(root, ["src/a.js"]);
  assert.equal(d.clusters.length, 1);
  assert.deepEqual(d.clusters[0].coupled, ["src/b.js"], "the forgot-related-module guard");
});

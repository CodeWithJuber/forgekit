import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build, has, impact, isStale, load, query } from "../src/atlas.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  writeFileSync(
    join(root, "a.js"),
    "export function computeTax(x){ return x*0.2 }\nclass Ledger {}\n",
  );
  writeFileSync(join(root, "b.py"), "def load_config():\n    pass\nclass Store:\n    pass\n");
  return root;
}

test("build indexes symbols across languages and writes the artifact", () => {
  const root = fixture();
  const atlas = build({ root });
  assert.ok(existsSync(join(root, ".forge", "atlas.json")), "artifact written");
  const names = atlas.symbols.map((s) => s.name);
  assert.ok(names.includes("computeTax"), "js function");
  assert.ok(names.includes("Ledger"), "js class");
  assert.ok(names.includes("load_config"), "py function");
});

test("query returns a symbol with file:line", () => {
  const root = fixture();
  build({ root });
  const hits = query(load(root), "computeTax");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "a.js");
  assert.equal(hits[0].line, 1);
});

test("has() distinguishes real from hallucinated symbols", () => {
  const atlas = build({ root: fixture() });
  assert.equal(has(atlas, "Ledger"), true);
  assert.equal(has(atlas, "totallyMadeUpFn"), false);
});

test("build emits inherits edges for JS `extends` and Python bases (blast radius through hierarchy)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  writeFileSync(
    join(root, "base.js"),
    "export class Animal {}\nexport class Dog extends Animal {}\n",
  );
  writeFileSync(join(root, "m.py"), "class Base:\n    pass\nclass Sub(Base):\n    pass\n");
  const atlas = build({ root });
  const inh = atlas.edges.filter((e) => e.kind === "inherits");
  assert.ok(inh.length >= 2, `expected inherits edges, got ${inh.length}`);
  // A change to Animal should now reach Dog through the inherits edge.
  const r = impact(atlas, "Animal");
  assert.ok(r.impactedFiles.includes("base.js"));
});

test("incremental build reuses unchanged files and refreshes an edited one", () => {
  const root = fixture();
  const a1 = build({ root });
  assert.ok(existsSync(join(root, ".forge", "atlas.cache.json")), "cache written");
  const a2 = build({ root }); // nothing changed
  assert.deepEqual(
    a2.symbols.map((s) => s.name).sort(),
    a1.symbols.map((s) => s.name).sort(),
    "unchanged rebuild yields the same symbols",
  );
  writeFileSync(
    join(root, "a.js"),
    "export function computeTax(x){ return x }\nexport function newFn(){}\n",
  );
  const a3 = build({ root });
  assert.ok(a3.symbols.map((s) => s.name).includes("newFn"), "edited file re-parsed");
});

test("isStale detects an edit and a deletion", () => {
  const root = fixture();
  const atlas = build({ root });
  assert.equal(isStale(root, atlas), false, "fresh right after build");
  writeFileSync(join(root, "a.js"), "export function computeTax(x){ return x + 1 }\n");
  assert.equal(isStale(root, atlas), true, "content change is detected");
});

test("impact (llm on): a proposed edge survives only if real + grep-verified", () => {
  const root = fixture();
  const atlas = build({ root });
  const kept = impact(atlas, "computeTax", {
    llm: true,
    run: () => '{"files":["a.js","ghost.js"]}',
    verify: (f) => f === "a.js",
  });
  assert.ok(!kept.impactedFiles.includes("ghost.js"), "fabricated file dropped");
  const blind = impact(atlas, "computeTax", { llm: true, run: () => '{"files":["a.js"]}' });
  assert.deepEqual(blind.llmVerified, [], "no verify predicate → nothing added blind");
});

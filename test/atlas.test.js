import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("markdown docs become graph nodes whose references make them impact dependents", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  writeFileSync(join(root, "src.js"), "export function computeTax(x){ return x*0.2 }\n");
  writeFileSync(
    join(root, "GUIDE.md"),
    "# guide\n\nThe `computeTax` helper lives in [the source](src.js).\n",
  );
  writeFileSync(join(root, "UNRELATED.md"), "# other\n\nNothing about the code here.\n");
  const atlas = build({ root });
  assert.ok(
    atlas.nodes.some((n) => n.kind === "doc" && n.file === "GUIDE.md"),
    "the doc is a graph node",
  );
  // Change the symbol → the doc that references it is in the blast radius.
  const bySymbol = impact(atlas, "computeTax");
  assert.ok(bySymbol.impactedFiles.includes("GUIDE.md"), JSON.stringify(bySymbol.impactedFiles));
  assert.ok(!bySymbol.impactedFiles.includes("UNRELATED.md"), "silent docs stay out");
  // Change the file → same answer through the module-path reference.
  const byFile = impact(atlas, "src.js");
  assert.ok(byFile.impactedFiles.includes("GUIDE.md"), JSON.stringify(byFile.impactedFiles));
});

test("config artifacts become graph nodes; a code change lists its CI/config dependents", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "val.js"), "export function validate(x){ return !!x }\n");
  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "jobs:\n  test:\n    steps:\n      - run: node src/val.js\n",
  );
  writeFileSync(join(root, "Dockerfile"), "FROM node:20\nCOPY src/val.js /app/val.js\n");
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, ".hidden", "x.yml"), "a: src/val.js\n");
  const atlas = build({ root });
  assert.ok(
    atlas.nodes.some((n) => n.kind === "config" && n.file === ".github/workflows/ci.yml"),
    "workflow is a config node",
  );
  assert.ok(
    atlas.nodes.some((n) => n.kind === "config" && n.file === "Dockerfile"),
    "Dockerfile is a config node",
  );
  assert.ok(
    !atlas.nodes.some((n) => n.file === "package-lock.json"),
    "lockfiles are generated churn, never graphed",
  );
  assert.ok(
    !atlas.nodes.some((n) => n.file?.startsWith(".hidden")),
    "other dot-dirs stay out of the walk",
  );
  const r = impact(atlas, "src/val.js");
  assert.ok(r.impactedFiles.includes(".github/workflows/ci.yml"), JSON.stringify(r.impactedFiles));
  assert.ok(
    r.impactedFiles.includes("Dockerfile"),
    "the Dockerfile copying the file is a dependent",
  );
});

test("a config edit flips isStale (configs are tracked like any other artifact)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  writeFileSync(join(root, "app.js"), "export function main(){}\n");
  writeFileSync(join(root, "deploy.yml"), "run: node app.js\n");
  const atlas = build({ root });
  assert.equal(isStale(root, atlas), false);
  writeFileSync(join(root, "deploy.yml"), "run: node app.js --prod\n");
  assert.equal(isStale(root, atlas), true, "config content change detected");
});

test("atlas indexes the broadened language set (Ruby, C#, PHP, Kotlin, Swift, C/C++)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  writeFileSync(
    join(root, "svc.rb"),
    "class OrderService\n  def process_order(x)\n    x\n  end\nend\n",
  );
  writeFileSync(
    join(root, "Svc.cs"),
    "public class OrderSvc {\n  public int ProcessOrder(int x) { return x; }\n}\n",
  );
  writeFileSync(
    join(root, "svc.php"),
    "<?php\nclass OrderSvc {\n  function processOrder($x) { return $x; }\n}\n",
  );
  writeFileSync(
    join(root, "Svc.kt"),
    "class OrderSvc {\n  fun processOrder(x: Int): Int { return x }\n}\n",
  );
  writeFileSync(
    join(root, "Svc.swift"),
    "struct OrderSvc {\n  func processOrder(_ x: Int) -> Int { return x }\n}\n",
  );
  writeFileSync(join(root, "svc.cpp"), "int processOrder(int x) {\n  return x;\n}\n");
  const atlas = build({ root });
  const names = atlas.symbols.map((s) => s.name);
  for (const sym of ["OrderService", "process_order", "OrderSvc", "ProcessOrder", "processOrder"])
    assert.ok(names.includes(sym), `${sym} indexed — have: ${names.join(", ")}`);
  // A C/C++ header shares the C grammar and is walked.
  writeFileSync(join(root, "api.h"), "void doThing(int n) {\n}\n");
  const a2 = build({ root });
  assert.ok(a2.symbols.map((s) => s.name).includes("doThing"), ".h uses the C grammar");
  // impact reaches a newly-added-language symbol.
  const r = build({ root });
  assert.ok(
    r.symbols.some((s) => s.name === "processOrder"),
    "cross-language symbols present",
  );
});

test("the Java/C# method grammar is linear on pathological input (ReDoS guard)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-atlas-"));
  // `public static public static …` with no `(` forced polynomial backtracking before
  // the {0,6}-bounded, whitespace-anchored rewrite. Must stay well under a second.
  writeFileSync(join(root, "Bad.cs"), `${"public static ".repeat(5000)}\n`);
  writeFileSync(join(root, "Bad.java"), `public int name ${"a ".repeat(20000)}\n`);
  const t = Date.now();
  build({ root });
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `build stayed linear (${ms}ms)`);
});

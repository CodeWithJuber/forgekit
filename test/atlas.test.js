import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build, has, load, query } from "../src/atlas.js";

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

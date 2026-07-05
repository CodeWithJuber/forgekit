import assert from "node:assert/strict";
import { test } from "node:test";
import { extractCalledSymbols, findUnknownSymbols } from "../src/verify.js";

test("extractCalledSymbols finds call sites, skips methods and builtins", () => {
  const src = [
    "const x = computeTax(income)",
    "obj.doThing(1)", // method call — skipped (preceded by '.')
    "console.log(x)", // builtin — skipped
    "return helper(a, b)",
  ].join("\n");
  const syms = extractCalledSymbols(src);
  assert.ok(syms.includes("computeTax"));
  assert.ok(syms.includes("helper"));
  assert.ok(!syms.includes("doThing"), "method call skipped");
  assert.ok(!syms.includes("log"), "builtin skipped");
});

test("findUnknownSymbols flags symbols absent from the atlas", () => {
  const atlas = { symbols: [{ name: "computeTax" }, { name: "helper" }] };
  const unknown = findUnknownSymbols(atlas, ["computeTax", "helper", "totallyMadeUpFn"]);
  assert.deepEqual(unknown, ["totallyMadeUpFn"]);
});

test("extractCalledSymbols dedupes", () => {
  const syms = extractCalledSymbols("foo()\nfoo()\nbar()");
  assert.equal(syms.filter((s) => s === "foo").length, 1);
});

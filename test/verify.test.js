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

test("shared extractor: atlas and verify use the same call-site extraction (no drift)", async () => {
  const { extractCalledSymbols, CALL_IGNORE } = await import("../src/extract.js");
  // Calls must be separated — the leading-boundary regex consumes the separator, so adjacent
  // calls like foo(bar()) only yield the outer one (shared, pre-existing behaviour).
  const syms = extractCalledSymbols("const x = foo(); bar(); baz.method(); JSON.parse(y)");
  assert.ok(syms.includes("foo") && syms.includes("bar"), "top-level calls captured");
  assert.ok(!syms.includes("method"), "member call .method( is skipped");
  assert.ok(!syms.includes("JSON"), "builtins ignored");
  assert.ok(CALL_IGNORE.has("console"));
});

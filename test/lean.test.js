import assert from "node:assert/strict";
import { test } from "node:test";
import { assessFootprint, leanRepo, parseDiffFootprint } from "../src/lean.js";

const diff = (s) => s.trimStart();

test("parseDiffFootprint counts files, added lines, and new abstractions", () => {
  const d = diff(`
+++ b/src/thing.js
+export function alpha(){ return 1 }
+export class Beta {}
+const gamma = () => 2
+const scalar = 42
+++ b/src/other.js
+import x from './x'
`);
  const fp = parseDiffFootprint(d);
  assert.deepEqual(fp.files.sort(), ["src/other.js", "src/thing.js"]);
  assert.ok(
    fp.newSymbols.includes("alpha") &&
      fp.newSymbols.includes("Beta") &&
      fp.newSymbols.includes("gamma"),
  );
  assert.ok(!fp.newSymbols.includes("scalar"), "a plain scalar const is not a new abstraction");
  assert.ok(fp.linesAdded >= 5);
});

test("assessFootprint flags abstractions the task never asked for", () => {
  const actual = {
    files: ["a.js"],
    linesAdded: 40,
    newSymbols: ["Factory", "Manager", "Registry", "Proxy"],
  };
  const r = assessFootprint("add a helper to a.js", actual);
  assert.ok(r.warnings.some((w) => /new abstractions the task didn't ask for/.test(w)));
  assert.deepEqual(r.footprint.unrequestedAbstractions.sort(), [
    "Factory",
    "Manager",
    "Proxy",
    "Registry",
  ]);
});

test("assessFootprint stays quiet when the footprint matches the ask", () => {
  const actual = { files: ["auth.js"], linesAdded: 8, newSymbols: ["validateToken"] };
  const r = assessFootprint("add validateToken to auth.js", actual);
  assert.equal(r.warnings.length, 0, "a proportionate change raises nothing");
});

test("assessFootprint flags a large diff for a short task", () => {
  const actual = { files: ["a.js"], linesAdded: 300, newSymbols: [] };
  const r = assessFootprint("fix the typo", actual);
  assert.ok(r.warnings.some((w) => /lines added for a .* task/.test(w)));
});

test("leanRepo: no diff → quiet; injected diff → measured", () => {
  const empty = leanRepo("/nope", "do a thing", { diff: "" });
  assert.equal(empty.hasDiff, false);
  assert.equal(empty.warnings.length, 0);
  const measured = leanRepo("/nope", "tiny tweak", {
    diff: "+++ b/x.js\n+export class A{}\n+export class B{}\n+export class C{}\n+export class D{}\n",
  });
  assert.equal(measured.hasDiff, true);
  assert.ok(measured.warnings.length >= 1);
});

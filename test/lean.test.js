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

test("leanRepo (C10): a brand-new UNTRACKED file counts — that is where over-building lives", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "forge-lean-"));
  const g = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(root, "login.js"), "export function login(){}\n");
  g("add", "-A");
  g("commit", "-m", "init");
  writeFileSync(join(root, "login.js"), "export function login(){ return 1 }\n");
  const framework = `${Array.from(
    { length: 6 },
    (_, i) => `export class Factory${i} {}\nexport function make${i}(){}\n`,
  ).join("")}${"x\n".repeat(200)}`;
  writeFileSync(join(root, "framework.js"), framework); // never `git add`ed

  const r = leanRepo(root, "fix login return value");
  assert.equal(r.footprint.files, 2, "the untracked file is part of the footprint");
  assert.ok(r.footprint.linesAdded > 200, `linesAdded ${r.footprint.linesAdded}`);
  assert.ok(
    r.footprint.unrequestedAbstractions.includes("Factory0"),
    "its new abstractions are counted",
  );
  assert.ok(r.warnings.length >= 2, "and the over-engineering warnings actually fire");
  g("add", "framework.js");
  const staged = leanRepo(root, "fix login return value");
  const shape = (x) => ({
    files: x.files,
    linesAdded: x.linesAdded,
    abstractions: [...x.newAbstractions].sort(),
  });
  assert.deepEqual(shape(staged.footprint), shape(r.footprint), "staging it changes nothing");
});

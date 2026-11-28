import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defaultCommand,
  findTestFiles,
  loadRuntimeMap,
  recordRuntimeMap,
  runtimeTests,
  saveRuntimeMap,
} from "../src/runtime_map.js";

function repo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "forge-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test("the runtime map sees a call the import graph cannot: a computed import", async (t) => {
  const root = repo(t, {
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
    "src/tax.js":
      "export function computeTax(x) { return x * 0.2; }\nexport function unused() {}\n",
    // The module path and the export name are both computed: no import statement names them.
    "test/dynamic.test.js": [
      'import { test } from "node:test";',
      'test("computed", async () => {',
      '  const m = await import(new URL(`../src/${"ta" + "x"}.js`, import.meta.url).href);',
      '  m["compute" + "Tax"](10);',
      "});",
    ].join("\n"),
    "test/other.test.js": 'import { test } from "node:test";\ntest("nothing", () => {});\n',
  });
  assert.deepEqual(findTestFiles(root), ["test/dynamic.test.js", "test/other.test.js"]);
  const map = await recordRuntimeMap(root, { jobs: 2 });
  assert.equal(map.tests, 2);
  assert.deepEqual(map.failedRuns, []);
  assert.ok(map.runs["test/dynamic.test.js"]["src/tax.js"].includes("computeTax"));
  assert.ok(!map.runs["test/dynamic.test.js"]["src/tax.js"].includes("unused"), "never ran");
  assert.equal(map.runs["test/other.test.js"]["src/tax.js"], undefined);

  saveRuntimeMap(root, map);
  const loaded = /** @type {NonNullable<ReturnType<typeof loadRuntimeMap>>} */ (
    loadRuntimeMap(root)
  );
  const seen = runtimeTests(root, loaded, { files: ["src/tax.js"], names: ["computeTax"] });
  assert.deepEqual(seen, { tests: ["test/dynamic.test.js"], stale: [] });
  assert.deepEqual(
    runtimeTests(root, loaded, { files: ["src/tax.js"], names: ["unused"] }).tests,
    [],
  );

  // A source changed after the recording is reported, never silently trusted.
  writeFileSync(join(root, "src/tax.js"), "export function computeTax(x) { return x * 0.3; }\n");
  assert.deepEqual(runtimeTests(root, loaded, { files: ["src/tax.js"], names: [] }).stale, [
    "src/tax.js",
  ]);
});

test("a child process a test spawns is attributed to that test", async (t) => {
  const root = repo(t, {
    "package.json": JSON.stringify({ type: "module" }),
    "src/cli.js": "export function main() { return 0; }\nmain();\n",
    "test/cli.test.js": [
      'import { test } from "node:test";',
      'import { execFileSync } from "node:child_process";',
      'test("spawns", () => { execFileSync(process.execPath, ["src/cli.js"]); });',
    ].join("\n"),
  });
  const map = await recordRuntimeMap(root, { jobs: 1 });
  assert.ok(map.runs["test/cli.test.js"]["src/cli.js"].includes("main"));
});

test("the per-file command follows the project's runner and keeps node preloads", (t) => {
  const node = repo(t, {
    "package.json": JSON.stringify({
      scripts: { test: "node --test --import ./test/_setup.js test/*.test.js" },
    }),
  });
  assert.equal(defaultCommand(node), "node --test --import ./test/_setup.js {file}");
  const vitest = repo(t, { "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
  assert.equal(defaultCommand(vitest), "npx vitest run {file}");
  const jest = repo(t, { "package.json": JSON.stringify({ scripts: { test: "jest --ci" } }) });
  assert.equal(defaultCommand(jest), "npx jest --runTestsByPath {file}");
  const none = repo(t, {});
  assert.equal(defaultCommand(none), "node --test {file}");
});

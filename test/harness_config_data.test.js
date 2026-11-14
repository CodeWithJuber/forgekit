import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { readHarnessConfigData } from "../src/harness_config_data.js";
import { installedHarnessPython } from "../src/harness_python.js";

test("config accepts plain data and rejects ambiguous JSON, deep structures and path escapes", (t) => {
  const base = mkdtempSync(join(tmpdir(), "forge-harness-config-")),
    root = join(base, "workspace");
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(root, "policy.yaml");
  writeFileSync(file, '{"limits":{"turns":4}}');
  assert.deepEqual(readHarnessConfigData(file, { root }), { limits: { turns: 4 } });
  writeFileSync(file, '{"turns":1,"turns":2}');
  assert.throws(() => readHarnessConfigData(file, { root }), /Duplicate/);
  writeFileSync(file, '{"__proto__":1}');
  assert.throws(() => readHarnessConfigData(file, { root }), /key/);
  writeFileSync(file, `{"deep":${"[".repeat(60)}1${"]".repeat(60)}}`);
  assert.throws(() => readHarnessConfigData(file, { root }), /nesting/);
  const outside = join(base, "policy.yaml");
  writeFileSync(outside, "{}");
  assert.throws(() => readHarnessConfigData(outside, { root }), /unsafe/);
  if (process.platform !== "win32") {
    const link = join(root, "link.yaml");
    symlinkSync(outside, link);
    assert.throws(() => readHarnessConfigData(link, { root }), /unsafe/);
  }
  writeFileSync(file, "budgets:\n  P1:\n    turns: 4\n");
  const bin = installedHarnessPython(root);
  if (spawnSync(bin, ["-I", "-c", "import yaml"]).status === 0) {
    assert.deepEqual(readHarnessConfigData(file, { root }), { budgets: { P1: { turns: 4 } } });
    writeFileSync(file, "a: &anchor [one, two]\nb: *anchor");
    assert.throws(() => readHarnessConfigData(file, { root }), /aliases/);
    writeFileSync(file, "a: 4\na: 20\n");
    assert.throws(() => readHarnessConfigData(file, { root }), /Duplicate/);
  } else assert.throws(() => readHarnessConfigData(file, { root }), /PyYAML/);
});

test("Python helper ignores executable shims in the project", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-harness-shim-"));
  const prev = process.env.PATH;
  t.after(() => {
    process.env.PATH = prev;
    rmSync(root, { recursive: true, force: true });
  });
  const name = process.platform === "win32" ? "python.exe" : "python3";
  const shim = join(root, name);
  writeFileSync(shim, "not an interpreter", { mode: 0o755 });
  process.env.PATH = [root, prev].join(delimiter);
  assert.notEqual(installedHarnessPython(root), shim);
  process.env.PATH = root;
  assert.throws(() => installedHarnessPython(root), /Install Python/);
});

test("strict JSON works without an interpreter and catches escaped duplicate and prototype keys", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-harness-fast-json-")),
    path = join(root, "controls.yaml");
  const prev = process.env.PATH;
  process.env.PATH = root;
  t.after(() => {
    process.env.PATH = prev;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(
    path,
    JSON.stringify({
      one: [{ "contains : { }": 'a "key": with \\ paths' }],
      another: { a: 12.5e8 },
    }),
  );
  assert.deepEqual(readHarnessConfigData(path, { root }).another, { a: 12.5e8 });
  writeFileSync(path, '{"profile":{"cap":0,"\\u0063ap":4}}');
  assert.throws(() => readHarnessConfigData(path, { root }), /Duplicate/);
  writeFileSync(path, '{"nested":[{"\\u005f_proto__":4}]}');
  assert.throws(() => readHarnessConfigData(path, { root }), /key/);
  writeFileSync(path, '{"budget":1e309}');
  assert.throws(() => readHarnessConfigData(path, { root }), /finite/);
});

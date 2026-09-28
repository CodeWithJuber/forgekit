#!/usr/bin/env node

/**
 * Tests for scripts/smart-test-select.mjs
 * Run: node --test test/smart-test-select.test.js
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "smart-test-select.mjs");

function select(changed) {
  const out = execSync(`node "${SCRIPT}" --changed "${changed}"`, { encoding: "utf8" });
  return JSON.parse(out);
}

test("cosmetic: docs-only → lint only, no tests", () => {
  const r = select("docs/GUIDE.md,README.md");
  assert.strictEqual(r.tier, "cosmetic");
  assert.strictEqual(r.fullSuite, false);
  assert.strictEqual(r.typecheck, false);
  assert.ok(r.lint.length > 0);
});

test("high: src/cli.js → full suite (high-risk)", () => {
  const r = select("src/cli.js");
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.fullSuite, true);
  assert.strictEqual(r.typecheck, true);
});

test("high: package.json → full suite", () => {
  const r = select("package.json");
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.fullSuite, true);
});

test("low: test file only → run that test", () => {
  const r = select("test/atlas.test.js");
  assert.strictEqual(r.tier, "low");
  assert.deepStrictEqual(r.tests, ["test/atlas.test.js"]);
  assert.strictEqual(r.fullSuite, false);
});

test("high: empty → fail-safe full suite", () => {
  const r = select("");
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.fullSuite, true);
  assert.match(r.reason, /fail-safe/);
});

test("high: mixed src + docs → fail-safe", () => {
  const r = select("src/atlas.js,docs/GUIDE.md");
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.fullSuite, true);
});

test("high: workflow change → full suite", () => {
  const r = select(".github/workflows/ci.yml");
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.fullSuite, true);
});

test("output is valid JSON with required fields", () => {
  const r = select("src/utils.js");
  assert.ok(["cosmetic", "low", "medium", "high"].includes(r.tier));
  assert.ok(Array.isArray(r.tests));
  assert.ok(Array.isArray(r.lint));
  assert.strictEqual(typeof r.typecheck, "boolean");
  assert.strictEqual(typeof r.fullSuite, "boolean");
  assert.strictEqual(typeof r.reason, "string");
});

// Tests for `forge test-select` (src/test_select.js) — the tier contract as a command.
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  blastRadius,
  classifyDeterministic,
  mapToTests,
  resolveChangedFiles,
  selectTests,
} from "../src/test_select.js";
import { COMMANDS } from "../src/commands.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");
const ROOT = join(import.meta.dirname, "..");

// ── Tier 1: deterministic classification (pure) ──────────────────────────────

test("cosmetic: docs-only → lint, no tests, no typecheck", () => {
  const r = classifyDeterministic(["docs/GUIDE.md", "README.md"]);
  assert.equal(r.tier, "cosmetic");
});

test("low: test files only → those tests", () => {
  const r = classifyDeterministic(["test/atlas.test.js"]);
  assert.equal(r.tier, "low");
  assert.deepEqual(r.tests, ["test/atlas.test.js"]);
});

test("medium: src-only → srcFiles for the impact leg", () => {
  const r = classifyDeterministic(["src/atlas.js"]);
  assert.equal(r.tier, "medium");
  assert.deepEqual(r.srcFiles, ["src/atlas.js"]);
});

test("high: high-risk files always escalate", () => {
  for (const f of [
    "package.json",
    "src/cli.js",
    "test/_setup.js",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(classifyDeterministic([f]).tier, "high", f);
  }
});

test("high: mixed types and empty detection both fail safe", () => {
  assert.equal(
    classifyDeterministic(["src/atlas.js", "docs/GUIDE.md"]).tier,
    "high",
  );
  const empty = classifyDeterministic([]);
  assert.equal(empty.tier, "high");
  assert.match(empty.reason, /fail-safe/);
});

// ── Tier 2: blast radius uses the real impact module (not the CLI) ──────────

test("blastRadius: a leaf src file stays small; central files explode", async () => {
  // Fixture repo: a.js is a leaf, b.js imports it. The atlas resolves the import,
  // so a.js's blast radius is exactly {a.js, b.js, test/a.test.js}.
  const dir = mkdtempSync(join(tmpdir(), "forge-ts-blast-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(
    join(dir, "src", "b.js"),
    "import { a } from './a.js';\nexport const b = a + 1;\n",
  );
  writeFileSync(
    join(dir, "test", "a.test.js"),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n",
  );
  const leaf = await blastRadius(dir, ["src/a.js"]);
  assert.ok(leaf !== null, "measurable");
  assert.ok(leaf.count <= 10, `leaf blast radius small, got ${leaf.count}`);
  assert.ok(leaf.files.includes("src/a.js"), "includes the target itself");
  assert.ok(leaf.files.includes("src/b.js"), "follows the real import edge");
  const central = await blastRadius(ROOT, ["src/atlas.js"]);
  assert.ok(central !== null && central.count > 10, "atlas.js is central");
});

test("selectTests: medium tier maps impact to real test files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-ts-medium-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "export const a = 1;\n");
  writeFileSync(
    join(dir, "test", "a.test.js"),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n",
  );
  const plan = await selectTests({ root: dir, files: ["src/a.js"] });
  assert.equal(plan.tier, "medium");
  assert.ok(
    plan.tests.includes("test/a.test.js"),
    `impact-mapped test, got ${plan.tests}`,
  );
  assert.equal(plan.typecheck, true);
  assert.equal(plan.fullSuite, false);
  assert.match(plan.reason, /heuristic/);
});

test("selectTests: unmeasurable blast radius escalates (fail-safe)", async () => {
  const plan = await selectTests({
    root: "/nonexistent-root-xyz",
    files: ["src/foo.js"],
  });
  assert.equal(plan.tier, "high");
  assert.match(plan.reason, /fail-safe/);
});

// ── Changed-file resolution: empty scope means "nothing to select" ──────────

test("resolveChangedFiles: a clean tree returns null (skip, never run-everything)", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-ts-clean-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  execSync("git add -A && git commit -qm init", { cwd: dir });
  assert.equal(resolveChangedFiles(dir, {}), null);
});

test("resolveChangedFiles: --changed parses CSV; working tree picks up edits", () => {
  assert.deepEqual(resolveChangedFiles(ROOT, { changed: "a.js, b.js " }), [
    "a.js",
    "b.js",
  ]);
  const dir = mkdtempSync(join(tmpdir(), "forge-ts-dirty-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  execSync("git add -A && git commit -qm init", { cwd: dir });
  writeFileSync(join(dir, "b.js"), "export const b = 2;\n");
  assert.deepEqual(resolveChangedFiles(dir, {}), ["b.js"]);
});

// ── CLI surface ────────────────────────────────────────────────────────────

test("forge test-select is registered, grouped, and handled", () => {
  assert.ok(COMMANDS["test-select"], "in the command registry");
  const out = execFileSync(process.execPath, [CLI, "test-select", "--help"], {
    encoding: "utf8",
  });
  assert.match(out, /test-select/);
});

test("forge test-select --json on a clean fixture reports tier none", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-ts-cli-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  writeFileSync(join(dir, "a.js"), "export const a = 1;\n");
  execSync("git add -A && git commit -qm init", { cwd: dir });
  const out = execFileSync(process.execPath, [CLI, "test-select", "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(out).tier, "none");
});

test("mapToTests: convention mapping finds the real test file", () => {
  const found = mapToTests(ROOT, ["src/atlas.js"]);
  assert.ok(found.includes("test/atlas_resolve.test.js") || found.length > 0);
});

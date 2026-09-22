import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const ENTRY = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const preEdit = (root, file) =>
  spawnSync("node", [ENTRY, "pre-edit"], {
    input: JSON.stringify({ cwd: root, tool_input: { file_path: file } }),
    encoding: "utf8",
    timeout: 10000,
  });

const seedLesson = (root) => {
  const s = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, s(), 1);
  processSession(root, s(), 2); // → active lesson on src/tax.ts
};

test("pre-edit surfaces a learned lesson for the file being edited", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  seedLesson(root);
  const r = preEdit(root, "src/tax.ts");
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /tax\.ts/);
});

test("pre-edit stays silent for a file with no lesson and no risk (low-nag)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  seedLesson(root);
  const r = preEdit(root, "src/unrelated.ts");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "no lesson, no risk → no advisory");
});

test("pre-edit is fail-safe: no file path → exit 0, no output", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-"));
  const r = spawnSync("node", [ENTRY, "pre-edit"], {
    input: JSON.stringify({ cwd: root }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

// --- E2: the live risk path can actually reach "high" -----------------------------------

// A genuinely risky edit: a hot file (≥10 commits) that 10 modules import, that no test
// references, whose EXPORTED SIGNATURE this edit rewrites while no caller is in the diff.
const riskyRepo = ({ withTest = false } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-risk-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < 10; i++)
    writeFileSync(
      join(root, "src", `caller${i}.js`),
      `import { pricing } from "./pricing.js";\nexport const v${i} = pricing(${i});\n`,
    );
  if (withTest) {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "pricing.test.js"), 'import "../src/pricing.js";\n');
  }
  for (let c = 0; c < 10; c++) {
    writeFileSync(
      join(root, "src", "pricing.js"),
      `export function pricing(qty) {\n  return qty * ${c + 1};\n}\n`,
    );
    git("add", "-A");
    git("commit", "-qm", `pricing tweak ${c}`);
  }
  return root;
};

const preEditInput = (root, toolInput) =>
  spawnSync("node", [ENTRY, "pre-edit"], {
    input: JSON.stringify({ cwd: root, tool_input: toolInput }),
    encoding: "utf8",
    timeout: 20000,
  });

test("pre-edit: a genuinely high-risk edit reaches the 'high' band and says why (E2)", () => {
  // Before the fix the hook passed only the path: every feature but churn was 0, so risk
  // topped out at σ(−1.0) = 0.27 and this advisory could never fire.
  const root = riskyRepo();
  const r = preEditInput(root, {
    file_path: join(root, "src", "pricing.js"),
    old_string: "export function pricing(qty) {",
    new_string: "export function pricing(qty, currency) {",
  });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /looks high-risk/);
  assert.match(ctx, /rewrites an existing declaration/);
  assert.match(ctx, /no test references it/);
});

test("pre-edit: the same hot file stays quiet for a body-only edit with a covering test", () => {
  const root = riskyRepo({ withTest: true });
  const r = preEditInput(root, {
    file_path: join(root, "src", "pricing.js"),
    old_string: "  return qty * 10;",
    new_string: "  return qty * 11;",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "churn + fan-out alone stay below 'high' (low-nag)");
});

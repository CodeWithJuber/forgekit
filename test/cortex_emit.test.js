import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processSession } from "../src/cortex_hook.js";
import { canonical } from "../src/sync.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-emit-"));
const brokenSession = () => [
  { type: "bash", command: "npm test", exitCode: 1 },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "bash", command: "npm test", exitCode: 0 },
];

test("a fresh repo's canonical AGENTS.md has no lessons block (no noise)", () => {
  const root = fixture();
  assert.doesNotMatch(canonical(root), /Lessons learned on this repo/);
});

test("once a lesson is active, it is inlined into AGENTS.md for every tool to read", () => {
  const root = fixture();
  processSession(root, brokenSession(), 1);
  processSession(root, brokenSession(), 2); // → active
  const body = canonical(root);
  assert.match(
    body,
    /Lessons learned on this repo \(Forge Cortex\)/,
    "cross-tool lessons block present",
  );
  assert.match(body, /tax\.ts/, "the learned lesson is in the shared file");
});

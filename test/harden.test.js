import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harden } from "../src/harden.js";

test("harden writes a mergeable sandbox block and reports gitleaks status", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const report = harden({ targetRoot: root });
  const sandbox = JSON.parse(
    readFileSync(join(root, ".forge", "sandbox.json"), "utf8"),
  );
  assert.equal(sandbox.sandbox.enabled, true);
  assert.ok(sandbox.credentials.deny.includes("~/.ssh"));
  assert.ok(typeof report.gitleaks === "string");
});

test("harden reports 'not a git repo' outside a repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  assert.match(harden({ targetRoot: root }).gitleaks, /not a git repo/);
});

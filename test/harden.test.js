import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { harden } from "../src/harden.js";

test("harden writes a mergeable sandbox block and reports gitleaks status", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const report = harden({ targetRoot: root });
  const sandbox = JSON.parse(readFileSync(join(root, ".forge", "sandbox.json"), "utf8"));
  assert.equal(sandbox.sandbox.enabled, true);
  assert.ok(sandbox.credentials.deny.includes("~/.ssh"));
  assert.ok(typeof report.gitleaks === "string");
});

test("harden reports 'not a git repo' outside a repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  const report = harden({ targetRoot: root });
  assert.match(report.gitleaks, /not a git repo/);
  assert.match(report.precommit, /not a git repo/);
});

test("harden installs the commit-gate pre-commit hook (gitleaks optional, gate always)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const report = harden({ targetRoot: root });
  assert.match(report.precommit, /installed pre-commit/);
  const hook = readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(hook, new RegExp(`installed by ${BRAND.cli} harden`), "ownership marker present");
  assert.match(hook, /gitleaks protect --staged/, "gitleaks runs first when installed");
  assert.match(hook, /precommit/, "the commit gate is the second rung");
  assert.match(hook, /command -v node .*\|\| exit 0/, "fail-open when node is missing");
});

test("harden never clobbers a user-authored pre-commit hook (writes beside it)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  const hooks = join(root, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const userHook = "#!/bin/sh\necho my own checks\n";
  writeFileSync(join(hooks, "pre-commit"), userHook);
  const report = harden({ targetRoot: root });
  assert.match(report.precommit, /existing pre-commit kept/);
  assert.equal(readFileSync(join(hooks, "pre-commit"), "utf8"), userHook, "user hook untouched");
  assert.ok(existsSync(join(hooks, `pre-commit.${BRAND.cli}`)), "ours lands beside it");
});

test("harden re-running overwrites its OWN hook (marker check, idempotent)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-harden-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  harden({ targetRoot: root });
  const report = harden({ targetRoot: root });
  assert.match(report.precommit, /installed pre-commit/, "second run rewrites, not sidesteps");
  assert.ok(!existsSync(join(root, ".git", "hooks", `pre-commit.${BRAND.cli}`)));
});

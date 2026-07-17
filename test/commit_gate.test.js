import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commitGate,
  commitGateDecision,
  gateMode,
  renderCommitGate,
  stagedAddedLines,
  stagedFiles,
} from "../src/commit_gate.js";
import { fakeGithubPat } from "./_fixtures.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-precommit-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

// A clean env for every gate call: the host shell (or CI) may export
// FORGE_COMMIT_GATE and the tests must not inherit it.
const env = (extra = {}) => {
  const e = { ...process.env, ...extra };
  if (!("FORGE_COMMIT_GATE" in extra)) delete e.FORGE_COMMIT_GATE;
  return e;
};

const cli = (root, extraEnv = {}) =>
  spawnSync("node", [CLI, "precommit"], {
    cwd: root,
    encoding: "utf8",
    env: env(extraEnv),
  });

test("warn (default): staged code without docs is a finding but the commit is allowed", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  git("add", "a.js");
  const r = commitGate(root, { env: env() });
  assert.equal(r.mode, "warn");
  assert.equal(r.allow, true);
  assert.equal(r.row, "warned");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "completeness");
  assert.match(r.findings[0].detail, /a\.js/);
  assert.match(renderCommitGate(r), /docs sync/, "the finding carries the repair procedure");
  const run = cli(root);
  assert.equal(run.status, 0, "warn mode never refuses the commit");
  assert.match(run.stdout, /completeness/);
});

test("code + doc staged together passes clean", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 3;\n");
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented the change\n");
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true);
  assert.equal(r.row, "clean");
  assert.equal(r.findings.length, 0);
});

test("FORGE_COMMIT_GATE=block refuses staged code without docs (exit 1 via CLI)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 4;\n");
  git("add", "a.js");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(r.allow, false);
  assert.equal(r.row, "blocked");
  const run = cli(root, { FORGE_COMMIT_GATE: "block" });
  assert.equal(run.status, 1, "block mode refuses via exit code");
  assert.match(run.stdout, /commit refused/);
});

test("a staged secret blocks even in warn mode (gitleaks fallback)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "config.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "config.js");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, false, "warn mode still refuses a credential");
  const secret = r.findings.find((f) => f.kind === "secret");
  assert.ok(secret, "a secret finding is reported");
  assert.match(secret.detail, /config\.js/);
  const run = cli(root);
  assert.equal(run.status, 1);
});

test("removed lines never trigger the secret scan (added lines only)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "cfg.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "cfg.js");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "leak (historical)");
  writeFileSync(join(root, "cfg.js"), "export const token = process.env.TOKEN;\n");
  writeFileSync(join(root, "README.md"), "# app\n\ntoken now comes from the env\n");
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true, "deleting the secret must not be refused as adding one");
  assert.equal(r.findings.length, 0);
});

test("kill switch FORGE_COMMIT_GATE=0 disables everything — even the secret scan", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "config.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "config.js");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "0" }) });
  assert.equal(r.allow, true);
  assert.equal(r.row, "kill-switch");
  assert.equal(cli(root, { FORGE_COMMIT_GATE: "0" }).status, 0);
});

test("nothing staged, non-repo, and unreadable roots all fail open", () => {
  const { root } = gitFixture();
  const clean = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(clean.allow, true);
  assert.equal(clean.row, "nothing-staged");
  const bare = mkdtempSync(join(tmpdir(), "forge-precommit-"));
  const notRepo = commitGate(bare, {
    env: env({ FORGE_COMMIT_GATE: "block" }),
  });
  assert.equal(notRepo.allow, true);
  assert.equal(notRepo.row, "not-a-repo");
  const gone = commitGate(join(bare, "does-not-exist"), {
    env: env({ FORGE_COMMIT_GATE: "block" }),
  });
  assert.equal(gone.allow, true, "an unusable root can never brick a commit");
});

test("test-only and docs-only commits pass (same class semantics as the Stop gate)", () => {
  const { root, git } = gitFixture();
  writeFileSync(
    join(root, "a.test.js"),
    "import { test } from 'node:test';\ntest('x', () => {});\n",
  );
  git("add", "a.test.js");
  assert.equal(commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) }).allow, true);
  writeFileSync(join(root, "NOTES.md"), "# notes\n");
  git("add", "NOTES.md");
  assert.equal(commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) }).allow, true);
});

test("unicode/space doc paths keep their doc credit (-z parsing)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 5;\n");
  writeFileSync(join(root, "Änderungen notes.md"), "# änderungen\n\ndokumentiert\n");
  git("add", "-A");
  const staged = stagedFiles(root);
  assert.ok(staged.includes("Änderungen notes.md"), "the exact unicode path survives -z");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(r.allow, true, "the unicode-named doc satisfies the gate");
});

test("stagedAddedLines maps added lines to their file, unified=0", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 1;\nexport const two = 2;\n");
  git("add", "a.js");
  const byFile = stagedAddedLines(root);
  assert.deepEqual(byFile.get("a.js"), ["export const two = 2;"]);
});

test("gateMode is total: unrecognized values degrade to warn, never crash or block", () => {
  assert.equal(gateMode(undefined), "warn");
  assert.equal(gateMode("banana"), "warn");
  assert.equal(gateMode("block"), "block");
  assert.equal(gateMode("0"), "off");
  assert.equal(gateMode("off"), "off");
});

test("pure decision table: vendor-free classes, block only on the stated rows", () => {
  const warn = commitGateDecision({ staged: ["src/x.js"], mode: "warn" });
  assert.equal(warn.allow, true);
  assert.equal(warn.findings[0].kind, "completeness");
  const block = commitGateDecision({ staged: ["src/x.js"], mode: "block" });
  assert.equal(block.allow, false);
  const withDocs = commitGateDecision({
    staged: ["src/x.js", "docs/x.md"],
    mode: "block",
  });
  assert.equal(withDocs.allow, true);
  const secret = commitGateDecision({
    staged: ["src/x.js", "docs/x.md"],
    secretFiles: ["src/x.js"],
    mode: "warn",
  });
  assert.equal(secret.allow, false, "a secret blocks regardless of docs credit and mode");
  const off = commitGateDecision({
    staged: ["src/x.js"],
    secretFiles: ["src/x.js"],
    mode: "off",
  });
  assert.equal(off.allow, true);
});

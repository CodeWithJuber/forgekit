import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installCommitHook } from "../src/harden.js";
import { init } from "../src/init.js";

const cli = join(import.meta.dirname, "..", "src", "cli.js");
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "forge-init-commit-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  mkdirSync(root);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "test@example.invalid");
  const setup = (tools, env = {}) =>
    spawnSync(process.execPath, [cli, "init", "--tools", tools, "--no-settings", "--no-warm"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  return { temp, root, git, setup, hooks: join(root, ".git", "hooks") };
}

test("init --tools enrolls mixed hookless selections in actual staged verification", (t) => {
  const { root, git, setup, hooks } = fixture(t);
  const native = setup("codex");
  assert.equal(native.status, 0, native.stderr);
  assert.equal(existsSync(join(hooks, "pre-commit")), false);
  const enrolled = setup("aider,codex");
  assert.equal(enrolled.status, 0, enrolled.stderr);
  assert.match(enrolled.stdout, /Git verification for aider: installed pre-commit/);
  assert.equal(existsSync(join(root, ".forge", "sandbox.json")), false);
  assert.match(readFileSync(join(hooks, "pre-commit"), "utf8"), /precommit --require-verified/);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(
    join(root, "math.test.js"),
    'require("node:test")("sum",()=>require("node:assert/strict").equal(1+2,3));\n',
  );
  git("add", "-A");
  assert.throws(() => git("hook", "run", "pre-commit"));
  execFileSync(process.execPath, [cli, "verify", "--json"], { cwd: root, stdio: "pipe" });
  assert.doesNotThrow(() => git("hook", "run", "pre-commit"));
});

test("advisory setup is recorded by the installed command and preserves an explicit manual hardening", (t) => {
  const { root, hooks, setup } = fixture(t);
  assert.equal(setup("aider").status, 0);
  const configPath = join(root, ".forge", "forge.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.hooks = { ...config.hooks, commitVerification: "advisory" };
  writeFileSync(configPath, JSON.stringify(config));
  const advisory = setup("aider");
  assert.equal(advisory.status, 0, advisory.stderr);
  assert.doesNotMatch(readFileSync(join(hooks, "pre-commit"), "utf8"), /--require-verified/);
  installCommitHook({ targetRoot: root, requireVerified: true });
  const repeat = setup("aider", { FORGE_GATE: "advisory" });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(readFileSync(join(hooks, "pre-commit"), "utf8"), /--require-verified/);
});

test("a developer's hook, sibling and external Git directories retain their bytes", (t) => {
  const { temp, root, hooks, git, setup } = fixture(t);
  const mine = "#!/bin/sh\necho project policy\n";
  const primary = join(hooks, "pre-commit");
  const sibling = join(hooks, "pre-commit.forge");
  writeFileSync(primary, mine);
  const personal = init({ targetRoot: root, tools: "zed", noSettings: true, warm: false });
  assert.equal(personal.gitVerification.active, false);
  assert.match(personal.gitVerification.message, /existing pre-commit kept/);
  assert.match(readFileSync(sibling, "utf8"), /--require-verified/);
  writeFileSync(sibling, mine);
  const both = setup("continue");
  assert.match(
    both.stdout,
    /Both the existing pre-commit and its ForgeKit sibling are user-managed/,
  );
  assert.equal(readFileSync(primary, "utf8"), mine);
  assert.equal(readFileSync(sibling, "utf8"), mine);
  const external = join(temp, "shared-hooks");
  mkdirSync(external);
  git("config", "--local", "core.hooksPath", external);
  const shared = setup("roo");
  assert.match(shared.stdout, /outside this checkout.*CI/);
  assert.deepEqual(readdirSync(external), []);
  git("config", "--local", "--unset", "core.hooksPath");
  const globalConfig = join(temp, "global-config");
  writeFileSync(globalConfig, "[core]\n hooksPath = .globally-managed\n");
  const global = setup("aider", { GIT_CONFIG_GLOBAL: globalConfig });
  assert.match(global.stdout, /shared configuration.*CI/);
  assert.equal(existsSync(join(root, ".globally-managed")), false);
});

test("an edit to a generated hook is preserved on reinitialization", (t) => {
  const { hooks, setup } = fixture(t);
  assert.equal(setup("aider").status, 0);
  const hook = join(hooks, "pre-commit");
  const edited = `${readFileSync(hook, "utf8")}# personal checks\n`;
  writeFileSync(hook, edited);
  const again = setup("aider");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /existing pre-commit kept/);
  assert.equal(readFileSync(hook, "utf8"), edited);
  assert.match(
    readFileSync(join(hooks, "pre-commit.forge"), "utf8"),
    /precommit --require-verified/,
  );
});

test("a linked hooks directory stays outside automatic setup", (t) => {
  const { temp, root, git, setup } = fixture(t);
  const outside = join(temp, "outside");
  mkdirSync(outside);
  try {
    symlinkSync(
      outside,
      join(root, "linked-hooks"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error.code === "EPERM") return t.skip("creating directory links is unavailable");
    throw error;
  }
  git("config", "--local", "core.hooksPath", "linked-hooks");
  assert.match(setup("openclaw").stdout, /linked hook directory.*CI/);
  assert.deepEqual(readdirSync(outside), []);
});

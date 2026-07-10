import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args, cwd, env = {}) =>
  spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

test("commands are quiet by default — no 'Forge <cmd>' title chrome", () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-quiet-"));
  const { status, stdout } = run(["doctor"], cwd);
  assert.equal(status === 0 || status === 1, true, "doctor runs");
  assert.doesNotMatch(stdout, /^Forge doctor/m, "the branding title is suppressed by default");
});

test("FORGE_VERBOSE=1 restores the title; --verbose too", () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-quiet-"));
  const env = run(["doctor"], cwd, { FORGE_VERBOSE: "1" });
  assert.match(env.stdout, /^Forge doctor/m, "FORGE_VERBOSE brings the title back");
  const flag = run(["doctor", "--verbose"], cwd);
  assert.match(flag.stdout, /^Forge doctor/m, "--verbose brings the title back");
});

test("the --help / --version banner is unaffected by quiet mode", () => {
  const help = run(["--help"], process.cwd());
  assert.match(help.stdout, /^Forge \(forgekit\) v/, "help still shows the version banner");
  const ver = run(["--version"], process.cwd());
  assert.match(ver.stdout, /^Forge \(forgekit\) v/, "version banner intact");
});

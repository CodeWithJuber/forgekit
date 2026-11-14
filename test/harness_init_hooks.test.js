// `forge harness init|connect` re-emit each host's hook files. They must do it the way
// `forge sync` does and honour the repository's recorded `hooks.bootstrap`: without it a
// fresh machine (cloud, CI) never installs the CLI, and every guard hook exits quietly.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hooksStatus, packageSpec } from "../src/emit/hooks.js";
import { readForgeConfig } from "../src/repo_config.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exec = promisify(execFile);
const FILES = {
  claude: ".claude/settings.json",
  codex: ".codex/hooks.json",
  cursor: ".cursor/hooks.json",
};

/** A throwaway git project with its own private state, and a runner for `forge harness …`. */
function project(config) {
  const folder = mkdtempSync(join(tmpdir(), "harness-hooks-"));
  const root = join(folder, "project");
  mkdirSync(join(root, ".forge"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (config)
    writeFileSync(
      join(root, ".forge", "forge.config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  const env = {
    ...process.env,
    FORGE_HOME: join(folder, "private"),
    FORGE_NO_HINT: "1",
    FORGE_NO_CATALOG_FETCH: "1",
  };
  const run = async (...args) =>
    JSON.parse(
      (await exec(process.execPath, [cli, "harness", ...args], { cwd: root, env })).stdout,
    );
  return { root, run };
}

/** What `forge hooks status` says per host: `on` means the file holds exactly what forge
 *  would write for this repository's recorded settings, `stale` that it holds yesterday's. */
function states(root) {
  const status = hooksStatus(root, { config: readForgeConfig(root) });
  return Object.fromEntries(status.hosts.map((h) => [h.host, h.state]));
}

const installs = (root, host) =>
  readFileSync(join(root, FILES[host]), "utf8").includes(
    `npm install -g --silent ${packageSpec()}`,
  );

test("harness init keeps a recorded bootstrap: every session start still installs the CLI", async () => {
  const { root, run } = project({ hooks: { project: true, bootstrap: true } });
  await run("init", "--hosts", "claude,codex,cursor");
  const state = states(root);
  for (const host of Object.keys(FILES)) {
    assert.ok(installs(root, host), `${FILES[host]} installs the pinned CLI when it is missing`);
    assert.equal(state[host], "on", `${host}: hook file matches the recorded bootstrap`);
  }
});

test("harness init does not switch the bootstrap on for a repository that never asked for it", async () => {
  const { root, run } = project();
  await run("init", "--hosts", "claude,codex,cursor");
  const state = states(root);
  for (const host of Object.keys(FILES)) {
    assert.equal(installs(root, host), false, `${FILES[host]} has no install step`);
    assert.equal(state[host], "on", `${host}: hook file matches the recorded settings`);
  }
});

test("harness connect adds a host with the bootstrap and leaves the earlier host's in place", async () => {
  const { root, run } = project({ hooks: { project: true, bootstrap: true } });
  await run("init", "--hosts", "claude");
  await run("connect", "--hosts", "cursor");
  const state = states(root);
  for (const host of ["claude", "cursor"]) {
    assert.ok(installs(root, host), `${FILES[host]} installs the pinned CLI when it is missing`);
    assert.equal(state[host], "on", `${host}: hook file matches the recorded bootstrap`);
  }
});

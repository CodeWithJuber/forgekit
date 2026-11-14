import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyHooks } from "../src/emit/hooks.js";
import { checkHarnessDrift } from "../src/harness_drift.js";
import { init } from "../src/init.js";

test("generated hooks and MCP match across six hosts; tampering is detected without touching the checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-drift-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hosts = ["kimi", "codex", "gemini", "cursor", "claude", "copilot"];
  init({ targetRoot: root, tools: hosts, noSettings: true, warm: false });
  for (const host of hosts) applyHooks(root, host);
  const before = checkHarnessDrift(root, hosts);
  assert.deepEqual(before.failures, []);
  assert.ok(
    before.checks.some(
      (c) => c.host === "kimi" && c.component === "user plugin" && c.status === "manual",
    ),
  );
  const edit = (path, fn) => {
    const full = join(root, path),
      text = JSON.stringify(fn(JSON.parse(readFileSync(full, "utf8"))));
    writeFileSync(full, text);
    return text;
  };
  const changed = edit(".gemini/settings.json", (j) => ({
    ...j,
    editor: { font: "mono" },
    hooks: {
      ...j.hooks,
      BeforeTool: [{ hooks: [{ type: "command", command: "unrelated" }] }, ...j.hooks.BeforeTool],
    },
  }));
  // Reformatting and independent settings/hook lists are outside this projection.
  assert.equal(checkHarnessDrift(root, ["gemini"]).ok, true);
  assert.equal(readFileSync(join(root, ".gemini/settings.json"), "utf8"), changed);
  const bad = edit(".cursor/hooks.json", (j) => ({
    ...j,
    hooks: { ...j.hooks, beforeSubmitPrompt: [] },
  }));
  edit(".kimi-code/mcp.json", (j) => ({ ...j, servers: j.mcpServers, mcpServers: {} }));
  const path = join(root, ".codex/config.toml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('args = ["cortex-mcp"]', 'args = ["wrong"]'),
  );
  const report = checkHarnessDrift(root, hosts);
  assert.deepEqual(report.failures.map((r) => r.host).sort(), ["codex", "cursor", "kimi"]);
  assert.equal(readFileSync(join(root, ".cursor/hooks.json"), "utf8"), bad);
});

test("supervised setup selects detected hosts and supplies a portable stdio recipe for a fresh project", (t) => {
  const area = mkdtempSync(join(tmpdir(), "harness-any-host-"));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const env = { ...process.env, FORGE_HOME: join(area, "state"), FORGE_NO_CATALOG_FETCH: "1" };
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const project = (name) => {
    const cwd = join(area, name);
    mkdirSync(cwd);
    execFileSync("git", ["init", "-q"], { cwd, env });
    return realpathSync.native(cwd);
  };
  const run = (cwd, ...args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "harness", ...args], {
        cwd,
        env,
        encoding: "utf8",
      }),
    );
  const empty = project("project with spaces");
  const setup = run(empty, "init", "--supervised");
  const server = setup.mcpServers["forge-cortex"];
  assert.deepEqual(server, { command: "forge", args: ["cortex-mcp"], env: { FORGE_ROOT: empty } });
  assert.deepEqual(run(empty, "status").hosts, ["generic"]);
  assert.equal(existsSync(join(empty, ".claude")), false);
  const check = run(empty, "drift");
  assert.equal(check.ok, true);
  assert.equal(check.checks[0].status, "manual");
  assert.deepEqual(check.checks[0].mcpServers["forge-cortex"], server);
  const rpc = `${[
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ExampleEditor" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n")}\n`;
  const output = execFileSync(process.execPath, [cli, ...server.args], {
    cwd: area,
    env: { ...env, ...server.env },
    input: rpc,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    output.find((msg) => msg.id === 2).result.tools.map((t) => t.name),
    ["forge_harness_run", "forge_harness_status"],
  );
  const detected = project("claude");
  mkdirSync(join(detected, ".claude"));
  run(detected, "init", "--supervised");
  assert.deepEqual(run(detected, "status").hosts, ["claude"]);
  assert.equal(run(detected, "drift").ok, true);
  const existing = project("existing");
  run(existing, "init", "--hosts", "kimi,codex", "--supervised");
  const path = join(existing, "harness/policy.yaml");
  const connected = run(existing, "connect", "--hosts", "claude,generic");
  assert.deepEqual(connected.hosts, ["claude", "codex", "kimi", "generic"]);
  assert.equal(connected.mode, "supervised");
  assert.equal(run(existing, "drift").ok, true);
  const savedPolicy = readFileSync(path, "utf8");
  run(existing, "connect", "--hosts", "claude");
  assert.equal(readFileSync(path, "utf8"), savedPolicy);
  const untrusted = JSON.parse(savedPolicy);
  untrusted.nativeProfile = "reviewer";
  writeFileSync(path, JSON.stringify(untrusted));
  assert.throws(() => run(existing, "connect", "--hosts", "gemini"), /trust/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), untrusted);
  assert.equal(existsSync(join(existing, ".gemini")), false);
  const mixed = project("mixed");
  run(mixed, "init", "--hosts", "generic,claude-code,kimi", "--supervised");
  assert.deepEqual(run(mixed, "status").hosts, ["claude", "kimi", "generic"]);
  assert.equal(run(mixed, "drift").ok, true);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeIntegration } from "../src/integrations.js";
import { connectLocal } from "../src/local_integration.js";
import { writeForgeConfig } from "../src/repo_config.js";

test("custom installed stdio tool handshakes through its emitted launcher, checking pins and private workspace binding", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-stdio-"));
  const root = join(tmp, "repo"),
    sibling = join(tmp, "sibling");
  mkdirSync(root);
  mkdirSync(sibling);
  const before = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(tmp, "private");
  t.after(() => {
    if (before === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = before;
    rmSync(tmp, { force: true, recursive: true });
  });
  writeForgeConfig(root, () => ({ tools: ["codex", "claude"] }));
  const script = join(tmp, "installed.mjs");
  writeFileSync(
    script,
    `import {createInterface} from "node:readline";
 for await(const line of createInterface({input:process.stdin})) {
  const r=JSON.parse(line);
  console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{tools:[{name:"search",inputSchema:{type:"object"}}],allowed:Boolean(process.env.TEST_INTEGRATION_AUTH),excluded:Boolean(process.env.TEST_UNRELATED_SECRET)}}));
 }`,
  );
  assert.throws(
    () => connectLocal(root, "test", process.execPath, ["-e", "wrong"]),
    /absolute installed/,
  );
  const projectScript = join(root, "shadow.mjs");
  writeFileSync(projectScript, "");
  assert.throws(() => connectLocal(root, "test", process.execPath, [projectScript]), /outside/);
  const connected = connectLocal(
    root,
    "private-index",
    process.execPath,
    [script],
    ["TEST_INTEGRATION_AUTH"],
  );
  assert.equal(connected.ok, true);
  const contents = readFileSync(join(root, ".mcp.json"), "utf8");
  assert.ok(!contents.includes(script));
  const spec = JSON.parse(contents).mcpServers["private-index"];
  assert.equal(spec.command, "forge");
  assert.deepEqual(spec.args, ["integrations", "serve-local", "private-index"]);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (cwd) =>
    spawnSync(process.execPath, [cli, ...spec.args], {
      cwd,
      env: { ...process.env, TEST_INTEGRATION_AUTH: "fixture", TEST_UNRELATED_SECRET: "fixture" },
      encoding: "utf8",
      timeout: 15000,
      input: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n',
    });
  const ran = invoke(root);
  assert.equal(ran.status, 0, ran.stderr);
  const packet = JSON.parse(ran.stdout);
  assert.equal(packet.id, 7);
  assert.deepEqual(packet.result, {
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    allowed: true,
    excluded: false,
  });
  const cfg = JSON.parse(readFileSync(join(root, ".forge/forge.config.json"), "utf8"));
  writeForgeConfig(sibling, () => cfg);
  const copied = invoke(sibling);
  assert.notEqual(copied.status, 0);
  assert.match(copied.stderr, /not approved/);
  writeFileSync(script, "process.stdout.write('unapproved');");
  const modified = invoke(root);
  assert.notEqual(modified.status, 0);
  assert.match(modified.stderr, /changed/);
  assert.ok(!modified.stdout.includes("unapproved"));
  assert.equal(removeIntegration("private-index", { targetRoot: root }).ok, true);
  assert.notEqual(invoke(root).status, 0);
});

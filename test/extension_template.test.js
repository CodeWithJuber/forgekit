import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../src/brand.js";
import { handle } from "../src/cortex_mcp.js";
import { integrationTemplate } from "../src/extension_template.js";
import {
  inspectHarnessExtension,
  pinHarnessExtension,
  removeHarnessExtension,
} from "../src/harness_extensions.js";
import { httpDiscoveryVersions } from "../src/mcp_protocol.js";
import { probeMcpEndpoint } from "../src/source_mcp.js";

test("the packaged developer starter copies into a new directory and follows the real upgrade and removal flow", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-dev-template-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = spawnSync(
    process.execPath,
    [join(BRAND.root, "src/cli.js"), "integrations", "template", "--out", "plugins", "--json"],
    { cwd: root, env: { ...process.env, FORGE_NO_HINT: "1" }, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.adapters.length, 4);
  assert.deepEqual(result.protocols.stdio, ["2024-11-05"]);
  assert.throws(() => integrationTemplate(root, "plugins"), /already exists/);
  assert.throws(() => integrationTemplate(root, "../outside"), /new directory/);
  const directory = "plugins/team-guide",
    original = inspectHarnessExtension(root, directory);
  assert.equal(original.name, "team-guide");
  pinHarnessExtension(root, directory, original.digest);
  const ref = join(root, directory, "references", "release.md");
  writeFileSync(ref, "# Updated acceptance criteria\n");
  assert.throws(() => pinHarnessExtension(root, directory, original.digest), /digest/);
  const updated = inspectHarnessExtension(root, directory);
  assert.notEqual(updated.digest, original.digest);
  pinHarnessExtension(root, directory, updated.digest);
  removeHarnessExtension(root, "team-guide");
  assert.match(readFileSync(ref, "utf8"), /Updated acceptance/);
});
test("stdio negotiates its implemented revision, returns a dated alternative and rejects malformed version types", async () => {
  for (const revision of ["2024-11-05", "2099-01-01", 7]) {
    const init = JSON.parse(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: revision,
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    );
    const r = await handle(init);
    if (typeof revision === "string") assert.equal(r.result.protocolVersion, "2024-11-05");
    else assert.equal(r.error.code, -32602);
  }
});
test("the scoped HTTP probe accepts exactly its declared revisions and never invokes tools", async () => {
  for (const revision of [...httpDiscoveryVersions, "2099-01-01"]) {
    const methods = [];
    const fetchImpl = async (_url, opts) => {
      const req = JSON.parse(opts.body);
      methods.push(req.method);
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      const reply =
        req.method === "initialize"
          ? {
              protocolVersion: revision,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: req.id, result: reply });
    };
    const task = probeMcpEndpoint({ url: "https://docs.example.org/mcp" }, { fetchImpl });
    if (revision === "2099-01-01") {
      await assert.rejects(task, /Unsupported negotiated/);
      assert.deepEqual(methods, ["initialize"]);
    } else {
      await task;
      assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
    }
  }
});

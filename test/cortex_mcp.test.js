import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";
import { handle } from "../src/cortex_mcp.js";

test("handle: initialize advertises the forge-cortex server", () => {
  const r = handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(r.result.serverInfo.name, "forge-cortex");
});

test("handle: tools/list exposes cortex_lessons + cortex_status", () => {
  const r = handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["cortex_lessons", "cortex_status"]);
});

test("handle: notifications get no response; unknown methods error", () => {
  assert.equal(handle({ method: "notifications/initialized" }), null);
  assert.equal(handle({ id: 9, method: "bogus" }).error.code, -32601);
});

const SERVER = fileURLToPath(new URL("../src/cortex_mcp.js", import.meta.url));

test("live server over stdio returns learned lessons for a repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-"));
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  processSession(root, session(), 2); // → active lesson

  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "cortex_lessons", arguments: { files: ["src/tax.ts"] } },
    }),
  ].join("\n");
  const r = spawnSync("node", [SERVER], {
    input: `${requests}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root },
    timeout: 10000,
  });
  const responses = r.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const call = responses.find((x) => x.id === 2);
  assert.match(call.result.content[0].text, /Lessons for the files in play/);
  assert.match(call.result.content[0].text, /tax\.ts/);
});

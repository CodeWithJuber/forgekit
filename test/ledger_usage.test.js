// Every place that SERVES ledger claims logs the use (ledger retention learns from it). This
// drives the real entrypoints — hook, CLI, MCP server — in the default ledger-only mode, where
// lessons live in the ledger and carry their claim id.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { processSession } from "../src/cortex_hook.js";
import { loadClaims, readUses, repoLedger } from "../src/ledger_store.js";
import { epochDay } from "../src/util.js";

delete process.env.FORGE_LEDGER_ONLY; // the default: ledger-only

const HOOK = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SERVER = fileURLToPath(new URL("../src/cortex_mcp.js", import.meta.url));

const session = () => [
  { type: "bash", command: "npm test", exitCode: 1 },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "bash", command: "npm test", exitCode: 0 },
];

/** Total use events per claim id, summed over the whole log. */
const useCount = (dir, ids) => ids.reduce((n, id) => n + (readUses(dir).get(id)?.length ?? 0), 0);

test("session-start, pre-edit, `ledger query` and the MCP query each log what they served", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-usage-"));
  // Recent days: the hooks judge a ledger lesson's status by its decayed val TODAY.
  const today = epochDay();
  processSession(root, session(), today - 1);
  processSession(root, session(), today); // → an active lesson on src/tax.ts, in the ledger
  const dir = repoLedger(root);
  const lessons = loadClaims(dir)
    .filter((c) => c.kind === "lesson")
    .map((c) => c.id);
  assert.ok(lessons.length, "the seeded lesson is a ledger claim");
  assert.equal(useCount(dir, lessons), 0, "nothing served yet");

  const start = spawnSync("node", [HOOK, "session-start"], {
    input: JSON.stringify({ session_id: "s-usage", cwd: root }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Lessons learned on this repo/);
  const afterStart = useCount(dir, lessons);
  assert.ok(afterStart >= 1, "the session-start lesson block logged its lessons");

  const pre = spawnSync("node", [HOOK, "pre-edit"], {
    input: JSON.stringify({ cwd: root, tool_input: { file_path: "src/tax.ts" } }),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.match(pre.stdout, /tax\.ts/);
  const afterPre = useCount(dir, lessons);
  assert.ok(afterPre > afterStart, "the pre-edit advisory logged the lesson it showed");

  const query = spawnSync("node", [CLI, "ledger", "query", "tax.ts tests fail"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1" },
    timeout: 20000,
  });
  assert.equal(query.status, 0, query.stderr);
  const afterQuery = useCount(dir, lessons);
  assert.ok(afterQuery > afterPre, "`forge ledger query` logged its results");

  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "forge_ledger_query", arguments: { query: "tax.ts tests fail" } },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const mcp = spawnSync("node", [SERVER], {
    input: `${requests}\n`,
    encoding: "utf8",
    env: { ...process.env, FORGE_ROOT: root },
    timeout: 20000,
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.ok(useCount(dir, lessons) > afterQuery, "the MCP ledger query logged its results");
});

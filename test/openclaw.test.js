// OpenClaw target — the compiler's tenth tool. What has to hold:
//   1. instructions travel via the shared AGENTS.md (OpenClaw reads the execution folder's
//      AGENTS.md as project context) — no second instruction file, no invented hooks;
//   2. the MCP artifact is a VALID OpenClaw config fragment (`mcp.servers.<name>`), not a
//      guess at some other tool's schema;
//   3. it is idempotent, non-destructive, and reversible through the same
//      integrations add/remove path every other target uses;
//   4. nothing forge emits for OpenClaw carries a secret, and nothing forge writes ever
//      lands outside the target repo (the user's ~/.openclaw is off limits).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitMcp, MCP_TARGET_FILES, OPENCLAW_TARGET, openclawAddCommand } from "../src/emit/mcp.js";
import openclaw from "../src/emit/openclaw.js";
import { addIntegration, removeIntegration } from "../src/integrations.js";
import { detectPrimaryTool, KNOWN_TOOLS, rowToolKey } from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-openclaw-"));
const readTarget = (root) => JSON.parse(readFileSync(join(root, OPENCLAW_TARGET), "utf8"));

// --------------------------------------------------------------------------
// Instructions: AGENTS.md, and only AGENTS.md.
// --------------------------------------------------------------------------

test("OpenClaw instructions ride the shared AGENTS.md — no second instruction file", () => {
  const root = fixture();
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.tool === "OpenClaw");
  assert.ok(row, "sync reports an OpenClaw row");
  assert.equal(row.target, "AGENTS.md");
  assert.equal(row.action, "relies-on-agents");

  // The canonical body actually reached AGENTS.md, and AGENTS.md is forge-managed.
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /forge:sync:[a-f0-9]{12}/);
  assert.match(agents, /^# AGENTS\.md/m);

  // No OpenClaw-specific instruction file is invented — OPENCLAW.md would be a file
  // OpenClaw never reads, and CLAUDE.md is Claude's, not OpenClaw's.
  assert.ok(!existsSync(join(root, "OPENCLAW.md")));
});

test("the OpenClaw row never claims ambient hooks or a live MCP connection", () => {
  const note = openclaw.emit({ targetRoot: fixture() }).note;
  assert.doesNotMatch(note, /hook/i, "forge installs nothing into OpenClaw's hook system");
  assert.match(note, /AGENTS\.md/);
  assert.match(note, /manual/i, "the MCP step is stated as manual");
});

// --------------------------------------------------------------------------
// MCP artifact: real OpenClaw shape.
// --------------------------------------------------------------------------

test("sync writes a valid OpenClaw `mcp.servers` stdio fragment", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const doc = readTarget(root);
  // Nested under mcp.servers — OpenClaw's documented config shape, not a flat mcpServers key.
  assert.deepEqual(Object.keys(doc), ["mcp"]);
  assert.deepEqual(Object.keys(doc.mcp), ["servers"]);
  const server = doc.mcp.servers["forge-cortex"];
  assert.ok(server, "the forge server is registered under mcp.servers");
  // A stdio server needs a command; args must be a string array.
  assert.equal(typeof server.command, "string");
  assert.ok(server.command.length > 0);
  assert.ok(Array.isArray(server.args));
  for (const a of server.args) assert.equal(typeof a, "string");
  assert.deepEqual(server.args, ["cortex-mcp"]);
  // No stray keys: anything forge does not understand must not be invented here.
  assert.deepEqual(Object.keys(server).sort(), ["args", "command"]);
});

test("the reported enable command matches the emitted server definition", () => {
  const root = fixture();
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.target === OPENCLAW_TARGET);
  assert.ok(row);
  const server = readTarget(root).mcp.servers["forge-cortex"];
  const expected = openclawAddCommand("forge-cortex", server);
  assert.equal(expected, "openclaw mcp add forge-cortex --command forge --arg cortex-mcp");
  assert.ok(row.note.includes(expected), row.note);
  // The row must not read as "done" — OpenClaw does not auto-load this file.
  assert.match(row.note, /not auto-loaded/);
});

test("openclawAddCommand shell-quotes only what needs it", () => {
  assert.equal(
    openclawAddCommand("forge-cortex", { command: "node", args: ["./dist/x.js", "a b"] }),
    "openclaw mcp add forge-cortex --command node --arg ./dist/x.js --arg 'a b'",
  );
  assert.equal(
    openclawAddCommand("srv", { command: "my cmd" }),
    "openclaw mcp add srv --command 'my cmd'",
  );
});

// --------------------------------------------------------------------------
// Idempotency + preservation.
// --------------------------------------------------------------------------

test("re-running sync leaves the OpenClaw artifact byte-identical", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const first = readFileSync(join(root, OPENCLAW_TARGET), "utf8");
  const second = sync({ targetRoot: root });
  assert.equal(readFileSync(join(root, OPENCLAW_TARGET), "utf8"), first, "bytes unchanged");
  assert.equal(second.report.find((r) => r.target === OPENCLAW_TARGET).action, "unchanged");
});

test("a user's own OpenClaw config keys and same-name server survive emission", () => {
  const root = fixture();
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  writeFileSync(
    join(root, OPENCLAW_TARGET),
    `${JSON.stringify(
      {
        gateway: { publicOrigin: "https://gateway.example.com" },
        mcp: {
          apps: { enabled: true },
          servers: {
            "forge-cortex": { command: "my-own-forge", args: ["serve"] },
            mine: { command: "node", args: ["./mine.js"] },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const res = sync({ targetRoot: root });
  const doc = readTarget(root);
  // Unrelated config is untouched...
  assert.deepEqual(doc.gateway, { publicOrigin: "https://gateway.example.com" });
  assert.deepEqual(doc.mcp.apps, { enabled: true });
  assert.deepEqual(doc.mcp.servers.mine, { command: "node", args: ["./mine.js"] });
  // ...and a DIVERGENT same-name entry forge did not write is preserved, not clobbered.
  assert.deepEqual(doc.mcp.servers["forge-cortex"], {
    command: "my-own-forge",
    args: ["serve"],
  });
  const row = res.report.find((r) => r.target === OPENCLAW_TARGET);
  assert.equal(row.action, "skipped");
  assert.match(row.note, /user-owned/);
});

test("a non-object at mcp.servers is left exactly as the user wrote it", () => {
  const root = fixture();
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  const original = `${JSON.stringify({ mcp: { servers: "oops" } }, null, 2)}\n`;
  writeFileSync(join(root, OPENCLAW_TARGET), original);
  const res = sync({ targetRoot: root });
  assert.equal(readFileSync(join(root, OPENCLAW_TARGET), "utf8"), original, "bytes preserved");
  const row = res.report.find((r) => r.target === OPENCLAW_TARGET);
  assert.equal(row.action, "skipped");
  assert.match(row.note, /not an object/);
});

// --------------------------------------------------------------------------
// Reversibility, through the same registry path as every other target.
// --------------------------------------------------------------------------

test("OpenClaw is an ownable MCP target: integrations add then remove round-trips", () => {
  const root = fixture();
  assert.ok(MCP_TARGET_FILES.includes(OPENCLAW_TARGET), "target is in the ownership domain");

  const added = addIntegration("context7", { targetRoot: root, adopt: false });
  assert.equal(added.ok, true, added.reason);
  assert.ok(readTarget(root).mcp.servers.context7, "context7 landed in the OpenClaw fragment");
  assert.ok(readTarget(root).mcp.servers["forge-cortex"], "the registry server is there too");

  const removed = removeIntegration("context7", { targetRoot: root });
  assert.equal(removed.ok, true, removed.reason);
  const doc = readTarget(root);
  assert.equal(doc.mcp.servers.context7, undefined, "removal reverses the add");
  assert.ok(doc.mcp.servers["forge-cortex"], "the registry server is untouched by the removal");
  const row = removed.rows.find((r) => r.target === OPENCLAW_TARGET);
  assert.equal(row.action, "written");
});

test("emitMcp ownership is per-target: adopting elsewhere does not claim OpenClaw's entry", () => {
  const root = fixture();
  mkdirSync(join(root, ".openclaw"), { recursive: true });
  writeFileSync(
    join(root, OPENCLAW_TARGET),
    `${JSON.stringify({ mcp: { servers: { srv: { command: "theirs" } } } }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { srv: { command: "theirs" } } }, null, 2)}\n`,
  );
  const servers = { srv: { command: "ours", args: [] } };
  // Adoption is recorded for Claude's file only.
  emitMcp({ targetRoot: root, servers, owns: (target) => target === ".mcp.json" });
  assert.equal(
    JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.srv.command,
    "ours",
    "the adopted target is refreshed",
  );
  assert.equal(
    readTarget(root).mcp.servers.srv.command,
    "theirs",
    "OpenClaw's same-name entry is NOT claimed by another target's adoption",
  );
});

// --------------------------------------------------------------------------
// Registry wiring + safety.
// --------------------------------------------------------------------------

test("openclaw is selectable and auto-detected as a primary tool", () => {
  assert.ok(KNOWN_TOOLS.includes("openclaw"));
  assert.equal(rowToolKey("OpenClaw MCP"), "openclaw");
  assert.equal(rowToolKey("OpenClaw"), "openclaw");
  const root = fixture();
  mkdirSync(join(root, ".openclaw"));
  assert.equal(detectPrimaryTool(root), "openclaw");
});

test("nothing forge emits for OpenClaw carries a credential", () => {
  const root = fixture();
  // A token in the environment must not be picked up and written into any artifact.
  const canary = "forge-openclaw-canary-token-value";
  process.env.FORGE_OPENCLAW_TEST_TOKEN = canary;
  try {
    sync({ targetRoot: root });
  } finally {
    delete process.env.FORGE_OPENCLAW_TEST_TOKEN;
  }
  const text = readFileSync(join(root, OPENCLAW_TARGET), "utf8");
  assert.ok(!text.includes(canary));
  // No credential-shaped keys at all: the stdio server needs none, so none are emitted.
  for (const key of ["env", "headers", "token", "password", "auth", "Authorization"])
    assert.ok(!text.includes(key), `${key} must not appear in ${OPENCLAW_TARGET}`);
});

test("emission stays inside the target repo — the user's ~/.openclaw is never a write target", () => {
  // Every ownable MCP path is repo-relative: no absolute path, no `~`, no parent escape.
  for (const target of MCP_TARGET_FILES) {
    assert.ok(!target.startsWith("~"), target);
    assert.ok(!target.startsWith("/") && !/^[A-Za-z]:/.test(target), target);
    assert.ok(!target.split(/[\\/]/).includes(".."), target);
  }
  assert.equal(OPENCLAW_TARGET, ".openclaw/mcp.json");
});

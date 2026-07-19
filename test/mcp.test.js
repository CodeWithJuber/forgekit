import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitMcp } from "../src/emit/mcp.js";
import { addIntegration, removeIntegration } from "../src/integrations.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-mcp-"));

// Every MCP target emitMcp writes, with its top-level key (mirror of src/emit/mcp.js).
const JSON_TARGETS = [
  [".mcp.json", "mcpServers"],
  [".cursor/mcp.json", "mcpServers"],
  [".gemini/settings.json", "mcpServers"],
  [".roo/mcp.json", "mcpServers"],
  [".zed/settings.json", "context_servers"],
  [".vscode/mcp.json", "servers"],
];

function assertServersEverywhere(root, names, when) {
  for (const [file, key] of JSON_TARGETS) {
    const j = JSON.parse(readFileSync(join(root, file), "utf8"));
    for (const n of names) assert.ok(j[key]?.[n], `${when}: ${n} present in ${file}`);
  }
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  for (const n of names)
    assert.match(toml, new RegExp(`\\[mcp_servers\\.${n}\\]`), `${when}: ${n} in codex toml`);
  for (const n of names) {
    const f = n.startsWith("forge-") ? `${n}.yaml` : `forge-${n}.yaml`;
    assert.ok(existsSync(join(root, ".continue", "mcpServers", f)), `${when}: ${f} exists`);
  }
}

test("sync emits MCP config into each tool's real format (forge server only, no third-party)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const mcp = readFileSync(join(root, ".mcp.json"), "utf8");
  assert.match(mcp, /"mcpServers"[\s\S]*forge-cortex/);
  // P0-06: the third-party context7 server is NOT installed by default.
  assert.doesNotMatch(mcp, /context7/, "context7 must not be a default MCP server");
  assert.match(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"), /forge-cortex/);
  assert.match(
    readFileSync(join(root, ".zed", "settings.json"), "utf8"),
    /"context_servers"[\s\S]*forge-cortex/,
  );
  assert.match(
    readFileSync(join(root, ".vscode", "mcp.json"), "utf8"),
    /"servers"[\s\S]*forge-cortex/,
  );
  assert.match(
    readFileSync(join(root, ".codex", "config.toml"), "utf8"),
    /\[mcp_servers\.forge-cortex\]/,
  );
  assert.match(
    readFileSync(join(root, ".continue", "mcpServers", "forge-cortex.yaml"), "utf8"),
    /mcpServers:/,
  );
});

test("integrations add context7 writes it (opt-in) after not being present by default", async () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.doesNotMatch(readFileSync(join(root, ".mcp.json"), "utf8"), /context7/);
  const m = await import("../src/integrations.js");
  assert.equal(m.planIntegration("nope").ok, false, "unknown integration rejected");
  const res = m.addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  const after = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(after.mcpServers.context7, "context7 added on opt-in");
  assert.ok(after.mcpServers["forge-cortex"], "existing forge server preserved");
});

test("ME-09: a divergent user entry with a registry name is preserved + reported, not overwritten", () => {
  const root = fixture();
  // A JSON entry named like the registry server but diverging from forge's spec is the
  // USER's — registry names carry no implicit ownership, so it must survive byte-identical.
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        mine: { command: "x" },
        "forge-cortex": { command: "forge", args: ["OLD-STALE-ARG"] },
      },
    }),
  );
  const r = sync({ targetRoot: root });
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(
    j.mcpServers["forge-cortex"].args,
    ["OLD-STALE-ARG"],
    "divergent registry-name entry preserved (not clobbered without adoption)",
  );
  assert.ok(j.mcpServers.mine, "user server preserved");
  const row = r.report.find((x) => x.target === ".mcp.json");
  assert.match(row.note, /user-owned/);
  assert.match(row.note, /--adopt/);
  // Absent targets still receive the registry server untouched.
  const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers["forge-cortex"], "registry server written where absent");
});

test("sync emits Continue rules (Continue does not read AGENTS.md)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.ok(existsSync(join(root, ".continue", "rules", "00-forge.md")));
  assert.match(
    readFileSync(join(root, ".continue", "rules", "00-forge.md"), "utf8"),
    /## Workflow/,
  );
});

test("MCP + rules emit is idempotent (second sync writes nothing new)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const written = sync({ targetRoot: root }).report.filter((r) => r.action === "written");
  assert.equal(written.length, 0, `second sync wrote: ${written.map((r) => r.target)}`);
});

test("MCP merge preserves a user's own server", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { mine: { command: "x" } } }),
  );
  sync({ targetRoot: root });
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(j.mcpServers.mine, "user server preserved");
  assert.ok(j.mcpServers["forge-cortex"], "forge server added");
});

test("cortex MCP exposes substrate tools", async () => {
  const { handle } = await import("../src/cortex_mcp.js");
  const listed = await handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("substrate_check"));
  assert.ok(names.includes("predict_impact"));
  assert.ok(names.includes("assumption_gate"));
  const called = await handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "assumption_gate", arguments: { task: "Fix the bug." } },
  });
  assert.match(called.result.content[0].text, /shouldAsk/);
});

// ---------------------------------------------------------------------------
// RA-03 / RA-21 regression matrix — non-destructive emitters, persistent managed set.
// ---------------------------------------------------------------------------

test("RA-03: sync → integrations add → sync keeps BOTH servers in every target (no oscillation)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  assertServersEverywhere(root, ["forge-cortex"], "after first sync");
  const res = addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  assertServersEverywhere(root, ["forge-cortex", "context7"], "after add");
  sync({ targetRoot: root });
  assertServersEverywhere(root, ["forge-cortex", "context7"], "after second sync");
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  assert.deepEqual(cfg.mcp.integrations, ["context7"], "install recorded in the managed set");
  assert.ok(
    cfg.mcp.adopted.some((a) => a.server === "context7" && a.target === ".mcp.json"),
    "fresh create is forge-owned per target (auto-adopted)",
  );
});

test("Codex: a stale forge-marked block is refreshed on the next emit", () => {
  const root = fixture();
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "config.toml"),
    '# forge:managed:forge-cortex begin\n[mcp_servers.forge-cortex]\ncommand = "forge"\nargs = ["OLD-STALE-ARG"]\n# forge:managed:forge-cortex end\n',
  );
  sync({ targetRoot: root });
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /args = \["cortex-mcp"\]/, "marked block refreshed");
  assert.doesNotMatch(toml, /OLD-STALE-ARG/);
  assert.equal(toml.match(/mcp_servers\.forge-cortex/g).length, 1, "no duplicate block");
});

test("Codex: unmarked user blocks (own name AND same-name) survive byte-identical, reported", () => {
  const root = fixture();
  const myTool = '[mcp_servers.mytool]\ncommand = "mine"\nargs = ["a"]\n';
  const myContext7 = '[mcp_servers.context7]\ncommand = "custom"\nargs = ["b"]\n';
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), `${myTool}\n${myContext7}`);
  const res = addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  assert.equal(res.adopted, false, "divergent pre-existing entry is NOT auto-adopted");
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  assert.ok(toml.includes(myTool), "user's own tool block byte-identical");
  assert.ok(toml.includes(myContext7), "user's same-name context7 block byte-identical");
  const row = res.rows.find((r) => r.target === ".codex/config.toml");
  assert.match(row.note, /user-owned/);
  assert.match(row.note, /--adopt/);
});

test("Codex: an unmarked block byte-matching the old forge emission is migrated to markers", () => {
  const root = fixture();
  // Exactly what the pre-marker emitter wrote for the registry server.
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "config.toml"),
    '\n[mcp_servers.forge-cortex]\ncommand = "forge"\nargs = ["cortex-mcp"]\n',
  );
  sync({ targetRoot: root });
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /# forge:managed:forge-cortex begin/, "wrapped with markers");
  assert.equal(toml.match(/mcp_servers\.forge-cortex/g).length, 1, "no duplicate block");
});

test("RA-21 JSON: user-owned same-name entry preserved + reported; --adopt refreshes it", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        context7: { command: "my-custom-context7" },
        other: { command: "keep-me" },
      },
    }),
  );
  let res = addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  let j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.equal(j.mcpServers.context7.command, "my-custom-context7", "user entry preserved");
  assert.ok(j.mcpServers.other, "unrelated user entry survives");
  const row = res.rows.find((r) => r.target === ".mcp.json");
  assert.match(row.note, /user-owned/);
  assert.match(row.note, /--adopt/);
  const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers.context7, "absent targets still get the server");
  res = addIntegration("context7", { targetRoot: root, adopt: true });
  assert.ok(res.ok && res.adopted);
  j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.equal(j.mcpServers.context7.command, "npx", "adopted entry refreshed to catalog spec");
  assert.ok(j.mcpServers.other, "unrelated user entry still survives");
});

test("Continue: per-server marked files; forge legacy combined file migrated; user file kept", () => {
  const root = fixture();
  const dir = join(root, ".continue", "mcpServers");
  mkdirSync(dir, { recursive: true });
  // The pre-RA-03 emitter's exact header fingerprint (it never wrote a marker).
  writeFileSync(
    join(dir, "forge-mcp.yaml"),
    "name: Forge MCP\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: forge-cortex\n",
  );
  sync({ targetRoot: root });
  assert.ok(existsSync(join(dir, "forge-cortex.yaml")), "per-server file written");
  assert.match(readFileSync(join(dir, "forge-cortex.yaml"), "utf8"), /forge:sync:/);
  assert.ok(!existsSync(join(dir, "forge-mcp.yaml")), "legacy combined file migrated away");

  // A forge-MARKED legacy file is also migrated away.
  writeFileSync(join(dir, "forge-mcp.yaml"), "# forge:sync:abc123\nmcpServers: []\n");
  sync({ targetRoot: root });
  assert.ok(!existsSync(join(dir, "forge-mcp.yaml")), "marked legacy file migrated away");

  // A marker-less file at the legacy path that is NOT forge's fingerprint is user-owned.
  const userYaml = "name: my own servers\nmcpServers: []\n";
  writeFileSync(join(dir, "forge-mcp.yaml"), userYaml);
  sync({ targetRoot: root });
  assert.equal(readFileSync(join(dir, "forge-mcp.yaml"), "utf8"), userYaml, "user file preserved");
});

test("integrations remove reverses add everywhere; second remove is a no-op", () => {
  const root = fixture();
  sync({ targetRoot: root });
  addIntegration("context7", { targetRoot: root });
  let res = removeIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  assert.equal(res.removed, true);
  for (const [file, key] of JSON_TARGETS) {
    const j = JSON.parse(readFileSync(join(root, file), "utf8"));
    assert.equal(j[key].context7, undefined, `context7 removed from ${file}`);
    assert.ok(j[key]["forge-cortex"], `forge-cortex kept in ${file}`);
  }
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(toml, /context7/, "codex block removed");
  assert.match(toml, /\[mcp_servers\.forge-cortex\]/, "registry block kept");
  assert.ok(!existsSync(join(root, ".continue", "mcpServers", "forge-context7.yaml")));
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  assert.deepEqual(cfg.mcp.integrations, [], "record cleared");
  assert.deepEqual(cfg.mcp.adopted, [], "adoption cleared");
  res = removeIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  assert.equal(res.removed, false, "second remove is a no-op");
});

test("integrations remove never deletes a user-owned same-name entry", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: { context7: { command: "my-custom-context7" } },
    }),
  );
  addIntegration("context7", { targetRoot: root }); // not adopted — user entry preserved
  const res = removeIntegration("context7", { targetRoot: root });
  assert.ok(res.ok && res.removed);
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.equal(j.mcpServers.context7.command, "my-custom-context7", "user entry left in place");
  const cursor = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.context7, undefined, "forge-written entry removed");
});

test("corrupt forge.config.json: sync emits registry-only + warns; add refuses; bytes kept", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "forge.config.json"), "{ not json");
  const r = sync({ targetRoot: root });
  assert.ok(
    r.warnings.some((w) => /registry-only/.test(w)),
    "sync warns about registry-only fallback",
  );
  const j = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(j.mcpServers["forge-cortex"], "registry server still emitted");
  const res = addIntegration("context7", { targetRoot: root });
  assert.equal(res.ok, false, "add refuses when the record cannot be updated");
  assert.equal(
    readFileSync(join(root, ".forge", "forge.config.json"), "utf8"),
    "{ not json",
    "corrupt config bytes never overwritten",
  );
});

// ---------------------------------------------------------------------------
// ME-08..ME-11 — per-target ownership, atomic add/remove, name/definition validation.
// ---------------------------------------------------------------------------

const writeForgeConfigFile = (root, mcp) => {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "forge.config.json"), `${JSON.stringify({ mcp }, null, 2)}\n`);
};

test("ME-08: per-target adoption does not leak to other targets; legacy bare name honored", () => {
  const root = fixture();
  // A divergent same-name context7 in TWO targets.
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "custom-a" } } }),
  );
  mkdirSync(join(root, ".cursor"), { recursive: true });
  writeFileSync(
    join(root, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "custom-b" } } }),
  );
  // Adopt context7 for .mcp.json ONLY (per-target record).
  writeForgeConfigFile(root, {
    integrations: ["context7"],
    adopted: [{ server: "context7", target: ".mcp.json" }],
  });
  sync({ targetRoot: root });
  const a = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const b = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.equal(a.mcpServers.context7.command, "npx", "adopted target refreshed to catalog spec");
  assert.equal(b.mcpServers.context7.command, "custom-b", "non-adopted target NOT overwritten");

  // Legacy bare name is honored as a wildcard: both targets refresh.
  writeForgeConfigFile(root, { integrations: ["context7"], adopted: ["context7"] });
  writeFileSync(
    join(root, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "custom-b" } } }),
  );
  sync({ targetRoot: root });
  const b2 = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
  assert.equal(b2.mcpServers.context7.command, "npx", "legacy bare adopted name honored for all");
});

test("ME-08: add over a divergent entry in one target does not adopt it in others", () => {
  const root = fixture();
  // context7 diverges only in .mcp.json; absent elsewhere.
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "mine" } } }),
  );
  const res = addIntegration("context7", { targetRoot: root });
  assert.ok(res.ok);
  assert.equal(res.adopted, false, "pre-existing divergent entry not auto-adopted");
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  const owns = (t) => cfg.mcp.adopted.some((a) => a.server === "context7" && a.target === t);
  assert.equal(owns(".mcp.json"), false, "divergent target NOT adopted");
  assert.equal(owns(".cursor/mcp.json"), true, "fresh target auto-adopted");
  // The divergent entry survives byte-identical.
  const a = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.equal(a.mcpServers.context7.command, "mine", "user entry preserved");
});

test("ME-10 add: a failing target does not record a fully-installed integration", () => {
  const root = fixture();
  // Make .cursor a FILE so mkdirSync(.cursor) throws when emitting .cursor/mcp.json.
  writeFileSync(join(root, ".cursor"), "not a directory");
  const res = addIntegration("context7", { targetRoot: root });
  assert.equal(res.ok, false, "partial emit is not a success");
  assert.ok(res.incomplete, "reported as incomplete");
  assert.ok(
    res.rows.some((r) => r.action === "error"),
    "a target reported an error",
  );
  // The install was NOT recorded — a later add can finish.
  const cfgPath = join(root, ".forge", "forge.config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.ok(
      !(cfg.mcp?.integrations || []).includes("context7"),
      "context7 not recorded as installed after partial emit",
    );
  }
});

test("ME-10 remove: a failing target cleanup keeps the integration recorded (recoverable)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  addIntegration("context7", { targetRoot: root });
  // Sabotage the Continue per-server file: replace it with a directory so cleanup throws.
  const contFile = join(root, ".continue", "mcpServers", "forge-context7.yaml");
  rmSync(contFile, { force: true });
  mkdirSync(contFile, { recursive: true });
  const res = removeIntegration("context7", { targetRoot: root });
  assert.equal(res.removed, false, "not reported as fully removed");
  assert.ok(
    res.rows.some((r) => r.action === "error"),
    "a target cleanup errored",
  );
  const cfg = JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8"));
  assert.ok(
    cfg.mcp.integrations.includes("context7"),
    "integration kept in the managed set so a later remove can finish",
  );
});

test("ME-11: invalid server names are rejected before any write", () => {
  const root = fixture();
  for (const bad of ["../x", "foo bar", "foo\nbar", "foo.bar", "foo]bar", "Foo", "-foo"]) {
    assert.throws(
      () => emitMcp({ targetRoot: root, servers: { [bad]: { command: "x" } } }),
      /invalid MCP server name/,
      `rejected: ${JSON.stringify(bad)}`,
    );
  }
  // Nothing was written for the rejected set.
  assert.ok(!existsSync(join(root, ".mcp.json")), "no file written on validation failure");
});

test("ME-11: foo vs forge-foo Continue filename collision is rejected", () => {
  const root = fixture();
  assert.throws(
    () =>
      emitMcp({
        targetRoot: root,
        servers: { foo: { command: "x" }, "forge-foo": { command: "y" } },
      }),
    /collide on Continue file/,
  );
});

test("ME-11: a YAML-special command is serialized safely (quoted)", () => {
  const root = fixture();
  emitMcp({
    targetRoot: root,
    servers: { srv: { command: "cmd: --flag #danger", args: ["a: b"] } },
  });
  const yaml = readFileSync(join(root, ".continue", "mcpServers", "forge-srv.yaml"), "utf8");
  assert.match(yaml, /command: "cmd: --flag #danger"/, "command quoted as a YAML scalar");
  // And the same command lands safely (JSON-quoted) in the Codex TOML.
  const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  assert.match(toml, /command = "cmd: --flag #danger"/, "command quoted as a TOML string");
});

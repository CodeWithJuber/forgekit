// forge init emits config only for the tools a repo uses — Claude + AGENTS.md by default,
// plus every tool with a sign of life on disk, or an explicit --tools list — and records the
// choice so later syncs emit the same set. It used to create .aider.conf.yml, .codex/,
// .continue/, .cursor/, .gemini/, .openclaw/, .roo/, .vscode/ and .zed/ in every repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emitMcp } from "../src/emit/mcp.js";
import { init, resolveInitTools } from "../src/init.js";
import { addIntegration } from "../src/integrations.js";
import {
  clearRepoConfig,
  detectTools,
  KNOWN_TOOLS,
  parseTools,
  readForgeConfig,
  writeForgeConfig,
} from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-init-tools-"));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const OTHER_TOOL_PATHS = [
  ".aider.conf.yml",
  ".codex",
  ".continue",
  ".cursor",
  ".gemini",
  ".openclaw",
  ".roo",
  ".vscode",
  ".zed",
];

test("detectTools reads each tool's on-disk signs, including legacy rules files", () => {
  assert.deepEqual(detectTools(fixture()), []);
  const root = fixture();
  mkdirSync(join(root, ".cursor"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "copilot-instructions.md"), "be nice\n");
  writeFileSync(join(root, ".windsurfrules"), "x\n");
  writeFileSync(join(root, "CLAUDE.md"), "# mine\n");
  assert.deepEqual(detectTools(root), ["claude", "cursor", "vscode", "windsurf"]);
});

test("parseTools normalises lists, aliases and `all`; unknown names are reported", () => {
  assert.deepEqual(parseTools("cursor, Claude"), { tools: ["claude", "cursor"], unknown: [] });
  assert.deepEqual(parseTools(["copilot", "devin"]), {
    tools: ["vscode", "windsurf"],
    unknown: [],
  });
  assert.deepEqual(parseTools("all"), { tools: null, unknown: [] });
  assert.deepEqual(parseTools("claude,nope,nope"), { tools: ["claude"], unknown: ["nope"] });
  assert.deepEqual(parseTools(42), { tools: [], unknown: [] });
});

test("resolveInitTools: --tools wins, then the recorded set, else Claude + detected", () => {
  const root = fixture();
  mkdirSync(join(root, ".codex"));
  assert.deepEqual(resolveInitTools(root), { tools: ["claude", "codex"], source: "detected" });
  assert.deepEqual(resolveInitTools(root, "cursor"), { tools: ["cursor"], source: "--tools" });
  assert.deepEqual(resolveInitTools(root, "all"), { tools: null, source: "--tools" });
  assert.match(resolveInitTools(root, "claude,bogus").error, /unknown tool\(s\).*bogus/);
  assert.match(resolveInitTools(root, "").error, /at least one tool/);
  writeForgeConfig(root, (cfg) => ({ ...cfg, tools: ["gemini"] }));
  assert.deepEqual(resolveInitTools(root), { tools: ["gemini"], source: "config" });
});

test("init on a fresh repo emits Claude + AGENTS.md only and records the choice", () => {
  const root = fixture();
  const r = init({ targetRoot: root, noSettings: true });
  assert.deepEqual(r.tools, { tools: ["claude"], source: "detected" });
  for (const p of ["AGENTS.md", "CLAUDE.md", ".mcp.json"]) assert.ok(existsSync(join(root, p)), p);
  for (const p of OTHER_TOOL_PATHS) assert.ok(!existsSync(join(root, p)), `${p} not created`);
  assert.deepEqual(readForgeConfig(root).tools, ["claude"]);
  // A later plain sync (and doctor --fix, and `forge tools`) honours the recorded set.
  sync({ targetRoot: root });
  for (const p of OTHER_TOOL_PATHS) assert.ok(!existsSync(join(root, p)), `${p} still absent`);
});

test("init emits for tools the repo already uses (.cursor/, copilot-instructions.md)", () => {
  const root = fixture();
  mkdirSync(join(root, ".cursor"));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "copilot-instructions.md"), "x\n");
  const r = init({ targetRoot: root, noSettings: true });
  assert.deepEqual(r.tools.tools, ["claude", "cursor", "vscode"]);
  assert.ok(existsSync(join(root, ".cursor", "mcp.json")), "Cursor MCP");
  assert.ok(existsSync(join(root, ".vscode", "mcp.json")), "VS Code / Copilot MCP");
  for (const p of [".aider.conf.yml", ".gemini", ".codex", ".continue", ".roo", ".zed"])
    assert.ok(!existsSync(join(root, p)), `${p} not created`);
});

test("init --tools all emits every tool (the old behaviour, on request)", () => {
  const root = fixture();
  const r = init({ targetRoot: root, noSettings: true, tools: "all" });
  assert.equal(r.tools.tools, null);
  for (const p of OTHER_TOOL_PATHS) assert.ok(existsSync(join(root, p)), `${p} emitted`);
  assert.equal(readForgeConfig(root).tools, "all");
});

test("init with an unknown --tools name aborts before touching the repo", () => {
  const root = fixture();
  const r = init({ targetRoot: root, noSettings: true, tools: "claude,notatool" });
  assert.equal(r.aborted, true);
  assert.match(r.tools.error, /notatool/);
  assert.deepEqual(readdirSync(root), [], "zero side effects");
});

test("re-running init keeps the recorded set and does not churn config backups", () => {
  const root = fixture();
  init({ targetRoot: root, noSettings: true, tools: "claude,gemini" });
  mkdirSync(join(root, ".roo")); // appears later; the recorded choice still wins
  const again = init({ targetRoot: root, noSettings: true });
  assert.deepEqual(again.tools, { tools: ["claude", "gemini"], source: "config" });
  assert.ok(!existsSync(join(root, ".roo", "mcp.json")), "not re-detected over the choice");
  const baks = readdirSync(join(root, ".forge")).filter((f) => f.includes("forge-bak"));
  assert.deepEqual(baks, [], "config written once, not rewritten (and backed up) every run");
});

test("init --profile records profile and tools in ONE config write (no stray backup)", () => {
  const root = fixture();
  init({ targetRoot: root, noSettings: true, profile: "minimal" });
  assert.deepEqual(readForgeConfig(root), { profile: "minimal", tools: ["claude"] });
  const baks = readdirSync(join(root, ".forge")).filter((f) => f.includes("forge-bak"));
  assert.deepEqual(baks, []);
});

test("sync without a recorded selection still emits every tool (back-compat)", () => {
  const root = fixture();
  const r = sync({ targetRoot: root });
  assert.equal(r.tools, null);
  assert.ok(existsSync(join(root, ".aider.conf.yml")));
  assert.ok(existsSync(join(root, ".cursor", "mcp.json")));
});

test("sync warns about unknown names in a hand-edited `tools` config instead of failing", () => {
  const root = fixture();
  writeForgeConfig(root, (cfg) => ({ ...cfg, tools: ["claude", "emacs"] }));
  const r = sync({ targetRoot: root });
  assert.deepEqual(r.tools, ["claude"]);
  assert.ok(r.warnings.some((w) => /unknown tool\(s\).*emacs/.test(w)));
});

test("emitMcp writes only the selected tools' MCP targets", () => {
  const root = fixture();
  const servers = { "forge-cortex": { command: "forge", args: ["mcp"] } };
  const rows = emitMcp({ targetRoot: root, servers, tools: ["claude", "codex"] });
  assert.deepEqual(
    rows.map((r) => r.target),
    [".mcp.json", ".codex/config.toml"],
  );
  assert.deepEqual(readdirSync(root).sort(), [".codex", ".mcp.json"]);
  assert.ok(KNOWN_TOOLS.length > 2, "every other known tool was skipped");
});

test("integrations add honours the recorded tool set (no config for unused tools)", () => {
  const root = fixture();
  init({ targetRoot: root, noSettings: true });
  const res = addIntegration("context7", { targetRoot: root });
  assert.equal(res.ok, true, res.reason);
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.context7, "written for Claude Code");
  for (const p of OTHER_TOOL_PATHS) assert.ok(!existsSync(join(root, p)), `${p} not created`);
});

test("`forge tools --reset` keeps the recorded emit set (clearRepoConfig drops primaryTool only)", () => {
  const root = fixture();
  writeForgeConfig(root, (cfg) => ({ ...cfg, primaryTool: "claude", tools: ["claude"] }));
  assert.equal(clearRepoConfig(root).cleared, true);
  assert.deepEqual(readForgeConfig(root), { tools: ["claude"] });
});

test("notes a person adds under the generated CLAUDE.md header survive a later sync", () => {
  const root = fixture();
  sync({ targetRoot: root, tools: ["claude"] });
  const claudeMd = join(root, "CLAUDE.md");
  const notes = "\n## Claude-only\n- prefer small diffs\n";
  writeFileSync(claudeMd, readFileSync(claudeMd, "utf8") + notes);
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "rules.json"),
    JSON.stringify({ sections: [{ title: "New", rules: ["changes the hash"] }] }),
  );
  const r = sync({ targetRoot: root, tools: ["claude"] });
  const after = readFileSync(claudeMd, "utf8");
  assert.ok(after.endsWith(notes), "the person's notes are still there");
  assert.match(after, new RegExp(`forge:sync:${r.hash}`), "marker refreshed in place");
  assert.equal((after.match(/@AGENTS\.md/g) || []).length, 1);
});

test("CLI: `forge init --tools` prints the selection; a bad name exits 1 with nothing written", () => {
  const env = { ...process.env, FORGE_NO_HINT: "1" };
  const root = fixture();
  const ok = spawnSync("node", [CLI, "init", "--no-settings", "--tools", "claude,cursor"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /tools: {4}claude, cursor \(from --tools\)/);
  assert.match(ok.stdout, /forge owns only the block between <!-- forge:begin -->/);
  assert.ok(existsSync(join(root, ".cursor", "mcp.json")));

  const bad = fixture();
  const r = spawnSync("node", [CLI, "init", "--no-settings", "--tools=nope"], {
    cwd: bad,
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown tool\(s\) for --tools: nope/);
  assert.deepEqual(readdirSync(bad), []);
});

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
import { readGitignoreBlock } from "../src/gitignore.js";
import {
  applyPrimaryTool,
  clearRepoConfig,
  detectPrimaryTool,
  KNOWN_TOOLS,
  nonPrimaryTargets,
  readForgeConfig,
  readRepoConfig,
  resolvePrimaryTool,
  rowToolKey,
  writeForgeConfig,
} from "../src/repo_config.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const runCli = (args, cwd) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "forge-tools-"));

// A stand-in for sync()'s report shape so unit tests don't emit real files.
const FAKE_REPORT = {
  report: [
    { tool: "shared source", target: "AGENTS.md" },
    { tool: "Claude Code", target: "CLAUDE.md" },
    { tool: "Claude Code MCP", target: ".mcp.json" },
    { tool: "Cursor", target: "AGENTS.md" },
    { tool: "Cursor MCP", target: ".cursor/mcp.json" },
    { tool: "Gemini CLI MCP", target: ".gemini/settings.json" },
    { tool: "Codex MCP", target: ".codex/config.toml" },
    { tool: "Zed MCP", target: ".zed/settings.json" },
    { tool: "Aider", target: ".aider.conf.yml" },
  ],
};

test("readRepoConfig returns {} for a repo with no config", () => {
  const root = tmp();
  assert.deepEqual(readRepoConfig(root), {});
  assert.deepEqual(resolvePrimaryTool(root), { tool: null, source: "none" });
});

test("detectPrimaryTool auto-detects from an agent folder/file", () => {
  const root = tmp();
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
  assert.equal(detectPrimaryTool(root), "claude");
  assert.deepEqual(resolvePrimaryTool(root), {
    tool: "claude",
    source: "auto-detect",
  });

  const root2 = tmp();
  mkdirSync(join(root2, ".cursor"));
  assert.equal(detectPrimaryTool(root2), "cursor");
});

test("explicit config wins over auto-detect", () => {
  const root = tmp();
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n"); // would auto-detect claude
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ primaryTool: "cursor" }));
  assert.deepEqual(readRepoConfig(root), { primaryTool: "cursor" });
  assert.deepEqual(resolvePrimaryTool(root), {
    tool: "cursor",
    source: "config",
  });
});

test("malformed config never throws — treated as absent", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.json"), "{ not json");
  assert.deepEqual(readRepoConfig(root), {});
});

test("readForgeConfig: forge.config.json wins over legacy config.json on key conflicts", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ primaryTool: "cursor" }));
  writeFileSync(
    join(root, ".forge/forge.config.json"),
    JSON.stringify({ primaryTool: "claude", profile: "minimal" }),
  );
  const cfg = readForgeConfig(root);
  assert.equal(cfg.primaryTool, "claude", "unified file wins");
  assert.equal(cfg.profile, "minimal");
  assert.deepEqual(readRepoConfig(root), { primaryTool: "claude" });
});

test("readForgeConfig: corrupt forge.config.json is reported, valid legacy data still read (RA-15)", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/forge.config.json"), "{ not json");
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ primaryTool: "cursor" }));
  const cfg = readForgeConfig(root);
  assert.equal(cfg.corrupt, true, "corruption is reported, not swallowed");
  assert.equal(cfg.path, join(root, ".forge/forge.config.json"));
  assert.equal(cfg.primaryTool, "cursor", "valid data from the other file still read");
  // The filtered primary-tool view stays throw-free and back-compat shaped.
  assert.deepEqual(readRepoConfig(root), { primaryTool: "cursor" });
});

test("writeForgeConfig refuses to overwrite a corrupt forge.config.json (RA-15)", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  const file = join(root, ".forge/forge.config.json");
  const original = "{ definitely not json";
  writeFileSync(file, original);
  const res = writeForgeConfig(root, (cfg) => {
    cfg.profile = "minimal";
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not valid JSON/);
  assert.equal(
    readFileSync(file, "utf8"),
    original,
    "corrupt bytes preserved for the human to fix",
  );
});

test("writeForgeConfig round-trips unknown keys and folds legacy config.json keys", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/forge.config.json"),
    JSON.stringify({
      profile: "minimal",
      mcp: { integrations: ["context7"], adopted: ["x"] },
    }),
  );
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ primaryTool: "cursor" }));
  const res = writeForgeConfig(root, (cfg) => {
    cfg.primaryTool = "claude";
  });
  assert.equal(res.ok, true);
  const written = JSON.parse(readFileSync(join(root, ".forge/forge.config.json"), "utf8"));
  assert.deepEqual(written, {
    profile: "minimal",
    mcp: { integrations: ["context7"], adopted: ["x"] }, // unknown keys round-trip untouched
    primaryTool: "claude", // legacy key folded in, then mutated
  });
  // The legacy file is left in place (documented precedence: forge.config.json wins).
  assert.ok(existsSync(join(root, ".forge/config.json")));
});

test("applyPrimaryTool fails loudly on a corrupt forge.config.json — bytes preserved", async () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  const file = join(root, ".forge/forge.config.json");
  writeFileSync(file, "{ not json");
  await assert.rejects(
    () => applyPrimaryTool(root, "claude", { syncFn: () => FAKE_REPORT }),
    /not valid JSON/,
  );
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("clearRepoConfig scrubs primaryTool from both files but preserves other keys", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ primaryTool: "cursor" }));
  writeFileSync(
    join(root, ".forge/forge.config.json"),
    JSON.stringify({ primaryTool: "claude", profile: "minimal" }),
  );
  const r = clearRepoConfig(root);
  assert.equal(r.cleared, true);
  assert.deepEqual(readRepoConfig(root), {}, "no primary tool resurfaces from the legacy file");
  const kept = JSON.parse(readFileSync(join(root, ".forge/forge.config.json"), "utf8"));
  assert.deepEqual(kept, { profile: "minimal" }, "non-primary-tool keys preserved");
  assert.ok(!existsSync(join(root, ".forge/config.json")), "emptied legacy file deleted");
});

test("rowToolKey maps labels; shared source is never mapped", () => {
  assert.equal(rowToolKey("shared source"), null);
  assert.equal(rowToolKey("Claude Code MCP"), "claude");
  assert.equal(rowToolKey("VS Code / Copilot MCP"), "vscode");
  assert.equal(rowToolKey("Gemini CLI"), "gemini");
});

test("nonPrimaryTargets keeps AGENTS.md + primary's own files, ignores the rest", () => {
  const targets = nonPrimaryTargets(FAKE_REPORT.report, "claude");
  // Shared AGENTS.md and Claude's own CLAUDE.md/.mcp.json stay tracked:
  assert.ok(!targets.includes("AGENTS.md"));
  assert.ok(!targets.includes("CLAUDE.md"));
  assert.ok(!targets.includes(".mcp.json"));
  // Every other tool's artifact is listed:
  assert.deepEqual(targets, [
    ".aider.conf.yml",
    ".codex/config.toml",
    ".cursor/mcp.json",
    ".gemini/settings.json",
    ".zed/settings.json",
  ]);
});

test("applyPrimaryTool writes config + gitignore block (injected sync)", async () => {
  const root = tmp();
  const r = await applyPrimaryTool(root, "claude", {
    syncFn: () => FAKE_REPORT,
  });
  assert.equal(r.primaryTool, "claude");
  assert.equal(readRepoConfig(root).primaryTool, "claude");
  assert.deepEqual(readGitignoreBlock(root), r.targets);
  assert.ok(r.targets.includes(".cursor/mcp.json"));
  assert.ok(!r.targets.includes("CLAUDE.md"));
});

test("applyPrimaryTool rejects an unknown tool", async () => {
  const root = tmp();
  await assert.rejects(() => applyPrimaryTool(root, "notatool", { syncFn: () => FAKE_REPORT }));
});

test("`forge tools <name>` writes config + block from REAL emit targets", () => {
  const root = tmp();
  const res = runCli(["tools", "claude", "--json"], root);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.primaryTool, "claude");
  // config persisted
  assert.equal(readRepoConfig(root).primaryTool, "claude");
  // real sync emitted secondary-tool artifacts; the block lists them, not Claude's own
  const block = readGitignoreBlock(root);
  assert.ok(block.length > 0);
  assert.ok(block.includes(".cursor/mcp.json"), JSON.stringify(block));
  assert.ok(!block.includes("AGENTS.md"));
  assert.ok(!block.includes("CLAUDE.md"));
});

test("`forge tools --reset` clears config and removes ONLY the block", () => {
  const root = tmp();
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  runCli(["tools", "claude"], root);
  assert.ok(existsSync(join(root, ".forge/forge.config.json")));
  assert.ok(readGitignoreBlock(root).length > 0);

  const res = runCli(["tools", "--reset", "--json"], root);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readRepoConfig(root), {});
  assert.deepEqual(readGitignoreBlock(root), []);
  // user line survives the reset
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules\n");
});

test("`forge tools` rejects an unknown tool with a non-zero exit", () => {
  const root = tmp();
  const res = runCli(["tools", "notatool"], root);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown tool/);
});

test("clearRepoConfig on a fresh repo reports nothing to clear", () => {
  const root = tmp();
  assert.equal(clearRepoConfig(root).cleared, false);
});

test("KNOWN_TOOLS covers the documented set", () => {
  for (const t of ["claude", "cursor", "gemini", "codex", "zed", "vscode"])
    assert.ok(KNOWN_TOOLS.includes(t));
});

// ME-12: valid-but-non-object top-level JSON (null / [] / "x" / 42) must be treated as
// CORRUPT, not coerced to {} — otherwise a later write silently replaces valid bytes.
for (const body of ["null", "[]", '"oops"', "42"]) {
  test(`ME-12: non-object forge.config.json (${body}) is corrupt, not silently discarded`, () => {
    const root = tmp();
    mkdirSync(join(root, ".forge"), { recursive: true });
    const file = join(root, ".forge/forge.config.json");
    writeFileSync(file, body);

    // read: reported corrupt, never thrown, never coerced to usable data
    const cfg = readForgeConfig(root);
    assert.equal(cfg.corrupt, true, "corruption reported");
    assert.equal(cfg.path, file);
    assert.deepEqual(readRepoConfig(root), {}, "no bogus primary tool surfaces");

    // write: refused, bytes preserved for the human to fix
    const res = writeForgeConfig(root, (c) => {
      c.profile = "minimal";
    });
    assert.equal(res.ok, false, "write refuses");
    assert.equal(readFileSync(file, "utf8"), body, "original bytes preserved");
  });
}

// ME-13: writes go through a temp file + atomic rename, and an existing valid config is
// backed up (timestamped) before it is overwritten — a crash can never truncate the config.
test("ME-13: writeForgeConfig backs up the existing config and writes atomically", () => {
  const root = tmp();
  mkdirSync(join(root, ".forge"), { recursive: true });
  const file = join(root, ".forge/forge.config.json");
  const original = `${JSON.stringify({ profile: "minimal", keep: "me" }, null, 2)}\n`;
  writeFileSync(file, original);

  const res = writeForgeConfig(root, (c) => {
    c.primaryTool = "claude";
  });
  assert.equal(res.ok, true);

  // new content is intact and complete (no truncation), unknown keys round-tripped
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(written, {
    profile: "minimal",
    keep: "me",
    primaryTool: "claude",
  });

  // a timestamped backup of the ORIGINAL bytes appears next to the config
  const backups = readdirSync(join(root, ".forge")).filter((f) =>
    f.startsWith("forge.config.json.forge-bak-"),
  );
  assert.equal(backups.length, 1, "one backup written");
  assert.equal(
    readFileSync(join(root, ".forge", backups[0]), "utf8"),
    original,
    "backup holds the pre-overwrite bytes",
  );
  // no temp file is left behind after the rename
  assert.ok(
    !readdirSync(join(root, ".forge")).some((f) => f.includes(".forge-tmp-")),
    "temp file renamed away",
  );
});

test("ME-13: first write (no existing config) needs no backup", () => {
  const root = tmp();
  const res = writeForgeConfig(root, (c) => {
    c.primaryTool = "claude";
  });
  assert.equal(res.ok, true);
  const backups = readdirSync(join(root, ".forge")).filter((f) => f.includes(".forge-bak-"));
  assert.deepEqual(backups, [], "no backup for a fresh config");
});

// ME-14: KNOWN_TOOLS and primary-tool auto-detection are reconciled with the emit targets —
// Roo is selectable and every tool with an on-disk marker is detected.
test("ME-14: KNOWN_TOOLS includes roo/aider/continue/windsurf and detection recognizes them", () => {
  for (const t of ["aider", "continue", "windsurf", "roo"])
    assert.ok(KNOWN_TOOLS.includes(t), `${t} is selectable via \`forge tools\``);

  // Each tool's marker auto-detects that tool.
  const aiderRoot = tmp();
  writeFileSync(join(aiderRoot, ".aider.conf.yml"), "read: AGENTS.md\n");
  assert.equal(detectPrimaryTool(aiderRoot), "aider");

  const contRoot = tmp();
  mkdirSync(join(contRoot, ".continue"));
  assert.equal(detectPrimaryTool(contRoot), "continue");

  const windRoot = tmp();
  mkdirSync(join(windRoot, ".windsurf"));
  assert.equal(detectPrimaryTool(windRoot), "windsurf");

  const rooRoot = tmp();
  mkdirSync(join(rooRoot, ".roo"));
  assert.equal(detectPrimaryTool(rooRoot), "roo");
  assert.equal(rowToolKey("Roo Code MCP"), "roo", "emit label maps to the same key");
});

test("ME-14: `forge tools roo` is accepted (roo is a known tool)", async () => {
  const root = tmp();
  const r = await applyPrimaryTool(root, "roo", { syncFn: () => FAKE_REPORT });
  assert.equal(r.primaryTool, "roo");
  assert.equal(readRepoConfig(root).primaryTool, "roo");
});

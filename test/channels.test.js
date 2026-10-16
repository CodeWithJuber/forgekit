import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("plugin channel points at global/ (no duplication)", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  assert.equal(plugin.skills, "./global/tools");
  // The manifest schema requires each `agents` entry to be a path to a .md file
  // (pattern ^\.\/.*\.md$), not a directory — so crew agents are listed explicitly.
  assert.ok(Array.isArray(plugin.agents), "agents is an array of agent files");
  for (const a of plugin.agents) {
    assert.match(a, /^\.\/global\/crew\/.+\.md$/, `agent path ${a} is a ./global/crew/*.md file`);
    assert.ok(existsSync(join(root, a)), `${a} exists`);
  }
  assert.ok(existsSync(join(root, "global/tools")), "global/tools exists");
  assert.ok(existsSync(join(root, "global/crew")), "global/crew exists");
});

test("plugin name matches the distributable id (brand pkg)", () => {
  assert.equal(readJson(".claude-plugin/plugin.json").name, readJson("brand.json").pkg);
});

test("marketplace lists the plugin at the repo root", () => {
  const mkt = readJson(".claude-plugin/marketplace.json");
  assert.ok(Array.isArray(mkt.plugins) && mkt.plugins.length >= 1);
  assert.equal(mkt.plugins[0].source, ".");
  assert.ok(mkt.description, "marketplace declares a description (plugin validate warns without)");
});

// A plugin-only install never puts `forge` on PATH, so the root .mcp.json's bare `forge`
// command cannot spawn there. Claude Code loads the root .mcp.json first and lets a server
// the manifest declares later replace it by name, so the manifest pins the server to the
// plugin's own cli.js (the contributor checkout and the Codex manifest keep .mcp.json).
test("plugin manifest launches forge-cortex from the plugin root, not a PATH lookup", () => {
  const server = readJson(".claude-plugin/plugin.json").mcpServers?.["forge-cortex"];
  assert.ok(server, "plugin.json declares forge-cortex");
  assert.equal(server.command, "node");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${CLAUDE_PLUGIN_ROOT} is expanded by Claude Code at load time, must stay a literal string
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/cli.js", "cortex-mcp"]);
  assert.ok(existsSync(join(root, "src/cli.js")), "the launched entry point ships in the plugin");
  assert.ok(readJson(".mcp.json").mcpServers["forge-cortex"], "root .mcp.json keeps the same name");
});

test("npm channel ships global/ and the forge bin", () => {
  const pkg = readJson("package.json");
  assert.ok(pkg.files.includes("global"), "files includes global");
  assert.equal(pkg.bin.forge, "src/cli.js");
});

test("installer channel references global/", () => {
  const sh = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(sh, /global\/tools/);
  assert.match(sh, /"\$REPO\/global"/);
});

test("plugin hooks wire guards from the plugin root", () => {
  const hooks = JSON.stringify(readJson("hooks/hooks.json"));
  assert.match(hooks, /CLAUDE_PLUGIN_ROOT/);
  assert.match(hooks, /global\/guards\/protect-paths\.sh/);
});

// Claude Code loads the standard hooks/hooks.json automatically. Declaring it in
// `manifest.hooks` too registers the same file twice, and the loader rejects the
// WHOLE plugin ("Duplicate hooks file detected") — skills, agents, guards and the
// MCP server all vanish. manifest.hooks is only for ADDITIONAL hook files.
test("plugin manifest does not re-declare the standard hooks file", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const declared = [plugin.hooks ?? []].flat();
  for (const h of declared) {
    assert.notMatch(
      h,
      /^\.\/hooks\/hooks\.json$/,
      "hooks/hooks.json loads automatically; declaring it fails plugin load",
    );
  }
  assert.ok(existsSync(join(root, "hooks/hooks.json")), "the auto-loaded hooks file still exists");
});

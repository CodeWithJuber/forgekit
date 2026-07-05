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
  assert.equal(plugin.agents, "./global/crew");
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

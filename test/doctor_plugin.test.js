// Doctor × the Forge Claude Code PLUGIN. The plugin's hooks/hooks.json already wires every
// guard. Doctor used to ignore `enabledPlugins` and report "forge hooks missing/stale (15/15
// guard(s) absent) — run forge doctor --fix", and that fix merged the same 15 hooks into
// settings.json, so every guard (the Stop gate included) ran twice. With the plugin enabled,
// doctor now never asks for hooks: its repair merges permissions only, and a settings copy of
// the guards is reported as a double registration.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { doctor } from "../src/doctor.js";
import { forgePluginEnabled, init, mergeSettings } from "../src/init.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-doctor-plugin-"));
const PLUGIN = `${BRAND.pkg}@forge`;
const hookCount = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((e) => e.hooks || []).length;
const settingsRow = (opts) => doctor(opts).results.find((r) => r.label === "settings");

test("the plugin id doctor keys on is the real plugin manifest name", () => {
  const manifest = JSON.parse(
    readFileSync(join(BRAND.root, ".claude-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, BRAND.pkg);
});

test("forgePluginEnabled: user → project → local, the later scope wins", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  mkdirSync(join(root, ".claude"));
  assert.deepEqual(forgePluginEnabled({ settingsPath, targetRoot: root }), {
    enabled: false,
    source: null,
  });
  writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }));
  assert.deepEqual(forgePluginEnabled({ settingsPath, targetRoot: root }), {
    enabled: true,
    source: settingsPath,
  });
  const local = join(root, ".claude", "settings.local.json");
  writeFileSync(local, JSON.stringify({ enabledPlugins: { [PLUGIN]: false } }));
  assert.equal(forgePluginEnabled({ settingsPath, targetRoot: root }).enabled, false);
  // Enabled only in the project, nothing at user scope.
  const project = join(root, ".claude", "settings.json");
  writeFileSync(local, "{}");
  writeFileSync(settingsPath, "{}");
  writeFileSync(project, JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }));
  assert.deepEqual(forgePluginEnabled({ settingsPath, targetRoot: root }), {
    enabled: true,
    source: project,
  });
  // Some other plugin is not Forge.
  writeFileSync(project, JSON.stringify({ enabledPlugins: { "other@x": true } }));
  assert.equal(forgePluginEnabled({ settingsPath, targetRoot: root }).enabled, false);
});

test("mergeSettings: a settings file that enables the plugin gets permissions but NO hooks", () => {
  const settingsPath = join(fixture(), "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }));
  const r = mergeSettings({ settingsPath });
  assert.equal(r.action, "merged");
  assert.equal(/** @type {any} */ (r).hooksVia, "plugin");
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(hookCount(s), 0, "no guard is registered a second time");
  assert.ok(s.permissions?.deny?.length, "permissions are still merged");
  assert.deepEqual(s._forgeOwned.added.hooks, [], "no hooks recorded as Forge-owned");
  // Explicit `hooks: false` does the same for a file that does not name the plugin itself.
  const other = join(fixture(), "settings.json");
  mergeSettings({ settingsPath: other, hooks: false });
  assert.equal(hookCount(JSON.parse(readFileSync(other, "utf8"))), 0);
  // …and without the plugin nothing changes: the hooks are merged.
  const plain = join(fixture(), "settings.json");
  const p = mergeSettings({ settingsPath: plain });
  assert.equal(/** @type {any} */ (p).hooksVia, "settings");
  assert.ok(hookCount(JSON.parse(readFileSync(plain, "utf8"))) >= 10);
});

test("doctor with the plugin enabled: never suggests hooks, and --fix merges permissions only", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }));
  const before = settingsRow({ targetRoot: root, settingsPath });
  assert.equal(before.status, "warn");
  assert.match(before.note, /guards via the forgekit plugin/);
  assert.match(before.note, /permissions only/);
  assert.doesNotMatch(before.note, /hooks missing/);

  const fixed = doctor({ targetRoot: root, settingsPath, fix: true });
  assert.ok(fixed.repairs.some((r) => r.id === "settings" && r.ok));
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(hookCount(s), 0, "--fix did not register the plugin's guards again");
  assert.ok(s.permissions?.deny?.length);
  const after = fixed.results.find((r) => r.label === "settings");
  assert.equal(after.status, "ok", after.note);
  assert.match(after.note, /hooks not duplicated/);
});

test("doctor with the plugin enabled only in the project still merges no hooks at user scope", () => {
  const root = fixture();
  mkdirSync(join(root, ".claude"));
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }),
  );
  const settingsPath = join(fixture(), "settings.json"); // absent
  doctor({ targetRoot: root, settingsPath, fix: true });
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(hookCount(s), 0);
  assert.equal(settingsRow({ targetRoot: root, settingsPath }).status, "ok");
});

test("doctor: guards wired by the plugin AND settings.json are a double registration (warn, no auto-fix)", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  mergeSettings({ settingsPath }); // the settings-hook install…
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  s.enabledPlugins = { [PLUGIN]: true }; // …and then the plugin on top
  writeFileSync(settingsPath, JSON.stringify(s));
  const row = settingsRow({ targetRoot: root, settingsPath });
  assert.equal(row.status, "warn");
  assert.match(row.note, /runs twice/);
  assert.match(row.note, /--remove-settings/);
  assert.equal(row.fix, undefined, "no repair that could add even more hooks");
  const hooksBefore = hookCount(s);
  doctor({ targetRoot: root, settingsPath, fix: true });
  assert.equal(hookCount(JSON.parse(readFileSync(settingsPath, "utf8"))), hooksBefore);
});

test("forge init with the plugin enabled only in the project merges no hooks at user scope", () => {
  // Both init call sites: `--settings-only` (install.sh) and the full repo init. Before, init
  // only looked at the file it merged into, so it wrote every guard into the user settings and
  // doctor then reported the double registration init had just created.
  for (const settingsOnly of [true, false]) {
    const root = fixture();
    mkdirSync(join(root, ".claude"));
    const project = join(root, ".claude", "settings.json");
    writeFileSync(project, JSON.stringify({ enabledPlugins: { [PLUGIN]: true } }));
    const settingsPath = join(fixture(), "settings.json");
    const r = /** @type {any} */ (init({ targetRoot: root, settingsPath, settingsOnly }));
    assert.equal(r.settings.hooksVia, "plugin", `settingsOnly=${settingsOnly}`);
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(hookCount(s), 0, `settingsOnly=${settingsOnly}: no guard registered twice`);
    assert.ok(s.permissions?.deny?.length, "permissions are still merged");
    assert.equal(forgePluginEnabled({ settingsPath, targetRoot: root }).enabled, true);
    const row = settingsRow({ targetRoot: root, settingsPath });
    assert.equal(row.status, "ok", row.note);
    assert.doesNotMatch(row.note, /runs twice/);
  }
});

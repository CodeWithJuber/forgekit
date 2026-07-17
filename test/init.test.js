import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { catalog, init, mergeSettings } from "../src/init.js";

test("init emits the shared config for a fresh repo in one call", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-init-"));
  init({ targetRoot: root });
  assert.ok(existsSync(join(root, "AGENTS.md")), "AGENTS.md");
  assert.ok(existsSync(join(root, "CLAUDE.md")), "CLAUDE.md");
  assert.ok(existsSync(join(root, ".aider.conf.yml")), ".aider.conf.yml");
});

test("mergeSettings deduplicates plugin-style and settings-style hooks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-hooks-"));
  const settingsPath = join(tmp, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh prompt',
              },
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/cortex.sh preflight',
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: '"${CLAUDE_PLUGIN_ROOT}"/global/guards/lean-guard.sh',
              },
            ],
          },
        ],
      },
    }),
  );
  mergeSettings({ settingsPath });
  const result = JSON.parse(readFileSync(settingsPath, "utf8"));
  const promptHooks = result.hooks.UserPromptSubmit.flatMap((e) =>
    (e.hooks || []).map((h) => h.command),
  );
  const cortexPromptCount = promptHooks.filter((c) => c.includes("cortex.sh prompt")).length;
  assert.equal(
    cortexPromptCount,
    1,
    "cortex.sh prompt must not duplicate across plugin + settings paths",
  );
  const stopHooks = result.hooks.Stop.flatMap((e) => (e.hooks || []).map((h) => h.command));
  const leanCount = stopHooks.filter((c) => c.includes("lean-guard.sh")).length;
  assert.equal(leanCount, 1, "lean-guard.sh must not duplicate");
});

test("init({settingsOnly}) merges hooks + permissions but never emits repo config", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-settingsonly-"));
  const settingsPath = join(root, ".claude", "settings.json");
  const r = init({ targetRoot: root, settingsOnly: true, settingsPath });
  // Settings were written and marked forge-managed.
  assert.ok(existsSync(settingsPath), "settings.json written");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings._forge, "forge-managed", "marker stamped");
  assert.ok(settings.hooks, "hooks merged");
  assert.ok(settings.permissions, "permissions merged");
  assert.equal(r.settings.path, settingsPath, "reports the merged path");
  // But NO repo emit: none of the per-tool config files exist.
  assert.ok(!existsSync(join(root, "AGENTS.md")), "no AGENTS.md emitted");
  assert.ok(!existsSync(join(root, "CLAUDE.md")), "no CLAUDE.md emitted");
  assert.ok(!existsSync(join(root, ".aider.conf.yml")), "no .aider.conf.yml emitted");
  assert.ok(!existsSync(join(root, ".gitattributes")), "no gitattributes emitted");
});

test("init({settingsOnly}) is idempotent — a second run reports unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-settingsonly-idem-"));
  const settingsPath = join(root, ".claude", "settings.json");
  const first = init({ targetRoot: root, settingsOnly: true, settingsPath });
  assert.equal(first.settings.action, "merged");
  const second = init({ targetRoot: root, settingsOnly: true, settingsPath });
  assert.equal(second.settings.action, "unchanged", "re-run never clobbers");
});

test("catalog indexes tools (with a why), crew, and guards", () => {
  const c = catalog();
  assert.ok(
    c.tools.some((t) => t.name === "lean"),
    "has lean tool",
  );
  assert.ok(
    c.tools.some((t) => t.name === "atlas"),
    "has atlas tool",
  );
  assert.ok(
    c.tools.every((t) => t.why.length > 0),
    "every tool has a one-line why",
  );
  assert.ok(c.crew.includes("scout"), "has scout crew");
  assert.ok(c.guards.includes("cost-budget"), "has cost-budget guard");
  assert.ok(!c.guards.includes("_guardlib"), "excludes the sourced lib");
});

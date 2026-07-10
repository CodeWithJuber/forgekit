// The repo dogfoods its own plugin via a committed .claude/settings.json. This pins that
// every guard it wires actually exists and is executable — a broken path would silently
// no-op the guard when someone opens the repo in Claude Code.
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test(".claude/settings.json wires only real, executable guards via ${CLAUDE_PROJECT_DIR}", () => {
  const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const commands = Object.values(s.hooks)
    .flat()
    .flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(commands.length >= 10, "the full guard set is wired");
  for (const cmd of commands) {
    assert.match(cmd, /\$\{CLAUDE_PROJECT_DIR\}/, `resolves through the project dir: ${cmd}`);
    // extract the .sh path (first token ending in .sh)
    const m = cmd.match(/global\/guards\/([\w-]+\.sh)/);
    assert.ok(m, `references a guard script: ${cmd}`);
    const path = join(repo, "global", "guards", m[1]);
    accessSync(path, constants.X_OK); // exists AND executable, else throws
  }
});

test(".claude/settings.json Stop array registers the completion gate", () => {
  const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const stop = s.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command)).join("\n");
  assert.match(stop, /completion-gate\.sh/);
});

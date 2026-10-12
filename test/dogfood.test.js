// The repo dogfoods its own plugin via a committed .claude/settings.json. This pins that
// every guard it wires actually exists and is executable — a broken path would silently
// no-op the guard when someone opens the repo in Claude Code.
import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// biome-ignore lint/suspicious/noTemplateCurlyInString: test title names the literal placeholder; not code
test(".claude/settings.json wires only real, executable scripts via ${CLAUDE_PROJECT_DIR}", () => {
  const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const hooks = Object.values(s.hooks)
    .flat()
    .flatMap((e) => e.hooks);
  assert.ok(hooks.length >= 10, "the full guard set is wired");
  for (const h of hooks) {
    // Exec form through the portable launcher: command is "node", the script path (and the
    // launcher itself) live in args[], resolved through ${CLAUDE_PROJECT_DIR}.
    assert.equal(
      h.command,
      "node",
      `interpreter is node (bash is not on PATH on Windows): ${JSON.stringify(h)}`,
    );
    assert.ok(
      Array.isArray(h.args) && h.args.length >= 4,
      `args = [launcher, --event, Name, guard, …]: ${JSON.stringify(h)}`,
    );
    assert.match(
      h.args[0],
      /\$\{CLAUDE_PROJECT_DIR\}/,
      `launcher resolves through the project dir`,
    );
    assert.equal(h.args[1], "--event", `launcher budget flag present: ${JSON.stringify(h)}`);
    // A wired script is either a global guard or a repo-local hook (e.g. the web
    // session-start install hook) — both must exist AND be executable.
    const m = h.args[3].match(/\}\/((?:global\/guards|\.claude\/hooks)\/[\w-]+\.sh)/);
    assert.ok(m, `guard references a guard or repo hook script: ${h.args[3]}`);
    accessSync(join(repo, m[1]), constants.X_OK); // exists AND executable, else throws
  }
});

test(".claude/settings.json Stop array registers the completion gate", () => {
  const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
  const stop = s.hooks.Stop.flatMap((e) => e.hooks.flatMap((h) => h.args ?? [])).join("\n");
  assert.match(stop, /completion-gate\.sh/);
});

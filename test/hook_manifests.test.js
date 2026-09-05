// Windows portability of the hook manifests: every hook (and the statusLine) is exec form THROUGH
// the launcher — `node <root>/guards/run.mjs <root>/…/<guard>.sh [mode]` — never a bare `bash`.
//
// Exec-form hooks are spawned with a plain PATH lookup and no shell. A default Git for Windows
// install puts git on PATH but NOT bash, so `command: "bash"` failed every hook there with
// `spawn bash ENOENT` (SessionStart first). `node` is guaranteed wherever the package runs; the
// launcher locates bash. Pinned in all three manifests so the regression cannot return via any.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** [file, launcher path as written, prefix every guard path must start with] */
const MANIFESTS = [
  ["global/settings.template.json", "~/.forge/guards/run.mjs", "~/.forge/"],
  ["hooks/hooks.json", "${CLAUDE_PLUGIN_ROOT}/global/guards/run.mjs", "${CLAUDE_PLUGIN_ROOT}/"],
  [
    ".claude/settings.json",
    "${CLAUDE_PROJECT_DIR}/global/guards/run.mjs",
    "${CLAUDE_PROJECT_DIR}/",
  ],
];

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

/** Every command entry in a manifest, tagged with its event ("statusLine" for the status line). */
function entries(manifest) {
  const out = [];
  for (const [event, list] of Object.entries(manifest.hooks || {}))
    for (const e of list) for (const h of e.hooks || []) out.push({ event, ...h });
  if (manifest.statusLine) out.push({ event: "statusLine", ...manifest.statusLine });
  return out;
}

for (const [file, launcher, prefix] of MANIFESTS) {
  test(`${file}: every hook and the statusLine run through the launcher — no bare bash`, () => {
    const all = entries(read(file));
    assert.ok(all.length >= 10, `${file}: expected the full hook set, got ${all.length}`);
    for (const h of all) {
      const where = `${file} ${h.event}: ${JSON.stringify(h)}`;
      assert.equal(h.type, "command", where);
      assert.equal(
        h.command,
        "node",
        `interpreter must be node (bash is not on PATH on Windows): ${where}`,
      );
      assert.ok(
        Array.isArray(h.args) && h.args.length >= 2,
        `args = [launcher, guard, …]: ${where}`,
      );
      assert.equal(h.args[0], launcher, `args[0] is the launcher: ${where}`);
      assert.ok(
        h.args[1].startsWith(prefix) && h.args[1].endsWith(".sh"),
        `args[1] is the guard: ${where}`,
      );
      // Exec form carries literal paths: no shell, so no quoting — a quote char would be a bug.
      for (const a of h.args) assert.doesNotMatch(a, /['"]/, `unquoted args: ${where}`);
    }
  });
}

test("plugin manifest and settings template wire the SAME guards per event (both were converted)", () => {
  const identity = (h) =>
    `${h.event} ${h.args[1].split("/").pop()} ${h.args.slice(2).join(" ")}`.trim();
  const plugin = entries(read("hooks/hooks.json"))
    .filter((h) => h.event !== "statusLine")
    .map(identity)
    .sort();
  const template = entries(read("global/settings.template.json"))
    .filter((h) => h.event !== "statusLine")
    .map(identity)
    .sort();
  assert.deepEqual(plugin, template);
});

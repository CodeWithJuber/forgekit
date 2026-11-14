import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyHooks } from "../src/emit/hooks.js";
import { checkHarnessDrift } from "../src/harness_drift.js";
import { init } from "../src/init.js";

test("generated hooks and MCP match across six hosts; tampering is detected without touching the checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "harness-drift-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hosts = ["kimi", "codex", "gemini", "cursor", "claude", "copilot"];
  init({ targetRoot: root, tools: hosts, noSettings: true, warm: false });
  for (const host of hosts) applyHooks(root, host);
  const before = checkHarnessDrift(root, hosts);
  assert.deepEqual(before.failures, []);
  assert.ok(
    before.checks.some(
      (c) => c.host === "kimi" && c.component === "user plugin" && c.status === "manual",
    ),
  );
  const edit = (path, fn) => {
    const full = join(root, path),
      text = JSON.stringify(fn(JSON.parse(readFileSync(full, "utf8"))));
    writeFileSync(full, text);
    return text;
  };
  const changed = edit(".gemini/settings.json", (j) => ({
    ...j,
    editor: { font: "mono" },
    hooks: {
      ...j.hooks,
      BeforeTool: [{ hooks: [{ type: "command", command: "unrelated" }] }, ...j.hooks.BeforeTool],
    },
  }));
  // Reformatting and independent settings/hook lists are outside this projection.
  assert.equal(checkHarnessDrift(root, ["gemini"]).ok, true);
  assert.equal(readFileSync(join(root, ".gemini/settings.json"), "utf8"), changed);
  const bad = edit(".cursor/hooks.json", (j) => ({
    ...j,
    hooks: { ...j.hooks, beforeSubmitPrompt: [] },
  }));
  edit(".kimi-code/mcp.json", (j) => ({ ...j, servers: j.mcpServers, mcpServers: {} }));
  const path = join(root, ".codex/config.toml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('args = ["cortex-mcp"]', 'args = ["wrong"]'),
  );
  const report = checkHarnessDrift(root, hosts);
  assert.deepEqual(report.failures.map((r) => r.host).sort(), ["codex", "cursor", "kimi"]);
  assert.equal(readFileSync(join(root, ".cursor/hooks.json"), "utf8"), bad);
});

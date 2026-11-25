import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readHostModelReports, recordHostModel } from "../src/host_models.js";
import { runHook } from "../src/hosts.js";
import { privateMemoryDir } from "../src/private_memory.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-model-host-"));
test("valid host start stores only the explicit ID, timestamp and source privately", async () => {
  const root = fixture(),
    other = fixture();
  const payload = {
    conversation_id: "private-conversation",
    workspace_roots: [root],
    hook_event_name: "sessionStart",
    model: "vendor/model-v2",
    initialPrompt: "customer contract 12345",
  };
  const reply = await runHook({
    host: "cursor",
    event: "sessionStart",
    input: JSON.stringify(payload),
    env: {},
    claim: null,
    run: () => [],
  });
  assert.equal(reply.exit, 0);
  const row = readHostModelReports(root).cursor;
  assert.equal(row.id, payload.model);
  assert.ok(Number.isFinite(Date.parse(row.observedAt)));
  assert.equal(row.source, "session-start");
  assert.deepEqual(readHostModelReports(other), {});
  const priv = join(privateMemoryDir(root, "host-models"), "cursor"),
    file = readdirSync(priv)[0];
  assert.doesNotMatch(readFileSync(join(priv, file), "utf8"), /private-conversation|12345/);
  assert.equal(existsSync(join(root, ".forge", "host-models")), false);
  assert.equal(recordHostModel("cursor", "beforeSubmitPrompt", payload), false);
  for (const p of [
    { ...payload, model: "auto" },
    { ...payload, model: "not a valid id" },
    { ...payload, modelId: "another" },
    { ...payload, conversation_id: "" },
    { ...payload, hook_event_name: "beforeSubmitPrompt" },
  ])
    assert.equal(recordHostModel("cursor", "sessionStart", p), false);
  assert.equal(recordHostModel("unknown", "SessionStart", payload), false);
  assert.deepEqual(readHostModelReports(root).cursor, row);
});
test("Claude's native plugin path observes SessionStart; an older report cannot supersede it", () => {
  const root = fixture();
  const payload = {
    session_id: "test-session",
    cwd: root,
    hook_event_name: "SessionStart",
    source: "startup",
    model: "model-3",
  };
  const entry = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
  const r = spawnSync(process.execPath, [entry, "session-start"], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const result = readHostModelReports(root);
  assert.equal(result.claude.id, "model-3");
  recordHostModel("claude", "SessionStart", { ...payload, model: "older" }, { now: 1700000000000 });
  assert.deepEqual(readHostModelReports(root), result);
});

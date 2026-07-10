import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clearGoal, getGoal, goalBlock, setGoal } from "../src/goal.js";
import { autoSyncIfDrifted, sync } from "../src/sync.js";
import { fakeAnthropic } from "./_fixtures.js";

const repo = () => mkdtempSync(join(tmpdir(), "forge-goal-"));

test("setGoal/getGoal/clearGoal round-trip, empty and missing cases", () => {
  const root = repo();
  assert.equal(getGoal(root), null);
  assert.equal(setGoal(root, "   ").ok, false);
  const r = setGoal(root, "ship the provider auto-detection fix");
  assert.equal(r.ok, true);
  assert.equal(getGoal(root), "ship the provider auto-detection fix");
  clearGoal(root);
  assert.equal(getGoal(root), null);
});

test("setGoal refuses a goal that carries a secret", () => {
  const root = repo();
  const r = setGoal(root, `deploy with key ${fakeAnthropic()}`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /secret/);
  assert.equal(getGoal(root), null, "nothing persisted");
});

test("goalBlock renders the goal for SessionStart, empty when unset", () => {
  const root = repo();
  assert.equal(goalBlock(root), "");
  setGoal(root, "remove every keyword heuristic");
  const block = goalBlock(root);
  assert.match(block, /Active goal/);
  assert.match(block, /remove every keyword heuristic/);
});

test("session-start hook injects the persistent goal", () => {
  const root = repo();
  setGoal(root, "finish the docs drift machinery");
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cortex_hook_main.js");
  const r = spawnSync("node", [entry, "session-start"], {
    input: JSON.stringify({ session_id: "s", cwd: root }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /finish the docs drift machinery/);
});

test("autoSyncIfDrifted: repairs a drifted managed AGENTS.md, never adopts an unmanaged repo", () => {
  const root = repo();
  // Unmanaged repo (no AGENTS.md): must not adopt.
  assert.equal(autoSyncIfDrifted(root).synced, false);
  assert.equal(existsSync(join(root, "AGENTS.md")), false, "auto-sync never creates from nothing");

  // Managed repo, in sync: no-op.
  sync({ targetRoot: root });
  assert.equal(autoSyncIfDrifted(root).synced, false);

  // Drift the canonical inputs (a per-repo rules override) → auto-sync repairs.
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "rules.json"),
    JSON.stringify({ sections: [{ title: "Extra", rules: ["always frob the widget"] }] }),
  );
  const r = autoSyncIfDrifted(root);
  assert.equal(r.synced, true);
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /always frob the widget/);
  assert.equal(autoSyncIfDrifted(root).synced, false, "second pass: already in sync");
});

test("autoSyncIfDrifted: FORGE_AUTOSYNC=0 disables the repair", () => {
  const root = repo();
  sync({ targetRoot: root });
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "rules.json"),
    JSON.stringify({ sections: [{ title: "X", rules: ["y"] }] }),
  );
  const saved = process.env.FORGE_AUTOSYNC;
  process.env.FORGE_AUTOSYNC = "0";
  try {
    assert.equal(autoSyncIfDrifted(root).synced, false);
  } finally {
    if (saved === undefined) delete process.env.FORGE_AUTOSYNC;
    else process.env.FORGE_AUTOSYNC = saved;
  }
});

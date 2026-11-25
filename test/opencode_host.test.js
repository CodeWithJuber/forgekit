// OpenCode carries ForgeKit's guards in a generated JavaScript plugin. These tests hold the
// host row, the payload translation, the marker-owned file, and the adapter itself: a stub
// `forge` proves the plugin blocks, injects context and fails open without the CLI.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applyPlugin, OPENCODE_PLUGIN, planPlugin } from "../src/emit/opencode.js";
import { HOSTS, normalize, render } from "../src/hosts.js";
import { sync } from "../src/sync.js";

const tmp = (name = "opencode-") => mkdtempSync(join(tmpdir(), name));
const one = (event, payload) => {
  const n = normalize("opencode", event, payload, {});
  assert.equal(n?.payloads.length, 1, `opencode ${event}: exactly one payload`);
  return n.payloads[0];
};

test("OpenCode: the host row translates native tools and renders one JSON verdict", () => {
  assert.equal(HOSTS.opencode.layout, "module");
  assert.deepEqual(Object.keys(HOSTS.opencode.events), [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]);
  const pre = one("PreToolUse", {
    session_id: "s1",
    cwd: "/repo",
    tool_name: "bash",
    tool_input: { command: "ls" },
    tool_use_id: "c1",
  });
  assert.equal(pre.hook_event_name, "PreToolUse");
  assert.equal(pre.tool_name, "Bash");
  assert.equal(pre.tool_input.command, "ls");
  const edit = one("PreToolUse", {
    tool_name: "edit",
    tool_input: { filePath: "a.js", oldString: "a", newString: "b" },
  });
  assert.equal(edit.tool_name, "Edit");
  assert.equal(edit.tool_input.file_path, "a.js");
  assert.equal(edit.tool_input.old_string, "a");
  const patch = one("PreToolUse", {
    tool_name: "patch",
    tool_input: { patchText: "not a patch" },
  });
  assert.equal(patch.tool_name, "Edit");
  assert.equal(patch.tool_input.patch, "not a patch");

  assert.deepEqual(
    JSON.parse(
      render("opencode", "PreToolUse", {
        decision: "deny",
        reason: "no",
        context: "",
        block: "",
      }).stdout,
    ),
    { decision: "deny", reason: "no" },
  );
  assert.deepEqual(
    JSON.parse(
      render("opencode", "PostToolUse", {
        decision: "allow",
        reason: "",
        context: "hint",
        block: "",
      }).stdout,
    ),
    { context: "hint" },
  );
  assert.deepEqual(
    JSON.parse(
      render("opencode", "Stop", {
        decision: "allow",
        reason: "",
        context: "",
        block: "not done",
      }).stdout,
    ),
    { block: "not done" },
  );
});

test("OpenCode plugin: marker-owned, idempotent, restored after tampering, never clobbers a person", () => {
  const root = tmp();
  assert.equal(applyPlugin(root).action, "written");
  const path = join(root, OPENCODE_PLUGIN);
  const text = readFileSync(path, "utf8");
  assert.match(text, /forge:sync:[a-f0-9]{12}/);
  assert.match(text, /"tool\.execute\.before"/);
  assert.match(text, /"opencode"/);
  assert.equal(applyPlugin(root).action, "unchanged");
  assert.equal(planPlugin(text).next, text);
  // A hand-edited body with an intact marker is restored, exactly like every other managed file.
  writeFileSync(path, text.replace("const TIMEOUT_MS = 30000;", "const TIMEOUT_MS = 1;"));
  assert.equal(applyPlugin(root).action, "written");
  assert.equal(readFileSync(path, "utf8"), text);
  // A person's own file is reported and preserved, on and off.
  writeFileSync(path, "export const Mine = async () => ({});\n");
  assert.equal(applyPlugin(root).action, "skipped");
  assert.equal(readFileSync(path, "utf8"), "export const Mine = async () => ({});\n");
  assert.equal(applyPlugin(root, { enable: false }).action, "skipped");
  writeFileSync(path, text);
  assert.equal(applyPlugin(root, { enable: false }).action, "removed");
  assert.equal(existsSync(path), false);
});

test("sync: OpenCode is a first-class tool and its plugin waits for `forge hooks on`", () => {
  const root = tmp();
  const res = sync({ targetRoot: root, tools: ["opencode"] });
  assert.ok(
    res.report.some((r) => r.tool === "OpenCode" && r.action === "relies-on-agents"),
    "OpenCode reports that it reads the shared AGENTS.md",
  );
  assert.equal(existsSync(join(root, OPENCODE_PLUGIN)), false, "hooks stay off until asked for");
});

/** A stub `forge` that logs every payload and answers with the JSON verdicts the plugin reads. */
function stubForge(root, logPath) {
  // Node executes the first CLI argument, "hooks", as a script on every platform.
  // A shell-script executable would fail to spawn on Windows before exercising the adapter.
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(root, "hooks"),
    `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, readFileSync(0, "utf8") + "\\n");
const replies = {
  SessionStart: { context: "session context" },
  UserPromptSubmit: { context: "prompt context" },
  PreToolUse: { decision: "deny", reason: "blocked by test" },
  PostToolUse: { context: "tool context" },
  Stop: { block: "stop block" },
};
const reply = replies[process.argv[4]];
if (reply) process.stdout.write(JSON.stringify(reply));
`,
  );
  return process.execPath;
}

/**
 * Import the generated plugin with a fresh module instance. `FORGE_CLI` is read at module
 * load, so it is set for the import and restored immediately afterwards.
 */
async function loadPlugin(root, { cli }) {
  const path = join(root, OPENCODE_PLUGIN);
  if (!existsSync(path)) applyPlugin(root);
  const before = process.env.FORGE_CLI;
  process.env.FORGE_CLI = cli;
  try {
    const mod = await import(`${pathToFileURL(path).href}?v=${Math.random()}`);
    return await mod.ForgeKit({ directory: root });
  } finally {
    if (before === undefined) delete process.env.FORGE_CLI;
    else process.env.FORGE_CLI = before;
  }
}

test("OpenCode adapter: blocks a tool, injects context, and carries the stop verdict", async () => {
  const root = tmp();
  applyPlugin(root);
  const log = join(root, "calls.log");
  const hooks = await loadPlugin(root, { cli: stubForge(root, log) });

  let blocked = null;
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "s1", callID: "c1" },
    { args: { command: "rm -rf /" } },
  ).catch((e) => {
    blocked = e.message;
  });
  assert.equal(blocked, "blocked by test");

  const system = { system: [] };
  await hooks["chat.message"](
    { sessionID: "s1" },
    {
      parts: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    },
  );
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, system);
  assert.deepEqual(system.system, ["session context", "prompt context"]);

  await hooks["tool.execute.after"](
    { tool: "read", sessionID: "s1", callID: "c2", args: { filePath: "a.txt" } },
    { title: "read", output: "contents", metadata: {} },
  );
  const after = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, after);
  assert.deepEqual(after.system, ["tool context"]);

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  const idle = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, idle);
  assert.deepEqual(idle.system, ["stop block"]);

  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((c) => c.hook_event_name),
    ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"],
  );
  assert.deepEqual(calls[0].tool_input, { command: "rm -rf /" });
  assert.equal(calls[2].prompt, "hello\nworld");
  assert.equal(calls[3].tool_response, "contents");
});

test("OpenCode adapter: a missing forge CLI denies the tool call", async () => {
  const root = tmp();
  applyPlugin(root);
  const hooks = await loadPlugin(root, { cli: join(root, "does-not-exist") });
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { args: { command: "ls" } },
    ),
    /could not check/,
  );
  const system = { system: [] };
  await hooks["chat.message"]({ sessionID: "s1" }, { parts: [{ type: "text", text: "hi" }] });
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, system);
  assert.deepEqual(system.system, []);
});

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budgetHookOutput } from "../global/guards/run.mjs";
import { BRAND } from "../src/brand.js";
import { failureQuery, queueQuery, takeQuery } from "../src/hook_evidence.js";
import { HOSTS } from "../src/hosts.js";
import { initSources, syncSources } from "../src/sources.js";
import { userStateDir } from "../src/util.js";

test("budgets preserve valid hook JSON, Unicode, escaping and structured block decisions", () => {
  const obj = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: 'a\\"😺\n'.repeat(1000),
    },
  };
  const text = budgetHookOutput(JSON.stringify(obj), 400);
  const output = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= 400);
  assert.ok(output.hookSpecificOutput.additionalContext.isWellFormed());
  assert.match(output.hookSpecificOutput.additionalContext, /truncated/);
  const block = JSON.stringify({ decision: "block", reason: "too long".repeat(200) });
  assert.equal(budgetHookOutput(block, 90), block);
});

test("deferred prompts are private, redacted, repo/session-specific, single-use and expire", () => {
  const root = mkdtempSync(join(tmpdir(), "fk-query-"));
  const secret = `ghp_${"Z".repeat(36)}`;
  queueQuery("cursor", root, "session/1", `Find parser ${secret}`);
  const dir = join(userStateDir(), "hook-queries");
  const path = join(dir, readdirSync(dir)[0]);
  assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(secret));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(takeQuery("copilot", root, "session/1"), "");
  assert.equal(takeQuery("cursor", root, "session/2"), "");
  assert.equal(takeQuery("cursor", `${root}another`, "session/1"), "");
  assert.match(takeQuery("cursor", root, "session/1"), /Find parser/);
  assert.equal(takeQuery("cursor", root, "session/1"), "");
  queueQuery("cursor", root, "session/1", "old query");
  utimesSync(path, new Date(0), new Date(0));
  assert.equal(takeQuery("cursor", root, "session/1"), "");
  queueQuery("cursor", root, "default", "no genuine session");
  assert.deepEqual(readdirSync(dir), []);
  rmSync(root, { recursive: true, force: true });
});

test("failure lookup uses the real exit or protocol signal and ignores cancelled tools", () => {
  assert.equal(
    failureQuery({ tool_name: "Read", tool_response: "Output:\nProcess exited with code 1" }),
    "",
  );
  assert.equal(failureQuery({ is_interrupt: true, error: "user cancelled" }), "");
  assert.equal(failureQuery({ failure_type: "permission_denied", error: "user denied" }), "");
  assert.match(
    failureQuery({ tool_name: "Bash", tool_response: "Exit code: 127\nmissing parser" }),
    /missing parser/,
  );
  assert.match(
    failureQuery({
      tool_response: { isError: true, content: [{ type: "text", text: "parser timeout" }] },
    }),
    /parser timeout/,
  );
});

test("packaged prompt and failure hooks retrieve actual indexed evidence without a skill or an MCP call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fk-automatic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, "teamdocs");
  mkdirSync(folder);
  writeFileSync(
    join(folder, "runbook.md"),
    "Nebulaparse teams use the lacustrine sentinel for versioned imports.\n",
  );
  const { configPath } = initSources(root);
  writeFileSync(
    configPath,
    JSON.stringify({ sources: [{ id: "runbooks", provider: "local", root: folder }] }),
  );
  assert.equal((await syncSources(root)).ok, true);
  const env = { ...process.env, PLUGIN_ROOT: BRAND.root, FORGE_EVIDENCE_WEB: "0" };
  const body = {
    cwd: root,
    session_id: "hook-session",
    prompt: "Implement the Nebulaparse importer",
  };
  const codex = JSON.parse(readFileSync(join(BRAND.root, ".codex-plugin", "plugin.json"), "utf8"));
  const bundled = JSON.parse(readFileSync(join(BRAND.root, codex.hooks), "utf8")).hooks;
  assert.deepEqual(Object.keys(bundled), Object.keys(HOSTS.codex.events));
  const command = bundled.UserPromptSubmit[0].hooks[0];
  const prompt =
    process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-Command", command.commandWindows], {
          input: JSON.stringify(body),
          cwd: root,
          env,
          encoding: "utf8",
        })
      : spawnSync("sh", ["-c", command.command], {
          input: JSON.stringify(body),
          cwd: root,
          env,
          encoding: "utf8",
        });
  assert.equal(prompt.status, 0, prompt.stderr);
  const injected = JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /lacustrine sentinel/);
  assert.match(injected, /runbook\.md/);

  const fire = (host, event, payload) =>
    spawnSync(process.execPath, [join(BRAND.root, "src", "cli.js"), "hooks", "run", host, event], {
      cwd: root,
      env,
      input: JSON.stringify({ cwd: root, ...payload }),
      encoding: "utf8",
    });
  const kimi = JSON.parse(readFileSync(join(BRAND.root, "kimi.plugin.json"), "utf8"));
  assert.deepEqual(
    kimi.hooks.map((h) => h.event),
    Object.keys(HOSTS.kimi.events),
  );
  const kPrompt = {
    ...body,
    session_id: "kimi-native",
    prompt: [
      { type: "image_url", image_url: { url: "data:image/png;base64,omitted" } },
      { type: "text", text: body.prompt },
    ],
  };
  const k = spawnSync(kimi.hooks.find((h) => h.event === "UserPromptSubmit").command, {
    shell: true,
    cwd: BRAND.root,
    env,
    input: JSON.stringify(kPrompt),
    encoding: "utf8",
  });
  assert.equal(k.status, 0, k.stderr);
  assert.match(JSON.parse(k.stdout).message, /lacustrine sentinel/);
  assert.doesNotMatch(k.stdout, /data:image/);
  writeFileSync(
    join(root, ".forge", "forge.config.json"),
    JSON.stringify({ hooks: { project: false } }),
  );
  assert.equal(fire("kimi", "UserPromptSubmit", kPrompt).stdout, "");
  rmSync(join(root, ".forge", "forge.config.json"));
  const cursorPrompt = fire("cursor", "beforeSubmitPrompt", {
    conversation_id: "cursor",
    prompt: body.prompt,
  });
  assert.equal(cursorPrompt.status, 0);
  assert.doesNotMatch(cursorPrompt.stdout, /additional_context/);
  const post = fire("cursor", "postToolUse", {
    conversation_id: "cursor",
    tool_name: "Read",
    tool_input: { path: "README.md" },
    tool_output: "OK",
  });
  assert.match(JSON.parse(post.stdout).additional_context, /lacustrine sentinel/);
  // Two parallel tools from one turn compete for the private prompt. Exactly one consumes it.
  queueQuery("cursor", root, "parallel", body.prompt);
  const posts = await Promise.all(
    ["a", "b"].map(async (id) => {
      const child = execFile(
        process.execPath,
        [join(BRAND.root, "src", "cli.js"), "hooks", "run", "cursor", "postToolUse"],
        { cwd: root, env },
      );
      const done = new Promise((resolve, reject) => {
        let stdout = "";
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`hook exit ${code}`)),
        );
      });
      child.stdin.end(
        JSON.stringify({
          cwd: root,
          conversation_id: "parallel",
          tool_use_id: id,
          tool_name: "Read",
          tool_output: "OK",
        }),
      );
      return done;
    }),
  );
  assert.equal(posts.filter((out) => /lacustrine sentinel/.test(out)).length, 1);
  const failures = [
    [
      "claude",
      "PostToolUseFailure",
      { session_id: "cc", tool_name: "Bash", error: "Nebulaparse import failed" },
    ],
    [
      "cursor",
      "postToolUseFailure",
      { conversation_id: "cf", tool_name: "Shell", error_message: "Nebulaparse import failed" },
    ],
    [
      "codex",
      "PostToolUse",
      {
        session_id: "cx",
        tool_name: "Bash",
        tool_response: "Exit code: 1\nNebulaparse import failed",
      },
    ],
    [
      "copilot",
      "postToolUseFailure",
      { sessionId: "cp", toolName: "bash", error: "Nebulaparse import failed" },
    ],
  ];
  for (const [host, event, payload] of failures) {
    const reply = fire(host, event, payload);
    assert.equal(reply.status, host === "copilot" ? 2 : 0, reply.stderr);
    assert.match(reply.stdout, /lacustrine sentinel/, host);
  }
  // A configuration can change between prompt and tool. Recheck scope at delivery.
  queueQuery("cursor", root, "revoked", body.prompt);
  writeFileSync(configPath, JSON.stringify({ sources: [] }));
  const revoked = fire("cursor", "postToolUse", {
    conversation_id: "revoked",
    tool_name: "Read",
    tool_output: "OK",
  });
  assert.doesNotMatch(revoked.stdout, /lacustrine sentinel/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { planHooks } from "../src/emit/hooks.js";
import { initHarness } from "../src/harness_config.js";
import { nativeHarnessDenial } from "../src/harness_native.js";
import { runHook } from "../src/hosts.js";

const guard = fileURLToPath(new URL("../global/guards/protect-paths.mjs", import.meta.url));
function fixture(t, supervised = true) {
  const area = mkdtempSync(join(tmpdir(), "forge-host-supervision-"));
  const root = join(area, "workspace");
  mkdirSync(root);
  const old = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(area, "private-state");
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = old;
    rmSync(area, { recursive: true, force: true });
  });
  initHarness(root, { supervised });
  return { area, root };
}
const ordinary = async () => [];
const pre = async (host, event, payload) =>
  runHook({ host, event, input: JSON.stringify(payload), run: ordinary, claim: null, env: {} });
function denied(host, reply) {
  if (host === "cursor") return JSON.parse(reply.stdout || "{}").permission === "deny";
  if (host === "copilot") return JSON.parse(reply.stdout || "{}").permissionDecision === "deny";
  return reply.exit === 2;
}

test("opt-in pre-tool supervision translates deny and exact ForgeKit ingress into each host's dialect", async (t) => {
  const { root } = fixture(t);
  const hosts = [
    ["claude", "PreToolUse", "Bash", "mcp__forge-cortex__forge_harness_run"],
    ["codex", "PreToolUse", "apply_patch", "mcp__forge-cortex__forge_harness_status"],
    ["kimi", "PreToolUse", "ReadFile", "mcp__forge-cortex__forge_harness_run"],
    ["gemini", "BeforeTool", "read_file", "mcp_forge-cortex_forge_harness_run"],
    ["cursor", "preToolUse", "write_file", "mcp__forge-cortex__forge_harness_run"],
    ["copilot", "preToolUse", "edit", "forge-cortex-forge_harness_run"],
  ];
  for (const [host, event, native, allowed] of hosts) {
    const name = host === "copilot" ? "toolName" : "tool_name";
    const p = { cwd: root, [name]: native, tool_input: { command: "safe fixture" } };
    assert.equal(denied(host, await pre(host, event, p)), true, `${host} direct`);
    assert.equal(
      denied(host, await pre(host, event, { ...p, [name]: allowed })),
      false,
      `${host} ingress`,
    );
    for (const impostor of [
      "forge_harness_run",
      `${allowed}_approve`,
      "mcp__attacker__forge_harness_run",
      "mcp__forge-cortex__forge_harness_approve",
    ])
      assert.equal(
        denied(host, await pre(host, event, { ...p, [name]: impostor })),
        true,
        `${host} rejects ${impostor}`,
      );
  }
  assert.ok(
    denied(
      "cursor",
      await pre("cursor", "beforeShellExecution", {
        workspace_roots: [root],
        command: "echo test",
      }),
    ),
  );
  const event = "beforeMCPExecution",
    payload = {
      workspace_roots: [root],
      tool_name: "forge_harness_run",
      mcp_server_name: "forge-cortex",
    };
  assert.equal(denied("cursor", await pre("cursor", event, payload)), false);
  assert.equal(
    denied("cursor", await pre("cursor", event, { ...payload, mcp_server_name: "other" })),
    true,
  );
  assert.ok(JSON.parse(planHooks(null, "cursor").next).hooks.beforeMCPExecution);
});

test("supervised checks survive a changed cwd, nested fake policy, opted-out advisories and modified policy", async (t) => {
  const { root, area } = fixture(t);
  const nested = join(root, "nested");
  mkdirSync(join(nested, "harness"), { recursive: true });
  writeFileSync(join(nested, "harness", "policy.yaml"), "{}");
  const payload = {
    cwd: nested,
    tool_name: "Read",
    tool_input: { tool_name: "mcp__forge-cortex__forge_harness_run" },
  };
  assert.ok(denied("codex", await pre("codex", "PreToolUse", payload)));
  const raw = {
    host: "codex",
    event: "PreToolUse",
    input: JSON.stringify({ ...payload, cwd: area }),
    env: { FORGE_HOOKS: "0", CLAUDE_PROJECT_DIR: root },
  };
  assert.ok(denied("codex", await runHook(raw)));
  const path = join(root, "harness", "policy.yaml");
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), nativeMode: "parallel" }),
  );
  assert.match(
    nativeHarnessDenial({
      host: "kimi",
      event: "PreToolUse",
      payload: { cwd: root, tool_name: "mcp__forge-cortex__forge_harness_run" },
    }),
    /could not be validated/,
  );
});

test("bundled Claude guard covers arbitrary plugin tools; historical standalone copies retain secret checks", (t) => {
  const { root, area } = fixture(t);
  for (const def of [
    "../global/settings.template.json",
    "../hooks/hooks.json",
    "../.claude/settings.json",
  ]) {
    const manifest = JSON.parse(readFileSync(new URL(def, import.meta.url), "utf8"));
    assert.ok(
      manifest.hooks.PreToolUse.some(
        (g) =>
          g.matcher === "*" && g.hooks.some((h) => h.args?.at(-1)?.endsWith("/protect-paths.sh")),
      ),
    );
  }
  const run = (program, tool, tool_input = {}) =>
    spawnSync(process.execPath, [program], {
      cwd: root,
      input: JSON.stringify({ tool_name: tool, tool_input, cwd: root }),
      encoding: "utf8",
    });
  assert.equal(run(guard, "mcp__other__fetch").status, 2);
  assert.equal(run(guard, "mcp__plugin_forgekit_forge-cortex__forge_harness_run").status, 0);
  const legacy = join(area, "legacy", "guards", "protect-paths.mjs");
  mkdirSync(join(area, "legacy", "guards"), { recursive: true });
  copyFileSync(guard, legacy);
  assert.equal(run(legacy, "Read", { file_path: "ok.txt" }).status, 0);
  assert.equal(run(legacy, "Read", { file_path: ".env" }).status, 2);
});

test("ordinary workspaces preserve ordinary tool calls", async (t) => {
  const { root } = fixture(t, false);
  const remote = spawnSync(process.execPath, [guard], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify({
      cwd: root,
      tool_name: "mcp__reader__describe",
      tool_input: { path: ".env", command: "git reset --hard" },
    }),
  });
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(
    denied("codex", await pre("codex", "PreToolUse", { cwd: root, tool_name: "exec_command" })),
    false,
  );
});

test("Cursor defers an unqualified MCP candidate only with the fail-closed, namespaced gate installed", async (t) => {
  const { root } = fixture(t);
  const input = { cwd: root, tool_name: "MCP:forge_harness_run" };
  assert.ok(denied("cursor", await pre("cursor", "preToolUse", input)));
  const file = join(root, ".cursor", "hooks.json");
  mkdirSync(join(root, ".cursor"));
  const config = JSON.parse(planHooks(null, "cursor").next);
  writeFileSync(file, JSON.stringify(config));
  assert.equal(denied("cursor", await pre("cursor", "preToolUse", input)), false);
  const mcp = {
    cwd: root,
    tool_name: "forge_harness_run",
    mcp_server_name: "attacker",
    tool_input: { private: "never-store-in-denial-audit" },
  };
  assert.ok(denied("cursor", await pre("cursor", "beforeMCPExecution", mcp)));
  assert.deepEqual(
    JSON.parse(
      (await pre("cursor", "beforeMCPExecution", { ...mcp, mcp_server_name: "forge-cortex" }))
        .stdout,
    ),
    { permission: "allow" },
  );
  config.hooks.beforeMCPExecution[0].matcher = "never-match";
  writeFileSync(file, JSON.stringify(config));
  assert.ok(denied("cursor", await pre("cursor", "preToolUse", input)));
  const { readHarnessNativeAudit } = await import("../src/harness_trace.js");
  const result = readHarnessNativeAudit(root);
  assert.equal(result.denied, 3);
  assert.doesNotMatch(JSON.stringify(result), /never-store-in-denial-audit/);
});

test("supervised Claude, Kimi and Codex get the exact ingress on an ordinary first user prompt", async (t) => {
  const { root } = fixture(t);
  for (const host of ["claude", "kimi", "codex"]) {
    const outcome = await pre(host, "UserPromptSubmit", {
      cwd: root,
      prompt: "Investigate source imports",
    });
    const reply = JSON.parse(outcome.stdout);
    const context = host === "kimi" ? reply.message : reply.hookSpecificOutput.additionalContext;
    assert.match(context, /forge_harness_run/);
    assert.match(context, /forge_harness_status/);
    assert.match(context, /forge-cortex/);
  }
});

test("Claude can discover only the two exact deferred harness schemas", (t) => {
  const { root } = fixture(t);
  const tool = "mcp__forge-cortex__forge_harness_";
  function denial(query, host = "claude", extra = {}) {
    return nativeHarnessDenial({
      host,
      event: "PreToolUse",
      payload: { cwd: root, tool_name: "ToolSearch", tool_input: { query }, ...extra },
      env: {},
    });
  }
  assert.equal(denial(`select:${tool}run,${tool}status`), null);
  assert.equal(denial("select:mcp__plugin_forgekit_forge-cortex__forge_harness_run"), null);
  for (const query of [
    "",
    "Bash",
    "github",
    `select:${tool}run,Bash`,
    "select:mcp__other__forge_harness_run",
  ]) {
    assert.match(denial(query), /supervised ForgeKit/);
  }
  assert.match(denial(`select:${tool}run`, "kimi"), /supervised ForgeKit/);
  assert.match(
    denial(`select:${tool}run`, "claude", { mcp_server_name: "other" }),
    /supervised ForgeKit/,
  );
});

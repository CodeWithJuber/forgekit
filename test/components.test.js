import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../src/brand.js";
import { componentCommand } from "../src/cli/components.js";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-component-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(root, args, input = "") {
  const result = spawnSync(process.execPath, [join(BRAND.root, "src/cli.js"), ...args], {
    cwd: root,
    env: { ...process.env, FORGE_NO_HINT: "1" },
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("the public catalogs describe installed source, folded frontmatter and event matchers", (t) => {
  const root = workspace(t);
  for (const [kind, expected] of [
    ["agents", ["doc-sync", "planner"]],
    ["skills", ["forge-ledger", "cost-guard"]],
    ["hooks", ["protect-paths", "cortex-capture"]],
  ]) {
    const report = cli(root, [kind, "list", "--json"]);
    const ids = report.components.map((c) => c.id);
    for (const id of expected) assert.ok(ids.includes(id));
    assert.equal(new Set(ids).size, ids.length);
    for (const c of report.components) assert.ok(existsSync(join(BRAND.root, c.source)), c.source);
    if (kind === "hooks")
      assert.equal(report.components.find((c) => c.id === "cortex-capture").matchers.length, 2);
  }
  const item = cli(root, ["agents", "show", "doc-sync", "--json"]);
  assert.match(item.description, /documentation/i);
  assert.ok(item.instructions.length > 100);
});

test("agent briefs and typed skill commands work without host configuration", async (t) => {
  const root = workspace(t);
  const handoff = cli(
    root,
    ["agents", "run", "debugger", "--input", "-", "--json"],
    '{"task":"Investigate the build time"}',
  );
  assert.equal(handoff.mode, "handoff");
  assert.match(handoff.brief, /Investigate the build time/);
  assert.match(
    cli(root, ["skills", "run", "cost-guard", "--task", "Explore a repo", "--json"]).brief,
    /Explore a repo/,
  );
  const ledger = cli(root, ["skills", "run", "forge-ledger", "--json"]);
  assert.equal(ledger.mode, "command");
  assert.equal(ledger.ok, true);
  await assert.rejects(
    componentCommand("agents", ["run", "debugger", "--host", "codex", "--task", "Review"], root),
    /host-billing/,
  );
  await assert.rejects(
    componentCommand("agents", ["run", "does-not-exist"], root),
    /Unknown component/,
  );
  await assert.rejects(componentCommand("skills", ["run", "forge-impact"], root), /missing/);
  await assert.rejects(
    componentCommand("skills", ["run", "forge-verify", "--task", "x"], root),
    /typed/,
  );
});

test("one installed Claude hook preserves local entries and the team bundle", async (t) => {
  const root = workspace(t);
  mkdirSync(join(root, ".claude"));
  const user = { hooks: [{ type: "command", command: "my-personal-hook" }] };
  const local = join(root, ".claude", "settings.local.json");
  writeFileSync(local, JSON.stringify({ theme: "light", hooks: { PreToolUse: [user] } }));
  const args = (op) => ["hooks", op, "protect-paths", "--host", "claude", "--json"];
  assert.equal(cli(root, args("enable")).status, "enabled");
  const settings = JSON.parse(readFileSync(local, "utf8"));
  const cmd = settings.hooks.PreToolUse.find((group) => group !== user && group.hooks[0].args)
    .hooks[0];
  assert.equal(cmd.command, process.execPath);
  const reply = spawnSync(cmd.command, cmd.args, {
    cwd: root,
    input: JSON.stringify({
      cwd: root,
      tool_name: "Read",
      tool_input: { file_path: join(root, "README.md") },
    }),
    encoding: "utf8",
  });
  assert.equal(reply.status, 0);
  const before = readFileSync(local, "utf8");
  assert.equal(cli(root, args("enable")).status, "enabled");
  assert.equal(readFileSync(local, "utf8"), before);
  cli(root, ["hooks", "on", "--hosts", "claude", "--json"]);
  const team = join(root, ".claude", "settings.json");
  const shipped = readFileSync(team, "utf8");
  assert.equal(cli(root, args("disable")).status, "disabled");
  assert.equal(readFileSync(team, "utf8"), shipped);
  assert.deepEqual(JSON.parse(readFileSync(local, "utf8")), {
    theme: "light",
    hooks: { PreToolUse: [user] },
  });
  assert.equal(cli(root, args("disable")).status, "absent");
});

test("standalone hooks use normalized typed events and the selected matcher", async (t) => {
  const root = workspace(t);
  const body = {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, "guide.md") },
  };
  const report = cli(
    root,
    ["hooks", "invoke", "protect-paths", "--input", "-", "--json"],
    JSON.stringify(body),
  );
  assert.equal(report.decision, "allow");
  assert.equal(report.ok, true);
  const input = join(root, "hook.json");
  writeFileSync(input, JSON.stringify(body));
  await assert.rejects(
    componentCommand("hooks", ["invoke", "cortex-pre-edit", "--input", input], root),
    /does not select/,
  );
  writeFileSync(input, JSON.stringify({ ...body, hook_event_name: "Stop" }));
  await assert.rejects(
    componentCommand("hooks", ["invoke", "protect-paths", "--input", input], root),
    /Expected hook_event_name/,
  );
  writeFileSync(input, JSON.stringify({ hook_event_name: "PreToolUse" }));
  await assert.rejects(
    componentCommand("hooks", ["invoke", "protect-paths", "--input", input], root),
    /tool_name/,
  );
});

test("skill installation copies references and preserves unrelated or modified work", async (t) => {
  const root = workspace(t);
  const call = (op, host = "codex") =>
    componentCommand("skills", [op, "forge-ledger", "--host", host], root);
  const first = await call("install");
  assert.equal(first.status, "installed");
  assert.ok(existsSync(join(first.path, "references", "evidence-model.md")));
  assert.doesNotMatch(readFileSync(join(first.path, "SKILL.md"), "utf8"), /^allowed-tools:/m);
  assert.equal((await call("install")).status, "current");
  assert.equal((await call("uninstall")).status, "removed");
  assert.equal((await call("uninstall")).status, "absent");
  await call("install");
  writeFileSync(join(first.path, "operator-notes.md"), "private edits");
  await assert.rejects(call("uninstall"), /user changes/);
  await assert.rejects(call("install"), /user changes/);
  assert.equal(readFileSync(join(first.path, "operator-notes.md"), "utf8"), "private edits");
  const existing = join(root, ".github", "skills", "forge-ledger");
  mkdirSync(existing, { recursive: true });
  await assert.rejects(call("install", "copilot"), /belongs to the user/);
});

test("a single Claude crew agent installs independently and preserves user edits", (t) => {
  const root = workspace(t);
  const commands = (op) => ["agents", op, "scout", "--host", "claude", "--json"];
  const install = cli(root, commands("install"));
  assert.equal(install.status, "installed");
  assert.match(readFileSync(install.path, "utf8"), /^name: scout$/m);
  assert.equal(cli(root, commands("install")).status, "current");
  assert.equal(cli(root, commands("uninstall")).status, "removed");
  assert.equal(cli(root, commands("uninstall")).status, "absent");
  cli(root, commands("install"));
  const edited = readFileSync(install.path, "utf8").replace("model: haiku", "model: sonnet");
  writeFileSync(install.path, edited);
  const removal = spawnSync(
    process.execPath,
    [join(BRAND.root, "src/cli.js"), ...commands("uninstall")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(removal.status, 1);
  assert.match(removal.stderr, /user changes/);
  assert.equal(readFileSync(install.path, "utf8"), edited);
});

test("install refuses a linked host directory", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = workspace(t),
    target = workspace(t);
  symlinkSync(target, join(root, ".claude"), "dir");
  await assert.rejects(
    componentCommand("skills", ["install", "forge-ledger", "--host", "claude"], root),
    /real project directory/,
  );
  assert.ok(!existsSync(join(target, "skills")));
});

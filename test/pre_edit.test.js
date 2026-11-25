import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitGate } from "../src/commit_gate.js";
import { hooksStatus } from "../src/emit/hooks.js";
import { harden } from "../src/harden.js";
import { HOSTS, loadManifest, runHook } from "../src/hosts.js";
import { checkPreEdit, editIntent, reviewPreEdit } from "../src/pre_edit.js";
import { matchingIndex, verify } from "../src/verify.js";
import { privateWorkspaceFile } from "../src/workspace_preference.js";

const cli = join(import.meta.dirname, "..", "src", "cli.js");
const manifest = {
  PreToolUse: loadManifest().PreToolUse.filter((group) =>
    group.hooks.some((h) => h.args.at(-1).endsWith("/pre-edit-impact.sh")),
  ),
};
const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-pre-edit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  return { root, git };
};
const requestId = (reply) =>
  (reply.stderr + reply.stdout).match(/forge impact --review ([a-f0-9]{64})/)?.[1];
const send = (host, event, input, env = process.env) =>
  runHook({ host, event, input: JSON.stringify(input), env, claim: null, manifest });

test("each callback dialect binds a named file edit to an actual review", async (t) => {
  const { root } = fixture(t);
  const coverage = hooksStatus(root).edits;
  assert.ok(coverage.withoutCallbacks.includes("aider"));
  assert.ok(coverage.withoutCallbacks.includes("vscode"));
  assert.deepEqual(coverage.callbacks.find((row) => row.host === "cursor").events, ["preToolUse"]);
  assert.match(coverage.commit, /--require-verified/);
  for (const [host, adapter] of Object.entries(HOSTS)) {
    const event =
      Object.entries(adapter.events).find(
        ([, spec]) => spec.as === "PreToolUse" && !spec.tool && !spec.ask,
      ) ??
      Object.entries(adapter.events).find(([, spec]) => spec.as === "PreToolUse" && !spec.tool);
    assert.ok(event, host);
    const body = {
      cwd: root,
      session_id: host,
      tool_name: "Write",
      tool_input: { file_path: "note.md", content: "hello" },
    };
    const first = await send(host, event[0], body);
    const id = requestId(first);
    assert.ok(id, `${host}: ${JSON.stringify(first)}`);
    const review = await reviewPreEdit(root, id);
    assert.deepEqual(review.files, ["note.md"]);
    assert.equal(review.plan.fullSuite, true);
    const retry = await send(host, event[0], body);
    assert.equal(retry.exit, 0, host);
    assert.doesNotMatch(retry.stdout, /"deny"|--review/, host);
  }
});

test("one CLI review covers all moved/added paths; a changed operation, checkout, or session needs fresh evidence", async (t) => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  writeFileSync(join(root, "b.js"), 'import { a } from "./a.js";\nexport const b = a;\n');
  git("add", "-A");
  git("commit", "-qm", "baseline");
  const patch =
    "*** Begin Patch\n*** Update File: a.js\n*** Move to: moved.js\n@@\n-export const a = 1;\n+export const a = 2;\n*** Add File: note.md\n+hello-from-user\n*** End Patch";
  const body = {
    cwd: root,
    session_id: "session-a",
    tool_name: "apply_patch",
    tool_input: { patch },
  };
  const request = () => send("codex", "PreToolUse", body);
  const id = requestId(await request());
  assert.ok(id);
  const review = JSON.parse(
    execFileSync(process.execPath, [cli, "impact", "--review", id, "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  assert.deepEqual(review.files, ["a.js", "moved.js", "note.md"]);
  assert.ok(review.plan.impact.dependents.includes("b.js"), JSON.stringify(review.plan.impact));
  assert.ok(review.plan.impact.unindexedTargets.includes("moved.js"));
  assert.equal(review.plan.fullSuite, true);
  assert.equal((await request()).exit, 0);
  const records = privateWorkspaceFile(root, "pre-edit-v1").slice(0, -5);
  for (const state of ["pending", "reviewed"])
    assert.doesNotMatch(
      readFileSync(join(records, `${id}.${state}.json`), "utf8"),
      /hello-from-user|export const|session-a/,
    );
  assert.ok(requestId(await send("codex", "PreToolUse", { ...body, session_id: "session-b" })));
  body.tool_input.patch += "\n";
  assert.notEqual(requestId(await request()), id);
  body.tool_input.patch = patch;
  writeFileSync(join(root, "b.js"), "export const b = 4;\n");
  assert.notEqual(requestId(await request()), id);
  await assert.rejects(reviewPreEdit(root, id), /changed/);
  writeFileSync(join(root, "a.js"), "export const a = 5;\n");
  assert.notEqual(requestId(await request()), id);
  assert.equal(
    (await send("codex", "PreToolUse", body, { ...process.env, FORGE_GATE: "advisory" })).exit,
    0,
  );
});

test("a fresh nongit workspace and an unidentified session receive conservative scope", async (t) => {
  const { root } = fixture(t);
  rmSync(join(root, ".git"), { recursive: true });
  const paths = ["new.txt"];
  const intent = editIntent("Write", { file_path: paths[0], content: "hello" });
  const first = await checkPreEdit({ cwd: root, paths, intent, session: "new" });
  const review = await reviewPreEdit(root, first.id);
  assert.equal(review.plan.fullSuite, true);
  const once = await checkPreEdit({ cwd: root, paths, intent });
  assert.equal(once.allow, true);
  assert.ok(once.plan.fullSuite);
  assert.equal(once.id, undefined);
});

test("strict precommit requires a counted PASS linked to the actual staged tree", (t) => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, ".gitignore"), ".forge/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(
    join(root, "value.test.js"),
    'require("node:test")("arithmetic", () => require("node:assert/strict").equal(2+2,4));\n',
  );
  writeFileSync(join(root, "readme.md"), "start\n");
  git("add", "-A");
  git("commit", "-qm", "baseline");
  writeFileSync(join(root, "readme.md"), "finish\n");
  git("add", "readme.md");
  const check = () => commitGate(root, { requireVerified: true });
  assert.equal(check().allow, false);
  const result = verify({ targetRoot: root });
  assert.equal(result.ok, true, result.tests.output);
  assert.equal(result.provenance.indexDigest, matchingIndex(root));
  assert.equal(check().allow, true);
  harden({ targetRoot: root, requireVerified: true });
  const hook = readFileSync(join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(hook, /precommit --require-verified/);
  assert.match(hook, /command -v node .*exit 1/);
  harden({ targetRoot: root });
  assert.doesNotThrow(() => git("hook", "run", "pre-commit"));
  writeFileSync(join(root, "readme.md"), "different staged change\n");
  assert.equal(check().allow, false);
  git("add", "readme.md");
  assert.equal(check().allow, false);
  assert.throws(() => git("hook", "run", "pre-commit"));
  const off = commitGate(root, { env: { FORGE_COMMIT_GATE: "off" }, requireVerified: true });
  assert.equal(off.allow, false);
  assert.ok(existsSync(join(root, ".forge", "provenance.json")));
  const processResult = spawnSync(
    process.execPath,
    [cli, "precommit", "--require-verified", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(processResult.status, 1);
  assert.equal(JSON.parse(processResult.stdout).findings[0].kind, "verification");
});

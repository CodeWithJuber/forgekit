import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approvalStore,
  decideHarnessCall,
  defaultHarnessPolicy,
  harnessTrust,
  stageTurnCap,
  validateHarnessArgs,
  visibleHarnessTools,
} from "../src/harness_policy.js";
import { createHarnessTools } from "../src/harness_tools.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "harness-policy-"));
  const tools = createHarnessTools(),
    policy = defaultHarnessPolicy();
  const desc = (n) => tools.find((t) => t.name === n);
  const context = { root, request: { profile: "coder" } };
  const decide = (name, args, tool = desc(name), request = context.request) =>
    decideHarnessCall({ root, policy, request, tool, call: { name, args } });
  return { root, tools, policy, desc, context, decide };
}

test("stage ceilings combine the role, risk and actual arguments before execution", () => {
  const { root, policy, tools, decide } = setup();
  policy.profiles.coder.stage = 2;
  const args = { path: "ok.js", content: "hello", expectedSha256: null };
  assert.equal(decide("write_file", args).level, "approval");
  assert.equal(decide("write_file", { ...args, path: "../no.js" }).level, "denied");
  for (const name of ["shell", "deploy"]) assert.equal(decide(name, {}).level, "denied");
  assert.equal(decide("list_files", { surprise: true }).level, "denied");
  assert.equal(decide("list_files", {}, undefined, { profile: "__proto__" }).level, "denied");
  assert.deepEqual(
    visibleHarnessTools(policy, "reviewer", tools).map((t) => t.name),
    ["read_file", "list_files"],
  );
  for (const [i, n] of [5, 8, 10, 12, 15, 20, 25].entries()) {
    policy.profiles.coder.stage = i + 1;
    assert.equal(stageTurnCap(policy, "coder"), n);
  }
  const plugin = { name: "lookup", risk: "read", inputSchema: { type: "object", properties: {} } };
  assert.equal(decide("lookup", {}, plugin).level, "restricted");
  const exec = { ...plugin, risk: "execute" };
  assert.equal(decide("lookup", {}, exec).level, "denied");
  policy.profiles.coder.tools.lookup = "sandbox";
  assert.equal(decide("lookup", {}, exec).level, "denied");
  assert.equal(decide("lookup", {}, { ...exec, executeSandbox: () => null }).level, "sandbox");
  policy.profiles.coder.tools.lookup = "allowed";
  assert.equal(decide("lookup", {}, { ...plugin, risk: "spend" }).level, "approval");
  assert.ok(!existsSync(join(root, "ok.js")));
});

test("bounded file reads redact credentials and guarded writes retain concurrent edits", () => {
  const { root, desc, context, decide } = setup();
  const write = desc("write_file").execute,
    read = desc("read_file").execute;
  const create = { path: "hello.txt", content: "\ufefffirst\r\n", expectedSha256: null };
  const first = write(create, context);
  assert.deepEqual(read({ path: create.path }, context), {
    path: create.path,
    content: create.content,
    sha256: first.sha256,
    nextOffset: null,
  });
  assert.throws(() => write(create, context), /changed/);
  write({ ...create, content: "revision", expectedSha256: first.sha256 }, context);
  assert.throws(
    () => write({ ...create, content: "stale", expectedSha256: first.sha256 }, context),
    /changed/,
  );
  assert.equal(readFileSync(join(root, create.path), "utf8"), "revision");
  const outside = { ...create, path: "other.js" };
  assert.equal(
    decide("write_file", outside, undefined, { profile: "coder", scope: ["src"] }).level,
    "denied",
  );
  for (const p of [
    ".env",
    "harness/policy.yaml",
    ".git/config",
    "node_modules/tool.js",
    "C:\\outside.txt",
    "some/../x",
    "NUL",
    "f.txt:alternate",
  ]) {
    assert.equal(decide("write_file", { ...create, path: p }).level, "denied", p);
  }
  writeFileSync(
    join(root, "leak.txt"),
    `token=${["p", "a", "s", "s", "w", "o", "r", "d", "1", "2", "3", "4", "5"].join("")}`,
  );
  assert.match(read({ path: "leak.txt" }, context).content, /REDACTED/);
});

test("directories with links and hardlinked source files cannot escape a workspace", (_t) => {
  const { root, desc, context, decide } = setup();
  const other = mkdtempSync(join(tmpdir(), "harness-outer-"));
  writeFileSync(join(other, "info.txt"), "external");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "visible.txt"), "safe");
  linkSync(join(other, "info.txt"), join(root, "hardlink.txt"));
  symlinkSync(other, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["hardlink.txt", "alias/info.txt"]) {
    assert.equal(decide("read_file", { path }).level, "denied");
    assert.equal(
      decide("write_file", { path, content: "x", expectedSha256: null }).level,
      "denied",
    );
  }
  assert.deepEqual(
    desc("list_files")
      .execute({ path: "." }, context)
      .entries.map((e) => e.name)
      .sort(),
    ["sub", "visible.txt"],
  );
  assert.equal(readFileSync(join(other, "info.txt"), "utf8"), "external");
});

test("exact approvals survive a restart, expire and are single-use even with reordered properties", () => {
  const { root } = setup();
  let time = 1;
  const store = () => approvalStore(root, { now: () => time });
  const call = { name: "send", args: { a: "\r\n", b: "cafe\u0301" } };
  const binding = { runId: "r", profile: "coder", attempt: "1:0", ttlMs: 5, call };
  const first = store().request(binding);
  assert.equal(first.status, "pending");
  assert.deepEqual(first.call, call);
  assert.equal(store().consume(first.id, binding), false);
  assert.equal(store().grant(first.id).status, "granted");
  assert.equal(store().consume(first.id, { ...binding, attempt: "1:1" }), false);
  assert.equal(
    store().consume(first.id, { ...binding, call: { ...call, args: { a: "\n", b: "café" } } }),
    false,
  );
  assert.equal(
    store().consume(first.id, {
      ...binding,
      call: { ...call, args: { b: call.args.b, a: call.args.a } },
    }),
    true,
  );
  assert.equal(store().consume(first.id, binding), false);
  assert.equal(store().request(binding).status, "consumed");
  const later = store().request({ ...binding, attempt: "2:0" });
  time += 5;
  assert.equal(store().grant(later.id).status, "expired");
  assert.equal(store().consume(later.id, { ...binding, attempt: "2:0" }), false);
  const denied = store().request({ ...binding, attempt: "3:0" });
  assert.equal(store().deny(denied.id).status, "denied");
  assert.equal(store().grant(denied.id).status, "denied");
  assert.equal(store().list().length, 3);
  assert.throws(() => store().get("../approval"), /Invalid/);
  assert.throws(() => approvalStore(setup().root).get(first.id), /not found/);
});

test("profile trust counts completed runs once, demotes mechanically and resets on model changes", () => {
  const { root } = setup();
  const store = harnessTrust(root);
  const good = { model: "pinned-a", verified: true, gateViolations: 0 };
  assert.equal(store.get("coder", good.model, 3).stage, 3);
  for (let i = 0; i < 20; i++) store.record("coder", `ok-${i}`, good, 3);
  assert.equal(store.get("coder", good.model, 3).stage, 4);
  assert.equal(store.record("coder", "ok-19", good, 3).total, 0);
  for (let i = 0; i < 3; i++) store.record("coder", `bad-${i}`, { ...good, verified: false }, 3);
  assert.equal(store.get("coder", good.model, 3).stage, 3);
  assert.equal(store.record("coder", "incident", { ...good, secretExposed: true }, 3).stage, 2);
  assert.equal(store.get("coder", "new-model", 3).stage, 2);
  assert.equal(store.record("coder", "late-old", good, 3).model, "new-model");
  assert.equal(store.get("reviewer", good.model, 1).stage, 1);
});

test("unknown schema keywords, dangerous keys, ambiguous types and extra arguments fail closed", () => {
  const s = {
    type: "object",
    properties: { pos: { type: "integer", minimum: 0, maximum: 20 } },
    required: ["pos"],
  };
  for (const args of [
    { pos: 1, extra: 2 },
    { pos: Infinity },
    { pos: 21 },
    { pos: 1.1 },
    JSON.parse('{"pos":1,"__proto__":{}}'),
  ])
    assert.throws(() => validateHarnessArgs(s, args));
  assert.throws(() => validateHarnessArgs({ ...s, oneOf: [] }, { pos: 0 }));
  assert.equal(validateHarnessArgs(s, { pos: 0 }), true);
});

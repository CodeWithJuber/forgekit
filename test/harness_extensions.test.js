import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  inspectHarnessExtension,
  listHarnessExtensions,
  loadHarnessExtensions,
  pinHarnessExtension,
  removeHarnessExtension,
} from "../src/harness_extensions.js";
import { createHarnessHooks, HARNESS_HOOK_POINTS } from "../src/harness_hooks.js";

test("all named hooks support ordered transforms; veto and hook deadlines are enforced", async () => {
  const hooks = createHarnessHooks({ timeoutMs: 100 });
  for (const point of HARNESS_HOOK_POINTS)
    assert.deepEqual(await hooks.apply(point, { n: 1 }), { n: 1 });
  hooks.on("agent.tool.before", (x) => ({ n: x.n * 2 }), { source: "core" });
  hooks.on("agent.tool.before", (x) => ({ n: x.n + 4 }), { source: "policy" });
  assert.throws(() => hooks.on("agent.tool.before", (x) => x, { source: "test" }), /trust/);
  const off = hooks.on("agent.tool.before", (x) => ({ n: x.n * 5 }), {
    source: "test",
    trusted: true,
  });
  assert.deepEqual(await hooks.apply("agent.tool.before", { n: 1 }), { n: 30 });
  off();
  hooks.on("agent.tool.before", () => ({ veto: "blocked path" }), {
    source: "test",
    trusted: true,
  });
  await assert.rejects(hooks.apply("agent.tool.before", { n: 2 }), {
    code: "HOOK_VETO",
    source: "test",
    message: "blocked path",
  });
  hooks.on("memory.before_store", () => new Promise(() => {}));
  await assert.rejects(hooks.apply("memory.before_store", {}), {
    code: "HOOK_VETO",
    source: "core",
  });
  hooks.on("chat.output", (x) => {
    x.n = 200;
    throw new Error("Formatter failed");
  });
  assert.deepEqual(await hooks.apply("chat.output", { n: 1 }), { n: 1 });
  assert.deepEqual(
    hooks
      .history()
      .filter((e) => e.name === "hook.failed")
      .map((e) => e.data.reason),
    ["timeout", "handler error"],
  );
});

test("event subscriptions are isolated, one-shot, removable before dispatch and history is capped", async () => {
  const hooks = createHarnessHooks({ historyLimit: 2 });
  let count = 0;
  hooks.subscribe(
    "run.*",
    (e) => {
      count++;
      e.data.label = "changed";
    },
    { once: true },
  );
  hooks.subscribe("run.*", () => assert.fail("Listener removed before delivery"), {
    source: "will-unload",
  });
  hooks.emit("run.started", { label: "original" });
  hooks.emit("run.completed", {});
  hooks.removeSource("will-unload");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  assert.equal(hooks.history()[0].data.label, "original");
  hooks.emit("job.started", {});
  assert.deepEqual(
    hooks.history().map((e) => e.name),
    ["run.completed", "job.started"],
  );
});

function fixture(t, overrides = {}, kind = "plugin") {
  const root = mkdtempSync(join(tmpdir(), "harness-plugin-")),
    dir = join(root, "extensions", "retry");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "references", "guide.md"), "Use exponential backoff.");
  const manifest = {
    name: "retry",
    version: "1.2.0",
    source: "team",
    license: "MIT",
    description: "Retry guidance",
    tools: [
      { name: "guide", reference: "references/guide.md", description: "Read the retry guide" },
    ],
    hooks: [{ point: "agent.tool.before", action: "veto_contains", value: "forbidden" }],
    events: ["run.*"],
    ...overrides,
  };
  writeFileSync(join(dir, `${kind}.json`), JSON.stringify(manifest));
  if (kind === "skill") writeFileSync(join(dir, "SKILL.md"), "Inspect existing retry helpers.");
  const hooks = createHarnessHooks();
  const open = (opts) =>
    loadHarnessExtensions({
      root,
      task: "review retry behavior",
      host: "codex",
      hooks,
      policy: { trustedHooks: { retry: ["agent.tool.before"] } },
      ...opts,
    });
  return { root, dir, hooks, open };
}
test("extensions resolve through a workspace alias and reject symlinks inside it", (t) => {
  const f = fixture(t);
  const aliases = mkdtempSync(join(tmpdir(), "harness-alias-"));
  t.after(() => rmSync(aliases, { recursive: true, force: true }));
  const root = join(aliases, "workspace");
  symlinkSync(realpathSync.native(f.root), root, "junction");
  const physical = realpathSync.native(f.dir);
  const lexical = join(root, "extensions", "retry");
  const { digest } = inspectHarnessExtension(root, lexical);
  assert.equal(inspectHarnessExtension(root, physical).digest, digest);
  pinHarnessExtension(root, lexical, digest);
  assert.equal(f.open().active.length, 1);
  symlinkSync(physical, join(root, "linked-extension"), "junction");
  assert.throws(() => inspectHarnessExtension(root, "linked-extension"), /symlink/);
  assert.throws(() => inspectHarnessExtension(root, aliases), /in the workspace/);
});
test("review binds exact content, workspace, host and task; unloading revokes even retained tool handles", async (t) => {
  const f = fixture(t, { triggers: ["retry"], hosts: ["codex", "kimi"] }, "skill");
  const review = inspectHarnessExtension(f.root, f.dir);
  assert.throws(() => pinHarnessExtension(f.root, f.dir, "0".repeat(64)), /current digest/);
  pinHarnessExtension(f.root, f.dir, review.digest);
  assert.equal(f.open({ task: "css" }).skills.length, 0);
  assert.equal(f.open({ host: "another" }).active.length, 0);
  assert.match(f.open({ policy: {} }).skipped[0].reason, /trust/);
  const plugin = f.open();
  assert.equal(plugin.skills[0].instructions, "Inspect existing retry helpers.");
  const tool = plugin.tools[0];
  assert.equal(tool.execute({}), "Use exponential backoff.");
  await assert.rejects(f.hooks.apply("agent.tool.before", { path: "forbidden" }), {
    code: "HOOK_VETO",
    source: "retry",
  });
  f.hooks.emit("run.completed", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.active[0].events, 1);
  plugin.unload("retry");
  assert.deepEqual(f.hooks.registrations("retry"), { hooks: 0, listeners: 0 });
  assert.throws(() => tool.execute({}), /unloaded/);
  assert.equal(plugin.tools.length + plugin.skills.length, 0);
  writeFileSync(join(f.dir, "references", "guide.md"), "Changed");
  assert.match(f.open().skipped[0].reason, /changed/);
  removeHarnessExtension(f.root, "retry");
  assert.deepEqual(listHarnessExtensions(f.root), []);
});
test("modified or injected lockfiles do not authorize code; unsupported and secret files are rejected", (t) => {
  const f = fixture(t),
    review = inspectHarnessExtension(f.root, f.dir);
  mkdirSync(join(f.root, "harness"), { recursive: true });
  writeFileSync(
    join(f.root, "harness", "lockfile.json"),
    JSON.stringify({
      extensions: [
        {
          name: review.name,
          version: review.version,
          directory: review.directory,
          digest: review.digest,
        },
      ],
    }),
  );
  assert.equal(f.open().skipped[0].reason, "local review required");
  writeFileSync(join(f.dir, "entry.js"), "throw Error('untrusted')");
  assert.throws(() => inspectHarnessExtension(f.root, f.dir), /declarative/);
  rmSync(join(f.dir, "entry.js"));
  writeFileSync(join(f.dir, "references", "guide.md"), ["sk", "-", "z".repeat(32)].join(""));
  assert.throws(() => inspectHarnessExtension(f.root, f.dir), /credential/);
});
test("repeated hook faults quarantine the pinned digest until an explicit review", async (t) => {
  const f = fixture(t, {
    hooks: [{ point: "chat.output", action: "require_field", value: "answer" }],
  });
  const { digest } = inspectHarnessExtension(f.root, f.dir);
  pinHarnessExtension(f.root, f.dir, digest);
  const plugin = f.open(),
    tool = plugin.tools[0];
  for (let i = 0; i < 3; i++)
    assert.equal(await f.hooks.apply("chat.output", "no object"), "no object");
  assert.throws(() => tool.execute({}), /unloaded/);
  assert.deepEqual(f.hooks.registrations("retry"), { hooks: 0, listeners: 0 });
  assert.equal(listHarnessExtensions(f.root)[0].quarantine.reason, "handler error");
  assert.equal(f.open().skipped[0].reason, "quarantined");
  assert.ok(f.hooks.history().some((e) => e.name === "plugin.quarantined"));
  pinHarnessExtension(f.root, f.dir, digest);
  assert.equal(f.open().active.length, 1);
  assert.ok(readFileSync(join(f.root, "harness", "lockfile.json"), "utf8").includes(digest));
});

test("a checkout rollback cannot restore an older approved version", (t) => {
  const f = fixture(t);
  pinHarnessExtension(f.root, f.dir, inspectHarnessExtension(f.root, f.dir).digest);
  const lock = join(f.root, "harness", "lockfile.json"),
    old = readFileSync(lock, "utf8"),
    ref = join(f.dir, "references", "guide.md"),
    text = readFileSync(ref, "utf8");
  writeFileSync(ref, "Changed retry policy.");
  pinHarnessExtension(f.root, f.dir, inspectHarnessExtension(f.root, f.dir).digest);
  writeFileSync(ref, text);
  writeFileSync(lock, old);
  assert.equal(f.open().skipped[0].reason, "local review required");
});

test("quarantine counts failures across distinct harness runs", async (t) => {
  const f = fixture(t, {
    hooks: [{ point: "chat.output", action: "require_field", value: "answer" }],
  });
  pinHarnessExtension(f.root, f.dir, inspectHarnessExtension(f.root, f.dir).digest);
  for (let i = 0; i < 3; i++) {
    const hooks = createHarnessHooks(),
      ext = f.open({ hooks });
    await hooks.apply("chat.output", {});
    ext.unload("retry");
  }
  assert.equal(f.open().skipped[0].reason, "quarantined");
  assert.ok(listHarnessExtensions(f.root)[0].lastUsedAt);
});

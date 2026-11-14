import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { autoStatus, configureAuto, maybeAutoAdopt, runAutoJob } from "../src/auto_adoption.js";
import { writeForgeConfig } from "../src/repo_config.js";

const tmp = mkdtempSync(join(tmpdir(), "forge-auto-"));
const prev = process.env.FORGE_HOME;
process.env.FORGE_HOME = join(tmp, "private");
after(() => {
  if (prev === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = prev;
  rmSync(tmp, { recursive: true, force: true });
});
const root = () => mkdtempSync(join(tmp, "tree-"));
const slot = 600000;
const start = Math.floor(Date.now() / slot) * slot + 1000;
const at = () => start;
const prompt = "Use context7 to look up the library docs for sensitive client-7421";
function enqueue(path, time = start, query = prompt) {
  const args = [];
  const job = maybeAutoAdopt(path, query, { now: time, launchWorker: (...a) => args.push(...a) });
  return { args, job };
}
test("auto is disabled without an allowlist; status never creates private state", () => {
  const r = root();
  assert.deepEqual(autoStatus(r), { enabled: false, allowed: [], jobs: [], installed: [] });
  assert.equal(enqueue(r).job, null);
  assert.equal(existsSync(join(process.env.FORGE_HOME, "integrations-auto")), false);
  assert.throws(() => configureAuto(r, "on", ["arbitrary-command"]), /catalog/);
  assert.throws(() => configureAuto(r, "on", ["constructor"]), /catalog/);
  assert.throws(() => configureAuto(r, "on", []), /Use auto/);
});

test("only approved, matched IDs enqueue, private queries never reach disk or worker, concurrent prompt calls dedup", async () => {
  const r = root();
  const opt = configureAuto(r, "on", ["context7"]);
  assert.deepEqual(opt.allowed, ["context7"]);
  assert.equal(enqueue(r, start, "A screenshot via playwright").job, null);
  assert.equal(enqueue(r, start, "hello").job, null);
  assert.equal(enqueue(root()).job, null);
  const job = enqueue(r);
  assert.deepEqual(job.job, { id: "context7", state: "queued" });
  assert.deepEqual(job.args.slice(0, 3), [r, "context7", 1]);
  assert.equal(enqueue(r).job, null);
  const jobs = autoStatus(r).jobs;
  assert.ok(!JSON.stringify(jobs).includes("client-7421"));
  const dir = join(process.env.FORGE_HOME, "integrations-auto");
  const saved = readdirSync(dir, { recursive: true })
    .filter((p) => String(p).endsWith(".json"))
    .map((p) => readFileSync(join(dir, String(p)), "utf8"))
    .join("");
  assert.ok(!saved.includes("client-7421"));
  configureAuto(r, "off");
  let called = false;
  await runAutoJob(r, "context7", job.args[2], {
    now: at,
    install: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(autoStatus(r).jobs[0].state, "cancelled");
});

test("a pinned checkout without its private package is restored once; installation is checked at worker start", async () => {
  const r = root();
  configureAuto(r, "on", ["context7"]);
  writeForgeConfig(r, (cfg) => {
    cfg.mcp = { integrations: ["context7"], versions: { context7: "3.2.2" } };
  });
  const { args } = enqueue(r);
  let installs = 0;
  const install = async (root, id, opts) => {
    installs++;
    assert.equal(root, r);
    assert.equal(id, "context7");
    assert.equal(opts.version, "3.2.2");
    assert.equal(opts.canRegister(), true);
    const p = join(process.env.FORGE_HOME, "tool-packages", id, "3.2.2");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "receipt.json"), "{}");
    return { ok: true, id, version: "3.2.2" };
  };
  await Promise.all([
    runAutoJob(r, "context7", args[2], { now: at, install }),
    runAutoJob(r, "context7", args[2], { now: at, install }),
  ]);
  assert.equal(installs, 1);
  assert.equal(autoStatus(r).jobs[0].state, "installed");
  assert.equal(enqueue(r, start + slot).job, null);
  rmSync(join(process.env.FORGE_HOME, "tool-packages"), { recursive: true });
});

test("failed or expired jobs are observable and retry only for a later matching prompt", async () => {
  const r = root();
  configureAuto(r, "on", ["context7"]);
  const { args } = enqueue(r);
  await runAutoJob(r, "context7", args[2], {
    now: at,
    install: async () => ({ ok: false, reason: "Registry lookup is offline" }),
  });
  assert.equal(autoStatus(r).jobs[0].state, "failed");
  assert.equal(enqueue(r).job, null);
  const next = enqueue(r, start + slot);
  assert.ok(next.job);
  await runAutoJob(r, "context7", next.args[2], {
    now: () => start + 2 * slot,
    install: () => assert.fail("expired authorization"),
  });
  assert.equal(autoStatus(r).jobs[0].state, "cancelled");
});
test("a named personal tool is pinned to its reviewed executable and permissions", () => {
  const r = root();
  const tool = {
    id: "widget-test",
    npm: "widget-tools",
    upstream: "https://github.com/example/widget-tools",
    bin: "widget-test",
    terms: ["widget test"],
    cost: "local",
    permissions: "test widget fixtures",
  };
  const p = join(process.env.FORGE_HOME, "tool-catalog.json");
  writeFileSync(p, JSON.stringify({ tools: [tool] }));
  configureAuto(r, "on", [tool.id]);
  writeFileSync(p, JSON.stringify({ tools: [{ ...tool, bin: "different-entry" }] }));
  assert.equal(enqueue(r, start, "Please run a widget test").job, null);
  configureAuto(r, "on", [tool.id]);
  assert.equal(enqueue(r, start, "Please run a widget test").job.id, "widget-test");
  rmSync(p);
});

test("a revoked policy prevents registration after a worker has already begun", async () => {
  const r = root();
  configureAuto(r, "on", ["context7"]);
  const { args } = enqueue(r);
  await runAutoJob(r, "context7", args[2], {
    now: at,
    install: async (_root, _id, { canRegister }) => {
      assert.equal(canRegister(), true);
      configureAuto(r, "off");
      assert.equal(canRegister(), false);
      return { ok: false, reason: "Policy changed during installation" };
    },
  });
  assert.equal(autoStatus(r).jobs[0].state, "failed");
  assert.deepEqual(autoStatus(r).installed, []);
});

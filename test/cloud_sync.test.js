import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cloudStatus,
  configureCloud,
  previewCloud,
  pushCloud,
  removeCloud,
} from "../src/cloud_client.js";
import { cloudService } from "../src/cloud_server.js";
import { cloudDeadline, sha, workspaceSnapshot } from "../src/cloud_snapshot.js";
import { installedHarnessPython } from "../src/harness_python.js";

test("cloud snapshots use Git ignore rules and preview the explicit expansion", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-cloud-ignore-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, ".gitignore"), "*.private\n!public.private\n");
  writeFileSync(join(root, "docs", ".gitignore"), "local.txt\n");
  for (const name of ["operator.private", "public.private", "docs/local.txt", "normal.txt"])
    writeFileSync(join(root, name), "synthetic fixture");
  for (const asGitRepo of [false, true]) {
    if (asGitRepo) execFileSync("git", ["init", "-q"], { cwd: root });
    const normal = workspaceSnapshot(root);
    assert.deepEqual(normal.files.map((f) => f.path).sort(), [
      ".gitignore",
      "docs/.gitignore",
      "normal.txt",
      "public.private",
    ]);
    const expanded = workspaceSnapshot(root, [], { includeIgnored: true });
    assert.deepEqual(expanded.ignoredPaths.sort(), ["docs/local.txt", "operator.private"]);
  }
  assert.ok(cloudDeadline(145 * 1024 * 1024) > (145 * 1024 * 1024 * 8) / 20000);
  assert.equal(cloudDeadline(0), 45000);
});

test("enrolled workspace snapshots isolate credentials, retry pending bytes, compare revisions and delete", async (t) => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "forge-cloud-"));
  const root = join(dir, "project"),
    other = join(dir, "other"),
    state = join(dir, "private"),
    dataDir = join(dir, "hosted");
  for (const path of [root, other, state]) mkdirSync(path, { mode: 0o700 });
  const token = () => randomBytes(32).toString("hex");
  const env = { WRITE: token(), READ: token(), ADMIN: token(), OTHER: token() };
  const saved = process.env.FORGE_HOME,
    savedToken = process.env.FORGE_CLOUD_TEST_CREDENTIAL;
  process.env.FORGE_HOME = state;
  process.env.FORGE_CLOUD_TEST_CREDENTIAL = env.WRITE;
  t.after(() => {
    for (const [name, val] of [
      ["FORGE_HOME", saved],
      ["FORGE_CLOUD_TEST_CREDENTIAL", savedToken],
    ]) {
      if (val === undefined) delete process.env[name];
      else process.env[name] = val;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const config = {
    dataDir,
    principals: [
      { tenant: "first", workspace: "project", role: "writer", tokenEnv: "WRITE" },
      { tenant: "first", workspace: "project", role: "reader", tokenEnv: "READ" },
      { tenant: "first", workspace: "project", role: "admin", tokenEnv: "ADMIN" },
      { tenant: "another", workspace: "project", role: "reader", tokenEnv: "OTHER" },
    ],
  };
  const server = cloudService(config, env);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const api = `${origin}/v1/workspaces/project`;
  const call = (secret, suffix = "", options = {}) =>
    fetch(api + suffix, {
      ...options,
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    });
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(api)).status, 401);
  assert.deepEqual(await cloudStatus(root), { enrolled: false });
  const privateFolder = join(state, "personal");
  mkdirSync(privateFolder);
  assert.throws(() => previewCloud(privateFolder), /separate directories/);
  await assert.rejects(
    configureCloud(privateFolder, {
      url: origin,
      workspace: "project",
      tokenEnv: "FORGE_CLOUD_TEST_CREDENTIAL",
      fullWorkspace: true,
    }),
    /separate directories/,
  );
  await assert.rejects(pushCloud(privateFolder), /separate directories/);
  await configureCloud(root, {
    url: origin,
    workspace: "project",
    tokenEnv: "FORGE_CLOUD_TEST_CREDENTIAL",
    fullWorkspace: true,
  });
  await assert.rejects(
    configureCloud(root, {
      url: origin,
      workspace: "project",
      tokenEnv: "FORGE_CLOUD_TEST_CREDENTIAL",
      fullWorkspace: true,
    }),
    /already enrolled/,
  );
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  writeFileSync(
    join(root, ".forge", "sessions", "a.jsonl"),
    '{"prompt":"document a public algorithm"}',
  );
  writeFileSync(join(root, "example.txt"), `hello ${env.WRITE}`);
  writeFileSync(join(root, ".env"), "private");
  if (process.platform !== "win32") symlinkSync(join(root, ".env"), join(root, "link.txt"));
  const privateRoot = join(state, "workspace-memory", sha(root), "prompts");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(privateRoot, "prompt.jsonl"), '{"prompt":"workspace-scoped record"}');
  const otherRoot = join(state, "workspace-memory", sha(other), "prompts");
  mkdirSync(otherRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(otherRoot, "other.jsonl"), "unrelated");
  const memoryDb = join(state, "harness-memory", "memory.sqlite");
  const jobDir = join(state, "harness-jobs", sha(root));
  mkdirSync(join(state, "harness-memory"), { mode: 0o700 });
  mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  execFileSync(installedHarnessPython(root), [
    "-I",
    "-c",
    `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("CREATE TABLE items(scope,text)")
    db.executemany("INSERT INTO items VALUES (?,?)", [(sys.argv[2], "eligible memory"), ("personal", "private"), (sys.argv[3], "other project")])
with sqlite3.connect(sys.argv[4]) as jobs:
    jobs.execute("CREATE TABLE jobs(id,token)")
    jobs.execute("INSERT INTO jobs VALUES (1,'protected lease')")
with sqlite3.connect(sys.argv[5]) as application:
    application.execute("CREATE TABLE notes(content TEXT)")`,
    memoryDb,
    `repo-${sha(root)}`,
    `repo-${sha(other)}`,
    join(jobDir, "jobs.sqlite3"),
    join(root, "application.cards"),
  ]);
  writeFileSync(join(root, "application.cards-shm"), Buffer.alloc(128));
  const preview = previewCloud(root);
  assert.equal(preview.skipped["database-requires-logical-export"], 2);
  assert.deepEqual(preview.files.map((f) => f.path).sort(), [
    ".forge-cloud-export/harness-jobs.json",
    ".forge-cloud-export/harness-memory.json",
    ".forge-cloud-export/workspace-memory/prompts/prompt.jsonl",
    ".forge/sessions/a.jsonl",
    "example.txt",
  ]);
  assert.equal(preview.files.find((x) => x.path === "example.txt").redacted, true);
  const first = await pushCloud(root);
  assert.equal(first.modified, 5);
  for (const [file, expected] of [
    ["memory", { items: [{ scope: `repo-${sha(root)}`, text: "eligible memory" }] }],
    ["jobs", { jobs: [{ id: 1 }] }],
  ]) {
    const artifact = await (
      await call(env.READ, `/artifact?path=.forge-cloud-export/harness-${file}.json`)
    ).json();
    assert.deepEqual(JSON.parse(Buffer.from(artifact.content, "base64").toString()), expected);
  }
  const history = await (await call(env.READ, "/events")).json();
  assert.equal(history.events[0].id, first.revision);
  assert.equal(history.next, first.revision);
  const delta = await (await call(env.READ, `/events?id=${first.revision}`)).json();
  assert.equal(delta.updated.length, 5);
  assert.deepEqual(delta.removed, []);
  assert.equal((await call(env.OTHER, `/events?id=${first.revision}`)).status, 404);
  assert.equal((await pushCloud(root)).modified, 0);
  assert.deepEqual((await (await call(env.OTHER)).json()).files, []);
  const artifact = "/artifact?path=example.txt";
  assert.equal((await call(env.WRITE, artifact)).status, 403);
  const record = await (await call(env.READ, artifact)).json();
  assert.equal(Buffer.from(record.content, "base64").toString(), "hello [REDACTED]");
  writeFileSync(join(root, "example.txt"), "pending version");
  process.env.FORGE_CLOUD_TEST_CREDENTIAL = env.READ;
  await assert.rejects(pushCloud(root), /403/);
  assert.equal((await cloudStatus(root)).pending, true);
  writeFileSync(join(root, "example.txt"), "newer version");
  process.env.FORGE_CLOUD_TEST_CREDENTIAL = env.WRITE;
  await pushCloud(root);
  assert.equal(
    Buffer.from((await (await call(env.READ, artifact)).json()).content, "base64").toString(),
    "pending version",
  );
  await pushCloud(root);
  unlinkSync(join(root, "example.txt"));
  assert.equal((await pushCloud(root)).removed, 1);
  assert.equal((await call(env.READ, artifact)).status, 404);
  await configureCloud(other, {
    url: origin,
    workspace: "project",
    tokenEnv: "FORGE_CLOUD_TEST_CREDENTIAL",
    fullWorkspace: true,
  });
  await assert.rejects(pushCloud(other), /409/);
  await assert.rejects(removeCloud(root, true, false), /confirm/);
  assert.equal((await call(env.WRITE, "", { method: "DELETE" })).status, 403);
  process.env.FORGE_CLOUD_TEST_CREDENTIAL = env.ADMIN;
  await removeCloud(root, true, true);
  assert.equal((await cloudStatus(root)).enrolled, false);
  const after = await (await call(env.READ)).json();
  assert.equal(after.files.length, 0);
  assert.deepEqual(after.events, []);
  assert.match(after.revision, /^[0-9a-f-]{36}$/);
  const heads = execFileSync(
    installedHarnessPython(root),
    [
      "-c",
      "import json,sqlite3,sys; print(json.dumps(sqlite3.connect(sys.argv[1]).execute('SELECT scope, revision FROM heads').fetchall()))",
      join(dataDir, "cloud.sqlite"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(heads), [["first/project", after.revision]]);
  await assert.rejects(pushCloud(other), /409/);
  await removeCloud(other);
});

test("a pending write reserves only its scope, and read workers have an independent limit", async (t) => {
  const dataDir = mkdtempSync(join(realpathSync.native(tmpdir()), "forge-cloud-admission-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { FIRST: randomBytes(32).toString("hex"), NEXT: randomBytes(32).toString("hex") };
  const principals = Object.keys(env).map((tokenEnv) => ({
    tenant: tokenEnv.toLowerCase(),
    workspace: "project",
    role: "admin",
    tokenEnv,
  }));
  const config = {
    dataDir,
    principals,
    maxConcurrentReads: 1,
    maxConcurrentWrites: 2,
    maxHistoryBytes: 450,
  };
  assert.throws(() => cloudService({ ...config, maxConcurrentReads: 0 }, env), /positive integers/);
  const server = cloudService(config, env);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = "http://127.0.0.1:" + server.address().port + "/v1/workspaces/project";
  const headers = (key) => ({
    authorization: "Bearer " + env[key],
    "content-type": "application/json",
  });
  const change = JSON.stringify({ id: randomUUID(), parent: null, files: [], removed: [] });
  const incoming = once(server, "request");
  const upload = request(base + "/sync", { method: "POST", headers: headers("FIRST") });
  upload.on("error", () => {});
  t.after(() => upload.destroy());
  upload.write(change.slice(0, 1));
  await incoming;
  assert.equal((await fetch(base, { method: "DELETE", headers: headers("FIRST") })).status, 429);
  assert.equal(
    (await fetch(base + "/sync", { method: "POST", headers: headers("NEXT"), body: change }))
      .status,
    200,
  );
  const received = once(upload, "response");
  upload.end(change.slice(1));
  const [receipt] = await received;
  receipt.resume();
  assert.equal(receipt.statusCode, 200);

  // Remove only the new accounting row to exercise upgrade from an existing journal.
  const db = join(dataDir, "cloud.sqlite");
  execFileSync(installedHarnessPython(dataDir), [
    "-c",
    "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('DELETE FROM journal_usage'); db.commit()",
    db,
  ]);
  const push = (change) =>
    fetch(base + "/sync", {
      method: "POST",
      headers: headers("FIRST"),
      body: JSON.stringify(change),
    });
  const original = JSON.parse(change);
  const replay = await push(original);
  assert.equal((await replay.json()).replayed, true);
  const next = { ...original, id: randomUUID(), parent: original.id, removed: ["ordinary.txt"] };
  const limited = await push(next);
  assert.equal(limited.status, 413);
  assert.match((await limited.json()).reason, /journal capacity/);
  const unchanged = await (await fetch(base, { headers: headers("FIRST") })).json();
  assert.equal(unchanged.revision, original.id);
  assert.equal(unchanged.events.length, 1);
  assert.equal((await fetch(base, { method: "DELETE", headers: headers("FIRST") })).status, 200);
  const tombstone = (await (await fetch(base, { headers: headers("FIRST") })).json()).revision;
  assert.equal((await push({ ...next, parent: tombstone })).status, 200);

  // Hold the database briefly to keep a normal status read pending deterministically.
  const locker = spawn(
    installedHarnessPython(dataDir),
    [
      "-u",
      "-c",
      "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('BEGIN EXCLUSIVE'); print('ready'); sys.stdin.readline(); db.rollback()",
      join(dataDir, "cloud.sqlite"),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  t.after(() => locker.kill());
  await once(locker.stdout, "data");
  const reading = once(server, "request");
  const pending = fetch(base, { headers: headers("FIRST") });
  await reading;
  const saturated = await fetch(base, { headers: headers("NEXT") });
  assert.equal(saturated.status, 429);
  locker.stdin.end("\n");
  assert.equal((await pending).status, 200);
  assert.equal((await fetch(base, { headers: headers("NEXT") })).status, 200);
});

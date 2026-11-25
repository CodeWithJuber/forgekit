import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cloudStatus,
  configureCloud,
  previewCloud,
  pushCloud,
  readRelay,
  removeCloud,
} from "../src/cloud_client.js";
import {
  inspectRelay,
  pendingRelayChange,
  queueRelayChange,
  relayChange,
  relayKeys,
} from "../src/cloud_relay.js";
import { cloudService } from "../src/cloud_server.js";
import { sha } from "../src/cloud_snapshot.js";
import { installedHarnessPython } from "../src/harness_python.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const credential = () => randomBytes(32).toString("base64");
const keyEnv = "RELAY_FIXTURE_LOCAL_KEY";
const tokenEnv = "RELAY_FIXTURE_CREDENTIAL";
function scopedEnv(t, values) {
  for (const [k, value] of Object.entries(values)) {
    const before = process.env[k];
    process.env[k] = value;
    t.after(() => {
      if (before === undefined) delete process.env[k];
      else process.env[k] = before;
    });
  }
}

async function startRelay(t, dataDir, principals, env) {
  const server = cloudService({ dataDir, principals, transport: "relay" }, env);
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}

test("encrypted snapshots authenticate manifest, tenant, revision, names and artifact bytes", async (t) => {
  const key = credential();
  scopedEnv(t, { [keyEnv]: key, [tokenEnv]: credential() });
  const config = { tenant: "team", workspace: "demo", keyEnv, tokenEnv };
  const keys = relayKeys(config);
  const [a, b] = ["design-notes.txt", "research-notes.txt"].map((path) => {
    const raw = Buffer.from("same private note");
    return {
      path,
      content: raw.toString("base64"),
      kind: "text",
      redacted: false,
      sha256: sha(raw),
      bytes: raw.length,
    };
  });
  const change = relayChange(
    keys,
    { revision: null, manifest: null },
    { files: [a, b], bytes: a.bytes + b.bytes },
  );
  const rows = change.files;
  const manifest = rows.find((row) => row.path === "manifest");
  assert.equal(rows.length, 3);
  assert.notEqual(rows[0].content, rows[1].content);
  assert.ok(rows.every((r) => r.kind === "binary" && !r.redacted));
  assert.ok(!JSON.stringify(change).includes("notes.txt"));
  assert.ok(!JSON.stringify(change).includes(a.sha256));
  const status = { revision: change.id, files: rows.map(({ content, ...r }) => r) };
  const get = async (sub) => {
    if (!sub) return status;
    const path = new URL(sub, "http://fixture.test").searchParams.get("path");
    return rows.find((r) => r.path === path);
  };
  assert.deepEqual(
    (await inspectRelay(keys, get, undefined, change.id)).files,
    [a, b].map(({ content, ...meta }) => meta),
  );
  assert.equal((await inspectRelay(keys, get, b.path, change.id)).content, b.content);
  for (const mismatched of [{ tenant: "another" }, { workspace: "another" }]) {
    const other = relayKeys({ ...config, ...mismatched });
    await assert.rejects(inspectRelay(other, get, a.path, change.id), /authentication/);
  }
  await assert.rejects(
    inspectRelay(
      keys,
      async (sub) => (sub ? get(sub) : { ...status, revision: randomUUID() }),
      a.path,
      undefined,
    ),
    /authentication/,
  );
  await assert.rejects(
    inspectRelay(
      keys,
      async (sub) => (sub.includes(rows[0].path) ? rows[1] : get(sub)),
      a.path,
      undefined,
    ),
    /authentication/,
  );
  await assert.rejects(
    inspectRelay(
      keys,
      async (sub) => (sub ? get(sub) : { ...status, files: [manifest, rows[0]] }),
      a.path,
      undefined,
    ),
    /authentication/,
  );
  await assert.rejects(
    inspectRelay(
      keys,
      async (sub) =>
        sub.includes("path=manifest")
          ? { ...manifest, content: Buffer.alloc(manifest.bytes).toString("base64") }
          : get(sub),
      a.path,
      undefined,
    ),
    /authentication/,
  );
  await assert.rejects(inspectRelay(keys, get, a.path, randomUUID()), /expected relay revision/);
  process.env[tokenEnv] = key;
  assert.throws(() => relayKeys(config), /independent/);
  assert.throws(() => relayKeys(config, "wrong"), /32 random bytes/);
});

test("relay clients retry an encrypted outbox, verify another device's receipt and isolate tenants", async (t) => {
  const folder = mkdtempSync(join(realpathSync.native(tmpdir()), "forge-relay-"));
  const home = join(folder, "state"),
    root = join(folder, "sender"),
    peer = join(folder, "reader"),
    dataDir = join(folder, "service");
  mkdirSync(root);
  mkdirSync(peer);
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const env = { WRITE: credential(), READ: credential(), ADMIN: credential(), OTHER: credential() };
  const key = credential();
  scopedEnv(t, { FORGE_HOME: home, [keyEnv]: key, [tokenEnv]: env.WRITE });
  const principals = Object.keys(env).map((name) => ({
    workspace: "demo",
    tenant: name === "OTHER" ? "second" : "first",
    tokenEnv: name,
    role: { READ: "reader", WRITE: "writer", OTHER: "reader", ADMIN: "admin" }[name],
  }));
  const origin = await startRelay(t, dataDir, principals, env);
  const path = "/v1/relay/first/demo";
  const call = (suffix, secret, base = path) =>
    fetch(origin + base + suffix, { headers: { authorization: "Bearer " + secret } });
  const config = {
    url: origin,
    tenant: "first",
    workspace: "demo",
    tokenEnv,
    keyEnv,
    fullWorkspace: true,
  };
  assert.equal((await fetch(origin)).headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal((await call("", env.READ, "/v1/workspaces/demo")).status, 404);
  assert.equal((await call("", env.READ, "/v1/relay/second/demo")).status, 403);
  assert.equal((await call("", env.READ, "/v1/relay/first/another")).status, 403);
  assert.equal((await call("", env.OTHER)).status, 403);
  assert.deepEqual((await (await call("", env.OTHER, "/v1/relay/second/demo")).json()).files, []);
  await configureCloud(root, config, "relay");
  await configureCloud(peer, config, "relay");
  assert.deepEqual(await cloudStatus(root), { enrolled: false });
  const file = "workshop-ledger.txt";
  const content = "first private result";
  const media = Buffer.from([0, 255, 127, 96]);
  const mediaPath = "--json";
  writeFileSync(join(root, mediaPath), media);
  writeFileSync(join(root, file), content);
  writeFileSync(join(root, "credentials-in-text.md"), "enrollment value " + key);
  assert.equal(
    previewCloud(root, "relay").files.find((f) => f.path === "credentials-in-text.md").redacted,
    true,
  );
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).endsWith("/sync") && response.ok) {
      sent = options.body;
      await response.arrayBuffer();
      throw new Error("Simulated lost acknowledgement");
    }
    return response;
  };
  try {
    await assert.rejects(pushCloud(root, {}, "relay"), /lost acknowledgement/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const dir = join(home, "relay", sha(root));
  const wire = JSON.stringify(JSON.parse(sent));
  for (const secret of [file, content, sha(Buffer.from(content)), key, env.WRITE]) {
    assert.ok(!wire.includes(secret));
    assert.ok(!readFileSync(join(dir, "pending.json"), "utf8").includes(secret));
    assert.ok(!readFileSync(join(dataDir, "cloud.sqlite")).includes(Buffer.from(secret)));
  }
  const pending = join(dir, "pending.json");
  const saved = readFileSync(pending);
  const edited = JSON.parse(saved.toString());
  edited.payload = JSON.stringify({ ...JSON.parse(edited.payload), trace: "local-only data" });
  writeFileSync(pending, JSON.stringify(edited));
  let transmitted = false;
  globalThis.fetch = async () => {
    transmitted = true;
    throw new Error("Unexpected network request");
  };
  try {
    await assert.rejects(
      pushCloud(root, {}, "relay"),
      /pending relay upload failed authentication/i,
    );
    assert.equal(transmitted, false);
  } finally {
    globalThis.fetch = realFetch;
    writeFileSync(pending, saved);
  }
  writeFileSync(join(root, file), "second private result");
  const first = await pushCloud(root, {}, "relay");
  assert.equal(first.revision, JSON.parse(sent).id);
  assert.equal(first.modified, 3);
  const opaque = await (await call("", env.READ)).json();
  assert.equal(opaque.files.length, 4);
  assert.ok(opaque.files.every((f) => f.path === "manifest" || /^[a-f0-9]{64}$/.test(f.path)));
  assert.equal(
    (
      await call(
        "/artifact?path=" +
          opaque.files.find((f) => f.path !== "manifest").path +
          "&revision=" +
          first.revision,
        env.WRITE,
      )
    ).status,
    403,
  );
  process.env[tokenEnv] = env.READ;
  assert.equal(
    Buffer.from((await readRelay(peer, file, first.revision)).content, "base64").toString(),
    content,
  );
  assert.ok(
    Buffer.from((await readRelay(peer, "credentials-in-text.md", first.revision)).content, "base64")
      .toString()
      .includes("[REDACTED]"),
  );
  process.env[tokenEnv] = env.WRITE;
  const second = await pushCloud(root, {}, "relay");
  assert.equal(second.modified, 1);
  assert.equal((await pushCloud(root, {}, "relay")).modified, 0);
  assert.deepEqual((await cloudStatus(root, true, "relay")).remote, {
    revision: second.revision,
    authenticated: true,
    files: 3,
  });
  process.env[tokenEnv] = env.READ;
  await assert.rejects(readRelay(peer, file, first.revision), /expected relay revision/);
  const readArgs = [cli, "relay", "read", file, "--revision", second.revision];
  const result = await run(process.execPath, readArgs, {
    cwd: peer,
    env: { ...process.env, FORGE_NO_HINT: "1" },
  });
  assert.equal(result.stdout, "second private result");
  const binary = await run(
    process.execPath,
    [cli, "relay", "read", "--path=" + mediaPath, "--revision", second.revision],
    { cwd: peer, encoding: "buffer" },
  );
  assert.deepEqual(binary.stdout, media);
  // Accept a real online backup on an independently started receiver using the saved receipt.
  const restoredDir = join(folder, "restored-service");
  mkdirSync(restoredDir, { mode: 0o700 });
  const backup = [
    "import os, sqlite3, sys",
    "os.umask(0o077)",
    "with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as dest:",
    "    source.backup(dest)",
  ].join("\n");
  await run(installedHarnessPython(root), [
    "-I",
    "-c",
    backup,
    join(dataDir, "cloud.sqlite"),
    join(restoredDir, "cloud.sqlite"),
  ]);
  const restoredOrigin = await startRelay(t, restoredDir, principals, env);
  const recoveredPeer = join(folder, "restored-reader");
  mkdirSync(recoveredPeer);
  await configureCloud(recoveredPeer, { ...config, url: restoredOrigin }, "relay");
  const recovered = await readRelay(recoveredPeer, mediaPath, second.revision);
  assert.deepEqual(Buffer.from(recovered.content, "base64"), media);
  assert.equal(recovered.sha256, sha(media));
  const newKey = credential();
  process.env[keyEnv] = newKey;
  await assert.rejects(readRelay(peer, file), /changed since enrollment/);
  const wrongPeer = join(folder, "other-key");
  mkdirSync(wrongPeer);
  await configureCloud(wrongPeer, config, "relay");
  await assert.rejects(readRelay(wrongPeer, file, second.revision), /authentication/);
  process.env[tokenEnv] = env.WRITE;
  await assert.rejects(
    pushCloud(wrongPeer, { replaceRemote: true, confirmed: true }, "relay"),
    /authentication/,
  );
  process.env[keyEnv] = key;
  process.env[tokenEnv] = env.WRITE;
  rmSync(join(root, file));
  const third = await pushCloud(root, {}, "relay");
  assert.equal(third.removed, 1);
  process.env[tokenEnv] = env.READ;
  await assert.rejects(readRelay(peer, file), /absent/);
  await assert.rejects(
    readRelay(recoveredPeer, mediaPath, third.revision),
    /expected relay revision/,
  );
  process.env[tokenEnv] = env.ADMIN;
  await removeCloud(root, true, true, "relay");
  assert.deepEqual((await readRelay(peer)).files, []);
  assert.equal((await readRelay(recoveredPeer, mediaPath, second.revision)).sha256, sha(media));
  await assert.rejects(pushCloud(peer, {}, "relay"), /409/);
  const initial = await pushCloud(peer, { replaceRemote: true, confirmed: true }, "relay");
  assert.equal((await readRelay(peer, undefined, initial.revision)).authenticated, true);
});

test("durable relay retries authenticate saved bytes and accept the previous queue format", () => {
  const keys = { outbox: randomBytes(32) };
  const change = { removed: [], files: [], label: "café", parent: null };
  const { version, tag, payload } = queueRelayChange(keys, change);
  assert.deepEqual(pendingRelayChange(keys, { tag, version, payload }), change);
  assert.throws(
    () => pendingRelayChange(keys, { tag, version, payload: payload + " " }),
    /authentication/,
  );
  const old = createHmac("sha256", keys.outbox).update(JSON.stringify(change)).digest("hex");
  assert.deepEqual(pendingRelayChange(keys, { tag: old, change }), change);
  assert.throws(() => pendingRelayChange(keys, { tag, change }), /authentication/);
});

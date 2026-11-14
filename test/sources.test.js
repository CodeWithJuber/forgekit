import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  getSource,
  initSources,
  readSourceRecord,
  searchSources,
  sourcesStatus,
  sourceWorkspaceRoot,
  syncSources,
} from "../src/sources.js";

const dir = mkdtempSync(join(tmpdir(), "forge-sources-"));
const oldHome = process.env.FORGE_HOME;
process.env.FORGE_HOME = join(dir, "private");
after(() => {
  if (oldHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
});
function fixture(sources = []) {
  const root = mkdtempSync(join(dir, "repo-"));
  const { configPath } = initSources(root);
  const set = (list) => writeFileSync(configPath, JSON.stringify({ sources: list }));
  set(sources);
  return { root, configPath, set };
}
const remote = {
  id: "tickets",
  provider: "gitlab",
  deployment: "self-hosted",
  baseUrl: "https://gitlab.example",
  project: "org/test",
  tokenEnv: "SOURCE_TEST_TOKEN",
};
const issue = (id, description) => ({
  id: 100 + id,
  iid: id,
  title: `Issue ${id}`,
  description,
  updated_at: "2026-11-12T14:00:00Z",
  state: "opened",
  web_url: `https://gitlab.example/org/test/-/issues/${id}`,
});
function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function setupRemote(t, fetcher) {
  const original = globalThis.fetch;
  const token = process.env.SOURCE_TEST_TOKEN;
  globalThis.fetch = fetcher;
  process.env.SOURCE_TEST_TOKEN = "test-only-scope-a";
  t.after(() => {
    globalThis.fetch = original;
    if (token === undefined) delete process.env.SOURCE_TEST_TOKEN;
    else process.env.SOURCE_TEST_TOKEN = token;
  });
}
function activeFile(path, id, file) {
  const dir = join(dirname(path), `source-${id}`);
  return join(
    dir,
    readdirSync(dir)
      .filter((n) => n.startsWith("g-"))
      .sort()
      .at(-1),
    file,
  );
}

test("init is exclusive, status is read-only, configuration is private and tied to the working tree", () => {
  const a = mkdtempSync(join(dir, "repo-"));
  const before = sourcesStatus(a);
  assert.deepEqual(before.sources, []);
  assert.equal(existsSync(before.configPath), false);
  const other = fixture();
  assert.notEqual(before.configPath, other.configPath);
  assert.deepEqual(initSources(a), { created: true, configPath: before.configPath });
  const original = '{"sources":[]}\n';
  writeFileSync(before.configPath, original);
  assert.equal(initSources(a).created, false);
  assert.equal(readFileSync(before.configPath, "utf8"), original);
  assert.ok(!before.configPath.startsWith(a));
  if (process.platform !== "win32") assert.equal(statSync(before.configPath).mode & 0o777, 0o600);
  assert.deepEqual(searchSources(a, "Find everything").hits, []);
  assert.throws(() => getSource(a, "anything"), /Unknown/);
});

test("subdirectories use the same repository config while nested worktrees remain isolated", () => {
  const { root } = fixture();
  execFileSync("git", ["init", "-q"], { cwd: root });
  const sub = join(root, "pkg", "nested");
  mkdirSync(sub, { recursive: true });
  assert.equal(sourceWorkspaceRoot(sub), root);
  assert.equal(sourcesStatus(sub).configPath, sourcesStatus(root).configPath);
  execFileSync("git", ["init", "-q"], { cwd: sub });
  assert.notEqual(sourcesStatus(sub).configPath, sourcesStatus(root).configPath);
});

test("configuration rejects duplicated IDs, unknown providers, relative roots and invalid budgets", () => {
  const { root, set } = fixture();
  set([
    { id: "x", provider: "local", root },
    { id: "x", provider: "local", root },
  ]);
  assert.throws(() => sourcesStatus(root), /unique/);
  set([{ id: "../dir", provider: "local", root }]);
  assert.throws(() => sourcesStatus(root), /unique/);
  set([{ id: "x", provider: "local", root: "../other" }]);
  assert.throws(() => sourcesStatus(root), /absolute/);
  set([{ id: "x", provider: "other" }]);
  assert.throws(() => sourcesStatus(root), /provider/);
  set(Array(13).fill(remote));
  assert.throws(() => sourcesStatus(root), /up to/);
  set([{ ...remote, ttlSeconds: -1 }]);
  assert.throws(() => sourcesStatus(root), /ttlSeconds/);
  set([]);
  assert.throws(() => searchSources(root, "q", { budget: NaN }), /budget/);
});

test("private local index spans two folders with deterministic BM25 results, bounded citations, and removal", async () => {
  const a = mkdtempSync(join(dir, "left-")),
    b = mkdtempSync(join(dir, "right-"));
  writeFileSync(join(a, "ledger.md"), "Use the ledger for the team.\n");
  writeFileSync(
    join(b, "precision.md"),
    "The ledger rounds commission. Confirm commission in accounting.\n",
  );
  writeFileSync(join(b, "input.md"), 'constructor prototype "untrusted"\n');
  const { root, set, configPath } = fixture([
    { id: "team", provider: "local", root: a },
    { id: "billing", provider: "local", root: b },
  ]);
  assert.ok((await syncSources(root)).ok);
  const results = searchSources(root, "ledger commission");
  assert.deepEqual(
    results.hits.map((x) => x.sourceId),
    ["billing", "team"],
  );
  assert.deepEqual(searchSources(root, "ledger commission"), results);
  assert.match(results.text, /precision.md/);
  assert.match(results.text, /lines /);
  assert.equal(searchSources(root, "ledger commission", { sourceId: "team" }).hits.length, 1);
  assert.equal(searchSources(root, "constructor").hits.length, 1);
  assert.deepEqual(searchSources(root, "absentRareWord").hits, []);
  for (const budget of [1, 25, 50, 60, 100]) {
    const r = searchSources(root, "ledger", { budget });
    assert.ok(r.estimatedTokens <= budget);
    assert.equal(Math.ceil(r.text.length / 3.6), r.estimatedTokens);
  }
  assert.equal(getSource(root, "team").root, a);
  assert.equal(
    sourcesStatus(root).sources.every((s) => s.status === "ready"),
    true,
  );
  if (process.platform !== "win32")
    assert.equal(statSync(activeFile(configPath, "team", "evidence.pack")).mode & 0o777, 0o600);
  writeFileSync(join(b, "precision.md"), "different content after sync");
  assert.equal(searchSources(root, "commission").hits.length, 0);
  assert.ok((await syncSources(root, { sourceId: "billing" })).ok);
  writeFileSync(join(b, ".gitignore"), "precision.md\n");
  assert.equal(searchSources(root, "different content").hits.length, 0);
  rmSync(join(b, ".gitignore"));
  rmSync(join(b, "precision.md"));
  assert.equal(searchSources(root, "different content").hits.length, 0);
  assert.ok((await syncSources(root, { sourceId: "billing" })).ok);
  assert.equal(searchSources(root, "commission").hits.length, 0);
  set([{ id: "team", provider: "local", root: b }]);
  assert.equal(searchSources(root, "ledger").hits.length, 0);
});

test("scope changes, missing credentials and expiry hide a previous remote snapshot without network", async (t) => {
  let calls = 0;
  setupRemote(t, async () => {
    calls++;
    return response([issue(3, "Meridian retry queue")]);
  });
  const { root, configPath } = fixture([{ ...remote, ttlSeconds: 2 }]);
  assert.ok((await syncSources(root)).ok);
  const result = searchSources(root, "Meridian");
  assert.equal(result.hits[0].recordId, "3");
  assert.match(result.text, /record 3/);
  assert.equal(calls, 1);
  process.env.SOURCE_TEST_TOKEN = "different-account";
  assert.equal(searchSources(root, "Meridian").hits.length, 0);
  delete process.env.SOURCE_TEST_TOKEN;
  assert.equal(sourcesStatus(root).sources[0].status, "unavailable");
  process.env.SOURCE_TEST_TOKEN = "test-only-scope-a";
  const meta = activeFile(configPath, remote.id, "result.json");
  const prev = JSON.parse(readFileSync(meta, "utf8"));
  writeFileSync(meta, JSON.stringify({ ...prev, at: Date.now() - 2500 }));
  assert.equal(sourcesStatus(root).sources[0].status, "expired");
  assert.equal(searchSources(root, "Meridian").hits.length, 0);
  assert.equal(calls, 1);
});

test("later denied sync suppresses an earlier in-flight success, and the next sync recovers", async (t) => {
  let signal, release;
  const inflight = new Promise((resolve) => {
    signal = resolve;
  });
  let count = 0;
  setupRemote(t, async () => {
    count++;
    if (count === 1) return response([issue(1, "oldprivate")]);
    if (count === 2) {
      signal();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    if (count === 3) return response({}, 403);
    return response([]);
  });
  const { root } = fixture([remote]);
  assert.ok((await syncSources(root)).ok);
  const slow = syncSources(root);
  await inflight;
  assert.equal(searchSources(root, "oldprivate").hits.length, 0);
  const denied = await syncSources(root);
  assert.equal(denied.ok, false);
  assert.match(denied.sources[0].error, /403/);
  release(response([issue(2, "shouldneverreturn")]));
  assert.equal((await slow).ok, false);
  assert.equal(searchSources(root, "shouldneverreturn").hits.length, 0);
  assert.equal(sourcesStatus(root).sources[0].status, "unavailable");
  assert.ok((await syncSources(root)).ok);
  assert.equal(sourcesStatus(root).sources[0].status, "ready");
  assert.equal(searchSources(root, "oldprivate").hits.length, 0);
});

test("live read returns newly fetched text and invalidates the old snapshot after a denial", async (t) => {
  let count = 0;
  setupRemote(t, async () => {
    count++;
    if (count === 1) return response([issue(1, "old text")]);
    if (count === 2) return response(issue(1, "fresh replacement"));
    return response({}, 404);
  });
  const { root } = fixture([remote]);
  assert.ok((await syncSources(root)).ok);
  assert.match((await readSourceRecord(root, remote.id, "1")).text, /fresh replacement/);
  assert.equal(searchSources(root, "replacement").hits.length, 0);
  await assert.rejects(readSourceRecord(root, remote.id, "1"), /404/);
  assert.equal(sourcesStatus(root).sources[0].status, "unavailable");
});

test("live read pages the redacted text using UTF-16 offsets", async (t) => {
  const data = `🌎 ${"credentials should be configured locally ".repeat(300)}`;
  setupRemote(t, async () => response(issue(1, data)));
  const { root } = fixture([remote]);
  const first = await readSourceRecord(root, remote.id, "1");
  assert.equal(first.text.length, 8000);
  assert.equal(first.nextOffset, 8000);
  const second = await readSourceRecord(root, remote.id, "1", { offset: first.nextOffset });
  assert.match(first.text + second.text, /🌎 credentials/);
  assert.equal(first.totalChars, first.text.length + second.text.length);
  assert.equal(second.nextOffset, null);
  await assert.rejects(readSourceRecord(root, remote.id, "1", { limit: Infinity }), /limit/);
  await assert.rejects(readSourceRecord(root, remote.id, "1", { offset: -1 }), /offset/);
  await assert.rejects(readSourceRecord(root, remote.id, "1", { offset: 20000 }), /beyond/);
});

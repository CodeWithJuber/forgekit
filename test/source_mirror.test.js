import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mirrorGet, mirrorSql } from "../src/source_mirror.js";
import { initSources, syncSources, writeSourcePage } from "../src/sources.js";

const python = process.platform === "win32" ? "python" : "python3";
const hasSqlite = spawnSync(python, ["-I", "-c", "import sqlite3"]).status === 0;

function workspace(t) {
  const prev = process.env.FORGE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "mirror-sql-"));
  const root = join(dir, "repo");
  const local = join(dir, "docs");
  mkdirSync(root);
  mkdirSync(local);
  process.env.FORGE_HOME = join(dir, "private");
  t.after(() => {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const { configPath } = initSources(root);
  const configure = (sources) => writeFileSync(configPath, JSON.stringify({ sources }));
  configure([{ id: "files", provider: "local", root: local }]);
  return { root, local, configPath, configure };
}

test("manifest first, locator second, bounded excerpt third; ignore and replacement invalidate all mirror readers", {
  skip: !hasSqlite,
}, async (t) => {
  const { root, local } = workspace(t);
  writeFileSync(join(local, "data.csv"), "category,amount\nA,2\nB,3\n");
  writeFileSync(join(local, "notes.md"), "private-term\n".repeat(70));
  assert.equal((await syncSources(root)).ok, true);
  const list = mirrorGet(root, "files", { limit: 1 });
  assert.equal(list.total, 2);
  assert.equal(list.nextOffset, 1);
  assert.ok(list.fetchedAt);
  assert.doesNotMatch(JSON.stringify(list), /private-term/);
  const manifest = mirrorGet(root, "files", { id: "data.csv" });
  assert.match(manifest.item.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.item.structure.sheets, [
    { sheet: null, indexedRows: 2, columnCount: 2, columns: ["category", "amount"] },
  ]);
  assert.equal(manifest.entries[0].locator, "rows 1-3");
  const note = mirrorGet(root, "files", { id: "notes.md", chunk: 1 });
  assert.equal(note.locator, "lines 31-60");
  assert.match(note.text, /private-term/);
  assert.deepEqual(
    mirrorSql(root, "files", "SELECT kind, count(*) FROM items GROUP BY kind ORDER BY kind").rows,
    [
      ["csv", 1],
      ["md", 1],
    ],
  );
  writeFileSync(join(local, ".gitignore"), "notes.md\n");
  assert.throws(() => mirrorGet(root, "files", { id: "notes.md", chunk: 0 }), /unavailable/);
  assert.deepEqual(mirrorSql(root, "files", "SELECT id FROM items").rows, [["data.csv"]]);
  writeFileSync(join(local, "data.csv"), "replaced\n");
  const empty = mirrorSql(root, "files", "SELECT count(*) FROM items");
  assert.deepEqual(empty.rows, [[0]]);
  assert.equal(empty.partial, true);
});

test("SQLite authorizer, statement boundary, function allowlist, row/output caps and actual aggregates", {
  skip: !hasSqlite,
}, async (t) => {
  const { root, local } = workspace(t);
  writeFileSync(join(local, "a.md"), "sample\n".repeat(1000));
  await syncSources(root);
  for (const sql of [
    "ATTACH DATABASE '/tmp/file' AS x",
    "PRAGMA schema_version",
    "SELECT * FROM sqlite_master",
    "SELECT * FROM pragma_table_info('items')",
    "SELECT load_extension('evil')",
    "SELECT readfile('/etc/passwd')",
    "SELECT randomblob(1000000)",
    "SELECT * FROM items); DROP TABLE items; --",
    "WITH q AS (SELECT 1) DELETE FROM items",
    "SELECT * FROM items; DELETE FROM items",
  ]) {
    assert.throws(() => mirrorSql(root, "files", sql), /disallowed/, sql);
  }
  assert.deepEqual(
    mirrorSql(root, "files", "WITH s AS (SELECT count(*) AS n FROM items) SELECT n FROM s;").rows,
    [[1]],
  );
  const many = mirrorSql(root, "files", "SELECT a.ordinal FROM chunks a CROSS JOIN chunks b");
  assert.equal(many.rows.length, 1000);
  assert.equal(many.truncated, true);
  const large = mirrorSql(root, "files", "SELECT a.text FROM chunks a CROSS JOIN chunks b");
  assert.equal(large.truncated, true);
  assert.ok(large.rows.length < 1000);
});

test("completed remote SQL cache counts distinct records and never follows a revoked token or denied generation", {
  skip: !hasSqlite,
}, async (t) => {
  const { root, configure, configPath } = workspace(t);
  const token = process.env.FORGE_TEST_MIRROR_TOKEN;
  const oldFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = oldFetch;
    if (token === undefined) delete process.env.FORGE_TEST_MIRROR_TOKEN;
    else process.env.FORGE_TEST_MIRROR_TOKEN = token;
  });
  process.env.FORGE_TEST_MIRROR_TOKEN = "user-one-fixture";
  configure([
    {
      id: "issues",
      provider: "gitlab",
      deployment: "self-hosted",
      baseUrl: "https://git.example",
      project: "org/repo",
      tokenEnv: "FORGE_TEST_MIRROR_TOKEN",
    },
  ]);
  const records = Array.from({ length: 48 }, (_, i) => ({
    id: i + 1,
    iid: i + 1,
    title: "Example",
    state: i < 40 ? "opened" : "closed",
    description: "a".repeat(2200),
    updated_at: "2026-11-14T00:00:00Z",
  }));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(records);
  };
  assert.equal((await syncSources(root)).ok, true);
  const query = "SELECT status,count(*) FROM items GROUP BY status ORDER BY status";
  assert.deepEqual(mirrorSql(root, "issues", query).rows, [
    ["closed", 8],
    ["opened", 40],
  ]);
  assert.deepEqual(mirrorSql(root, "issues", "SELECT count(*) FROM chunks").rows, [[96]]);
  assert.equal(mirrorGet(root, "issues", { id: "1", chunk: 1 }).ordinal, 1);
  assert.equal(calls, 1);
  const sourceDir = join(dirname(configPath), "source-issues");
  const db = join(
    sourceDir,
    readdirSync(sourceDir).find((s) => s.startsWith("g-")),
    "mirror-v1.sqlite",
  );
  if (process.platform !== "win32") assert.equal(statSync(db).mode & 0o777, 0o600);
  process.env.FORGE_TEST_MIRROR_TOKEN = "user-two-fixture";
  assert.throws(() => mirrorSql(root, "issues", query), /missing/);
  process.env.FORGE_TEST_MIRROR_TOKEN = "user-one-fixture";
  globalThis.fetch = async () => new Response(null, { status: 403 });
  assert.equal((await syncSources(root)).ok, false);
  assert.throws(() => mirrorSql(root, "issues", query), /unavailable/);
  assert.throws(() => mirrorGet(root, "issues", { id: "1" }), /unavailable/);
});

function remoteIo(t) {
  const original = globalThis.fetch;
  const prev = process.env.FORGE_TEST_MIRROR_TOKEN;
  const oldEmail = process.env.FORGE_TEST_MIRROR_EMAIL;
  process.env.FORGE_TEST_MIRROR_TOKEN = "mirror-only-token";
  process.env.FORGE_TEST_MIRROR_EMAIL = "test@example.com";
  t.after(() => {
    globalThis.fetch = original;
    if (prev === undefined) delete process.env.FORGE_TEST_MIRROR_TOKEN;
    else process.env.FORGE_TEST_MIRROR_TOKEN = prev;
    if (oldEmail === undefined) delete process.env.FORGE_TEST_MIRROR_EMAIL;
    else process.env.FORGE_TEST_MIRROR_EMAIL = oldEmail;
  });
}

test("incremental sync overlaps, independently rechecks visibility, catches a grant outside the watermark and supports full backfill", async (t) => {
  remoteIo(t);
  const { root, configure } = workspace(t);
  configure([
    {
      id: "issues",
      provider: "gitlab",
      deployment: "self-hosted",
      baseUrl: "https://git.example",
      project: "org/repo",
      tokenEnv: "FORGE_TEST_MIRROR_TOKEN",
    },
  ]);
  const issue = (n) => ({
    id: n,
    iid: n,
    title: `Issue ${n}`,
    description: `body ${n}`,
    updated_at: "2026-11-12T12:00:00Z",
  });
  const seen = [];
  const replies = [
    [issue(1), issue(2)],
    [{ ...issue(2), title: "Changed" }],
    [issue(2)],
    [],
    [issue(2), issue(3)],
    [issue(2), issue(3)],
    [issue(3)],
  ];
  globalThis.fetch = async (u) => {
    seen.push(new URL(u));
    assert.ok(replies.length);
    return Response.json(replies.shift());
  };
  assert.equal((await syncSources(root)).sources[0].mode, "full");
  const delta = (await syncSources(root)).sources[0];
  assert.equal(delta.mode, "incremental");
  assert.ok(Date.now() - Date.parse(seen[1].searchParams.get("updated_after")) >= 15 * 60000);
  assert.equal(seen[2].searchParams.has("updated_after"), false);
  assert.deepEqual(
    mirrorGet(root, "issues").entries.map((i) => [i.id, i.title]),
    [["2", "#2 Changed"]],
  );
  assert.equal((await syncSources(root)).sources[0].mode, "full");
  assert.equal(mirrorGet(root, "issues").total, 2);
  assert.equal((await syncSources(root, { full: true })).sources[0].mode, "full");
  assert.equal(seen[6].searchParams.has("updated_after"), false);
  assert.equal(replies.length, 0);
});

for (const deployment of ["cloud", "self-hosted"]) {
  test(`Confluence ${deployment} versioned writes reconcile success, conflict and ambiguous outcomes without retry`, async (t) => {
    remoteIo(t);
    const { root, configure } = workspace(t);
    const src = {
      id: "wiki",
      provider: "confluence",
      deployment,
      baseUrl: "https://example.org/wiki",
      space: "ENG",
      tokenEnv: "FORGE_TEST_MIRROR_TOKEN",
      emailEnv: "FORGE_TEST_MIRROR_EMAIL",
    };
    const put = (version, title = "New title") =>
      writeSourcePage(root, "wiki", "19", {
        expectedVersion: version,
        title,
        storage: "<p>body</p>",
      });
    let version = 4,
      title = "Wiki",
      mode = "ok",
      calls = 0,
      puts = 0;
    configure([src]);
    globalThis.fetch = async (u, opts) => {
      calls++;
      const url = new URL(u);
      if (opts?.method === "PUT") {
        puts++;
        assert.equal(
          url.pathname,
          deployment === "cloud" ? "/wiki/api/v2/pages/19" : "/wiki/rest/api/content/19",
        );
        const req = JSON.parse(opts.body);
        assert.equal(req.version.number, version + 1);
        assert.deepEqual(deployment === "cloud" ? req.body : req.body.storage, {
          representation: "storage",
          value: "<p>body</p>",
        });
        version++;
        if (mode === "race") return Response.json({}, { status: 409 });
        title = req.title;
        if (mode === "lost") throw Error("network response unavailable");
        return Response.json({ id: "19", version: { number: version } });
      }
      return Response.json({
        results: [
          {
            id: "19",
            title,
            space: { key: "ENG" },
            version: { number: version, when: "2026-11-12T00:00:00Z" },
            body: { storage: { value: "<p>body</p>" } },
          },
        ],
      });
    };
    await syncSources(root);
    await assert.rejects(put(version), /allowWrites/);
    assert.equal(calls, 1);
    configure([{ ...src, allowWrites: true }]);
    const initial = mirrorGet(root, "wiki");
    const ok = await put(4);
    assert.equal(ok.ok, true);
    assert.equal(ok.currentVersion, 5);
    assert.equal(mirrorGet(root, "wiki", { id: "19" }).item.version, 5);
    assert.equal(mirrorGet(root, "wiki").fetchedAt, initial.fetchedAt);
    version++; // Human edit before our write
    const stale = await put(5);
    assert.equal(stale.status, "conflict");
    assert.equal(puts, 1);
    assert.equal(mirrorGet(root, "wiki", { id: "19" }).item.version, 6);
    mode = "race";
    const race = await put(6);
    assert.equal(race.status, "conflict");
    assert.equal(puts, 2);
    mode = "lost";
    const lost = await put(7);
    assert.equal(lost.status, "unconfirmed");
    assert.equal(lost.written, null);
    assert.equal(puts, 3);
    assert.equal(mirrorGet(root, "wiki", { id: "19" }).item.version, 8);
  });
}

test("a rate-limited refresh persists Retry-After and suppresses network retries in this credential scope", async (t) => {
  remoteIo(t);
  const { root, configure } = workspace(t);
  configure([
    {
      id: "remote",
      provider: "gitlab",
      deployment: "self-hosted",
      baseUrl: "https://git.example",
      project: "org/repo",
      tokenEnv: "FORGE_TEST_MIRROR_TOKEN",
    },
  ]);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({}, { status: 429, headers: { "Retry-After": "45" } });
  };
  const first = await syncSources(root);
  assert.equal(first.ok, false);
  assert.ok(first.sources[0].retryAt > Date.now() + 40000);
  assert.equal((await syncSources(root, { full: true })).ok, false);
  assert.equal(calls, 1);
  process.env.FORGE_TEST_MIRROR_TOKEN = "another-identity";
  await syncSources(root);
  assert.equal(calls, 2);
});

test("joins full quoted CSV and TSV files with exact decimals, preserves leading-zero keys and excludes hidden credentials", {
  skip: !hasSqlite,
}, async (t) => {
  const { root, local } = workspace(t);
  writeFileSync(
    join(local, "people.csv"),
    'id,"customer name",password\n001,"Ali, A",private-fixture\n1,Bob,other-value\n',
  );
  writeFileSync(join(local, "amounts.tsv"), "id\tamount\n001\t0.1\n001\t0.2\n1\t0.01\n");
  const opts = {
    tables: [
      { name: "p", path: "people.csv" },
      { name: "a", path: "amounts.tsv" },
    ],
  };
  const data = await mirrorSql(
    root,
    "files",
    'SELECT p.id,p."customer name",decimal_sum(a.amount) FROM p JOIN a ON a.id=p.id GROUP BY p.id ORDER BY p.id',
    opts,
  );
  assert.deepEqual(data.rows, [
    ["001", "Ali, A", "0.3"],
    ["1", "Bob", "0.01"],
  ]);
  assert.deepEqual(
    data.inputs.map((x) => x.rows),
    [2, 3],
  );
  assert.match(data.inputs[0].sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(mirrorSql(root, "files", "SELECT password FROM p", opts), /disallowed/);
  await assert.rejects(
    mirrorSql(root, "files", "SELECT * FROM p", { tables: [{ name: "p", path: "../people.csv" }] }),
    /relative/,
  );
  await assert.rejects(
    mirrorSql(root, "files", "SELECT * FROM p", {
      tables: [{ name: "sqlite_master", path: "people.csv" }],
    }),
    /names/,
  );
  writeFileSync(join(local, ".gitignore"), "amounts.tsv\n");
  await assert.rejects(mirrorSql(root, "files", "SELECT * FROM a", opts), /ignored/);
});

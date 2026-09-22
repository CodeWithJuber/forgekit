// The private HTTP cache behind the model catalogs. Freshness must come from the RESPONSE (its
// Cache-Control / Expires / validators), never from a TTL in forge's code — so every test here
// scripts the headers and moves an injected clock, and no test touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cachedGetJson,
  currentAge,
  freshnessLifetime,
  httpGet,
  parseCacheControl,
} from "../src/http_cache.js";

const URL_ = "https://catalog.example/v1/models";
const tmpDir = () => join(mkdtempSync(join(tmpdir(), "forge-httpcache-")), ".forge", "cache");
const T0 = Date.parse("2026-09-22T12:00:00Z");

/** A transport that answers from a queue and records what it was asked. */
function scripted(...responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: (req) => {
      calls.push(req);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
}
const body = (v) => JSON.stringify(v);

test("parseCacheControl reads directives with and without arguments", () => {
  assert.deepEqual(parseCacheControl('max-age=60, No-Cache, private="x"'), {
    "max-age": "60",
    "no-cache": true,
    private: "x",
  });
  assert.deepEqual(parseCacheControl(undefined), {});
});

test("freshness comes only from the response: max-age, then Expires − Date, else zero", () => {
  assert.equal(freshnessLifetime({ "cache-control": "max-age=300" }, T0), 300);
  assert.equal(
    freshnessLifetime({ "cache-control": "max-age=300, no-cache" }, T0),
    0,
    "no-cache forbids reuse without revalidation",
  );
  assert.equal(
    freshnessLifetime(
      { expires: "Tue, 22 Sep 2026 13:00:00 GMT", date: "Tue, 22 Sep 2026 12:00:00 GMT" },
      T0,
    ),
    3600,
  );
  assert.equal(freshnessLifetime({ expires: "not a date" }, T0), 0, "invalid Expires = expired");
  assert.equal(freshnessLifetime({ etag: '"v1"' }, T0), 0, "no caching headers → no invented TTL");
  // Age: an upstream cache already held it 50 s, and it has sat here 10 s more.
  assert.equal(currentAge({ age: "50" }, T0, T0 + 10_000), 60);
});

test("a fresh response is reused without any request; expiry triggers a conditional GET", () => {
  const dir = tmpDir();
  const t = scripted(
    { status: 200, headers: { "Cache-Control": "max-age=60", ETag: '"v1"' }, body: body([1]) },
    { status: 304, headers: { "cache-control": "max-age=60" }, body: "" },
  );
  const first = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 });
  assert.deepEqual(first, { value: [1], cache: "network", url: URL_ });

  const reused = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + 59_000 });
  assert.equal(reused.cache, "fresh");
  assert.equal(t.calls.length, 1, "inside max-age: no request at all");

  const later = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + 61_000 });
  assert.deepEqual(later, { value: [1], cache: "revalidated", url: URL_ });
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].headers["if-none-match"], '"v1"', "revalidation is conditional");

  // The 304 refreshed the stored copy's clock: fresh again for another max-age.
  assert.equal(
    cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + 100_000 }).cache,
    "fresh",
  );
  assert.equal(t.calls.length, 2);
});

test("no caching headers → revalidate on every use (Last-Modified validator)", () => {
  const dir = tmpDir();
  const lm = "Mon, 21 Sep 2026 00:00:00 GMT";
  const t = scripted(
    { status: 200, headers: { "last-modified": lm }, body: body({ a: 1 }) },
    { status: 304, headers: {}, body: "" },
    { status: 200, headers: {}, body: body({ a: 2 }) },
  );
  cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 });
  const second = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + 1 });
  assert.equal(second.cache, "revalidated", "the very next use asks again");
  assert.equal(t.calls[1].headers["if-modified-since"], lm);
  const third = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + 2 });
  assert.deepEqual(third.value, { a: 2 }, "a changed resource replaces the stored copy");
});

test("a failed request serves the stored copy as stale; nothing stored → null", () => {
  const dir = tmpDir();
  const t = scripted(
    { status: 200, headers: { etag: '"v1"' }, body: body(["cached"]) },
    null, // offline / timeout
    { status: 503, headers: {}, body: "busy" },
    { status: 200, headers: {}, body: "<html>not json</html>" },
    new Error("socket hang up"),
  );
  cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 });
  for (let i = 1; i <= 4; i++) {
    const r = cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 + i });
    assert.deepEqual(r, { value: ["cached"], cache: "stale", url: URL_ }, `failure #${i}`);
  }
  assert.equal(cachedGetJson(URL_, { dir: tmpDir(), fetchImpl: () => null, now: T0 }), null);
});

test("a 304 without Date does not inherit the old Date (the copy would look old again)", () => {
  const dir = tmpDir();
  const t = scripted(
    {
      status: 200,
      headers: {
        "cache-control": "max-age=60",
        etag: '"v1"',
        date: "Tue, 22 Sep 2026 12:00:00 GMT",
      },
      body: body([1]),
    },
    { status: 304, headers: { "cache-control": "max-age=60" }, body: "" },
  );
  cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 });
  const hourLater = T0 + 3_600_000;
  assert.equal(
    cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: hourLater }).cache,
    "revalidated",
  );
  assert.equal(
    cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: hourLater + 30_000 }).cache,
    "fresh",
  );
});

test("no-store is used once and never written; the cache dir ignores itself in git", () => {
  const dir = tmpDir();
  const t = scripted({ status: 200, headers: { "cache-control": "no-store" }, body: body([1]) });
  assert.equal(cachedGetJson(URL_, { dir, fetchImpl: t.fetchImpl, now: T0 }).cache, "network");
  assert.equal(existsSync(dir), false, "nothing persisted for no-store");

  const root = mkdtempSync(join(tmpdir(), "forge-httpcache-git-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const cacheDir = join(root, ".forge", "cache");
  cachedGetJson(URL_, {
    dir: cacheDir,
    fetchImpl: () => ({ status: 200, headers: { etag: '"x"' }, body: body([2]) }),
    now: T0,
  });
  const files = readdirSync(cacheDir);
  assert.ok(files.includes(".gitignore"));
  assert.match(readFileSync(join(cacheDir, ".gitignore"), "utf8"), /^\*$/m);
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(status.trim(), "", "cached catalogs never show up as untracked files");
  const stored = files.find((f) => f.endsWith(".json"));
  assert.match(stored, /^catalog\.example-/, "file name carries the host");
  assert.doesNotMatch(readFileSync(join(cacheDir, stored), "utf8"), /x-api-key|authorization/i);
});

test("FORGE_NO_CATALOG_FETCH=1 turns the real transport off without spawning anything", () => {
  const prev = process.env.FORGE_NO_CATALOG_FETCH;
  process.env.FORGE_NO_CATALOG_FETCH = "1";
  try {
    const started = Date.now();
    assert.equal(httpGet({ url: "https://unreachable.invalid/v1/models" }), null);
    assert.ok(Date.now() - started < 500, "no child process, no DNS, no timeout");
  } finally {
    if (prev === undefined) delete process.env.FORGE_NO_CATALOG_FETCH;
    else process.env.FORGE_NO_CATALOG_FETCH = prev;
  }
});

// The one place the REAL transport runs: against a loopback server in a child process (never an
// external host). A child, because httpGet is synchronous — a server in this process could not
// answer while spawnSync blocks the event loop.
const LOOPBACK_SERVER = `const http=require("http");const s=http.createServer((q,r)=>{if(q.url.startsWith("/slow"))return;if(q.headers["if-none-match"]==='"v1"'){r.writeHead(304,{etag:'"v1"',"cache-control":"max-age=5"});return r.end();}r.writeHead(200,{"content-type":"application/json",etag:'"v1"',"cache-control":"max-age=5","x-unrelated":"dropped"});r.end(JSON.stringify({data:[{id:"m1"}],key:q.headers["x-api-key"]||null}));});s.listen(0,"127.0.0.1",()=>process.stdout.write(String(s.address().port)));`;

test("httpGet: the real child transport — headers out, status/validators back, 304, timeout", async () => {
  const { spawn } = await import("node:child_process");
  const server = spawn(process.execPath, ["-e", LOOPBACK_SERVER], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const prev = process.env.FORGE_NO_CATALOG_FETCH;
  try {
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.once("exit", (code) => reject(new Error(`loopback server exited (${code})`)));
      server.stdout.once("data", (d) => resolve(Number(String(d).trim())));
    });
    delete process.env.FORGE_NO_CATALOG_FETCH;
    const base = `http://127.0.0.1:${port}`;
    const res = httpGet({
      url: `${base}/v1/models`,
      headers: { "x-api-key": "k1" },
      timeoutMs: 5000,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      JSON.parse(res.body),
      { data: [{ id: "m1" }], key: "k1" },
      "headers reach the server",
    );
    assert.equal(res.headers.etag, '"v1"');
    assert.equal(res.headers["cache-control"], "max-age=5");
    assert.equal(res.headers["x-unrelated"], undefined, "only caching headers come back");

    const notModified = httpGet({ url: `${base}/v1/models`, headers: { "if-none-match": '"v1"' } });
    assert.equal(notModified.status, 304, "a 304 is an answer, not a failure");

    const started = Date.now();
    assert.equal(httpGet({ url: `${base}/slow`, timeoutMs: 300 }), null, "timeout → null");
    assert.ok(Date.now() - started < 4000, "the short timeout is honoured");
  } finally {
    if (prev === undefined) delete process.env.FORGE_NO_CATALOG_FETCH;
    else process.env.FORGE_NO_CATALOG_FETCH = prev;
    server.kill();
  }
});

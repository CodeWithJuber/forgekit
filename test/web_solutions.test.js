import assert from "node:assert/strict";
import test from "node:test";
import { searchWebSolutions } from "../src/web_solutions.js";

const serper = { FORGE_WEB_SEARCH_PROVIDER: "serper", SERPER_API_KEY: "unit-private-key" };
const brave = { FORGE_WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "unit-private-key" };
const failFetch = () => assert.fail("unexpected provider request");
test("web provider selection and key are both required and offline always wins", async () => {
  for (const env of [
    {},
    { SERPER_API_KEY: "present" },
    { FORGE_WEB_SEARCH_PROVIDER: "serper" },
    { FORGE_WEB_SEARCH_PROVIDER: "constructor" },
    { ...brave, FORGE_NO_CATALOG_FETCH: "1" },
  ]) {
    const r = await searchWebSolutions("rust hashing", { env, fetchImpl: failFetch });
    assert.equal(r.checkedAt, null);
    assert.deepEqual(r.results, []);
  }
  for (const query of ["", "npm\nprivate", "x".repeat(300), `token ghp_${"X".repeat(36)}`]) {
    const r = await searchWebSolutions(query, { env: serper, fetchImpl: failFetch });
    assert.ok(r.warnings.length);
    assert.equal(r.checkedAt, null);
  }
});
test("Google via Serper makes one credentialed POST to the fixed API and filters result citations", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, "https://google.serper.dev/search");
    assert.equal(init.headers["X-API-KEY"], serper.SERPER_API_KEY);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.deepEqual(JSON.parse(init.body), { q: "Rust CSV parsing", num: 2 });
    return Response.json({
      organic: [
        { title: "bad", link: "data:text/html,hello" },
        { title: "credentials", link: "https://alice:pw@private.test/x" },
        {
          title: "<b>Docs</b>\nreader",
          link: "https://docs.rs/csv",
          snippet: "<strong>Parse</strong> CSV files",
        },
        { title: "duplicate", link: "https://docs.rs/csv" },
        { title: "Second", link: "https://example.org/code" },
      ],
    });
  };
  const r = await searchWebSolutions("Rust CSV parsing", { env: serper, fetchImpl, limit: 2 });
  assert.equal(calls, 1);
  assert.match(r.provider, /Google/);
  assert.ok(r.checkedAt);
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results[0], {
    title: "Docs reader",
    url: "https://docs.rs/csv",
    snippet: "Parse CSV files",
  });
  assert.ok(!JSON.stringify(r).includes(serper.SERPER_API_KEY));
});
test("Brave uses its own endpoint and header, upper bounds requested count, and never fetches targets", async () => {
  let calls = 0;
  const r = await searchWebSolutions("how to test Go modules", {
    env: brave,
    limit: 900,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls++;
      assert.equal(url.origin, "https://api.search.brave.com");
      assert.equal(url.pathname, "/res/v1/web/search");
      assert.equal(url.searchParams.get("q"), "how to test Go modules");
      assert.equal(url.searchParams.get("count"), "5");
      assert.equal(init.headers["X-Subscription-Token"], brave.BRAVE_SEARCH_API_KEY);
      assert.ok(!url.href.includes(brave.BRAVE_SEARCH_API_KEY));
      return Response.json({
        web: {
          results: [{ title: "Go docs", url: "https://go.dev/doc/", description: "Documentation" }],
        },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.results[0].snippet, "Documentation");
  assert.equal(r.warnings.length, 0);
});
test("provider failures, oversized responses and auth-bearing exceptions stay out of evidence", async () => {
  for (const fetchImpl of [
    async () => new Response("private response", { status: 403 }),
    async () => new Response("{ not JSON"),
    async () => {
      throw Error(serper.SERPER_API_KEY);
    },
    async () => Response.json({ organic: [{ snippet: "a".repeat(600000) }] }),
  ]) {
    const r = await searchWebSolutions("rust parser", { env: serper, fetchImpl });
    assert.ok(r.warnings[0]);
    assert.deepEqual(r.results, []);
    assert.ok(!JSON.stringify(r).includes(serper.SERPER_API_KEY));
  }
});
test("rate-limited searches issue no retry and honor provider retry-after", async () => {
  const r = await searchWebSolutions("rust parser", {
    env: brave,
    fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "31" } }),
  });
  assert.match(r.warnings[0], /31 seconds/);
  const next = await searchWebSolutions("go parser", { env: brave, fetchImpl: failFetch });
  assert.equal(next.checkedAt, null);
  assert.match(next.warnings[0], /rate limit/);
});

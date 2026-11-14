import assert from "node:assert/strict";
import { test } from "node:test";
import { researchPointers, researchPublic } from "../src/public_research.js";

const ok = (body) => Response.json(body);
test("local pointers are selected by task and return only static publisher information", () => {
  const task = "compare GitLab, Jira and PDF spreadsheet context in internal/AIX-731";
  const pointers = researchPointers(task);
  assert.ok(pointers.some((p) => p.name.includes("GitLab")));
  assert.ok(pointers.some((p) => p.name === "Docling"));
  assert.ok(pointers.every((p) => p.url.startsWith("https://")));
  assert.doesNotMatch(JSON.stringify(pointers), /AIX-731|internal/);
  assert.deepEqual(researchPointers("hello"), []);
});

test("explicit public query searches three providers, returns attributable versions and dates", async () => {
  const query = "parse C++ & Rust";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, undefined);
    if (url.hostname === "api.github.com") {
      assert.equal(url.searchParams.get("q"), `${query} archived:false is:public`);
      return ok({
        items: [
          {
            full_name: "vendor/parser",
            license: { spdx_id: "MIT" },
            pushed_at: "2025-03-21T11:00:00Z",
          },
          { full_name: "invalid/..", html_url: "https://evil.example" },
        ],
      });
    }
    if (url.hostname === "api.stackexchange.com") {
      assert.equal(url.searchParams.get("q"), query);
      return ok({
        items: [
          {
            question_id: 12,
            accepted_answer_id: 42,
            title: "Existing solution",
            last_activity_date: 100,
            content_license: "CC BY-SA 4.0",
          },
        ],
      });
    }
    assert.equal(url.searchParams.get("text"), query);
    return ok({
      objects: [
        {
          package: { name: "@vendor/parser", version: "1.2.3", date: "2025-06-07", license: "ISC" },
        },
      ],
    });
  };
  const r = await researchPublic(query, { fetchImpl });
  assert.equal(calls.length, 3);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.results.length, 3);
  assert.equal(r.results[0].releasesUrl, "https://github.com/vendor/parser/releases");
  assert.equal(r.results[0].version, null);
  assert.equal(r.results[0].license, "MIT");
  assert.equal(r.results[1].acceptedAnswerUrl, "https://stackoverflow.com/a/42");
  assert.equal(r.results[1].updatedAt, new Date(100000).toISOString());
  assert.equal(r.results[2].url, "https://www.npmjs.com/package/@vendor/parser");
  assert.equal(r.results[2].version, "1.2.3");
  assert.ok(Number.isFinite(Date.parse(r.checkedAt)));
});

test("one failed provider and one over-large body leave bounded results from a third", async () => {
  const fetchImpl = async (url) => {
    if (url.hostname === "api.github.com") return new Response(null, { status: 429 });
    if (url.hostname === "api.stackexchange.com") return new Response(" ".repeat(520 * 1024));
    assert.equal(url.searchParams.get("size"), "5");
    return ok({
      objects: Array.from({ length: 12 }, (_, i) => ({ package: { name: `lib-${i}` } })),
    });
  };
  const r = await researchPublic("public csv parsers", { fetchImpl, limit: 1000 });
  assert.equal(r.results.length, 5);
  assert.ok(r.warnings.some((w) => w.includes("HTTP 429")));
  assert.ok(r.warnings.some((w) => w.includes("size limit")));
});

test("empty, multiline, oversized or secret-looking queries issue zero requests", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return ok({});
  };
  for (const query of ["", "multi\nline", "long".repeat(55), "password=example-password"]) {
    const r = await researchPublic(query, { fetchImpl });
    assert.deepEqual(r.results, []);
    assert.equal(r.warnings.length, 1);
  }
  assert.equal(calls, 0);
});

test("service-requested cooldown suppresses only that provider across subsequent queries", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.hostname);
    if (url.hostname === "api.stackexchange.com") return ok({ items: [], backoff: 10 });
    if (url.hostname === "api.github.com") return ok({ items: [] });
    return ok({ objects: [] });
  };
  const first = await researchPublic("alpha", { fetchImpl });
  const second = await researchPublic("beta", { fetchImpl });
  assert.equal(calls.filter((host) => host === "api.stackexchange.com").length, 1);
  assert.equal(calls.filter((host) => host === "api.github.com").length, 2);
  assert.ok(first.warnings[0].includes("wait 10 seconds"));
  assert.match(second.warnings[0], /Stack Overflow: retry after \d+ seconds/);
});

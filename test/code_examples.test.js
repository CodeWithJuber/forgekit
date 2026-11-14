import assert from "node:assert/strict";
import { test } from "node:test";
import { findCodeExamples } from "../src/code_examples.js";

const sha = `${"123abc".repeat(6)}9870`;
const repo = {
  provider: "GitHub",
  title: "org/retries",
  url: "https://github.com/org/retries",
  license: "UNVERIFIED",
};
const so = {
  provider: "Stack Overflow",
  title: "How to retry?",
  acceptedAnswerUrl: "https://stackoverflow.com/a/42",
  license: "UNVERIFIED",
};
const fence = "`".repeat(3);
const readme = (contents) => ({
  encoding: "base64",
  path: "README.md",
  size: Buffer.byteLength(contents),
  content: Buffer.from(contents).toString("base64"),
});
function transport(calls, licensed = true) {
  return async (url, req) => {
    url = String(url);
    calls.push(url);
    assert.equal(req.redirect, "error");
    assert.equal(req.credentials, "omit");
    assert.equal(req.headers.Authorization, undefined);
    if (url.includes("/commits?")) return Response.json([{ sha }]);
    if (url.includes("/readme?"))
      return Response.json(
        readme(
          [
            "# Getting started",
            "",
            `${fence}sh`,
            "npm install retries",
            fence,
            "",
            "Try a retry loop",
            `${fence}js`,
            "const retry = await createRetry();",
            "await retry.run(task);",
            fence,
          ].join("\n"),
        ),
      );
    if (url.includes("/license?"))
      return licensed
        ? Response.json({ license: { spdx_id: "MIT" }, path: "LICENSE" })
        : new Response(null, { status: 404 });
    if (url.includes("/answers/42"))
      return Response.json({
        items: [
          {
            answer_id: 42,
            is_accepted: true,
            content_license: licensed ? "CC BY-SA 3.0" : undefined,
            owner: { display_name: "A&amp;B" },
            body: "<p>Try:</p><pre><code>if (n &lt; retries) retry();\n</code></pre>",
          },
        ],
      });
    throw new Error("unexpected URL");
  };
}
test("fetches pinned GitHub usage code and attributed accepted answer, with authentic upstream licenses", async () => {
  const calls = [];
  const out = await findCodeExamples("retry", {
    repositories: [repo, so],
    fetchImpl: transport(calls),
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(out.warnings, []);
  assert.equal(
    out.results[0].snippet,
    "const retry = await createRetry();\nawait retry.run(task);",
  );
  assert.equal(out.results[0].url, `https://github.com/org/retries/blob/${sha}/README.md#L9-L10`);
  assert.equal(out.results[0].licenseUrl, `https://github.com/org/retries/blob/${sha}/LICENSE`);
  assert.equal(out.results[0].license, "MIT");
  assert.equal(out.results[1].author, "A&B");
  assert.equal(out.results[1].snippet.trim(), "if (n < retries) retry();");
  assert.equal(out.results[1].license, "CC BY-SA 3.0");
  assert.equal(new URL(out.manualGoogleUrl).hostname, "www.google.com");
  assert.deepEqual(
    new Set(calls.map((url) => new URL(url).hostname)),
    new Set(["api.github.com", "api.stackexchange.com"]),
  );
});
test("missing source license returns links only, ignoring unverified discovery licenses", async () => {
  const out = await findCodeExamples("retry", {
    repositories: [repo, so],
    fetchImpl: transport([], false),
  });
  assert.ok(out.results.every((row) => row.snippet === null && row.license === null));
  assert.equal(out.results.length, 2);
});
test("untrusted URLs, secret query, oversized response and invalid revision do not leak inputs", async () => {
  let count = 0;
  const get = async () => {
    count++;
    return new Response(" ".repeat(301 * 1024));
  };
  await findCodeExamples("password=secret", { repositories: [repo], fetchImpl: get });
  await findCodeExamples("retry", {
    repositories: [
      { ...repo, url: "https://github.com.evil.test/org/retries" },
      { ...so, acceptedAnswerUrl: "http://localhost:888/admin" },
    ],
    fetchImpl: get,
  });
  assert.equal(count, 0);
  const out = await findCodeExamples("retry", { repositories: [repo], fetchImpl: get });
  assert.deepEqual(out.results, []);
  assert.match(out.warnings[0], /size limit/);
  assert.equal(count, 1);
  const invalid = await findCodeExamples("retry", {
    repositories: [repo],
    fetchImpl: async () => Response.json([{ sha: "../../other" }]),
  });
  assert.equal(invalid.results.length, 0);
  assert.match(invalid.warnings[0], /missing revision/);
});
test("one provider can still return a candidate when another fails", async () => {
  const live = transport([]);
  const out = await findCodeExamples("retry", {
    repositories: [so, repo],
    fetchImpl: async (url, opts) =>
      new URL(String(url)).hostname === "api.github.com"
        ? new Response(null, { status: 429 })
        : live(url, opts),
  });
  assert.equal(out.results[0].provider, "Stack Overflow");
  assert.match(out.warnings[0], /HTTP 429/);
});

test("reStructuredText examples preserve pinned file line numbers and indentation", async () => {
  const get = transport([]);
  const out = await findCodeExamples("retry", {
    repositories: [repo],
    fetchImpl: async (url, opts) => {
      if (String(url).includes("/readme?"))
        return Response.json({
          ...readme(
            "Quick start\n\n.. code-block:: python\n   :linenos:\n\n   from retries import retry\n   retry(task)\n\nNext heading\n",
          ),
          path: "README.rst",
        });
      return get(url, opts);
    },
  });
  assert.equal(out.results[0].line, 6);
  assert.match(out.results[0].snippet, /^ {3}from retries import retry\n {3}retry\(task\)/);
});

test("raw nested markup inside an answer never becomes a source excerpt", async () => {
  const out = await findCodeExamples("retry", {
    repositories: [so],
    fetchImpl: async () =>
      Response.json({
        items: [
          {
            answer_id: 42,
            is_accepted: true,
            content_license: "CC BY-SA 4.0",
            owner: { display_name: "Author" },
            body: "<pre><code>&lt;s<b>cr</b>ipt&gt; retry();</code></pre>",
          },
        ],
      }),
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].snippet, null);
});

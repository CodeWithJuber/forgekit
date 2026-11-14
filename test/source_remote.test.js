import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import {
  fetchRemoteRecord,
  fetchRemoteSource,
  remoteScope,
  routeSource,
} from "../src/source_remote.js";

const env = { ACCESS: "test-token", LOGIN: "me@example.org" };
const jira = {
  provider: "jira",
  deployment: "cloud",
  baseUrl: "https://team.example",
  project: "TEAM",
  tokenEnv: "ACCESS",
  emailEnv: "LOGIN",
};
const confluence = {
  provider: "confluence",
  deployment: "self-hosted",
  baseUrl: "https://team.example/docs",
  space: "ENG",
  tokenEnv: "ACCESS",
};
const gitlab = {
  provider: "gitlab",
  deployment: "cloud",
  baseUrl: "https://git.example",
  project: "group/dept/repo",
  tokenEnv: "ACCESS",
};
const issue = (key, id = key) => ({
  id,
  key,
  fields: {
    summary: "Refresh",
    description: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Use " },
            { type: "text", text: "cursors" },
          ],
        },
      ],
    },
    status: { name: "Open" },
    updated: "2026-11-12T03:00:00Z",
  },
});
const page = (id) => ({
  id,
  title: "Refresh guide",
  body: { storage: { value: "<p>First &amp; second</p>" } },
  version: { when: "2026-11-12T03:00:00Z" },
});
const item = (id) => ({
  id,
  iid: id,
  title: "Refresh",
  description: "Across pages",
  state: "opened",
  web_url: `https://git.example/group/dept/repo/-/issues/${id}`,
});
function responses(pages) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (input, options) => {
      calls.push({ url: new URL(input), options });
      assert.ok(pages.length, "unexpected fetch");
      const [body, init] = pages.shift();
      return Response.json(body, init);
    },
  };
}

test("routing keeps reads offline and chooses the available live transport for freshness and writes", () => {
  assert.equal(routeSource({ cacheAvailable: true, mcpAvailable: true }), "cache");
  assert.equal(routeSource({ cacheAvailable: true, fresh: true, mcpAvailable: true }), "mcp");
  assert.equal(routeSource({ operation: "write", cacheAvailable: true }), "api");
  assert.equal(routeSource({ operation: "bulk", mcpAvailable: true }), "api");
  assert.throws(() => routeSource({ operation: "unexpected" }));
});

test("credentials, site, project/space, resource and deployment isolate remote caches", () => {
  const key = remoteScope(gitlab, env);
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const variant of [
    { ...gitlab, project: "other" },
    { ...gitlab, resource: "merge_requests" },
    { ...gitlab, baseUrl: "https://other.example" },
    { ...gitlab, deployment: "self-hosted" },
  ])
    assert.notEqual(key, remoteScope(variant, env));
  assert.notEqual(key, remoteScope(gitlab, { ...env, ACCESS: "rotated" }));
  assert.notEqual(
    remoteScope(jira, env),
    remoteScope(jira, { ...env, LOGIN: "other@example.org" }),
  );
  assert.throws(() => remoteScope(gitlab, {}), /Missing credential/);
  for (const baseUrl of [
    "file:///tmp/a",
    "http://external.example",
    "https://user:secret@example.org",
    "https://example.org/?token=s",
  ])
    assert.throws(() => remoteScope({ ...gitlab, baseUrl }, env));
  assert.throws(() => remoteScope({ ...jira, project: "" }, env), /project/);
});

test("Jira Cloud follows enhanced JQL continuation, normalizes ADF, and deduplicates IDs", async () => {
  const http = responses([
    [{ issues: [issue("TEAM-1", "10")], nextPageToken: "opaque/+" }],
    [{ issues: [issue("TEAM-1", "10"), issue("TEAM-2", "20")], isLast: true }],
  ]);
  const result = await fetchRemoteSource(jira, { ...http, env });
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].text, "Open\nUse cursors");
  assert.equal(result.documents[0].url, "https://team.example/browse/TEAM-1");
  assert.ok(Number.isFinite(Date.parse(result.checkpoint)));
  assert.equal(result.mode, "full");
  assert.equal(http.calls[0].url.pathname, "/rest/api/3/search/jql");
  assert.equal(http.calls[0].url.searchParams.get("jql"), 'project = "TEAM" ORDER BY key ASC');
  assert.equal(http.calls[1].url.searchParams.get("nextPageToken"), "opaque/+");
  assert.equal(
    http.calls[0].options.headers.Authorization,
    `Basic ${Buffer.from("me@example.org:test-token").toString("base64")}`,
  );
});

test("Jira Data Center preserves context path, uses offset and bearer PAT", async () => {
  const http = responses([
    [{ issues: [issue("T-1")], startAt: 0, total: 2 }],
    [{ issues: [issue("T-2")], startAt: 1, total: 2 }],
  ]);
  const result = await fetchRemoteSource(
    { ...jira, baseUrl: "https://team.example/jira/", deployment: "self-hosted" },
    { ...http, env },
  );
  assert.equal(result.documents[1].url, "https://team.example/jira/browse/T-2");
  assert.equal(http.calls[1].url.pathname, "/jira/rest/api/2/search");
  assert.equal(http.calls[1].url.searchParams.get("startAt"), "1");
  assert.equal(http.calls[0].options.headers.Authorization, "Bearer test-token");
});

test("Confluence Cloud and Data Center retain the configured origin/path and extract the requested body", async () => {
  for (const [deployment, param] of [
    ["cloud", "cursor"],
    ["self-hosted", "start"],
  ]) {
    const http = responses([
      [{ results: [page("2")], _links: { next: `https://untrusted.example/a?${param}=abc` } }],
      [{ results: [page("3")], _links: {} }],
    ]);
    const result = await fetchRemoteSource(
      { ...confluence, deployment, emailEnv: "LOGIN" },
      { ...http, env },
    );
    assert.equal(result.documents[0].text, "First & second");
    assert.equal(
      result.documents[1].url,
      "https://team.example/docs/pages/viewpage.action?pageId=3",
    );
    assert.equal(http.calls[1].url.origin, "https://team.example");
    assert.equal(http.calls[1].url.pathname, "/docs/rest/api/content/search");
    assert.equal(http.calls[1].url.searchParams.get(param), "abc");
    assert.match(http.calls[1].url.searchParams.get("cql"), /space = "ENG"/);
  }
});

test("GitLab cloud issues and self-managed merge requests use the scoped v4 collection and page headers", async () => {
  for (const [deployment, resource] of [
    ["cloud", "issues"],
    ["self-hosted", "merge_requests"],
  ]) {
    const http = responses([
      [[item(1)], { headers: { link: '<https://foreign.example/?page=2>; rel="next"' } }],
      [[item(2)], { headers: { "x-next-page": "" } }],
    ]);
    const result = await fetchRemoteSource({ ...gitlab, deployment, resource }, { ...http, env });
    assert.equal(result.documents[0].title, resource === "issues" ? "#1 Refresh" : "!1 Refresh");
    assert.equal(http.calls[0].url.pathname, `/api/v4/projects/group%2Fdept%2Frepo/${resource}`);
    assert.equal(http.calls[1].url.hostname, "git.example");
    assert.equal(http.calls[1].url.searchParams.get("page"), "2");
    assert.equal(http.calls[1].options.headers["PRIVATE-TOKEN"], "test-token");
  }
});

test("partial, unauthorised, repeated, oversized and malformed results cannot replace a mirror", async () => {
  for (const [source, pages, reason, maxPages] of [
    [jira, [[{ issues: [], nextPageToken: "more" }]], /limit reached/, 1],
    [
      jira,
      [[{ issues: [], nextPageToken: "more" }], [{ issues: [], nextPageToken: "more" }]],
      /repeated a page/,
    ],
    [jira, [[{ issues: [], isLast: false }]], /completion marker/],
    [confluence, [[{ results: [{ id: "1", title: "Hidden body" }] }]], /expanded page body/],
    [
      gitlab,
      [[{ error: "details with private text" }, { status: 403 }]],
      /^Error: Source returned HTTP 403$/,
    ],
    [gitlab, [[{}, { status: 429, headers: { "retry-after": "60" } }]], /429 \(retry in 60s\)/],
    [gitlab, [[[item(1), { ...item(2), description: "x".repeat(9 * 1024 * 1024) }]]], /size limit/],
  ]) {
    const http = responses(pages);
    await assert.rejects(fetchRemoteSource(source, { ...http, env, maxPages }), reason);
  }
});

test("real HTTP traversal reads a loopback instance and refuses authenticated redirects", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes("redirect")) {
      res.writeHead(302, { location: "/unexpected" });
      res.end();
      return;
    }
    assert.equal(req.headers["private-token"], env.ACCESS);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([item(10)]));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/services`;
  const result = await fetchRemoteSource({ ...gitlab, baseUrl }, { env });
  assert.equal(result.documents[0].url, `${baseUrl}/group/dept/repo/-/issues/10`);
  await assert.rejects(fetchRemoteSource({ ...gitlab, project: "redirect", baseUrl }, { env }));
  assert.equal(seen.length, 2);
});

test("fresh Jira read accepts an ID or key and checks the issue's project before returning its text", async () => {
  const row = issue("TEAM-2", "99");
  row.fields.project = { id: "12", key: "TEAM" };
  for (const [deployment, id] of [
    ["cloud", "TEAM-2"],
    ["self-hosted", "99"],
  ]) {
    const http = responses([[row]]);
    const result = await fetchRemoteRecord({ ...jira, deployment }, id, { ...http, env });
    assert.equal(result.recordId, "TEAM-2");
    assert.equal(result.id, "99");
    assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
    assert.equal(http.calls.length, 1);
    assert.equal(
      http.calls[0].url.pathname,
      `/rest/api/${deployment === "cloud" ? "3" : "2"}/issue/${id}`,
    );
  }
  const other = responses([[row]]);
  await assert.rejects(
    fetchRemoteRecord({ ...jira, project: "OTHER" }, "99", { ...other, env }),
    /unavailable in configured source/,
  );
});

test("fresh Confluence read restricts page by space and ID in a single GET", async () => {
  for (const deployment of ["cloud", "self-hosted"]) {
    const http = responses([[{ results: [{ ...page("30"), space: { key: "ENG" } }] }]]);
    const result = await fetchRemoteRecord({ ...confluence, deployment, emailEnv: "LOGIN" }, 30, {
      ...http,
      env,
    });
    assert.equal(result.recordId, "30");
    assert.equal(http.calls.length, 1);
    assert.equal(
      http.calls[0].url.searchParams.get("cql"),
      'type = page AND space = "ENG" AND id = 30',
    );
  }
  await assert.rejects(
    fetchRemoteRecord(confluence, "30", {
      ...responses([[{ results: [{ ...page("30"), space: { key: "OTHER" } }] }]]),
      env,
    }),
    /unavailable/,
  );
});

test("fresh GitLab read uses project-local IID and cannot escape configured project or collection", async () => {
  const row = { ...item(5), id: 90, project_id: 20 };
  const http = responses([[row], [row]]);
  const result = await fetchRemoteRecord(gitlab, 5, { ...http, env });
  assert.equal(result.id, "90");
  assert.equal(result.recordId, "5");
  assert.equal(http.calls[0].url.pathname, "/api/v4/projects/group%2Fdept%2Frepo/issues/5");
  await assert.rejects(
    fetchRemoteRecord({ ...gitlab, project: "500" }, "5", { ...http, env }),
    /unavailable/,
  );
  for (const bad of ["../../projects/other/5", "#5", "1?token=x", 0.4]) {
    await assert.rejects(fetchRemoteRecord(gitlab, bad, { ...http, env }), /Invalid record ID/);
  }
  assert.equal(http.calls.length, 2);
});

test("Confluence storage retains literal code inside CDATA and GitLab rejects dot segments", async () => {
  const row = page("1");
  row.body.storage.value =
    "<p>Example:</p><ac:plain-text-body><![CDATA[<b>\n  example &amp; source\n</b>]]></ac:plain-text-body>";
  const http = responses([[{ results: [row] }]]);
  const r = await fetchRemoteSource(confluence, { ...http, env });
  assert.ok(r.documents[0].text.includes("<b>\n  example &amp; source\n</b>"));
  for (const project of ["..", "group/../project", "group%2F..%2Fprivate"]) {
    assert.throws(() => remoteScope({ ...gitlab, project }, env), /GitLab numeric project/);
  }
});

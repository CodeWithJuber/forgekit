// The generic rules behind runtime model resolution: family membership, "newest", catalog
// normalization, pagination, cross-catalog id matching and per-token → per-million prices.
// Every catalog here is a stub — nothing is fetched.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anthropicSource,
  canonicalKey,
  catalogSource,
  fetchCatalog,
  inFamily,
  matchCatalogModel,
  newestInFamily,
  normalizeCatalogPage,
  openRouterSource,
  perMillion,
} from "../src/model_catalog.js";
import { anthropicPage, ok, stubTransport } from "./_catalog_stub.js";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "forge-catalog-"));

test("perMillion converts OpenRouter's per-token strings without float noise", () => {
  assert.equal(perMillion("0.000003"), 3);
  assert.equal(perMillion("0.000015"), 15);
  assert.equal(perMillion("0.0000008"), 0.8);
  assert.equal(perMillion("0.00000125"), 1.25);
  assert.equal(perMillion("3e-6"), 3);
  assert.equal(perMillion(0.000075), 75);
  assert.equal(perMillion("0"), 0, "a free model is priced at 0, not unpriced");
  for (const bad of ["-1", "", null, undefined, "n/a"])
    assert.equal(perMillion(bad), null, `${bad}`);
});

test("normalizeCatalogPage reads Anthropic, OpenAI-style, OpenRouter and bare-array shapes", () => {
  const a = normalizeCatalogPage(
    anthropicPage([["claude-x-1", "2026-01-02T00:00:00Z", "Claude X 1"]], { hasMore: true }),
  );
  assert.deepEqual(a, {
    models: [
      { id: "claude-x-1", displayName: "Claude X 1", createdAt: "2026-01-02T00:00:00.000Z" },
    ],
    next: "claude-x-1",
  });
  const oai = normalizeCatalogPage({ object: "list", data: [{ id: "m", created: 1_767_225_600 }] });
  assert.equal(oai.models[0].createdAt, "2026-01-01T00:00:00.000Z", "unix seconds");
  assert.equal(oai.next, null);
  const or = normalizeCatalogPage({
    data: [{ id: "v/m", name: "V: M", pricing: { prompt: "0.000001", completion: "0.000005" } }],
  });
  assert.deepEqual(or.models[0], { id: "v/m", displayName: "V: M", inCost: 1, outCost: 5 });
  assert.deepEqual(normalizeCatalogPage(["a", "", 7, "b"]).models, [{ id: "a" }, { id: "b" }]);
  assert.equal(normalizeCatalogPage({ error: "nope" }), null, "not a catalog");
});

test("family membership is a whole-token match on id or display name — no id list", () => {
  assert.ok(inFamily({ id: "claude-opus-4-8" }, "opus"));
  assert.ok(inFamily({ id: "anthropic/claude-3.5-sonnet" }, "sonnet"));
  assert.ok(inFamily({ id: "vendor-model-9", displayName: "Claude Haiku 9" }, "haiku"));
  assert.ok(
    inFamily({ id: "any-new-vendor-name-opus-v12" }, "opus"),
    "a never-seen id still matches",
  );
  assert.ok(!inFamily({ id: "octopus-large" }, "opus"), "substring is not membership");
  assert.ok(!inFamily({ id: "claude-opus4" }, "opus"), "the family word must stand alone");
  assert.ok(!inFamily({ id: "claude-mythos-5-1" }, "fable"));
});

test("newest is the catalog's created_at — not list order, not the version number", () => {
  const models = [
    { id: "claude-opus-4-8", createdAt: "2026-05-01T00:00:00Z" },
    { id: "claude-opus-5", createdAt: "2026-08-01T00:00:00Z" },
    { id: "claude-opus-4-9-preview", createdAt: "2026-07-01T00:00:00Z" },
    { id: "claude-sonnet-9", createdAt: "2027-01-01T00:00:00Z" },
  ];
  assert.equal(newestInFamily(models, "opus").id, "claude-opus-5");
  // A later point release of an older generation IS newer by the catalog's own clock.
  const patch = [...models, { id: "claude-opus-4-8-1", createdAt: "2026-09-01T00:00:00Z" }];
  assert.equal(newestInFamily(patch, "opus").id, "claude-opus-4-8-1");
  assert.equal(newestInFamily(models, "haiku"), null);
});

test("an epoch created_at means 'release date unknown', not 'oldest model'", () => {
  // The Models API docs: created_at "may be set to an epoch value if the release date is
  // unknown". A new model listed that way must still win on version against older dated ones.
  const models = [
    { id: "claude-opus-5", createdAt: "2026-07-24T00:00:00Z" },
    { id: "claude-opus-5-5", createdAt: "1970-01-01T00:00:00Z" },
  ];
  assert.equal(newestInFamily(models, "opus").id, "claude-opus-5-5");
  // Same version: the dated row beats the undated one.
  const sameVersion = [
    { id: "claude-opus-5", createdAt: "1970-01-01T00:00:00Z" },
    { id: "claude-opus-5-20260724", createdAt: "2026-07-24T00:00:00Z" },
  ];
  assert.equal(newestInFamily(sameVersion, "opus").id, "claude-opus-5-20260724");
});

test("undated catalogs (gateways) fall back to version, then snapshot date, then the plainest id", () => {
  assert.equal(
    newestInFamily([{ id: "claude-3-5-sonnet-20241022" }, { id: "claude-sonnet-4-5" }], "sonnet")
      .id,
    "claude-sonnet-4-5",
  );
  assert.equal(
    newestInFamily(
      [{ id: "claude-3-5-sonnet-20240620" }, { id: "claude-3-5-sonnet-20241022" }],
      "sonnet",
    ).id,
    "claude-3-5-sonnet-20241022",
    "same version: the later snapshot stamp wins",
  );
  assert.equal(
    newestInFamily([{ id: "vendor-prod-sonnet-5-preview" }, { id: "claude-sonnet-5" }], "sonnet")
      .id,
    "claude-sonnet-5",
  );
});

test("a namespace restricts a multi-vendor catalog; a :variant yields to its base id", () => {
  const models = [
    { id: "anthropic/claude-sonnet-5", createdAt: "2026-06-01T00:00:00Z" },
    { id: "anthropic/claude-sonnet-5:thinking", createdAt: "2026-06-02T00:00:00Z" },
    { id: "othervendor/sonnet-remix", createdAt: "2026-09-01T00:00:00Z" },
  ];
  assert.equal(
    newestInFamily(models, "sonnet", { namespace: "anthropic" }).id,
    "anthropic/claude-sonnet-5",
  );
  assert.equal(newestInFamily(models, "sonnet").id, "othervendor/sonnet-remix");
});

test("ids match across catalogs by canonical tokens (separators, namespace, snapshot date)", () => {
  assert.equal(canonicalKey("claude-opus-4-8"), canonicalKey("anthropic/claude-opus-4.8"));
  assert.equal(
    canonicalKey("claude-haiku-4-5-20251001"),
    canonicalKey("anthropic/claude-haiku-4.5"),
  );
  assert.equal(
    canonicalKey("claude-3-5-sonnet-20241022"),
    canonicalKey("anthropic/claude-3.5-sonnet"),
  );
  assert.notEqual(canonicalKey("claude-sonnet-4-5"), canonicalKey("claude-sonnet-4"));
  assert.notEqual(canonicalKey("claude-3.7-sonnet"), canonicalKey("claude-3.7-sonnet:thinking"));
  const rows = [
    { id: "anthropic/claude-3.7-sonnet:thinking" },
    { id: "anthropic/claude-3.7-sonnet" },
    { id: "anthropic/claude-opus-4.8" },
  ];
  assert.equal(
    matchCatalogModel("claude-3-7-sonnet-20250219", rows).id,
    "anthropic/claude-3.7-sonnet",
  );
  assert.equal(matchCatalogModel("claude-opus-4-8", rows).id, "anthropic/claude-opus-4.8");
  assert.equal(matchCatalogModel("claude-opus-5", rows), null, "no guess for an unlisted id");
});

test("catalogSource: env-derived like llm.js, provider-aware when given one", () => {
  assert.equal(catalogSource({ env: {} }).kind, null, "no key → no catalog");
  const direct = catalogSource({ env: { ANTHROPIC_API_KEY: "sk-a" } });
  assert.equal(direct.kind, "anthropic");
  assert.equal(direct.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.deepEqual(direct.headers, { "x-api-key": "sk-a", "anthropic-version": "2023-06-01" });
  assert.equal(
    catalogSource({ env: { ANTHROPIC_AUTH_TOKEN: "t" } }).kind,
    null,
    "the Models API is only asked with an API key",
  );
  const gw = catalogSource({
    env: { ANTHROPIC_BASE_URL: "http://gw:4000/", LITELLM_API_KEY: "k" },
  });
  assert.equal(gw.kind, "gateway");
  assert.equal(gw.url, "http://gw:4000/v1/models");
  assert.equal(gw.headers.authorization, "Bearer k");
  assert.equal(
    catalogSource({
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com/", ANTHROPIC_API_KEY: "a" },
    }).kind,
    "anthropic",
    "the default base URL is direct Anthropic, not a gateway",
  );
  const or = catalogSource({
    provider: { type: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
    env: {},
  });
  assert.deepEqual(or, openRouterSource());
  assert.equal(
    catalogSource({ provider: { name: "openai", format: "openai" }, env: {} }).kind,
    null,
  );
  assert.equal(
    catalogSource({ provider: { type: "litellm", baseUrl: "http://localhost:4000" }, env: {} })
      .kind,
    "gateway",
  );
});

test("fetchCatalog follows has_more/last_id with after_id and persists each page", () => {
  const root = tmpRoot();
  const page1 = anthropicPage(
    [
      ["claude-a-2", "2026-02-01T00:00:00Z"],
      ["claude-a-1", "2026-01-01T00:00:00Z"],
    ],
    { hasMore: true },
  );
  const page2 = anthropicPage([["claude-b-1", "2025-01-01T00:00:00Z"]]);
  const { fetchImpl, calls } = stubTransport({
    after_id: (req) => (req.url.includes("after_id=claude-a-1") ? ok(page2) : null),
    "/v1/models": ok(page1),
  });
  const cat = fetchCatalog(anthropicSource("sk"), { root, fetchImpl });
  assert.deepEqual(
    cat.models.map((m) => m.id),
    ["claude-a-2", "claude-a-1", "claude-b-1"],
  );
  assert.equal(cat.pages, 2);
  assert.match(calls[1].url, /limit=1000&after_id=claude-a-1$/);
  assert.equal(calls[0].headers["x-api-key"], "sk");
  // Both pages were persisted: offline, the whole catalog still comes back (marked stale).
  const offline = fetchCatalog(anthropicSource("sk"), { root, fetchImpl: () => null });
  assert.equal(offline.models.length, 3);
  assert.equal(offline.cache, "stale");

  // A page that cannot be fetched (and was never cached) makes the whole catalog unavailable.
  const broken = stubTransport({ after_id: null, "/v1/models": ok(page1) });
  assert.equal(
    fetchCatalog(anthropicSource("sk"), { root: tmpRoot(), fetchImpl: broken.fetchImpl }),
    null,
  );

  // A server that repeats the same cursor forever is stopped, not followed.
  const loop = stubTransport({ "/v1/models": ok(page1) });
  const looped = fetchCatalog(anthropicSource("sk"), { root: null, fetchImpl: loop.fetchImpl });
  assert.equal(looped.models.length, 2);
  assert.ok(loop.calls.length <= 2);
});

test("normalizeCatalogPage drops rows whose id is not a plausible model id", () => {
  // Catalog ids reach generated routing config and model calls, so an id that is not
  // id-shaped (whitespace, control characters) is dropped at the boundary, not sanitized later.
  const page = anthropicPage([
    ["claude-opus-5", "2026-08-01T00:00:00Z", "Claude Opus 5"],
    ["claude opus with spaces", "2026-08-02T00:00:00Z", "spaces"],
    ["anthropic/claude-opus-5:batch", "2026-08-01T00:00:00Z", "a :variant id is fine"],
  ]);
  page.data.push({ type: "model", id: `x${String.fromCharCode(10)}y`, created_at: "2026-08-03" });
  const { models } = /** @type {{models: any[]}} */ (normalizeCatalogPage(page));
  assert.deepEqual(
    models.map((m) => m.id),
    ["claude-opus-5", "anthropic/claude-opus-5:batch"],
  );
  // A display name is shown to a person, so it is kept — as one printable line.
  const noisy = `Two${String.fromCharCode(10)}lines${String.fromCharCode(7)}here`;
  const named = normalizeCatalogPage(anthropicPage([["m-1", "2026-08-01T00:00:00Z", noisy]]));
  assert.equal(named?.models[0].displayName, "Two lines here");
});

test("fetchCatalog reports when its answer expires (the memo uses it, no invented TTL)", () => {
  const T = 1_800_000_000_000;
  const withMaxAge = stubTransport({
    "api.anthropic.com": ok(anthropicPage([["claude-opus-5", "2026-08-01T00:00:00Z"]]), {
      "cache-control": "max-age=120",
    }),
  });
  const a = fetchCatalog(anthropicSource("sk-a"), { fetchImpl: withMaxAge.fetchImpl, now: T });
  assert.equal(a?.freshUntil, T + 120_000, "expiry comes from the response's own max-age");
  const noHeaders = stubTransport({
    "api.anthropic.com": ok(anthropicPage([["claude-opus-5", "2026-08-01T00:00:00Z"]])),
  });
  const b = fetchCatalog(anthropicSource("sk-a"), { fetchImpl: noHeaders.fetchImpl, now: T });
  assert.equal(b?.freshUntil, T, "no freshness stated → revalidate on the next use");
});

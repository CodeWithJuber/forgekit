import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allPricePairs,
  describeResolution,
  MODELS,
  priceOf,
  resolveModelPrice,
  resolveTierModel,
  resolveTierPrice,
  resolveTiers,
  TIER_ORDER,
} from "../src/model_tiers.js";
import { anthropicPage, ok, openRouterBody, stubTransport } from "./_catalog_stub.js";

// A synthetic table, so the window logic stays tested whether or not a real model currently
// carries a schedule.
const SCHEDULED = {
  intro: {
    inCost: 3,
    outCost: 15,
    prices: [
      { effectiveFrom: "2026-06-30", effectiveUntil: "2026-08-31", inCost: 2, outCost: 10 },
      { effectiveFrom: "2026-09-01", inCost: 3, outCost: 15 },
    ],
  },
  flat: { inCost: 1, outCost: 5 },
};

test("priceOf resolves the active pricing window by date (P0-12)", () => {
  assert.deepEqual(priceOf("intro", "2026-07-17", SCHEDULED), { inCost: 2, outCost: 10 });
  assert.deepEqual(
    priceOf("intro", "2026-08-31", SCHEDULED),
    { inCost: 2, outCost: 10 },
    "boundary",
  );
  assert.deepEqual(priceOf("intro", "2026-09-01", SCHEDULED), { inCost: 3, outCost: 15 });
  assert.deepEqual(
    priceOf("intro", "2026-06-01", SCHEDULED),
    { inCost: 3, outCost: 15 },
    "before any window → flat",
  );
});

test("priceOf falls back to flat cost for a model with no schedule", () => {
  assert.deepEqual(priceOf("haiku", "2026-07-17"), { inCost: 1, outCost: 5 });
  assert.deepEqual(priceOf("flat", "2026-07-17", SCHEDULED), { inCost: 1, outCost: 5 });
  assert.equal(priceOf("nope"), null);
});

// Anthropic made Sonnet 5's launch price of $2/$10 the standard price; the increase to $3/$15
// scheduled for 2026-09-01 was cancelled (platform.claude.com pricing page, checked 2026-09-22).
test("Sonnet 5 stays at $2/$10 after 2026-09-01 (the scheduled increase was cancelled)", () => {
  assert.deepEqual(priceOf("sonnet", "2026-07-17"), { inCost: 2, outCost: 10 });
  assert.deepEqual(priceOf("sonnet", "2026-09-22"), { inCost: 2, outCost: 10 });
});

test("allPricePairs includes both scheduled and flat prices", () => {
  const has = (pairs, i, o) => pairs.some((p) => p.inCost === i && p.outCost === o);
  const synthetic = allPricePairs(SCHEDULED);
  assert.ok(has(synthetic, 2, 10), "a scheduled window's price is included");
  assert.ok(has(synthetic, 3, 15), "the flat price is included");
  const real = allPricePairs();
  assert.ok(has(real, 1, 5), "haiku flat price present");
  assert.ok(has(real, 2, 10), "sonnet price present");
});

// ---------------------------------------------------------------------------
// Runtime resolution — a tier names a FAMILY; the id and price come from live catalogs.
// Every catalog below is a stub transport: no test touches the network.
// ---------------------------------------------------------------------------

const KEY_ENV = { ANTHROPIC_API_KEY: "sk-ant-test" };
const tmpRoot = () => mkdtempSync(join(tmpdir(), "forge-tiers-"));
const ANTHROPIC_TODAY = anthropicPage([
  ["claude-sonnet-5", "2026-06-01T00:00:00Z", "Claude Sonnet 5"],
  ["claude-opus-4-8", "2026-05-01T00:00:00Z", "Claude Opus 4.8"],
  ["claude-haiku-4-5-20251001", "2025-10-01T00:00:00Z", "Claude Haiku 4.5"],
  ["claude-3-opus-20240229", "2024-02-29T00:00:00Z", "Claude 3 Opus"],
]);

test("resolveTierModel: the newest family member in the live catalog, no code or data change", () => {
  const today = stubTransport({ "api.anthropic.com": ok(ANTHROPIC_TODAY) });
  const before = resolveTierModel("opus", {
    env: KEY_ENV,
    root: tmpRoot(),
    fetchImpl: today.fetchImpl,
  });
  assert.equal(before.id, "claude-opus-4-8");
  assert.equal(before.source, "catalog");
  assert.equal(before.createdAt, "2026-05-01T00:00:00.000Z");

  // Anthropic ships a new Opus. Same code, same model_tiers.json — the catalog alone moves the tier.
  const release = anthropicPage([
    ["claude-opus-5", "2026-08-01T00:00:00Z", "Claude Opus 5"],
    ...ANTHROPIC_TODAY.data.map((m) => [m.id, m.created_at, m.display_name]),
  ]);
  const tomorrow = stubTransport({ "api.anthropic.com": ok(release) });
  const after = resolveTierModel("opus", {
    env: KEY_ENV,
    root: tmpRoot(),
    fetchImpl: tomorrow.fetchImpl,
  });
  assert.equal(after.id, "claude-opus-5");
  assert.equal(after.displayName, "Claude Opus 5");
  assert.equal(MODELS.opus.id, "claude-opus-4-8", "the snapshot is untouched");
  // The other families are unaffected by an Opus release.
  const sonnet = resolveTierModel("sonnet", { env: KEY_ENV, fetchImpl: tomorrow.fetchImpl });
  assert.equal(sonnet.id, "claude-sonnet-5");
  // The request is the documented Models API call.
  assert.equal(today.calls[0].url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(today.calls[0].headers["x-api-key"], "sk-ant-test");
  assert.equal(today.calls[0].headers["anthropic-version"], "2023-06-01");
});

test("resolveTierModel fallback chain: every step, each only when the previous is unavailable", () => {
  // 1. no key → the snapshot, and it says why (no request made).
  const none = stubTransport({});
  const noKey = resolveTierModel("haiku", { env: {}, fetchImpl: none.fetchImpl });
  assert.deepEqual(
    [noKey.id, noKey.source, noKey.reason],
    [MODELS.haiku.id, "snapshot", "no ANTHROPIC_API_KEY for the Models API"],
  );
  assert.equal(none.calls.length, 0);

  // 2. offline / timeout / non-2xx with nothing cached → the snapshot.
  for (const failure of [
    null,
    { status: 500, headers: {}, body: "" },
    { status: 401, body: "{}" },
  ]) {
    const t = stubTransport({ "api.anthropic.com": failure });
    const r = resolveTierModel("haiku", { env: KEY_ENV, root: tmpRoot(), fetchImpl: t.fetchImpl });
    assert.equal(r.source, "snapshot");
    assert.equal(r.reason, "api.anthropic.com catalog unavailable");
  }

  // 3. reachable, but no model of the family → the snapshot.
  const noFable = stubTransport({ "api.anthropic.com": ok(ANTHROPIC_TODAY) });
  const fable = resolveTierModel("fable", { env: KEY_ENV, fetchImpl: noFable.fetchImpl });
  assert.equal(fable.id, MODELS.fable.id);
  assert.equal(fable.reason, "no fable model in the api.anthropic.com catalog");

  // 4. a cached catalog outlives a failed request: offline next time still gets the live answer.
  const root = tmpRoot();
  const online = stubTransport({ "api.anthropic.com": ok(ANTHROPIC_TODAY, { etag: '"c1"' }) });
  resolveTierModel("opus", { env: KEY_ENV, root, fetchImpl: online.fetchImpl });
  const offline = resolveTierModel("opus", { env: KEY_ENV, root, fetchImpl: () => null });
  assert.deepEqual(
    [offline.id, offline.source, offline.cache],
    ["claude-opus-4-8", "catalog", "stale"],
  );

  // 5. a transport that throws is contained.
  const boom = () => {
    throw new Error("kaboom");
  };
  assert.equal(resolveTierModel("opus", { env: KEY_ENV, fetchImpl: boom }).source, "snapshot");
  assert.equal(resolveTierModel("no-such-tier"), null);
});

test("resolveTierModel revalidates a header-less catalog with If-None-Match on the next use", () => {
  const root = tmpRoot();
  let n = 0;
  const t = stubTransport({
    "api.anthropic.com": (req) => {
      if (n++ === 0) return ok(ANTHROPIC_TODAY, { etag: '"cat-1"' });
      return req.headers["if-none-match"] === '"cat-1"' ? { status: 304, headers: {} } : null;
    },
  });
  resolveTierModel("sonnet", { env: KEY_ENV, root, fetchImpl: t.fetchImpl });
  const again = resolveTierModel("sonnet", { env: KEY_ENV, root, fetchImpl: t.fetchImpl });
  assert.equal(t.calls.length, 2, "no TTL: the next use asks again");
  assert.equal(t.calls[1].headers["if-none-match"], '"cat-1"');
  assert.deepEqual([again.id, again.cache], ["claude-sonnet-5", "revalidated"]);
  // With max-age on the response, the next use inside it makes no request at all.
  const root2 = tmpRoot();
  const cached = stubTransport({
    "api.anthropic.com": ok(ANTHROPIC_TODAY, { "cache-control": "max-age=600" }),
  });
  resolveTierModel("sonnet", { env: KEY_ENV, root: root2, fetchImpl: cached.fetchImpl });
  const hit = resolveTierModel("haiku", { env: KEY_ENV, root: root2, fetchImpl: cached.fetchImpl });
  assert.equal(cached.calls.length, 1);
  assert.equal(hit.cache, "fresh");
});

test("resolveTierModel honours explicit provider ids and namespaces OpenRouter picks", () => {
  // An explicit alias is configuration, not a family placeholder: never resolved away.
  const gw = { type: "litellm", baseUrl: "http://gw:4000", models: { haiku: "forge-simple" } };
  const t = stubTransport({});
  assert.deepEqual(resolveTierModel("haiku", { provider: gw, env: {}, fetchImpl: t.fetchImpl }), {
    id: "forge-simple",
    family: "haiku",
    source: "config",
  });
  assert.equal(t.calls.length, 0);
  // OpenRouter: its own catalog, restricted to the vendor namespace the provider is set up for.
  const orProvider = {
    type: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: { opus: `anthropic/${MODELS.opus.id}` },
  };
  const or = stubTransport({
    "openrouter.ai": ok({
      data: [
        { id: "anthropic/claude-opus-4.8", created: 1_777_000_000 },
        { id: "anthropic/claude-opus-5", created: 1_785_000_000 },
        { id: "someone-else/opus-finetune", created: 1_790_000_000 },
      ],
    }),
  });
  const r = resolveTierModel("opus", { provider: orProvider, env: {}, fetchImpl: or.fetchImpl });
  assert.equal(r.id, "anthropic/claude-opus-5");
  assert.equal(r.source, "catalog");
});

test("resolveTierPrice: live OpenRouter per-token price → per million, else the tier snapshot", () => {
  const catalogs = stubTransport({
    "api.anthropic.com": ok(
      anthropicPage([["claude-opus-5", "2026-08-01T00:00:00Z", "Claude Opus 5"]]),
    ),
    "openrouter.ai": ok(
      openRouterBody([
        ["anthropic/claude-opus-5", "0.000005", "0.000025"],
        ["anthropic/claude-sonnet-5", "0.0000021", "0.0000105"],
      ]),
    ),
  });
  const opts = { env: KEY_ENV, fetchImpl: catalogs.fetchImpl };
  const opus = resolveTierPrice("opus", opts);
  assert.deepEqual(
    [opus.inCost, opus.outCost, opus.source, opus.matchedId],
    [5, 25, "catalog", "anthropic/claude-opus-5"],
  );
  // Sonnet: no Sonnet in this Anthropic catalog → the snapshot id, which OpenRouter prices live.
  const sonnet = resolveTierPrice("sonnet", opts);
  assert.deepEqual([sonnet.inCost, sonnet.outCost, sonnet.source], [2.1, 10.5, "catalog"]);
  // Haiku: nobody lists it → the snapshot's own row.
  assert.deepEqual(resolveTierPrice("haiku", { ...opts, date: "2026-09-22" }), {
    inCost: 1,
    outCost: 5,
    source: "snapshot",
    basis: "exact",
    matchedId: MODELS.haiku.id,
  });
  // A resolved id the snapshot does not know, priced offline → its tier's price ("family").
  const offlineOpus = resolveTierPrice("opus", {
    ...opts,
    resolved: { id: "claude-opus-5", family: "opus", source: "catalog" },
    fetchImpl: () => null,
  });
  assert.deepEqual([offlineOpus.source, offlineOpus.basis], ["snapshot", "family"]);
});

test("resolveModelPrice (cost report): catalog → snapshot row → registry → family → unpriced", () => {
  const or = stubTransport({
    "openrouter.ai": ok(openRouterBody([["anthropic/claude-3-opus", "0.000015", "0.000075"]])),
  });
  const live = resolveModelPrice("claude-3-opus-20240229", { fetchImpl: or.fetchImpl });
  assert.deepEqual([live.inCost, live.outCost, live.source], [15, 75, "catalog"]);
  const offline = { fetchImpl: () => null, date: "2026-09-22" };
  const exact = resolveModelPrice(MODELS.opus.id, offline);
  assert.deepEqual([exact.inCost, exact.basis], [MODELS.opus.inCost, "exact"]);
  const registry = resolveModelPrice("claude-sonnet-4-5-20250929", offline);
  assert.deepEqual([registry.inCost, registry.outCost, registry.basis], [3, 15, "registry"]);
  const family = resolveModelPrice("claude-opus-9-20300101", offline);
  assert.deepEqual([family.inCost, family.basis], [MODELS.opus.inCost, "family"]);
  assert.equal(resolveModelPrice("<synthetic>", offline), null, "no guessed $3/$15");
  assert.equal(resolveModelPrice("gpt-4o", offline), null);
});

test("resolveTiers + describeResolution: every tier, with where its id came from", () => {
  const rows = resolveTiers({ env: {}, fetchImpl: () => null });
  assert.deepEqual(
    rows.map((r) => r.tier),
    TIER_ORDER,
  );
  for (const r of rows) {
    assert.equal(r.model.source, "snapshot");
    assert.equal(r.price.source, "snapshot");
    assert.match(describeResolution(r.model), /shipped snapshot, pricing verified \d{4}-\d\d-\d\d/);
  }
  assert.equal(
    describeResolution({
      id: "x",
      family: "opus",
      source: "catalog",
      catalog: "https://api.anthropic.com/v1/models?limit=1000",
      createdAt: "2026-08-01T00:00:00.000Z",
      cache: "stale",
    }),
    "newest opus in the api.anthropic.com catalog, created 2026-08-01, last cached copy (catalog unreachable)",
  );
});

test("resolveTierPrice never prices another vendor's configured model as a Claude tier", () => {
  const openai = { name: "openai", format: "openai", models: { haiku: "gpt-5-nano" } };
  assert.equal(
    resolveTierPrice("haiku", { provider: openai, env: {}, fetchImpl: () => null }),
    null,
    "unknown, not the Haiku snapshot price",
  );
  const or = stubTransport({
    "openrouter.ai": ok(openRouterBody([["openai/gpt-5-nano", "0.00000005", "0.0000004"]])),
  });
  const live = resolveTierPrice("haiku", { provider: openai, env: {}, fetchImpl: or.fetchImpl });
  assert.deepEqual([live.inCost, live.outCost, live.source], [0.05, 0.4, "catalog"]);
});

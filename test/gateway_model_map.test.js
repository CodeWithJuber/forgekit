import assert from "node:assert/strict";
import test from "node:test";
import {
  _resetGatewayCache,
  buildGatewayMap,
  familyScore,
  familyTokens,
  fetchModelIds,
  gatewayBase,
  gatewayModelId,
  gatewayModelMap,
} from "../src/gateway_model_map.js";

// ---------------------------------------------------------------------------
// familyScore — the family word is a hard gate; overlap rewards a version match.
// ---------------------------------------------------------------------------

test("familyScore requires the family word and scores higher on a version match", () => {
  // "haiku" absent → not a candidate for the haiku tier, no matter what else matches.
  assert.equal(familyScore("claude-sonnet-5", "haiku"), 0);
  assert.equal(familyScore("gpt-4o", "opus"), 0);
  // Family word present → scored by overlap of {haiku,4,5} with the id's tokens.
  const exact = familyScore("claude-haiku-4-5", "haiku"); // {haiku,4,5} ⊆ id → 1.0
  const bare = familyScore("prod-haiku", "haiku"); // only "haiku" shared → 1/3
  assert.ok(Math.abs(exact - 1) < 1e-9, "full name+version match saturates at 1");
  assert.ok(bare > 0 && bare < exact, "a bare family match still scores, but below an exact one");
});

test("familyTokens carries the tier key plus its marketing-name tokens", () => {
  assert.deepEqual([...familyTokens("sonnet")].sort(), ["5", "sonnet"]);
  assert.deepEqual([...familyTokens("haiku")].sort(), ["4", "5", "haiku"]);
});

// ---------------------------------------------------------------------------
// buildGatewayMap — pure assignment of tiers to a gateway's advertised ids.
// ---------------------------------------------------------------------------

test("buildGatewayMap maps each tier to the best family-matching advertised id", () => {
  const ids = [
    "bedrock-claude-haiku-4-5",
    "prod-sonnet-5",
    "claude-opus-4-8-internal",
    "gpt-4o", // unrelated — never assigned
  ];
  const map = buildGatewayMap(ids);
  assert.equal(map.haiku.id, "bedrock-claude-haiku-4-5");
  assert.equal(map.sonnet.id, "prod-sonnet-5");
  assert.equal(map.opus.id, "claude-opus-4-8-internal");
  assert.ok(!map.fable, "no fable model advertised → tier omitted (caller keeps the stock id)");
});

test("buildGatewayMap breaks ties toward the id closest to the canonical name", () => {
  // Both contain "sonnet" + "5" → equal overlap score; the shorter, less-noisy id wins.
  const map = buildGatewayMap(["vendor-region-prod-sonnet-5-preview", "claude-sonnet-5"]);
  assert.equal(map.sonnet.id, "claude-sonnet-5");
});

test("buildGatewayMap never assigns an unrelated model and tolerates junk input", () => {
  assert.deepEqual(buildGatewayMap(["gpt-4o", "mixtral", "llama-3"]), {});
  assert.deepEqual(buildGatewayMap([]), {});
  assert.deepEqual(buildGatewayMap([null, 42, "", "haiku"]).haiku.id, "haiku");
});

// ---------------------------------------------------------------------------
// gatewayBase — direct Anthropic never engages the remap.
// ---------------------------------------------------------------------------

test("gatewayBase returns null for the default Anthropic endpoint and when unset", () => {
  const save = {
    l: process.env.LITELLM_BASE_URL,
    a: process.env.ANTHROPIC_BASE_URL,
  };
  try {
    process.env.LITELLM_BASE_URL = "";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/";
    assert.equal(gatewayBase(), null, "trailing-slash default is still the default");
    process.env.ANTHROPIC_BASE_URL = "";
    assert.equal(gatewayBase(), null, "nothing configured → null");
    process.env.LITELLM_BASE_URL = "http://gw.internal:4000/";
    assert.equal(
      gatewayBase(),
      "http://gw.internal:4000",
      "gateway url wins, trailing slash trimmed",
    );
  } finally {
    process.env.LITELLM_BASE_URL = save.l ?? "";
    process.env.ANTHROPIC_BASE_URL = save.a ?? "";
  }
});

// ---------------------------------------------------------------------------
// fetch caching + fail-safe resolution (fetch is injected — no network in tests).
// ---------------------------------------------------------------------------

test("fetchModelIds caches once per process and returns null on failure", () => {
  _resetGatewayCache();
  let calls = 0;
  const fetchImpl = () => {
    calls++;
    return ["claude-haiku-4-5", "claude-sonnet-5"];
  };
  const a = fetchModelIds("http://gw:4000", { fetchImpl });
  const b = fetchModelIds("http://gw:4000", { fetchImpl });
  assert.deepEqual(a, ["claude-haiku-4-5", "claude-sonnet-5"]);
  assert.deepEqual(b, a);
  assert.equal(calls, 1, "second lookup is served from the process cache");

  _resetGatewayCache();
  const throwing = () => {
    throw new Error("connrefused");
  };
  assert.equal(fetchModelIds("http://down:4000", { fetchImpl: throwing }), null);
});

test("gatewayModelMap reports reachability and the scored mapping", () => {
  _resetGatewayCache();
  const m = gatewayModelMap({
    base: "http://gw:4000",
    fetchImpl: () => ["my-haiku", "my-sonnet-5", "gpt-4o"],
  });
  assert.equal(m.active, true);
  assert.equal(m.reachable, true);
  assert.equal(m.models.haiku.id, "my-haiku");
  assert.equal(m.models.sonnet.id, "my-sonnet-5");

  _resetGatewayCache();
  const down = gatewayModelMap({
    base: "http://down:4000",
    fetchImpl: () => null,
  });
  assert.equal(down.reachable, false);
  assert.deepEqual(down.models, {});
});

test("gatewayModelId remaps a matched tier and falls back silently otherwise", () => {
  _resetGatewayCache();
  const opts = {
    base: "http://gw:4000",
    fetchImpl: () => ["renamed-haiku-4-5", "prod-sonnet-5"],
  };
  assert.equal(gatewayModelId("haiku", "claude-haiku-4-5-20251001", opts), "renamed-haiku-4-5");
  // fable isn't advertised → the caller's stock id is returned unchanged (silent fallback).
  assert.equal(gatewayModelId("fable", "claude-fable-5", opts), "claude-fable-5");

  // No gateway base at all (default fetchImpl never invoked) → always the fallback, never a throw.
  _resetGatewayCache();
  assert.equal(
    gatewayModelId("haiku", "claude-haiku-4-5-20251001", { base: null }),
    "claude-haiku-4-5-20251001",
  );
});

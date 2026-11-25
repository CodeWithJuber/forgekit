// `forge models` and the resolved-id line of `forge route`, end to end through the real CLI.
// The spawned CLI inherits test/_setup.js's FORGE_NO_CATALOG_FETCH=1 and scrubbed env, so it
// never reaches a network: every tier resolves to the shipped snapshot and SAYS so.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODELS, TIER_ORDER } from "../src/model_tiers.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (args) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: mkdtempSync(join(tmpdir(), "forge-models-cli-")),
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1", NO_COLOR: "1" },
  });

test("forge models --schema 1 --json: every tier, its resolved id, price and where both came from", () => {
  const r = run(["models", "--schema", "1", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(
    out.tiers.map((t) => t.tier),
    TIER_ORDER,
  );
  for (const t of out.tiers) {
    assert.equal(t.family, t.tier);
    assert.equal(t.model.id, MODELS[t.tier].id);
    assert.equal(t.model.source, "snapshot");
    assert.equal(t.model.reason, "no ANTHROPIC_API_KEY for the Models API");
    assert.equal(t.price.source, "snapshot");
    assert.equal(t.price.inCost, MODELS[t.tier].inCost);
  }
  assert.match(out.pricingVerified, /^\d{4}-\d\d-\d\d$/);
});

test("forge models: a readable table plus one provenance line per family", () => {
  const r = run(["models", "--schema", "1"]);
  assert.equal(r.status, 0, r.stderr);
  for (const tier of TIER_ORDER) {
    assert.ok(r.stdout.includes(MODELS[tier].id), `${tier} id shown`);
    assert.match(r.stdout, new RegExp(`${tier}\\s+shipped snapshot, pricing verified`));
  }
  assert.match(r.stdout, /prices: shipped snapshot, verified/);
});

test("default model JSON shows profiles and native hosts with their availability", () => {
  const r = run(["models", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const inventory = JSON.parse(r.stdout);
  assert.equal(inventory.schemaVersion, 2);
  assert.ok(Array.isArray(inventory.profiles));
  assert.ok(Array.isArray(inventory.nativeHosts));
  assert.equal(inventory.profiles[0].status, "credential-missing");
});

test("forge route returns an honest cold-start message through the normal CLI", () => {
  const r = run(["route", "write an is_prime function"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No model recommendation.*verified task outcomes/);
  assert.doesNotMatch(r.stdout, /Haiku|claude/i);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeProvider,
  addProvider,
  applyRoute,
  listProviders,
  loadProviders,
  resolveModel,
  setProvider,
} from "../src/providers.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "forge-prov-"));
}

test("loadProviders returns defaults when no config file exists", () => {
  const root = tmpRoot();
  const config = loadProviders(root);
  assert.equal(config.active, "anthropic");
  assert.ok(config.providers.anthropic);
  assert.ok(config.providers.openrouter);
});

test("activeProvider returns anthropic by default", () => {
  const root = tmpRoot();
  const prov = activeProvider(root);
  assert.equal(prov.name, "anthropic");
  assert.equal(prov.type, "anthropic");
  assert.ok(prov.models.haiku);
});

test("setProvider switches active provider", () => {
  const root = tmpRoot();
  const r = setProvider(root, "openrouter");
  assert.ok(r.ok);
  assert.equal(r.name, "openrouter");
  const prov = activeProvider(root);
  assert.equal(prov.name, "openrouter");
  assert.match(prov.models.haiku, /^anthropic\//);
});

test("setProvider rejects unknown provider", () => {
  const root = tmpRoot();
  const r = setProvider(root, "nonexistent");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown provider/);
});

test("addProvider registers a custom provider", () => {
  const root = tmpRoot();
  const r = addProvider(root, "custom1", {
    baseUrl: "https://my-api.example.com",
    envKey: "CUSTOM_KEY",
    label: "My Custom",
  });
  assert.ok(r.ok);
  assert.equal(r.provider.baseUrl, "https://my-api.example.com");
  const list = listProviders(root);
  assert.ok(list.some((p) => p.name === "custom1"));
});

test("addProvider requires baseUrl", () => {
  const root = tmpRoot();
  const r = addProvider(root, "bad", {});
  assert.equal(r.ok, false);
});

test("resolveModel maps tier to active provider model ID", () => {
  const root = tmpRoot();
  const id = resolveModel(root, "haiku");
  assert.ok(id);
  assert.ok(!id.includes("/"));
  setProvider(root, "openrouter");
  const orId = resolveModel(root, "haiku");
  assert.match(orId, /^anthropic\//);
});

test("listProviders shows all with active flag", () => {
  const root = tmpRoot();
  const list = listProviders(root);
  assert.ok(list.length >= 2);
  const active = list.find((p) => p.active);
  assert.equal(active.name, "anthropic");
});

test("applyRoute writes model to settings.json", () => {
  const root = tmpRoot();
  const settingsDir = join(root, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(settingsPath, "{}");
  const r = applyRoute("sonnet", { settingsPath });
  assert.ok(r.ok);
  assert.equal(r.model, "sonnet");
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(written.model, "sonnet");
});

test("applyRoute rejects unknown tier", () => {
  const root = tmpRoot();
  const r = applyRoute("nonexistent", {
    settingsPath: join(root, "s.json"),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown tier/);
});

test("loadProviders merges user overrides with defaults", () => {
  const root = tmpRoot();
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({
      active: "openrouter",
      providers: { anthropic: { label: "My Anthropic" } },
    }),
  );
  const config = loadProviders(root);
  assert.equal(config.active, "openrouter");
  assert.equal(config.providers.anthropic.label, "My Anthropic");
  assert.ok(config.providers.anthropic.baseUrl);
});

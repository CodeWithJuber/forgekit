import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  activeProvider,
  addProvider,
  applyRoute,
  autoDetectProvider,
  listDetectedProviders,
  listProviders,
  loadProviders,
  providerStatus,
  resolveModel,
  setProvider,
} from "../src/providers.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "forge-prov-"));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAR_ENV = {
  LITELLM_BASE_URL: undefined,
  LITELLM_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  OPENROUTER_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
};

// --- existing tests ---

test("loadProviders returns defaults when no config file exists", () => {
  const root = tmpRoot();
  const config = loadProviders(root);
  assert.equal(config.active, "anthropic");
  assert.ok(config.providers.anthropic);
  assert.ok(config.providers.openrouter);
});

test("activeProvider returns anthropic by default", () => {
  const root = tmpRoot();
  withEnv(CLEAR_ENV, () => {
    const prov = activeProvider(root);
    assert.equal(prov.name, "anthropic");
    assert.equal(prov.type, "anthropic");
    assert.ok(prov.models.haiku);
  });
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

// --- auto-detection tests ---

test("autoDetectProvider returns null when no env vars set", () => {
  withEnv(CLEAR_ENV, () => {
    assert.equal(autoDetectProvider(), null);
  });
});

test("autoDetectProvider: ANTHROPIC_API_KEY → anthropic", () => {
  withEnv({ ...CLEAR_ENV, ANTHROPIC_API_KEY: "sk-ant-test" }, () => {
    const r = autoDetectProvider();
    assert.equal(r.name, "anthropic");
    assert.equal(r.type, "anthropic");
    assert.equal(r.source, "ANTHROPIC_API_KEY");
  });
});

test("autoDetectProvider: OPENROUTER_API_KEY → openrouter", () => {
  withEnv({ ...CLEAR_ENV, OPENROUTER_API_KEY: "sk-or-test" }, () => {
    const r = autoDetectProvider();
    assert.equal(r.name, "openrouter");
    assert.equal(r.type, "openrouter");
    assert.equal(r.source, "OPENROUTER_API_KEY");
  });
});

test("autoDetectProvider: LITELLM_BASE_URL → litellm with custom URL", () => {
  withEnv({ ...CLEAR_ENV, LITELLM_BASE_URL: "https://litellm.company.com" }, () => {
    const r = autoDetectProvider();
    assert.equal(r.name, "litellm");
    assert.equal(r.type, "litellm");
    assert.equal(r.baseUrl, "https://litellm.company.com");
    assert.equal(r.source, "LITELLM_BASE_URL");
    assert.ok(r.models.haiku);
    assert.ok(!r.models.haiku.startsWith("forge-"));
  });
});

test("autoDetectProvider: LITELLM_BASE_URL strips trailing slash", () => {
  withEnv({ ...CLEAR_ENV, LITELLM_BASE_URL: "https://gw.example.com/" }, () => {
    const r = autoDetectProvider();
    assert.equal(r.baseUrl, "https://gw.example.com");
  });
});

test("autoDetectProvider: LITELLM_BASE_URL + LITELLM_API_KEY → correct envKey", () => {
  withEnv(
    {
      ...CLEAR_ENV,
      LITELLM_BASE_URL: "https://gw.example.com",
      LITELLM_API_KEY: "sk-litellm-test",
    },
    () => {
      const r = autoDetectProvider();
      assert.equal(r.envKey, "LITELLM_API_KEY");
    },
  );
});

test("autoDetectProvider: LITELLM_BASE_URL without LITELLM_API_KEY → falls back to ANTHROPIC_API_KEY envKey", () => {
  withEnv(
    {
      ...CLEAR_ENV,
      LITELLM_BASE_URL: "https://gw.example.com",
      ANTHROPIC_API_KEY: "sk-ant-test",
    },
    () => {
      const r = autoDetectProvider();
      assert.equal(r.envKey, "ANTHROPIC_API_KEY");
    },
  );
});

test("autoDetectProvider: ANTHROPIC_BASE_URL (non-default) → anthropic-proxy", () => {
  withEnv({ ...CLEAR_ENV, ANTHROPIC_BASE_URL: "http://localhost:4000" }, () => {
    const r = autoDetectProvider();
    assert.equal(r.name, "anthropic-proxy");
    assert.equal(r.type, "anthropic");
    assert.equal(r.baseUrl, "http://localhost:4000");
    assert.equal(r.source, "ANTHROPIC_BASE_URL");
  });
});

test("autoDetectProvider: ANTHROPIC_BASE_URL=https://api.anthropic.com → ignored (default)", () => {
  withEnv({ ...CLEAR_ENV, ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, () => {
    assert.equal(autoDetectProvider(), null);
  });
});

test("autoDetectProvider: LITELLM_API_KEY alone (no URL) → ignored", () => {
  withEnv({ ...CLEAR_ENV, LITELLM_API_KEY: "sk-litellm-test" }, () => {
    assert.equal(autoDetectProvider(), null);
  });
});

test("autoDetectProvider: priority — LITELLM_BASE_URL wins over OPENROUTER_API_KEY", () => {
  withEnv(
    {
      ...CLEAR_ENV,
      LITELLM_BASE_URL: "https://gw.example.com",
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    },
    () => {
      const r = autoDetectProvider();
      assert.equal(r.name, "litellm");
      assert.equal(r.source, "LITELLM_BASE_URL");
    },
  );
});

test("autoDetectProvider: priority — OPENROUTER_API_KEY wins over ANTHROPIC_API_KEY alone", () => {
  withEnv(
    {
      ...CLEAR_ENV,
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    },
    () => {
      const r = autoDetectProvider();
      assert.equal(r.name, "openrouter");
      assert.equal(r.source, "OPENROUTER_API_KEY");
    },
  );
});

// --- activeProvider with auto-detection ---

test("activeProvider: explicit config overrides auto-detection", () => {
  const root = tmpRoot();
  const dir = join(root, ".forge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify({ active: "anthropic", providers: {} }),
  );
  withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
    const prov = activeProvider(root);
    assert.equal(prov.name, "anthropic");
    assert.ok(!prov._autoDetected);
  });
});

test("activeProvider: auto-detects when no config file exists", () => {
  const root = tmpRoot();
  withEnv({ ...CLEAR_ENV, OPENROUTER_API_KEY: "sk-or-test" }, () => {
    const prov = activeProvider(root);
    assert.equal(prov.name, "openrouter");
    assert.ok(prov._autoDetected);
    assert.equal(prov._source, "OPENROUTER_API_KEY");
  });
});

test("activeProvider: falls back to anthropic when nothing detected", () => {
  const root = tmpRoot();
  withEnv(CLEAR_ENV, () => {
    const prov = activeProvider(root);
    assert.equal(prov.name, "anthropic");
    assert.ok(!prov._autoDetected);
  });
});

// --- providerStatus ---

test("providerStatus: reports auto-detection source", () => {
  const root = tmpRoot();
  withEnv({ ...CLEAR_ENV, OPENROUTER_API_KEY: "sk-or-test" }, () => {
    const status = providerStatus(root);
    assert.equal(status.autoDetected, true);
    assert.equal(status.source, "OPENROUTER_API_KEY");
    assert.ok(status.checks.some((c) => c.id === "auto-detect"));
  });
});

test("providerStatus: envScan lists all relevant env vars", () => {
  const root = tmpRoot();
  withEnv(CLEAR_ENV, () => {
    const status = providerStatus(root);
    assert.ok(Array.isArray(status.envScan));
    assert.ok(status.envScan.length >= 5);
    const keys = status.envScan.map((e) => e.key);
    assert.ok(keys.includes("LITELLM_BASE_URL"));
    assert.ok(keys.includes("LITELLM_API_KEY"));
    assert.ok(keys.includes("ANTHROPIC_BASE_URL"));
    assert.ok(keys.includes("OPENROUTER_API_KEY"));
    assert.ok(keys.includes("ANTHROPIC_API_KEY"));
  });
});

// --- listDetectedProviders ---

test("listDetectedProviders: returns empty when no env vars set", () => {
  withEnv(CLEAR_ENV, () => {
    assert.deepEqual(listDetectedProviders(), []);
  });
});

test("listDetectedProviders: returns all available providers from env", () => {
  withEnv(
    {
      ...CLEAR_ENV,
      LITELLM_BASE_URL: "https://gw.example.com",
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "sk-ant-test",
    },
    () => {
      const detected = listDetectedProviders();
      assert.ok(detected.length >= 3);
      const names = detected.map((d) => d.name);
      assert.ok(names.includes("litellm"));
      assert.ok(names.includes("openrouter"));
      assert.ok(names.includes("anthropic"));
    },
  );
});

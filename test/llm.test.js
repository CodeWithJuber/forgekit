import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHttpProvider } from "../src/llm.js";

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

const CLEAR = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  LITELLM_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  LITELLM_BASE_URL: undefined,
  ANTHROPIC_MODEL: undefined,
};

test("resolveHttpProvider: ANTHROPIC_API_KEY + default URL", () => {
  withEnv({ ...CLEAR, ANTHROPIC_API_KEY: "sk-test" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.baseUrl, "https://api.anthropic.com");
    assert.equal(p.key, "sk-test");
  });
});

test("resolveHttpProvider: ANTHROPIC_AUTH_TOKEN + custom URL", () => {
  withEnv(
    {
      ...CLEAR,
      ANTHROPIC_AUTH_TOKEN: "bearer-token",
      ANTHROPIC_BASE_URL: "https://gw.example.com",
    },
    () => {
      const p = resolveHttpProvider();
      assert.equal(p.baseUrl, "https://gw.example.com");
      assert.equal(p.key, "bearer-token");
    },
  );
});

test("resolveHttpProvider: LITELLM_BASE_URL takes precedence over ANTHROPIC_BASE_URL", () => {
  withEnv(
    {
      ...CLEAR,
      ANTHROPIC_API_KEY: "sk-test",
      LITELLM_BASE_URL: "https://litellm.local",
      ANTHROPIC_BASE_URL: "https://other.local",
    },
    () => {
      const p = resolveHttpProvider();
      assert.equal(p.baseUrl, "https://litellm.local");
    },
  );
});

test("resolveHttpProvider: ANTHROPIC_MODEL override surfaces in result", () => {
  withEnv({ ...CLEAR, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_MODEL: "claude-opus-4-7" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.model, "claude-opus-4-7");
  });
});

test("resolveHttpProvider: no model override → null", () => {
  withEnv({ ...CLEAR, ANTHROPIC_API_KEY: "sk-test" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.model, null);
  });
});

test("resolveHttpProvider: no credentials → null", () => {
  withEnv(CLEAR, () => {
    assert.equal(resolveHttpProvider(), null);
  });
});

test("resolveHttpProvider: LITELLM_API_KEY as fallback", () => {
  withEnv({ ...CLEAR, LITELLM_API_KEY: "sk-lite" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.key, "sk-lite");
  });
});

test("resolveHttpProvider: strips trailing slash from URL", () => {
  withEnv(
    { ...CLEAR, ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://gw.example.com/" },
    () => {
      const p = resolveHttpProvider();
      assert.equal(p.baseUrl, "https://gw.example.com");
    },
  );
});

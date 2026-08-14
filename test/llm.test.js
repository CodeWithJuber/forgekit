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
  FORGE_MODEL: undefined,
  OPENAI_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
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

test("resolveHttpProvider: OPENAI_API_KEY → OpenAI-compatible chat/completions", () => {
  withEnv({ ...CLEAR, OPENAI_API_KEY: "sk-oai" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.format, "openai");
    assert.equal(p.baseUrl, "https://api.openai.com/v1");
    assert.equal(p.path, "/chat/completions");
    assert.equal(p.key, "sk-oai");
    assert.equal(p.defaultModel, "gpt-5-mini");
  });
});

test("resolveHttpProvider: GEMINI_API_KEY → Gemini OpenAI-compatible endpoint", () => {
  withEnv({ ...CLEAR, GEMINI_API_KEY: "gm" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.format, "openai");
    assert.equal(p.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(p.defaultModel, "gemini-2.5-flash");
  });
});

test("resolveHttpProvider: GOOGLE_API_KEY is a Gemini alias", () => {
  withEnv({ ...CLEAR, GOOGLE_API_KEY: "goog" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.format, "openai");
    assert.equal(p.key, "goog");
  });
});

test("resolveHttpProvider: Anthropic key wins over OpenAI (format stays anthropic)", () => {
  withEnv({ ...CLEAR, ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.format, "anthropic");
    assert.equal(p.key, "sk-ant");
  });
});

test("resolveHttpProvider: FORGE_MODEL override surfaces for OpenAI", () => {
  withEnv({ ...CLEAR, OPENAI_API_KEY: "sk-oai", FORGE_MODEL: "gpt-5" }, () => {
    const p = resolveHttpProvider();
    assert.equal(p.model, "gpt-5");
  });
});

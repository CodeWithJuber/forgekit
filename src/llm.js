// forge llm — direct HTTP LLM call. Follows the embed.js child-process-fetch pattern:
// synchronous shell-out to a spawned node child so this module stays synchronous like
// every other forge faculty. The auth token travels via the child's env (_FORGE_LLM_KEY)
// — never in argv, never logged.
//
// Two wire formats are supported so a native key from any major vendor works with zero
// config: the Anthropic Messages API (default), and the OpenAI-compatible chat/completions
// API that OpenAI, Google Gemini, OpenRouter, and LiteLLM all expose.
import { spawnSync } from "node:child_process";

// Anthropic Messages API — POST {baseUrl}/v1/messages, x-api-key / bearer auth.
const HTTP_CHILD_ANTHROPIC = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,prompt,maxTokens}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"content-type":"application/json","anthropic-version":"2023-06-01"};if(key.startsWith("Bearer "))headers.authorization=key;else if(key)headers["x-api-key"]=key;const body=JSON.stringify({model,max_tokens:maxTokens||1024,messages:[{role:"user",content:prompt}]});const res=await fetch(url,{method:"POST",headers,body});if(!res.ok){process.stderr.write("llm: http "+res.status);process.exit(1);}const data=await res.json();const text=(data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");process.stdout.write(text);}catch(e){process.stderr.write("llm: "+(e.message||e));process.exit(1);}});`;

// OpenAI-compatible chat/completions — POST {baseUrl}/chat/completions, bearer auth.
const HTTP_CHILD_OPENAI = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,prompt,maxTokens}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"content-type":"application/json"};if(key)headers.authorization=key.startsWith("Bearer ")?key:"Bearer "+key;const body=JSON.stringify({model,max_tokens:maxTokens||1024,messages:[{role:"user",content:prompt}]});const res=await fetch(url,{method:"POST",headers,body});if(!res.ok){process.stderr.write("llm: http "+res.status);process.exit(1);}const data=await res.json();const c=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content;const text=Array.isArray(c)?c.map(p=>typeof p==="string"?p:p.text||"").join(""):(c||"");process.stdout.write(text);}catch(e){process.stderr.write("llm: "+(e.message||e));process.exit(1);}});`;

const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

/**
 * Resolve base URL, auth key, wire format, and model override from environment.
 * Anthropic credentials win when present (forge is Claude-native); OpenAI and Gemini
 * are the zero-config fallback when they are the only key set. Returns null if no auth
 * is available.
 * @returns {{baseUrl:string, key:string, model:string|null, format:"anthropic"|"openai", path:string, defaultModel:string|null}|null}
 */
export function resolveHttpProvider() {
  const modelOverride =
    process.env.ANTHROPIC_MODEL?.trim() || process.env.FORGE_MODEL?.trim() || null;

  const anthropicKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.LITELLM_API_KEY ||
    "";
  if (anthropicKey) {
    const baseUrl = (
      process.env.LITELLM_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      "https://api.anthropic.com"
    ).replace(/\/+$/, "");
    return {
      baseUrl,
      key: anthropicKey,
      model: modelOverride,
      format: "anthropic",
      path: "/v1/messages",
      defaultModel: null,
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: "https://api.openai.com/v1",
      key: process.env.OPENAI_API_KEY,
      model: modelOverride,
      format: "openai",
      path: "/chat/completions",
      defaultModel: "gpt-5-mini",
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (geminiKey) {
    return {
      baseUrl: GEMINI_OPENAI_URL,
      key: geminiKey,
      model: modelOverride,
      format: "openai",
      path: "/chat/completions",
      defaultModel: "gemini-2.5-flash",
    };
  }

  return null;
}

/**
 * Build an HTTP-based LLM runner. Same contract as adjudicate.buildRunner:
 * returns (prompt) => string. Selects the Anthropic or OpenAI-compatible wire format
 * from the resolved provider.
 * @param {{model?: string, timeoutMs?: number}} [opts]
 */
export function buildHttpRunner({ model = "claude-haiku-4-5-20251001", timeoutMs = 20000 } = {}) {
  return (prompt) => {
    const provider = resolveHttpProvider();
    if (!provider)
      throw new Error(
        "no LLM provider configured — set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY",
      );
    const child = provider.format === "openai" ? HTTP_CHILD_OPENAI : HTTP_CHILD_ANTHROPIC;
    const chosenModel = provider.model || provider.defaultModel || model;
    const input = JSON.stringify({
      url: `${provider.baseUrl}${provider.path}`,
      model: chosenModel,
      prompt,
      maxTokens: 1024,
    });
    const r = spawnSync(process.execPath, ["-e", child], {
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, _FORGE_LLM_KEY: provider.key },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0 || !r.stdout) {
      throw new Error(r.stderr?.trim() || r.error?.message || "llm call failed");
    }
    return r.stdout;
  };
}

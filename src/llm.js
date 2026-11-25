// forge llm — direct HTTP LLM call. Follows the embed.js child-process-fetch pattern:
// synchronous shell-out to a spawned node child so this module stays synchronous like
// every other forge faculty. The auth token travels via the child's env (_FORGE_LLM_KEY)
// — never in argv, never logged.
//
// Two wire formats are supported so a native key from any major vendor works with zero
// config: the Anthropic Messages API (default), and the OpenAI-compatible chat/completions
// API that OpenAI, Google Gemini, OpenRouter, and LiteLLM all expose.
import { spawnSync } from "node:child_process";
import { recordModelCall } from "./model_call_evidence.js";
import { SAFE_MODEL_ID } from "./model_catalog.js";
import { MODELS, resolveTierModel } from "./model_tiers.js";
import {
  activeProvider,
  cleanModelEndpoint,
  envModelOverride,
  loadProviders,
  profileCredential,
  trustedModelProfile,
} from "./providers.js";
import { defaultDispatchModel } from "./route.js";

// Anthropic Messages API — POST {baseUrl}/v1/messages, x-api-key / bearer auth.
const HTTP_CHILD_ANTHROPIC = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,prompt,maxTokens}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"content-type":"application/json","anthropic-version":"2023-06-01"};if(key.startsWith("Bearer "))headers.authorization=key;else if(key)headers["x-api-key"]=key;const body=JSON.stringify({model,max_tokens:maxTokens||1024,messages:[{role:"user",content:prompt}]});const res=await fetch(url,{method:"POST",headers,body,redirect:"error"});if(!res.ok){process.stderr.write("llm: http "+res.status);process.exit(1);}const data=await res.json();const text=(data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");process.stdout.write(JSON.stringify({text,model:data.model||null,usage:data.usage||null}));}catch(e){process.stderr.write("llm: "+(e.message||e));process.exit(1);}});`;

// OpenAI-compatible chat/completions — POST {baseUrl}/chat/completions, bearer auth.
const HTTP_CHILD_OPENAI = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,prompt,maxTokens,limitField}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"content-type":"application/json"};if(key)headers.authorization=key.startsWith("Bearer ")?key:"Bearer "+key;const body=JSON.stringify({model,[limitField]:maxTokens||1024,messages:[{role:"user",content:prompt}]});const res=await fetch(url,{method:"POST",headers,body,redirect:"error"});if(!res.ok){process.stderr.write("llm: http "+res.status);process.exit(1);}const data=await res.json();const c=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content;const text=Array.isArray(c)?c.map(p=>typeof p==="string"?p:p.text||"").join(""):(c||"");process.stdout.write(JSON.stringify({text,model:data.model||null,usage:data.usage||null}));}catch(e){process.stderr.write("llm: "+(e.message||e));process.exit(1);}});`;

/** Resolve the transport once, scoped to the selected profile and its authorized endpoint. */
export function resolveHttpProvider({ root = process.cwd(), profile = undefined } = {}) {
  let selected = activeProvider(root);
  if (profile !== undefined && selected.name !== profile) {
    const cfg = loadProviders(root).providers;
    if (!Object.hasOwn(cfg, profile)) throw new Error("Unknown model profile");
    selected = { ...cfg[profile], name: profile };
  }
  if (!trustedModelProfile(root, selected))
    throw new Error(
      "Model profile endpoint needs local authorization through forge config provider add",
    );
  const credential = profileCredential(selected);
  let key = credential.value;
  if (
    !key &&
    !profile &&
    !process.env.ANTHROPIC_API_KEY &&
    process.env.LITELLM_API_KEY &&
    !process.env.LITELLM_BASE_URL &&
    selected.name === "anthropic"
  ) {
    selected = { ...loadProviders(root).providers.litellm, name: "litellm" };
    if (!trustedModelProfile(root, selected)) throw new Error("Untrusted LiteLLM endpoint");
    key = process.env.LITELLM_API_KEY;
  }
  if (!key && selected.envKey) return null;
  const baseUrl = cleanModelEndpoint(selected.baseUrl);
  const openai = selected.format === "openai" || selected.type === "openrouter";
  const path = openai
    ? "/chat/completions"
    : baseUrl.endsWith("/v1")
      ? "/messages"
      : "/v1/messages";
  return {
    profile: selected,
    key: key || "",
    bearer: credential.bearer,
    baseUrl,
    path,
    format: openai ? "openai" : "anthropic",
    model: envModelOverride(selected) || selected.selectedModel || null,
    defaultModel: envModelOverride(selected) || selected.selectedModel || null,
  };
}

/**
 * Build an HTTP-based LLM runner. Same contract as adjudicate.buildRunner:
 * returns (prompt) => string. Selects the Anthropic or OpenAI-compatible wire format
 * from the resolved provider. An omitted model uses an explicit operator pin or a verified workload route.
 * @param {{model?: string, timeoutMs?: number, root?:string,profile?:string,onReceipt?:Function, spawn?:typeof spawnSync}} [opts]
 */
export function buildHttpRunner({
  model,
  timeoutMs = 20000,
  root = process.cwd(),
  profile,
  onReceipt,
  spawn = spawnSync,
} = {}) {
  return (prompt) => {
    const provider = resolveHttpProvider({ root, profile });
    if (!provider)
      throw new Error(
        "no LLM provider configured — set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, or GEMINI_API_KEY",
      );
    const child = provider.format === "openai" ? HTTP_CHILD_OPENAI : HTTP_CHILD_ANTHROPIC;
    const chosenModel = !model
      ? defaultDispatchModel(root, prompt, provider.profile.name)
      : Object.hasOwn(MODELS, model)
        ? provider.model || resolveTierModel(model, { root, provider: provider.profile })?.id
        : model;
    if (!SAFE_MODEL_ID.test(chosenModel || "")) throw new Error("Invalid selected model ID");
    const input = JSON.stringify({
      url: `${provider.baseUrl}${provider.path}`,
      model: chosenModel,
      prompt,
      maxTokens: 1024,
      limitField:
        provider.baseUrl === "https://api.openai.com/v1" ? "max_completion_tokens" : "max_tokens",
    });
    const started = performance.now();
    const r = spawn(process.execPath, ["-e", child], {
      input,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        _FORGE_LLM_KEY:
          provider.bearer && provider.key && !provider.key.startsWith("Bearer ")
            ? `Bearer ${provider.key}`
            : provider.key,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const latencyMs = Math.round(performance.now() - started);
    /** @param {string} status @param {{model?:string,usage?:{cost?:number}}} [reply] */
    const remember = (status, reply = {}) => {
      try {
        recordModelCall(root, provider.profile, provider.key, {
          sent: chosenModel,
          status,
          latencyMs,
          at: Date.now(),
          returned: reply.model ?? null,
          costUsd: provider.profile.type === "openrouter" ? reply.usage?.cost : null,
        });
      } catch {} // Local observability cannot turn a completed paid call into a failed attempt.
    };
    if (r.error || r.status !== 0 || !r.stdout) {
      if (/^llm: http (401|403)$/.test(r.stderr?.trim() || "")) remember("denied");
      throw new Error(r.stderr?.trim() || r.error?.message || "llm call failed");
    }
    const reply = JSON.parse(String(r.stdout));
    if (typeof reply.text !== "string") throw new Error("Invalid model response");
    remember("success", reply);
    onReceipt?.({
      latencyMs,
      profile: provider.profile.name,
      requested: model ?? null,
      resolved: chosenModel,
      sent: chosenModel,
      returned: typeof reply.model === "string" ? reply.model : null,
      usage: reply.usage ?? null,
    });
    return reply.text;
  };
}

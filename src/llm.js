// forge llm — direct HTTP LLM call (Anthropic Messages API). Follows the embed.js
// child-process-fetch pattern: synchronous shell-out to a spawned node child so this
// module stays synchronous like every other forge faculty. The auth token travels via
// the child's env (_FORGE_LLM_KEY) — never in argv, never logged.
import { spawnSync } from "node:child_process";

const HTTP_CHILD = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,prompt,maxTokens}=JSON.parse(raw);const key=process.env._FORGE_LLM_KEY||"";const headers={"content-type":"application/json","anthropic-version":"2023-06-01"};if(key.startsWith("Bearer "))headers.authorization=key;else if(key)headers["x-api-key"]=key;const body=JSON.stringify({model,max_tokens:maxTokens||1024,messages:[{role:"user",content:prompt}]});const res=await fetch(url,{method:"POST",headers,body});if(!res.ok){process.stderr.write("llm: http "+res.status);process.exit(1);}const data=await res.json();const text=(data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");process.stdout.write(text);}catch(e){process.stderr.write("llm: "+(e.message||e));process.exit(1);}});`;

/** Resolve base URL, auth key, and model override from environment. Returns null if no auth is available. */
export function resolveHttpProvider() {
  const key =
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.LITELLM_API_KEY ||
    "";
  if (!key) return null;
  const baseUrl = (
    process.env.LITELLM_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.anthropic.com"
  ).replace(/\/+$/, "");
  const model = process.env.ANTHROPIC_MODEL?.trim() || null;
  return { baseUrl, key, model };
}

/**
 * Build an HTTP-based LLM runner (Anthropic Messages API).
 * Same contract as adjudicate.buildRunner: returns (prompt) => string.
 * @param {{model?: string, timeoutMs?: number}} [opts]
 */
export function buildHttpRunner({ model = "claude-haiku-4-5-20251001", timeoutMs = 20000 } = {}) {
  return (prompt) => {
    const provider = resolveHttpProvider();
    if (!provider)
      throw new Error("no LLM provider configured — set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN");
    const input = JSON.stringify({
      url: `${provider.baseUrl}/v1/messages`,
      model: provider.model || model,
      prompt,
      maxTokens: 1024,
    });
    const r = spawnSync(process.execPath, ["-e", HTTP_CHILD], {
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

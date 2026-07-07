// forge embed — the OPTIONAL embeddings tier (ROADMAP "Next", ADR-0005). MinHash is
// weak on very short specs (a few words hash to too few shingles — the documented
// honest limit); a configured embedding provider replaces the lexical `rel` term in
// Eq. 3 retrieval and the reuse cache's near-match with semantic cosine similarity.
//
// ADR-0005 compliance, condition by condition:
//  1. Core stays stdlib — this file is node stdlib only (spawnSync + the provider's
//     own process); ledger.js never imports it. MinHash remains the reference path.
//  2. Graceful absence — no FORGE_EMBED, a crashed provider, a timeout, or garbage
//     output all yield `null`, and every caller keeps the MinHash path unchanged.
//  3. Named tiers — `dependencies` stays empty; the provider is an opt-in env config
//     (`FORGE_EMBED`), not a package at all.
//  4. Vetting — no third-party code runs unless the USER points FORGE_EMBED at it.
//
// Providers (FORGE_EMBED):
//   cmd:<shell-command>  spawn it, write {"texts":[..]} to stdin, read
//                        {"vectors":[[..]]} from stdout. The universal escape hatch:
//                        any local model, any script, any language.
//   http:<url>           OpenAI-compatible POST {input, model: $FORGE_EMBED_MODEL}
//                        with Authorization: Bearer $FORGE_EMBED_KEY. The fetch runs
//                        in a spawned node child (global fetch, node ≥20 stdlib) so
//                        this module stays synchronous like every other forge stage.
//                        The key travels only via the child's environment — it is
//                        never logged, never put in argv.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { contentHash } from "./util.js";

/** Hard ceilings — a misbehaving provider must never hang or flood a forge command. */
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TEXT_CHARS = 4000; // specs/claim texts are short; embed a stable prefix
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Cache cap — see appendCache for the truncate-oldest policy. */
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;

export const embedCachePath = (root = process.cwd()) => join(root, ".forge", "embed-cache.jsonl");

// Memoized per env value (not per process) so tests and long-lived callers that flip
// FORGE_EMBED re-resolve, while hot paths pay the parse once.
let memo = { env: /** @type {string|undefined} */ (undefined), provider: null };

/**
 * Resolve the provider from FORGE_EMBED. Unset/unknown scheme → null (callers keep
 * MinHash — the always-working default).
 * @returns {{kind:"cmd", cmd:string}|{kind:"http", url:string}|null}
 */
export function getProvider() {
  const env = process.env.FORGE_EMBED ?? "";
  if (memo.env === env) return memo.provider;
  /** @type {any} */
  let provider = null;
  if (env.startsWith("cmd:") && env.length > 4) provider = { kind: "cmd", cmd: env.slice(4) };
  else if (/^https?:\/\//.test(env)) provider = { kind: "http", url: env };
  else if (env.startsWith("http:") && env.length > 5)
    provider = { kind: "http", url: env.slice(5) };
  memo = { env, provider };
  return provider;
}

/** Cosine similarity in [-1,1]; zero-norm or empty vectors → 0 (never NaN). */
export function cosine(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const isVec = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isFinite(x));

/** Cache keys include the provider identity + model — switching backends must never
 *  serve another model's vectors. */
const providerId = (p) =>
  `${p.kind}:${p.kind === "cmd" ? p.cmd : p.url}:${process.env.FORGE_EMBED_MODEL ?? ""}`;

/** Corrupt-line-tolerant cache reader (same discipline as metrics.js — a bad line is
 *  skipped, never fatal). @returns {Map<string, number[]>} */
function readCache(root) {
  const out = new Map();
  const path = embedCachePath(root);
  if (!existsSync(path)) return out;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.k === "string" && isVec(e.v)) out.set(e.k, e.v);
      } catch {}
    }
  } catch {}
  return out;
}

/** Append new vectors; when the file outgrows CACHE_MAX_BYTES, rewrite it keeping the
 *  NEWEST lines that fit in half the cap (truncate-oldest — embeddings are
 *  re-derivable, so losing an old entry only costs one re-embed, never correctness).
 *  Best-effort: a cache write failure must never fail the query it was accelerating. */
function appendCache(root, entries) {
  if (!entries.length) return;
  const path = embedCachePath(root);
  try {
    mkdirSync(join(root, ".forge"), { recursive: true });
    appendFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
    if (statSync(path).size > CACHE_MAX_BYTES) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const keep = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        bytes += lines[i].length + 1;
        if (bytes > CACHE_MAX_BYTES / 2) break;
        keep.unshift(lines[i]);
      }
      writeFileSync(path, keep.length ? `${keep.join("\n")}\n` : "");
    }
  } catch {}
}

// Runs in a spawned node child: reads {url, model, texts} from stdin, POSTs the
// OpenAI-compatible payload, prints {vectors}. The Authorization header is built from
// the CHILD's env — the key never appears in argv, logs, or error output.
const HTTP_CHILD = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,model,texts}=JSON.parse(raw);const headers={"content-type":"application/json"};if(process.env.FORGE_EMBED_KEY)headers.authorization="Bearer "+process.env.FORGE_EMBED_KEY;const res=await fetch(url,{method:"POST",headers,body:JSON.stringify(model?{input:texts,model}:{input:texts})});if(!res.ok){console.error("embed: http "+res.status);process.exit(1);}const data=await res.json();process.stdout.write(JSON.stringify({vectors:(data.data??[]).map((d)=>d.embedding)}));}catch(e){console.error("embed: request failed");process.exit(1);}});`;

/** One provider round-trip. Any failure (spawn error, non-zero exit, timeout, bad
 *  JSON, wrong count, malformed vectors) → null. Never throws, never logs the key. */
function callProvider(provider, texts) {
  const timeout = Number(process.env.FORGE_EMBED_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const input =
    provider.kind === "cmd"
      ? JSON.stringify({ texts })
      : JSON.stringify({ url: provider.url, model: process.env.FORGE_EMBED_MODEL, texts });
  if (input.length > MAX_INPUT_BYTES) return null;
  try {
    const r =
      provider.kind === "cmd"
        ? spawnSync(provider.cmd, {
            shell: true,
            input,
            encoding: "utf8",
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
          })
        : spawnSync(process.execPath, ["-e", HTTP_CHILD], {
            input,
            encoding: "utf8",
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
          });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const vectors = JSON.parse(r.stdout).vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
    return vectors.map((v) => (isVec(v) ? v : null));
  } catch {
    return null;
  }
}

/**
 * Embed texts through the configured provider, via the content-hash-keyed disk cache
 * (`.forge/embed-cache.jsonl` under `root`) so repeated retrieval doesn't re-pay the
 * provider. Returns an array aligned with `texts` where an entry may be null (that
 * one text couldn't be embedded — per-candidate MinHash fallback), or null overall
 * when no provider is configured / nothing could be embedded.
 * @param {string[]} texts
 * @param {{root?: string}} [opts]
 * @returns {(number[]|null)[]|null}
 */
export function embed(texts, { root = process.cwd() } = {}) {
  const provider = getProvider();
  if (!provider || !Array.isArray(texts) || !texts.length) return null;
  const pid = providerId(provider);
  const trimmed = texts.map((t) => String(t).slice(0, MAX_TEXT_CHARS));
  const keys = trimmed.map((t) => contentHash(`${pid}\n${t}`));
  const cache = readCache(root);
  const out = keys.map((k) => cache.get(k) ?? null);

  const missIdx = out.flatMap((v, i) => (v === null ? [i] : []));
  if (missIdx.length) {
    const missTexts = [...new Set(missIdx.map((i) => trimmed[i]))];
    const vecs = callProvider(provider, missTexts);
    if (vecs) {
      const byText = new Map(missTexts.map((t, i) => [t, vecs[i]]));
      const fresh = new Map();
      for (const i of missIdx) {
        const v = byText.get(trimmed[i]) ?? null;
        out[i] = v;
        if (v) fresh.set(keys[i], v);
      }
      appendCache(
        root,
        [...fresh].map(([k, v]) => ({ k, v })),
      );
    }
  }
  return out.some(Boolean) ? out : null;
}

/**
 * Build the optional `sim` function callers inject into ledger.retrieve/score and
 * reuse.lookup (those cores stay embed-free). Query + every candidate text go through
 * ONE embed() call (cache-deduped); the returned sim maps a claim to
 * cosine(query, claim) or null when that claim's vector is missing (per-candidate
 * MinHash fallback). Returns null when no provider is configured, the candidate list
 * is empty, or the query itself couldn't be embedded — the caller's MinHash path is
 * then byte-for-byte unchanged.
 * @param {string} root repo root (hosts the disk cache)
 * @param {string} query
 * @param {any[]} claims
 * @param {(claim:any)=>string} textOf
 * @returns {((query:any, claim:any)=>number|null)|null}
 */
export function claimSim(root, query, claims, textOf) {
  if (!getProvider() || !claims.length) return null;
  const texts = [String(query), ...claims.map((c) => String(textOf(c)))];
  const vectors = embed(texts, { root });
  const qv = vectors?.[0];
  if (!qv) return null;
  const byText = new Map();
  for (let i = 1; i < texts.length; i++) if (vectors[i]) byText.set(texts[i], vectors[i]);
  return (_query, claim) => {
    const v = byText.get(String(textOf(claim)));
    return v ? cosine(qv, v) : null;
  };
}

/** The explainability line every query prints: which similarity backend served it. */
export function simLabel(sim) {
  const p = getProvider();
  return sim && p ? `embed(${p.kind})` : "minhash";
}

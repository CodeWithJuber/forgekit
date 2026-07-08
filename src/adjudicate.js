// forge adjudicate — the substrate's ONE shared "LLM proposes, checks verify" primitive.
// The whitepaper's load-bearing rule (Panickssery et al. C12; tabayyun, 49:6) is that a
// model is never its own judge: it may PROPOSE, but an external check arbitrates. This module
// supplies only the proposer half — a cheap, opt-in, fail-safe model call — while each faculty
// keeps its deterministic rubric as the judge and reconciles the two (verify, don't trust).
//
// Design contract (identical to src/cortex_distill.js, generalized so all faculties share it):
//   - OPT-IN. Off by default (FORGE_LLM!=1) → callers keep their deterministic result and this
//     module is never invoked. Behavior is byte-identical to the pre-LLM substrate.
//   - FAIL-SAFE. Any error/timeout/garble/secret → returns null. A null NEVER changes a verdict.
//   - ZERO-DEP. Access is a `claude -p` CLI shell-out; the runner is injectable so the pure
//     prompt/parse/verify logic is fully testable without the CLI or the network.
import { execFileSync, spawnSync } from "node:child_process";
import { buildHttpRunner as httpRunner } from "./llm.js";
import { MODELS } from "./model_tiers.js";
import { envModelOverride } from "./providers.js";
import { SECRET_RE } from "./recall.js";

/**
 * Is the LLM proposer layer active for this call? Explicit opt-in wins; env is the default.
 * @param {{llm?:boolean}} [opts]
 */
export function llmEnabled(opts = {}) {
  if (typeof opts.llm === "boolean") return opts.llm;
  return process.env.FORGE_LLM === "1";
}

let _claudeChecked = false;
let _claudeAvail = false;
function hasClaude() {
  if (!_claudeChecked) {
    _claudeChecked = true;
    try {
      const r = spawnSync("which", ["claude"], { encoding: "utf8", timeout: 2000, stdio: "pipe" });
      _claudeAvail = r.status === 0;
    } catch {
      _claudeAvail = false;
    }
  }
  return _claudeAvail;
}

/** Build an injectable LLM runner. Tries direct HTTP when `claude` CLI is unavailable
 *  or when FORGE_LLM_HTTP=1. Falls back to `claude -p` otherwise. */
export function buildRunner({ model = "haiku", timeoutMs = 20000 } = {}) {
  const resolvedModel = envModelOverride() || MODELS[model]?.id || model;
  if (process.env.FORGE_LLM_HTTP === "1" || !hasClaude()) {
    return httpRunner({ model: resolvedModel, timeoutMs });
  }
  return (prompt) =>
    execFileSync("claude", ["-p", "--model", resolvedModel], {
      input: prompt,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "ignore"],
    });
}

/** Extract the first balanced-ish JSON object from model output, or null. */
export function extractJson(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Run one adjudication: send `prompt`, parse+validate the reply, refuse secrets both ways.
 * The proposer half only — the caller must still verify the returned value against ground truth.
 * @template T
 * @param {{prompt:string, parse:(obj:any)=>(T|null), run?:(p:string)=>string}} spec
 * @returns {T|null} the validated proposal, or null on ANY failure (caller keeps deterministic).
 */
export function adjudicate({ prompt, parse, run = buildRunner() }) {
  try {
    if (SECRET_RE.test(String(prompt))) return null; // never send a secret to the model
    const raw = run(prompt);
    if (SECRET_RE.test(String(raw))) return null; // never trust a reply that leaked one back
    const obj = extractJson(raw);
    if (obj == null) return null;
    const parsed = parse(obj);
    return parsed ?? null;
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge adjudicate: ${err?.message ?? err}\n`);
    return null;
  }
}

import { clamp01 } from "./util.js";

/** Coerce an unknown model field to a number in [0,1], or null if it isn't one. */
export function asUnit(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? clamp01(n) : null;
}

/** Coerce an unknown model field to a trimmed, length-capped string (empty → ""). */
export function asText(v, cap = 200) {
  return String(v ?? "")
    .trim()
    .slice(0, cap);
}

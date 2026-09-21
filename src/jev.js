// forge jev — TypeSafe System One (Jev) client. Jev is not a text LLM: it takes a `state`
// plus typed `questions` (choice / score / noul) and returns typed answers with probabilities
// and confidence in ~150ms — the fast proposer for faculties whose judgment is already a
// classification, rating, or yes/no (route's complexity band, preflight's assumption gate).
//
// Same design contract as src/adjudicate.js, restated for a typed API:
//   - OPT-IN. Off unless the LLM layer is enabled (llmEnabled) AND TYPESAFE_API_KEY is set.
//     Without the key every function here returns null and behavior is byte-identical.
//   - FAIL-SAFE. Any error/timeout/non-2xx/garble/secret → null. A null NEVER changes a
//     verdict; callers fall back to the text-LLM proposer, then to the deterministic rubric.
//   - ZERO-DEP. One raw HTTPS POST via the child-process-fetch pattern (src/llm.js) — no SDK.
//     The key travels via the child's env (_FORGE_JEV_KEY) — never in argv, never logged.
// API contract: https://docs.typesafe.ai/api.md
import { spawnSync } from "node:child_process";
import { llmEnabled } from "./adjudicate.js";
import { hasSecret } from "./secrets.js";
import { clamp01 } from "./util.js";

// POST {baseUrl}/v1/systemone, bearer auth. Body arrives on stdin; the key never does.
const HTTP_CHILD = `let raw="";process.stdin.on("data",(d)=>{raw+=d;});process.stdin.on("end",async()=>{try{const{url,payload}=JSON.parse(raw);const key=process.env._FORGE_JEV_KEY||"";const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:JSON.stringify(payload)});if(!res.ok){process.stderr.write("jev: http "+res.status);process.exit(1);}process.stdout.write(JSON.stringify(await res.json()));}catch(e){process.stderr.write("jev: "+(e.message||e));process.exit(1);}});`;

/** The TypeSafe API key from the environment ("" when unset — every call then fail-safes). */
export function jevKey() {
  return process.env.TYPESAFE_API_KEY || "";
}

/** Base URL, overridable for self-hosted/staging endpoints. */
export function jevBaseUrl() {
  return (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
}

/**
 * Is the Jev proposer layer active for this call? Same opt-in as the text-LLM layer
 * (`llmEnabled`) plus the key. One switch governs both proposers; Jev is simply preferred
 * when its credentials exist.
 * @param {{llm?:boolean}} [opts]
 */
export function jevEnabled(opts = {}) {
  return llmEnabled(opts) && Boolean(jevKey());
}

/** A Choice question: pick one option from `criteria` (option → rubric description). */
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });

/** A Noul question: yes/no as a probability 0–1. `criteria` (optional) says what each means. */
export const noul = (instructions, criteria) =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };

/** A Score question: rate along ordered `criteria` levels (probability-weighted value). */
export const score = (instructions, criteria) => ({ type: "score", instructions, criteria });

const isUnit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

// Number(null) is 0 and Number("") is 0, so a null/absent noul used to validate as a confident
// "definitely not" instead of failing safe as no answer at all.
const toNumber = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return Number.NaN;
};

/**
 * Validate one raw answer against its question; returns a clean answer or null.
 * Typed output guarantees the interface, not the values — a Choice naming an option we
 * never offered, or a Noul outside [0,1], is garble and fails safe like any other.
 */
function validateAnswer(question, answer) {
  if (!answer || typeof answer !== "object" || answer.type !== question.type) return null;
  if (question.type === "noul") {
    const n = toNumber(answer.noul);
    if (!Number.isFinite(n)) return null;
    return { type: "noul", noul: clamp01(n) };
  }
  if (question.type === "choice") {
    // Case-insensitive, but resolved back to the option WE offered: an answer of "Mid" is the
    // "mid" we asked about, not garble, while an option we never offered still fails safe.
    const option = (v) =>
      Object.keys(question.criteria).find(
        (k) =>
          k.toLowerCase() ===
          String(v ?? "")
            .trim()
            .toLowerCase(),
      );
    const pick = option(answer.choice);
    if (!pick) return null;
    const out = { type: "choice", choice: pick };
    if (isUnit(answer.confidence)) out.confidence = answer.confidence;
    if (answer.probabilities && typeof answer.probabilities === "object") {
      const probabilities = {};
      for (const [key, p] of Object.entries(answer.probabilities)) {
        const n = toNumber(p);
        const named = option(key);
        if (named && Number.isFinite(n)) probabilities[named] = clamp01(n);
      }
      out.probabilities = probabilities;
    }
    return out;
  }
  if (question.type === "score") {
    const n = toNumber(answer.score);
    if (!Number.isFinite(n)) return null;
    const out = { type: "score", score: n };
    if (isUnit(answer.confidence)) out.confidence = answer.confidence;
    if (answer.legend && typeof answer.legend === "object") out.legend = answer.legend;
    return out;
  }
  return null;
}

/** Synchronous HTTPS round-trip through the child (forge faculties are synchronous). */
function httpCall(payload, timeoutMs) {
  const input = JSON.stringify({ url: `${jevBaseUrl()}/v1/systemone`, payload });
  const r = spawnSync(process.execPath, ["-e", HTTP_CHILD], {
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, _FORGE_JEV_KEY: jevKey() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0 || !r.stdout) {
    throw new Error(r.stderr?.trim() || r.error?.message || "jev call failed");
  }
  return JSON.parse(r.stdout);
}

/**
 * Evaluate `state` against `questions` (one API call — questions run in parallel server-side).
 * Returns `{ model, answers, usage }` with validated answers only, or null on ANY failure.
 * `call` is the injectable transport for tests: (payload) => raw API response object.
 * @param {{state?: string|object|Array, questions?: Record<string, object>, model?: string,
 *          timeoutMs?: number, call?: (payload: object) => object}} spec
 */
export function systemOne({ state, questions, model = "jev-latest", timeoutMs = 5000, call } = {}) {
  try {
    if (!jevKey()) return null;
    if (!questions || typeof questions !== "object" || !Object.keys(questions).length) return null;
    const stateText = typeof state === "string" ? state : JSON.stringify(state);
    if (hasSecret(stateText)) return null; // never send a secret to the model
    const payload = { state, model, questions };
    const raw = call ? call(payload) : httpCall(payload, timeoutMs);
    if (!raw || typeof raw !== "object" || !raw.answers || typeof raw.answers !== "object")
      return null;
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      const a = validateAnswer(q, raw.answers[id]);
      if (a) answers[id] = a;
    }
    if (!Object.keys(answers).length) return null;
    return { model: raw.model ?? model, answers, usage: raw.usage ?? null };
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge jev: ${err?.message ?? err}\n`);
    return null;
  }
}

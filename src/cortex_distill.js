// forge cortex distiller — turn a raw correction episode into a real, useful lesson via a
// cheap model call, instead of the deterministic template. OPT-IN (ENABLE_CORTEX_DISTILL=1)
// and fail-safe: any failure returns null and the caller keeps the template. Zero deps — it
// shells out to the `claude` CLI (same pattern as session-learner.sh); the runner is
// injectable so the pure prompt/parse logic is fully testable without the CLI.
import { execFileSync } from "node:child_process";
import { SECRET_RE } from "./recall.js";

/**
 * Pure: build the distillation prompt from an episode.
 * @param {{context?:{symbols?:string[], files?:string[]}, signals?:string[]}} episode
 */
export function buildPrompt({ context = {}, signals = [] }) {
  const where = context.symbols?.[0] || context.files?.[0] || "some code";
  return `A coding agent just made and then corrected a mistake on this repository.
Observed correction signals: ${signals.join(", ") || "n/a"}.
Location: ${where}.
Write ONE short, durable lesson that would stop this mistake recurring. Respond with STRICT
JSON and nothing else:
{"whatWentWrong":"<concrete, <=140 chars>","correctedBehavior":"<an imperative rule, <=140 chars>"}
Do not include secrets, tokens, keys, or PII. No text outside the JSON object.`;
}

/** Pure: extract {whatWentWrong, correctedBehavior} from model output, or null if unusable. */
export function parseDistilled(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const whatWentWrong = String(obj.whatWentWrong ?? "")
    .trim()
    .slice(0, 200);
  const correctedBehavior = String(obj.correctedBehavior ?? "")
    .trim()
    .slice(0, 200);
  if (!whatWentWrong || !correctedBehavior) return null;
  if (SECRET_RE.test(`${whatWentWrong} ${correctedBehavior}`)) return null; // never persist a secret
  return { whatWentWrong, correctedBehavior };
}

const claudeRun = (prompt, { model = "haiku", timeoutMs = 20000 } = {}) =>
  execFileSync("claude", ["-p", "--model", model], {
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "ignore"],
  });

/** Distill an episode into a lesson body. Returns null on any failure (caller keeps template). */
export function distill(episode, { run = claudeRun } = {}) {
  try {
    return parseDistilled(run(buildPrompt(episode)));
  } catch {
    return null;
  }
}

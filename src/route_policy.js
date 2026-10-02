// forge route policy — what `forge route` does on top of the complexity estimate when an agent
// runs UNATTENDED. Pure: the inputs are the tier route.js already picked, the proposer's vote,
// and the resolved policy (src/orchestration.js); the output is the final tier plus every step
// that moved it, so the decision stays explainable.
//
// Conservative mode (the default) returns the input tier untouched: routing then behaves exactly
// as it always has (whitepaper §5.1 — a model's vote for a HIGHER tier is never applied).
// Unattended mode exists because an agent nobody watches has no cheap retry loop: an
// under-provisioned attempt is not caught by a person and re-run, it burns a whole run. So:
//   1. vote raise   — a proposer's premium vote at p ≥ raiseConfidence raises to the premium tier;
//                     a mid-or-higher vote at p ≥ midConfidence raises to at least mid;
//   2. writes code  — a task that writes code starts at mid (read-only exploration may stay cheap);
//   3. risk floor   — money, auth, secrets, migrations, security: never below the premium tier;
//   4. top-tier gate — the top tier only when the gate allows it AND the deterministic score is at
//                     the top cutoff. Votes and floors never reach it (they stop at premium).
import { TIER_ORDER } from "./model_tiers.js";

// Tier keys by role, from the shipped order (cheap → expensive). "premium" is the highest tier a
// vote or floor may reach; the one above it is the top tier, gated separately.
const [CHEAP, MID, PREMIUM, TOP] = TIER_ORDER;
/** The tier keys the policy reasons about, by role. */
export const POLICY_TIERS = { cheap: CHEAP, mid: MID, premium: PREMIUM, top: TOP };

const rank = (key) => TIER_ORDER.indexOf(key);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which risk categories a task names. A keyword matches as a whole word or phrase,
 * case-insensitive, with an optional plural `s` ("payment" matches "payments", "auth" does not
 * match "author"). Pure.
 * @param {string} task
 * @param {Record<string, string[]>} categories
 * @returns {{category:string, keyword:string}[]} one entry per matching category
 */
export function riskMatches(task, categories = {}) {
  const text = String(task).toLowerCase();
  const out = [];
  for (const [category, words] of Object.entries(categories)) {
    if (!Array.isArray(words)) continue;
    const hit = words.find((w) => {
      const kw = String(w).trim().toLowerCase();
      if (!kw) return false;
      return new RegExp(`(^|[^a-z0-9])${escapeRe(kw)}s?(?=$|[^a-z0-9])`).test(text);
    });
    if (hit) out.push({ category, keyword: hit });
  }
  return out;
}

/**
 * @typedef {object} PolicyInput
 * @property {string} key the tier route.js picked (haiku/sonnet/opus/fable)
 * @property {boolean} detTop the DETERMINISTIC score is at the top tier's cutoff
 * @property {{band:string, confidence:number|null}|null} [vote] the proposer's band and p(band)
 * @property {string} task
 * @property {boolean} [writesCode] default true — only an explicit read-only task may stay cheap
 * @property {boolean} [allowTop] the caller's explicit opt-in to the top tier (--allow-top)
 * @property {ReturnType<typeof import("./orchestration.js").resolveRoutePolicy>} policy
 */

/**
 * Apply the routing policy. Pure.
 * @param {PolicyInput} input
 * @returns {{key:string, base:string, mode:string, steps:{step:string, from:string, to:string,
 *   reason:string}[], risk:{category:string, keyword:string}[], writesCode:boolean,
 *   topTier:{gate:string, allowTop:boolean, allowed:boolean}}}
 */
export function applyRoutePolicy({
  key,
  detTop,
  vote = null,
  task,
  writesCode = true,
  allowTop = false,
  policy,
}) {
  const base = key;
  const gateOpen =
    detTop && (policy.topTier === "auto" || (policy.topTier === "explicit" && allowTop));
  const topTier = { gate: policy.topTier, allowTop, allowed: gateOpen };
  if (policy.mode !== "unattended")
    return { key, base, mode: policy.mode, steps: [], risk: [], writesCode, topTier };
  const risk = policy.riskFloor ? riskMatches(task, policy.riskCategories) : [];
  const steps = [];
  let cur = key;
  const atLeast = (to, step, reason) => {
    if (rank(to) > rank(cur)) {
      steps.push({ step, from: cur, to, reason });
      cur = to;
    }
  };
  // 1. Vote raise: only a vote that carries a probability can clear the bar (the text proposer
  //    reports none, so it never raises). A premium vote under the premium bar still counts as
  //    a vote for at least mid — p(≥ mid) ≥ p(premium).
  const p = typeof vote?.confidence === "number" ? vote.confidence : null;
  if (p !== null && vote?.band === "premium" && p >= policy.raiseConfidence)
    atLeast(PREMIUM, "vote-raise", `proposer voted premium at p=${p.toFixed(2)}`);
  if (p !== null && (vote?.band === "premium" || vote?.band === "mid") && p >= policy.midConfidence)
    atLeast(MID, "vote-raise", `proposer voted ${vote.band} at p=${p.toFixed(2)}`);
  // 2. Writes-code floor.
  if (policy.writesCodeFloor && writesCode)
    atLeast(MID, "writes-code-floor", "task writes code (pass --read-only for exploration)");
  // 3. Risk floor.
  if (risk.length)
    atLeast(
      PREMIUM,
      "risk-floor",
      `risk: ${risk.map((r) => `${r.category} ("${r.keyword}")`).join(", ")}`,
    );
  // 4. Top-tier gate. Only the deterministic score can have picked the top tier (votes and
  //    floors stop at premium); it stays only when the gate is open.
  if (cur === TOP && !gateOpen) {
    steps.push({
      step: "top-tier-gate",
      from: TOP,
      to: PREMIUM,
      reason:
        policy.topTier === "never"
          ? "top tier disabled (route.topTier: never)"
          : "top tier needs --allow-top (route.topTier: explicit)",
    });
    cur = PREMIUM;
  }
  return { key: cur, base, mode: policy.mode, steps, risk, writesCode, topTier };
}

// forge intent — what KIND of work is this prompt asking for? The reference kit used a
// keyword DFA; here classification is the same exemplar k-NN math as route.js (labeled
// rows + overlap coefficient + confidence gate), so intents are tuned by adding example
// rows — including Hinglish ones — never by editing regexes. NOTE: intentGrams is NOT
// route.js contentGrams. Route's STOP set strips generic task verbs (fix/add/build/…)
// because they carry no COMPLEXITY signal — but they are exactly the INTENT signal.
// Same math, different stop-set data.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BRAND } from "./brand.js";
import { sessionPath } from "./cortex_hook.js";
import { setOverlap } from "./math.js";

/** Labeled intent bank — DATA, not decision code. Extend coverage by adding rows. */
export const INTENT_EXEMPLARS = [
  // question — answered directly, no ceremony (System-1 fast path)
  { text: "how does the login flow work", intent: "question" },
  { text: "what does this function do", intent: "question" },
  { text: "why is startup slow", intent: "question" },
  { text: "where is the config loaded from", intent: "question" },
  { text: "explain the difference between these two modules", intent: "question" },
  { text: "is this endpoint rate limited", intent: "question" },
  { text: "what happens when the cache expires", intent: "question" },
  { text: "yeh function kya karta hai", intent: "question" },
  { text: "yeh error kyun aa raha hai", intent: "question" },
  { text: "kaise kaam karta hai yeh module", intent: "question" },
  // bugfix — reproduce → root cause → failing test → fix → sweep
  { text: "fix the crash when saving a profile", intent: "bugfix" },
  { text: "the login page throws a 500 error", intent: "bugfix" },
  { text: "tests are failing after the last merge", intent: "bugfix" },
  { text: "the app crashes on startup", intent: "bugfix" },
  { text: "fix the race condition in the queue", intent: "bugfix" },
  { text: "the button does nothing when clicked", intent: "bugfix" },
  { text: "resolve the null pointer in checkout", intent: "bugfix" },
  { text: "fix the regression introduced by the last change", intent: "bugfix" },
  { text: "payment page thik karo crash ho raha hai", intent: "bugfix" },
  { text: "yeh bug thik karo", intent: "bugfix" },
  { text: "error aa raha hai isko sahi karo", intent: "bugfix" },
  { text: "form submit hone par error deta hai", intent: "bugfix" },
  // feature — spec → acceptance criteria → build with docs in the same pass
  { text: "add a login page with otp", intent: "feature" },
  { text: "implement dark mode for the dashboard", intent: "feature" },
  { text: "add export to csv", intent: "feature" },
  { text: "build a notification system", intent: "feature" },
  { text: "add pagination to the results list", intent: "feature" },
  { text: "implement password reset flow", intent: "feature" },
  { text: "add support for multiple languages", intent: "feature" },
  { text: "naya dashboard banao", intent: "feature" },
  { text: "ek search feature banao", intent: "feature" },
  { text: "profile page bana do", intent: "feature" },
  // refactor — behavior-preserving, tests first, sweep every old name
  { text: "clean up the api module", intent: "refactor" },
  { text: "refactor the payment service into smaller functions", intent: "refactor" },
  { text: "extract the shared logic into a helper", intent: "refactor" },
  { text: "rename the user manager and update the callers", intent: "refactor" },
  { text: "simplify this class hierarchy", intent: "refactor" },
  { text: "restructure the folder layout", intent: "refactor" },
  { text: "reduce duplication across the handlers", intent: "refactor" },
  { text: "modernize this file to async await", intent: "refactor" },
  { text: "code saaf karo is module ka", intent: "refactor" },
  { text: "is code ko behtar banao bina behavior badle", intent: "refactor" },
  // release — gates: changelog, version, tests, docs check
  { text: "ship the release", intent: "release" },
  { text: "cut a new version and update the changelog", intent: "release" },
  { text: "prepare the release notes", intent: "release" },
  { text: "publish the package to npm", intent: "release" },
  { text: "bump the version and tag it", intent: "release" },
  { text: "deploy to production", intent: "release" },
  { text: "get this ready to ship", intent: "release" },
  { text: "roll out the new build", intent: "release" },
  { text: "deploy karo", intent: "release" },
  { text: "release kar do production par", intent: "release" },
];

// Function words ONLY (English + Hinglish auxiliaries/pronouns). Task verbs stay —
// they are the intent signal (see module header).
const STOP = new Set(
  (
    "a an the in on of to for with and or is are be it its this that as at by from into up out " +
    "my your our their please can you i we " +
    "hai hain ho raha rahi ka ki ke ko par mein se aur yeh ye iska isko"
  ).split(" "),
);

const stem = (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

/** Same shape as route.js contentGrams — different stop-set (function words only). */
export function intentGrams(text) {
  const toks = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem);
  const grams = new Set(toks);
  for (let i = 0; i + 1 < toks.length; i++) grams.add(`${toks[i]} ${toks[i + 1]}`);
  return grams;
}

const EXEMPLAR_GRAMS = INTENT_EXEMPLARS.map((e) => ({ ...e, grams: intentGrams(e.text) }));

/**
 * k-NN over the bank: similarity-weighted vote among the top-k neighbors, gated on the
 * best similarity — a prompt resembling nothing in the bank is "none", never a guess.
 * Neighbors ride along so every classification is attributable to its evidence.
 */
export function classifyIntent(text, { k = 3, minConf = 0.25 } = {}) {
  const grams = intentGrams(text);
  if (!grams.size) return { intent: "none", confidence: 0, neighbors: [] };
  const sims = EXEMPLAR_GRAMS.map((e) => ({
    text: e.text,
    intent: e.intent,
    sim: setOverlap(grams, e.grams),
  }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);
  const top = sims[0];
  if (!top || top.sim < minConf)
    return { intent: "none", confidence: top?.sim ?? 0, neighbors: sims };
  const votes = new Map();
  for (const s of sims) votes.set(s.intent, (votes.get(s.intent) ?? 0) + s.sim);
  const [intent] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { intent, confidence: Number(top.sim.toFixed(3)), neighbors: sims };
}

/** Protocol cards — data. `question`/`none` deliberately have no card (no ceremony). */
export const PROTOCOL_CARDS = {
  bugfix: [
    `## Bugfix protocol (${BRAND.brand})`,
    "1. Reproduce first — no fix without a failing observation.",
    "2. Trace the CAUSE, not the symptom (the wrong-status UI is rarely a UI bug).",
    `3. Write the failing test BEFORE the fix; \`${BRAND.cli} diagnose "<error>"\` if this failure has repeated.`,
    `4. \`${BRAND.cli} impact <file>\` — sweep the blast radius (callers, configs, docs).`,
    `5. Full suite green, then \`${BRAND.cli} docs sync\` + \`${BRAND.cli} handoff\` — the gate checks.`,
  ].join("\n"),
  feature: [
    `## Feature protocol (${BRAND.brand})`,
    `1. \`${BRAND.cli} preflight "<task>"\` — answer its questions or record the assumptions.`,
    `2. State acceptance criteria up front (\`${BRAND.cli} handoff --criteria "…"\`).`,
    `3. \`${BRAND.cli} impact\` / \`${BRAND.cli} scope\` before building — know the full artifact list.`,
    "4. Docs, tests, and configs move IN THE SAME PASS as the code, not later.",
    `5. \`${BRAND.cli} verify\` before claiming done.`,
  ].join("\n"),
  refactor: [
    `## Refactor protocol (${BRAND.brand})`,
    "1. Behavior-preserving: capture current behavior with tests FIRST.",
    `2. \`${BRAND.cli} scope <files>\` — find the coupled files you didn't name.`,
    `3. Sweep every old name — code AND prose: \`${BRAND.cli} docs sync\` after the rename.`,
    `4. \`${BRAND.cli} lean\` — keep the footprint proportional to the ask.`,
  ].join("\n"),
  release: [
    `## Release protocol (${BRAND.brand})`,
    "1. Tests + lint green; CHANGELOG has a real [Unreleased] section.",
    `2. \`${BRAND.cli} docs check\` — commands/env/tools tables must match the code.`,
    "3. Version bump + tag; release notes from the changelog.",
    `4. \`${BRAND.cli} verify\` as the final gate before shipping.`,
  ].join("\n"),
};

/**
 * The UserPromptSubmit hook's entry: classify, dedupe per session (a card is injected
 * once per run of the same intent — context economy), kill switch FORGE_INTENT=0.
 * Returns "" whenever there is nothing worth saying (low-nag).
 */
export function intentCard(root, sid, text) {
  if (process.env.FORGE_INTENT === "0") return "";
  const { intent } = classifyIntent(text);
  const card = PROTOCOL_CARDS[intent];
  if (!card) return ""; // question/none: no ceremony
  const marker = sessionPath(root, sid, "intent");
  try {
    if (readFileSync(marker, "utf8").trim() === intent) return "";
  } catch {}
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${intent}\n`);
  } catch {}
  return card;
}

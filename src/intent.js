// Intent is explicit turn metadata, a user-selected protocol, or a previous verified
// task with an operator-supplied workload label. Free text carries no default work label.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BRAND } from "./brand.js";
import { sessionPath } from "./cortex_hook.js";
import { readOutcomes, taskRef } from "./router/index.js";

const dialogueTypes = new Set(["question", "acknowledgement", "continuation"]);

/** @param {string} text @param {{root?:string, intent?:string}} options */
export function classifyIntent(text, { root, intent } = {}) {
  const selected =
    intent ??
    String(text)
      .trim()
      .match(/^\/forge\s+(\S+)(?:\s|$)/u)?.[1];
  const known = (id) => Object.hasOwn(PROTOCOL_CARDS, id) || dialogueTypes.has(id);
  if (selected !== undefined)
    return known(selected)
      ? { intent: selected, source: "explicit", observations: 0 }
      : { intent: "none", source: "unrecognized", observations: 0 };
  if (root) {
    const hash = taskRef(text);
    const observed = readOutcomes(root).filter(
      (row) => row.task === hash && row.provenance === "verify-event" && known(row.workload),
    );
    const labels = new Set(observed.map((row) => row.workload));
    if (labels.size === 1)
      return {
        intent: [...labels][0],
        source: "verified-task-workload",
        observations: observed.length,
      };
    if (labels.size > 1)
      return { intent: "none", source: "conflicting-workloads", observations: observed.length };
  }
  return { intent: "none", source: "unclassified", observations: 0 };
}

export function isDialogueTurn(text, options = {}) {
  return dialogueTypes.has(classifyIntent(text, options).intent);
}

/** The skills and crew agents each kind of work calls for — data. A host with many skills
 *  installed lists a skill by name only, so the card is where the model learns when to load
 *  one. Every name is a shipped skill or crew agent (the test holds it).
 *  @type {Record<string, { skills: Array<[string, string]>, crew: Array<[string, string]> }>} */
export const INTENT_HELPERS = {
  bugfix: {
    skills: [
      ["problem-solver", "root cause"],
      ["self-improve", "a check keeps failing"],
    ],
    crew: [["verifier", "review the fix"]],
  },
  feature: {
    skills: [
      ["explore-plan-code", "multi-file or unfamiliar"],
      ["reuse-first", "before new code"],
      ["tech-selector", "choosing a library"],
      ["ui-workflow", "UI work"],
    ],
    crew: [
      ["scout", "explore"],
      ["verifier", "review the diff"],
      ["frontend-verifier", "UI changes"],
    ],
  },
  refactor: {
    skills: [
      ["forge-impact", "blast radius"],
      ["lean", "smallest change"],
      ["code-modernization", "legacy or migration"],
    ],
    crew: [["independent-reviewer", "before merge"]],
  },
  release: {
    skills: [
      ["forge-verify", "gates before commit or push"],
      ["sync-docs", "stale docs"],
      ["handoff", "when you finish"],
    ],
    crew: [
      ["doc-sync", "many stale docs"],
      ["independent-reviewer", "before merge"],
    ],
  },
};

/** The card's last line: which skills to load and which crew agent to hand work to. */
function helpers(intent) {
  const list = (pairs) => pairs.map(([name, when]) => `${name} (${when})`).join(", ");
  const { skills, crew } = INTENT_HELPERS[intent];
  return `Skills to load: ${list(skills)}. Crew: ${list(crew)}.`;
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
    helpers("bugfix"),
  ].join("\n"),
  feature: [
    `## Feature protocol (${BRAND.brand})`,
    `1. \`${BRAND.cli} preflight "<task>"\` — answer its questions or record the assumptions.`,
    `2. Look before you build: \`${BRAND.cli} reuse query "<what>"\`, then this repo, then a maintained library — and \`${BRAND.cli} vet <ecosystem:name>\` before any new dependency.`,
    `3. State acceptance criteria up front (\`${BRAND.cli} handoff --criteria "…"\`).`,
    `4. \`${BRAND.cli} impact\` / \`${BRAND.cli} scope\` before building — know the full artifact list.`,
    "5. Docs, tests, and configs move IN THE SAME PASS as the code, not later.",
    `6. \`${BRAND.cli} verify\` before claiming done.`,
    helpers("feature"),
  ].join("\n"),
  refactor: [
    `## Refactor protocol (${BRAND.brand})`,
    "1. Behavior-preserving: capture current behavior with tests FIRST.",
    `2. \`${BRAND.cli} scope <files>\` — find the coupled files you didn't name.`,
    `3. Sweep every old name — code AND prose: \`${BRAND.cli} docs sync\` after the rename.`,
    `4. \`${BRAND.cli} lean\` — keep the footprint proportional to the ask.`,
    helpers("refactor"),
  ].join("\n"),
  release: [
    `## Release protocol (${BRAND.brand})`,
    "1. Tests + lint green; CHANGELOG has a real [Unreleased] section.",
    `2. \`${BRAND.cli} docs check\` — commands/env/tools tables must match the code.`,
    "3. Version bump + tag; release notes from the changelog.",
    `4. \`${BRAND.cli} verify\` as the final gate before shipping.`,
    helpers("release"),
  ].join("\n"),
};

/**
 * The UserPromptSubmit hook's entry: classify, dedupe per session (a card is injected
 * once per run of the same intent — context economy), kill switch FORGE_INTENT=0.
 * Returns "" whenever there is nothing worth saying (low-nag).
 */
export function intentCard(root, sid, text, supplied = undefined) {
  if (process.env.FORGE_INTENT === "0") return "";
  const { intent } = supplied ?? classifyIntent(text, { root });
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

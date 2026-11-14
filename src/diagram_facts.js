// Diagram facts — the parts of a diagram that state something the CODE decides (which guards
// run on each hook event, how many tools get a native config, a threshold), bound to the code
// that decides it, so a diagram cannot keep describing last month's behaviour unnoticed.
//
// The diagrams are Archify sources (docs/diagrams/src/<id>.<type>.json): authored layout,
// rendered by a pinned tool in headless Chrome. The layout stays authored. A FACT is one
// string field on one line of a source, found by a marker that appears on exactly that line
// (`"id": "pre-tool"`, a card's `"title": …`). `renderDiagramFacts` rewrites a stale fact in
// place — that field only, every other byte untouched — and names the diagrams that now need
// a re-render (`node scripts/diagrams.mjs build --stale`). `forge docs check` reports drift
// without failing: re-rendering needs Chrome, so the docs-autoupdate workflow does it after a
// merge and opens a PR (docs/diagrams/README.md).
//
// Values are computed from the code at call time, and a module is imported only here, so the
// docs commands that never touch a diagram never load it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";

export const DIAGRAM_SOURCE_DIR = "docs/diagrams/src";

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/** A count as a diagram prints it ("eleven tools"); past twenty, digits. @param {number} n */
export const inWords = (n) => WORDS[n] ?? String(n);

/** How each cortex.sh mode is named in a hook chain; an unknown mode reads `cortex <mode>`.
 *  The pre-edit check is plain "cortex": the PreToolUse line is the longest in the diagram. */
const CORTEX_NAMES = {
  "session-start": "cortex session-start",
  prompt: "cortex prompt",
  preflight: "preflight",
  "pre-edit": "cortex",
  capture: "cortex capture",
  stop: "cortex stop",
};

/**
 * The guards one hook event runs, as the hook-sequence diagram names them: the guard scripts
 * in manifest order (each once), then the cortex steps. Entries are
 * `run.mjs --event <Event> <script> [mode]` (hooks/hooks.json).
 * @param {any} manifest parsed hooks/hooks.json
 * @param {string} event e.g. "PreToolUse"
 * @returns {string[]}
 */
export function hookChain(manifest, event) {
  /** @type {string[]} */
  const guards = [];
  /** @type {string[]} */
  const cortex = [];
  for (const group of manifest?.hooks?.[event] ?? [])
    for (const h of group?.hooks ?? []) {
      const args = Array.isArray(h?.args) ? h.args.map(String) : [];
      const at = args.indexOf("--event");
      const script = at >= 0 ? args[at + 2] : args[0];
      const mode = at >= 0 ? args[at + 3] : args[1];
      if (!script) continue;
      const name = script
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.(?:sh|mjs|js)$/, "");
      if (!name) continue;
      if (name === "cortex") cortex.push(CORTEX_NAMES[mode ?? ""] ?? `cortex ${mode ?? ""}`.trim());
      else guards.push(name);
    }
  return [...new Set([...guards, ...cortex])];
}

/**
 * What the code says today: every value a fact can be bound to.
 * @param {string} codeRoot the package whose code decides (default: this one)
 */
async function codeFacts(codeRoot) {
  const json = (rel) => JSON.parse(readFileSync(join(codeRoot, rel), "utf8"));
  const { NATIVE_CONFIG_TOOLS } = await import("./sync.js");
  const { SERVE_FLOOR } = await import("./reuse.js");
  const { ALL_KINDS } = await import("./semantic_guard.js");
  const { DORMANT_VAL } = await import("./ledger.js");
  const { DEPGATE_THRESHOLDS, CACHE_DAYS, ECOSYSTEMS } = await import("./depgate.js");
  const { HARNESS_MCP_TOOLS } = await import("./harness_mcp.js");
  return {
    harnessMcpNames: HARNESS_MCP_TOOLS.map((tool) => tool.name),
    hooks: json("hooks/hooks.json"),
    minConfidence: json("source/substrate.json").llm?.minConfidence,
    nativeTools: NATIVE_CONFIG_TOOLS.length,
    serveFloor: SERVE_FLOOR,
    guardKinds: /** @type {readonly string[]} */ (ALL_KINDS),
    dormant: DORMANT_VAL,
    // The trusted band starts at the mirror threshold (ledger.js), printed as a 2-place val.
    trusted: Number((1 - DORMANT_VAL).toFixed(2)),
    depgate: {
      ...DEPGATE_THRESHOLDS,
      days: CACHE_DAYS,
      ecosystems: Object.keys(ECOSYSTEMS).length,
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof codeFacts>>} CodeFacts */
/** @typedef {{diagram: string, at: string, field: string, value: (c: CodeFacts) => string}} Fact */

const HOOK_EVENTS = [
  ["session-start", "SessionStart"],
  ["prompt-submit", "UserPromptSubmit"],
  ["pre-tool", "PreToolUse"],
  ["post-tool", "PostToolUse"],
  ["tool-failure", "PostToolUseFailure"],
  ["stop", "Stop"],
];

/** Every bound fact. `diagram` is the source's file name without `.json`. @type {Fact[]} */
export const FACTS = [
  ...HOOK_EVENTS.map(([id, event]) => ({
    diagram: "hook-sequence.sequence",
    at: `"id": "${id}"`,
    field: "label",
    value: (/** @type {CodeFacts} */ c) => `${event}: ${hookChain(c.hooks, event).join(" · ")}`,
  })),
  {
    diagram: "system.architecture",
    at: '"id": "native-configs"',
    field: "label",
    value: (c) => `Native configs for ${inWords(c.nativeTools)} tools`,
  },
  {
    diagram: "supervised-run.workflow",
    at: '"title": "MCP entry points"',
    field: "items[0]",
    value: (c) => c.harnessMcpNames.join(" · "),
  },
  {
    diagram: "reuse-cache.workflow",
    at: '"id": "check"',
    field: "sublabel",
    value: (c) => `serve floor: confidence ≥ ${c.serveFloor}`,
  },
  {
    diagram: "reuse-cache.workflow",
    at: '"title": "Semantic guard"',
    field: "items[0]",
    value: (c) => c.guardKinds.map((k) => (k === "binding" ? "binding (roles)" : k)).join(" · "),
  },
  {
    diagram: "claim-lifecycle.lifecycle",
    at: '"id": "uncertain"',
    field: "sublabel",
    value: (c) => `val ${c.dormant}–${c.trusted}`,
  },
  {
    diagram: "claim-lifecycle.lifecycle",
    at: '"id": "trusted"',
    field: "sublabel",
    value: (c) => `val ≥ ${c.trusted}`,
  },
  {
    diagram: "claim-lifecycle.lifecycle",
    at: '"id": "trusted"',
    field: "tag",
    value: (c) => `reuse serve floor ${c.serveFloor}`,
  },
  {
    diagram: "claim-lifecycle.lifecycle",
    at: '"id": "dormant"',
    field: "sublabel",
    value: (c) => `val < ${c.dormant} · latched`,
  },
  {
    diagram: "claim-lifecycle.lifecycle",
    at: '"id": "fall"',
    field: "label",
    value: (c) => `contradicts: val < ${c.dormant}`,
  },
  {
    diagram: "dep-gate.workflow",
    at: '"id": "parse"',
    field: "sublabel",
    value: (c) => `${inWords(c.depgate.ecosystems)} ecosystems`,
  },
  {
    diagram: "dep-gate.workflow",
    at: '"id": "score-ask"',
    field: "label",
    value: (c) => `≥ ${c.depgate.ask}`,
  },
  {
    diagram: "dep-gate.workflow",
    at: '"id": "score-allow"',
    field: "label",
    value: (c) => `< ${c.depgate.ask} · note ≥ ${c.depgate.note}`,
  },
  {
    diagram: "dep-gate.workflow",
    at: '"id": "allow"',
    field: "sublabel",
    value: (c) => `clean result kept ${c.depgate.days} days`,
  },
  {
    diagram: "llm-reconcile.workflow",
    at: '"id": "verify"',
    field: "sublabel",
    value: (c) => `p ≥ ${c.minConfidence} · rubric band + floors · grep`,
  },
];

const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;

/** The string a field holds on one line: `label`, or the first string of `items[0]`. */
function fieldPattern(field) {
  const item = /^(\w+)\[0\]$/.exec(field);
  return item
    ? new RegExp(String.raw`"${item[1]}":\s*\[\s*${STRING}`)
    : new RegExp(String.raw`"${field}":\s*${STRING}`);
}

/**
 * Read or rewrite one fact in one source text. Pure.
 * @param {string} text the source file's text
 * @param {{at: string, field: string}} fact
 * @param {string} [next] the value to write (omit to only read)
 * @returns {{ok: true, current: string, text: string} | {ok: false, error: string}}
 */
export function factField(text, fact, next) {
  const lines = text.split("\n");
  const hits = lines.flatMap((l, i) => (l.includes(fact.at) ? [i] : []));
  if (hits.length !== 1)
    return {
      ok: false,
      error: `${hits.length ? "more than one line has" : "no line has"} ${fact.at}`,
    };
  const line = lines[hits[0]];
  const m = fieldPattern(fact.field).exec(line);
  if (!m) return { ok: false, error: `the ${fact.at} line has no "${fact.field}" string` };
  const current = JSON.parse(`"${m[1]}"`);
  if (next === undefined || next === current) return { ok: true, current, text };
  const start = m.index + m[0].length - m[1].length - 1;
  lines[hits[0]] =
    line.slice(0, start) + JSON.stringify(next).slice(1, -1) + line.slice(start + m[1].length);
  return { ok: true, current, text: lines.join("\n") };
}

/**
 * Compare every bound fact with the code, and with {write:true} bring the sources up to date.
 * A source that does not exist is skipped (a checkout without the diagrams manages none).
 * @param {string} [root] the tree holding docs/diagrams/src
 * @param {{write?: boolean, codeRoot?: string}} [opts]
 * @returns {Promise<{drift: {file: string, at: string, field: string, current: string,
 *   expected: string}[], errors: {file: string, at: string, field: string, error: string}[],
 *   changed: string[]}>} `changed`: the diagram ids whose source was rewritten
 */
export async function renderDiagramFacts(root = BRAND.root, { write = false, codeRoot } = {}) {
  const code = await codeFacts(codeRoot ?? BRAND.root);
  const drift = [];
  const errors = [];
  /** @type {Map<string, {text: string, orig: string}>} */
  const sources = new Map();
  for (const fact of FACTS) {
    const file = `${DIAGRAM_SOURCE_DIR}/${fact.diagram}.json`;
    if (!sources.has(file)) {
      const abs = join(root, file);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      sources.set(file, { text, orig: text });
    }
    const src = /** @type {{text: string, orig: string}} */ (sources.get(file));
    const expected = fact.value(code);
    const r = factField(src.text, fact, expected);
    if ("error" in r) {
      errors.push({ file, at: fact.at, field: fact.field, error: r.error });
      continue;
    }
    if (r.current !== expected) {
      drift.push({ file, at: fact.at, field: fact.field, current: r.current, expected });
      src.text = r.text;
    }
  }
  const changed = [];
  for (const [file, src] of sources)
    if (src.text !== src.orig) {
      changed.push(file.slice(DIAGRAM_SOURCE_DIR.length + 1).split(".")[0]);
      if (write) writeFileSync(join(root, file), src.text);
    }
  return { drift, errors, changed };
}

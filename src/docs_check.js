// forge docs — docs↔code drift reconcilers. Every check compares a DOCUMENT CLAIM
// against the SOURCE OF TRUTH that already exists in code (the commands.js table, the
// cortex_mcp TOOLS registry, actual process.env reads, package.json + git history), so
// a feature can no longer ship without its docs and the gap silently accumulate — the
// exact failure that let a whole command family go undocumented. Self-check: it runs
// against the forge package root (BRAND.root), not the host repo.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { BRAND } from "./brand.js";
import { COMMANDS, HIDDEN_COMMANDS } from "./commands.js";
import { TOOLS } from "./mcp_tools.js";
import { MODELS } from "./model_tiers.js";

/** The user-facing prose docs every claim is reconciled against. */
const DOC_FILES = [
  "README.md",
  "docs/GUIDE.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
];

// Env vars read in src that are NOT user-facing contract: child-process plumbing and
// values injected by host tools rather than set by users.
const INTERNAL_ENV = new Set([
  "_FORGE_LLM_KEY",
  "FORGE_EMBED_KEY",
  "CLAUDE_PLUGIN_ROOT",
]);

// Prefixes that mark an env var as OURS to document. A doc may freely mention other
// tools' vars (GITHUB_TOKEN, PATH) — those aren't claims about forge's own surface.
const ENV_PREFIX_RE =
  /\b((?:FORGE|ANTHROPIC|LITELLM|OPENROUTER|ENABLE_CORTEX)_[A-Z0-9_]+)\b/g;

function readDoc(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function srcFiles(root) {
  const dir = join(root, "src");
  if (!existsSync(dir)) return [];
  // recursive: src/emit/*.js reads are part of the same env contract.
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, f));
}

/** Every env var name the package actually reads: process.env.X in src/*.js plus
 *  $X / ${X...} in the shell guards (they are part of the same env contract). */
export function envVarsRead(root = BRAND.root) {
  const vars = new Set();
  for (const file of srcFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g))
      vars.add(m[1]);
    for (const m of text.matchAll(
      /process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g,
    ))
      vars.add(m[1]);
  }
  const guards = join(root, "global", "guards");
  if (existsSync(guards)) {
    for (const f of readdirSync(guards).filter((f) => f.endsWith(".sh"))) {
      const text = readFileSync(join(guards, f), "utf8");
      // Only forge-contract prefixes: a guard's own ALL-CAPS locals ($INPUT, $DIR)
      // are shell internals, not env surface the docs owe anyone.
      for (const m of text.matchAll(
        /\$\{?((?:FORGE|ANTHROPIC|LITELLM|OPENROUTER|ENABLE_CORTEX|CLAUDE)_[A-Z0-9_]*)/g,
      ))
        vars.add(m[1]);
    }
  }
  return vars;
}

/** Commands table vs README/GUIDE: every command documented, nothing phantom. */
function checkCommands(docs, issues) {
  for (const target of ["README.md", "docs/GUIDE.md"]) {
    const text = docs[target];
    if (!text) continue;
    for (const name of Object.keys(COMMANDS)) {
      // BRAND.cli, not a literal: after a rebrand the docs say `<newcli> <cmd>` and
      // this check must follow them or every command reports as undocumented.
      if (!new RegExp(`\\b${BRAND.cli} ${name}\\b`).test(text)) {
        issues.push({
          check: "commands",
          severity: "error",
          detail: `\`${BRAND.cli} ${name}\` is implemented but ${target} never mentions it`,
        });
      }
    }
  }
  for (const [file, text] of Object.entries(docs)) {
    for (const m of text.matchAll(
      new RegExp(`\`${BRAND.cli} ([a-z][a-z-]*)\\b`, "g"),
    )) {
      const name = m[1];
      if (!(name in COMMANDS) && !HIDDEN_COMMANDS.includes(name)) {
        issues.push({
          check: "commands",
          severity: "error",
          detail: `${file} documents \`${BRAND.cli} ${name}\` but no such command exists`,
        });
      }
    }
  }
}

/** Env vars: everything src reads is documented; everything docs name is real. */
function checkEnvVars(root, docs, issues) {
  const read = envVarsRead(root);
  const prose = Object.values(docs).join("\n");
  for (const v of read) {
    if (INTERNAL_ENV.has(v)) continue;
    if (!prose.includes(v)) {
      issues.push({
        check: "env-vars",
        severity: "error",
        detail: `src reads ${v} but no prose doc (${DOC_FILES.join(", ")}) documents it`,
      });
    }
  }
  const documented = new Set();
  for (const [file, text] of Object.entries(docs)) {
    for (const m of text.matchAll(ENV_PREFIX_RE)) {
      if (
        !documented.has(`${file}:${m[1]}`) &&
        !read.has(m[1]) &&
        !INTERNAL_ENV.has(m[1])
      ) {
        documented.add(`${file}:${m[1]}`);
        issues.push({
          check: "env-vars",
          severity: "error",
          detail: `${file} documents ${m[1]} but nothing in src reads it (phantom var)`,
        });
      }
    }
  }
}

/** MCP tools: documented counts match the registry; every tool name appears somewhere. */
function checkMcpTools(docs, issues) {
  const actual = TOOLS.length;
  for (const [file, text] of Object.entries(docs)) {
    for (const m of text.matchAll(/(\d+)\s+MCP tools\b/gi)) {
      if (Number(m[1]) !== actual) {
        issues.push({
          check: "mcp-tools",
          severity: "error",
          detail: `${file} claims ${m[1]} MCP tools; the registry serves ${actual}`,
        });
      }
    }
  }
  const prose = Object.values(docs).join("\n");
  for (const t of TOOLS) {
    if (!prose.includes(t.name)) {
      issues.push({
        check: "mcp-tools",
        severity: "error",
        detail: `MCP tool ${t.name} is served but never documented`,
      });
    }
  }
}

const git = (root, args) => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

/** Every tracked Markdown file, so diagram checks cover the WHOLE doc set — not just the
 *  four prose docs. Falls back to a recursive walk when git is unavailable (tmp fixtures). */
function markdownFiles(root) {
  const tracked = git(root, ["ls-files", "*.md"]);
  if (tracked) return tracked.split("\n").filter(Boolean);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter(
      (f) =>
        f.endsWith(".md") &&
        !f.includes("node_modules") &&
        !f.startsWith(".git/"),
    );
}

// The branded Mermaid theme every diagram shares (see README's `%%{init …}%%`). Without it
// GitHub renders Mermaid's default lavender, clashing with the ember/near-black identity.
const MERMAID_BLOCK_RE = /```mermaid\n([\s\S]*?)```/g;

/**
 * Diagram hygiene across ALL tracked Markdown: every ```mermaid block must (a) carry the
 * branded `%%{init` theme directive, and (b) use `<br/>` — never a literal `\n`, which
 * GitHub's renderer shows as garbage instead of a line break. This is the guard that keeps
 * "the diagrams look bad" from silently recurring; nothing else reconciled diagram quality.
 */
function checkDiagrams(root, issues) {
  for (const rel of markdownFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(MERMAID_BLOCK_RE)) {
      // An intentional example block (e.g. docs showing what a BAD diagram looks like) opts
      // out with an HTML comment `<!-- docs-check-ignore -->` on the line before the fence.
      if (
        /docs-check-ignore/.test(text.slice(Math.max(0, m.index - 80), m.index))
      )
        continue;
      const block = m[1];
      if (!block.includes("%%{init")) {
        issues.push({
          check: "diagrams",
          severity: "error",
          detail: `${rel}: a mermaid diagram has no branded \`%%{init\` theme — it renders in Mermaid's off-brand default`,
        });
      }
      if (block.includes("\\n")) {
        issues.push({
          check: "diagrams",
          severity: "error",
          detail: `${rel}: a mermaid node uses a literal \`\\n\` (GitHub renders it as garbage) — use \`<br/>\``,
        });
      }
    }
  }
}

/** CHANGELOG: latest release header matches package.json; no empty release sections;
 *  [Unreleased] must not be empty while src has commits the changelog hasn't seen. */
function checkChangelog(root, issues) {
  const text = readDoc(root, "CHANGELOG.md");
  if (!text) return;
  const sections = [
    ...text.matchAll(
      /^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## \[|\n*$(?![\s\S]))/gm,
    ),
  ];
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  const released = sections.filter((s) => s[1].toLowerCase() !== "unreleased");
  if (released.length && released[0][1] !== version) {
    issues.push({
      check: "changelog",
      severity: "error",
      detail: `CHANGELOG's latest release is [${released[0][1]}] but package.json is ${version}`,
    });
  }
  for (const [, name, body] of released) {
    if (!body.trim()) {
      issues.push({
        check: "changelog",
        severity: "error",
        detail: `CHANGELOG section [${name}] is an empty header — released work is unrecorded`,
      });
    }
  }
  const unreleased = sections.find((s) => s[1].toLowerCase() === "unreleased");
  if (unreleased && !unreleased[2].trim()) {
    const srcT = Number(
      git(root, ["log", "-1", "--format=%ct", "--", "src"]) || 0,
    );
    const clT = Number(
      git(root, ["log", "-1", "--format=%ct", "--", "CHANGELOG.md"]) || 0,
    );
    if (srcT && clT && srcT > clT) {
      issues.push({
        check: "changelog",
        severity: "error",
        detail:
          "src changed since CHANGELOG.md was last touched, but [Unreleased] is empty",
      });
    }
  }
}

/**
 * Model tiers: every `$in/$out per M tok` price in the docs must equal SOME model's price in
 * `src/model_tiers.json`. We deliberately do NOT attribute a price to a specific nearby model
 * — comparative prose ("Sonnet costs more than Haiku: $3/$15") makes proximity unreliable and
 * would false-positive — so a price is flagged only when it matches no current model at all
 * (the actual failure mode: a figure that went stale to a value the table no longer has).
 */
function checkModelTiers(docs, issues) {
  const models = Object.values(MODELS);
  const PRICE_RE = /\$(\d+)\/\$(\d+)\s*per\s*M\s*tok/gi;
  for (const [file, text] of Object.entries(docs)) {
    for (const m of text.matchAll(PRICE_RE)) {
      const inC = Number(m[1]);
      const outC = Number(m[2]);
      if (!models.some((mo) => mo.inCost === inC && mo.outCost === outC)) {
        issues.push({
          check: "model-tiers",
          severity: "error",
          detail: `${file}: price $${inC}/$${outC} per M tok matches no model in src/model_tiers.json (stale price?)`,
        });
      }
    }
  }
}

/** Every timing value measured in reports/benchmarks.md's table (median + p95 cells). */
function measuredTimings(root) {
  const set = new Set();
  for (const line of readDoc(root, "reports/benchmarks.md").split("\n")) {
    if (!line.startsWith("|")) continue; // table rows only — not the prose above it
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)\s*(ms|µs|s)\b/g))
      set.add(`${m[1]} ${m[2]}`);
  }
  return set;
}

/**
 * Benchmarks: every `N ms` value inside a **single bold run** in the README must be a number
 * reports/benchmarks.md actually measured (the same file the status page reads). Stops
 * "**118 ms**"-style figures from drifting away from the measured table — the "outdated
 * numbers" complaint. Matching one bold run at a time (`[^*]+`, never across a `**` boundary)
 * avoids the sandwich bug where a closing `**` pairs with the next opening `**` and captures
 * the plain prose between them. Only runs when a benchmark table exists.
 */
function checkBenchmarks(root, docs, issues) {
  const measured = measuredTimings(root);
  if (!measured.size) return;
  const readme = docs["README.md"] || "";
  for (const bold of readme.matchAll(/\*\*([^*]+)\*\*/g)) {
    const run = bold[1];
    for (const m of run.matchAll(/(\d+(?:\.\d+)?)\s*ms\b/g)) {
      const num = `${m[1]} ms`;
      if (measured.has(num)) continue;
      issues.push({
        check: "benchmarks",
        severity: "error",
        detail: `README claims "${run.trim()}" but no row in reports/benchmarks.md measures ${num}`,
      });
    }
  }
}

// GitHub-style heading→anchor slug: lowercase, drop backticks, strip punctuation (keep word
// chars/spaces/hyphens), spaces→hyphens. Close enough to GitHub's own algorithm for the intra-repo
// links these docs use; we only ever FLAG a miss, so a rare slug mismatch degrades to a false
// alarm we'd see immediately, never a silent wrong link.
function headingSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-"); // each space → one hyphen; GitHub does NOT collapse (an em-dash between
  // two words becomes "--", not "-"), so consecutive spaces must map 1:1.
}

// Every anchor a Markdown file EXPOSES: heading slugs plus explicit ids authors add
// (`<a id=…>`, `name=…`, or a `{#custom-id}` suffix).
function anchorsFor(text) {
  const set = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm))
    set.add(headingSlug(m[1]));
  for (const m of text.matchAll(/\b(?:id|name)=["']([\w-]+)["']/g))
    set.add(m[1].toLowerCase());
  for (const m of text.matchAll(/\{#([\w-]+)\}/g)) set.add(m[1].toLowerCase());
  return set;
}

/**
 * Intra-repo link hygiene: every Markdown link with an `#anchor` (same-file `#x` or a
 * `path.md#x` cross-reference) must resolve to a heading/anchor that actually exists in the
 * target. This is the guard that kills the "[README → Install](#install)" class of silent dead
 * links — a heading gets renamed, the anchor rots, and nothing noticed until now. External URLs
 * and non-Markdown targets (.html/.pdf/code) are skipped; a missing target file is left to other
 * checks. Only a genuine unresolved anchor is flagged.
 */
function checkLinks(root, issues) {
  const cache = new Map();
  const anchorsOf = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let a = null;
    try {
      a = anchorsFor(readFileSync(join(root, rel), "utf8"));
    } catch {
      a = null;
    }
    cache.set(rel, a);
    return a;
  };
  for (const rel of markdownFiles(root)) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    // Strip fenced code blocks so link SYNTAX shown in an example (```md … [x](#y) …```) isn't
    // scanned as a live link — that would false-positive on documentation about links.
    const prose = text.replace(/```[\s\S]*?```/g, "");
    for (const m of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = m[1].trim();
      if (/^https?:/i.test(href)) continue; // external
      const hash = href.indexOf("#");
      if (hash < 0) continue; // no anchor to resolve
      const path = href.slice(0, hash);
      const anchor = href.slice(hash + 1).toLowerCase();
      if (!anchor) continue;
      let targetRel;
      if (!path)
        targetRel = rel; // same-file anchor
      else if (path.endsWith(".md"))
        targetRel = normalize(join(dirname(rel), path));
      else continue; // .html/.pdf/code target — can't resolve headings, skip
      const anchors = anchorsOf(targetRel);
      if (anchors == null) continue; // unreadable/missing target — file existence is another matter
      if (!anchors.has(anchor)) {
        issues.push({
          check: "links",
          severity: "error",
          detail: `${rel}: link \`${href}\` points to #${anchor}, which is not a heading in ${targetRel}`,
        });
      }
    }
  }
}

/**
 * ROADMAP freshness: the "## Now" marker must not name a version behind package.json. A roadmap
 * that still says "Now (v0.8.1+)" two releases after 0.10.0 shipped is the "docs are outdated"
 * complaint in miniature — this makes it a CI failure the moment a release laps the roadmap.
 */
function checkRoadmap(root, issues) {
  const text = readDoc(root, "ROADMAP.md");
  if (!text) return;
  const now = text.match(/##\s+Now\b[^\n]*/i);
  if (!now) return;
  const vm = now[0].match(/v(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!vm) return;
  const road = [Number(vm[1]), Number(vm[2]), Number(vm[3] || 0)];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .version.split(".")
    .map(Number);
  const behind =
    road[0] < pkg[0] ||
    (road[0] === pkg[0] &&
      (road[1] < pkg[1] || (road[1] === pkg[1] && road[2] < pkg[2])));
  if (behind) {
    issues.push({
      check: "roadmap",
      severity: "error",
      detail: `ROADMAP's "Now" marker says v${road.join(".")} but package.json is ${pkg.join(".")} — the roadmap trails the shipped release`,
    });
  }
}

/**
 * Run every reconciler against the forge package tree.
 * @param {{root?: string}} [opts]
 * @returns {{ok: boolean, issues: {check:string, severity:string, detail:string}[], checked: string[]}}
 */
export function docsCheck({ root = BRAND.root } = {}) {
  const docs = Object.fromEntries(DOC_FILES.map((f) => [f, readDoc(root, f)]));
  const issues = [];
  checkCommands(docs, issues);
  checkEnvVars(root, docs, issues);
  checkMcpTools(docs, issues);
  checkChangelog(root, issues);
  checkDiagrams(root, issues);
  checkModelTiers(docs, issues);
  checkBenchmarks(root, docs, issues);
  checkLinks(root, issues);
  checkRoadmap(root, issues);
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    checked: [
      "commands",
      "env-vars",
      "mcp-tools",
      "changelog",
      "diagrams",
      "model-tiers",
      "benchmarks",
      "links",
      "roadmap",
    ],
  };
}

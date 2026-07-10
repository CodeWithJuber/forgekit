// forge docs — docs↔code drift reconcilers. Every check compares a DOCUMENT CLAIM
// against the SOURCE OF TRUTH that already exists in code (the commands.js table, the
// cortex_mcp TOOLS registry, actual process.env reads, package.json + git history), so
// a feature can no longer ship without its docs and the gap silently accumulate — the
// exact failure that let a whole command family go undocumented. Self-check: it runs
// against the forge package root (BRAND.root), not the host repo.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { COMMANDS, HIDDEN_COMMANDS } from "./commands.js";
import { TOOLS } from "./mcp_tools.js";

/** The user-facing prose docs every claim is reconciled against. */
const DOC_FILES = ["README.md", "docs/GUIDE.md", "ARCHITECTURE.md", "ROADMAP.md"];

// Env vars read in src that are NOT user-facing contract: child-process plumbing and
// values injected by host tools rather than set by users.
const INTERNAL_ENV = new Set(["_FORGE_LLM_KEY", "FORGE_EMBED_KEY", "CLAUDE_PLUGIN_ROOT"]);

// Prefixes that mark an env var as OURS to document. A doc may freely mention other
// tools' vars (GITHUB_TOKEN, PATH) — those aren't claims about forge's own surface.
const ENV_PREFIX_RE = /\b((?:FORGE|ANTHROPIC|LITELLM|OPENROUTER|ENABLE_CORTEX)_[A-Z0-9_]+)\b/g;

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
    for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) vars.add(m[1]);
    for (const m of text.matchAll(/process\.env\[["']([A-Z_][A-Z0-9_]*)["']\]/g)) vars.add(m[1]);
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
    for (const m of text.matchAll(new RegExp(`\`${BRAND.cli} ([a-z][a-z-]*)\\b`, "g"))) {
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
      if (!documented.has(`${file}:${m[1]}`) && !read.has(m[1]) && !INTERNAL_ENV.has(m[1])) {
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

/** CHANGELOG: latest release header matches package.json; no empty release sections;
 *  [Unreleased] must not be empty while src has commits the changelog hasn't seen. */
function checkChangelog(root, issues) {
  const text = readDoc(root, "CHANGELOG.md");
  if (!text) return;
  const sections = [
    ...text.matchAll(/^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## \[|\n*$(?![\s\S]))/gm),
  ];
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
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
    const srcT = Number(git(root, ["log", "-1", "--format=%ct", "--", "src"]) || 0);
    const clT = Number(git(root, ["log", "-1", "--format=%ct", "--", "CHANGELOG.md"]) || 0);
    if (srcT && clT && srcT > clT) {
      issues.push({
        check: "changelog",
        severity: "error",
        detail: "src changed since CHANGELOG.md was last touched, but [Unreleased] is empty",
      });
    }
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
  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    checked: ["commands", "env-vars", "mcp-tools", "changelog"],
  };
}

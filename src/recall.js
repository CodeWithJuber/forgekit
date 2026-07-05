// forge recall — file-based cross-session memory: one fact per file + a MEMORY.md
// index. Refuses to persist secrets. Consolidation is deterministic (exact-dupe
// prune) — honest: no model call, so it can't hallucinate a "merged" memory.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Anything matching this is refused — store a pointer to where the secret lives instead.
// Conservative (over-refusal is the safe direction for a memory tool). Covers the
// key formats this tool's own users paste most: Anthropic sk-ant-, OpenAI sk-,
// GitHub ghp_/github_pat_, Slack xox*, Google AIza/ya29, AWS AKIA, JWTs, PEM blocks.
const SECRET_RE =
  /(-----BEGIN |api[_-]?key|secret|passwd|password|\bghp_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,}|\bya29\.[A-Za-z0-9._-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16})/i;

export function defaultStore() {
  return join(process.env.FORGE_HOME || join(homedir(), ".forge"), "recall");
}

const factsDir = (store) => join(store, "facts");
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export function add(store, name, body) {
  if (SECRET_RE.test(`${name}\n${body}`)) {
    return {
      ok: false,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  }
  const dir = factsDir(store);
  mkdirSync(dir, { recursive: true });
  const slug = slugify(name) || "fact";
  writeFileSync(join(dir, `${slug}.md`), `# ${name}\n\n${body.trim()}\n`);
  reindex(store);
  return { ok: true, slug };
}

export function list(store) {
  const dir = factsDir(store);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

export function reindex(store) {
  const items = list(store);
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, "MEMORY.md"),
    ["# Durable memory index", "", ...items.map((s) => `- ${s}`), ""].join("\n"),
  );
  return items.length;
}

export function consolidate(store) {
  const dir = factsDir(store);
  if (!existsSync(dir)) return { removed: 0, kept: 0 };
  const seen = new Map();
  let removed = 0;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    // Dedupe on the fact BODY (after the "# title" line), so two facts with
    // different names but identical content collapse to one.
    const raw = readFileSync(join(dir, file), "utf8");
    const sep = raw.indexOf("\n\n");
    const key = (sep >= 0 ? raw.slice(sep + 2) : raw).replace(/\s+/g, " ").trim();
    if (seen.has(key)) {
      rmSync(join(dir, file));
      removed += 1;
    } else seen.set(key, file);
  }
  reindex(store);
  return { removed, kept: seen.size };
}

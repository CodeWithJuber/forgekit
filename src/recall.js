// forge recall — file-based cross-session memory: one fact per file + a MEMORY.md
// index. Refuses to persist secrets. Consolidation is deterministic (exact-dupe
// prune) — honest: no model call, so it can't hallucinate a "merged" memory.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Secret-refusal now lives in the PCM ledger core (ledger.js) so NO claim kind can
// persist a credential; re-exported here because recall is where callers historically
// imported it from (lessons_store, guards, tests). See ledger.js for the precision
// rationale (credential formats + key-assigned-to-value, never a bare English mention).
import { SECRET_RE } from "./ledger.js";

export { SECRET_RE };

export function defaultStore() {
  return join(process.env.FORGE_HOME || join(homedir(), ".forge"), "recall");
}

const factsDir = (store) => join(store, "facts");

import { slug as slugify } from "./util.js";

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

/** Parse one stored fact back into {name, text} — THE parser for the fact format
 *  (`# name\n\ntext`), CRLF-tolerant so a Windows checkout can't fork the format.
 *  Everything that reads fact files (bridge import, consolidation) must use this. */
export function readFact(store, slug) {
  const path = join(factsDir(store), `${slug}.md`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^# (.*)\n\n([\s\S]*)$/);
  return m ? { name: m[1].trim(), text: m[2].trim() } : { name: slug, text: raw.trim() };
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

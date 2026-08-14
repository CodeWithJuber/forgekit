// forge recall — file-based cross-session memory: one fact per file + a MEMORY.md
// index. Refuses to persist secrets. Consolidation is deterministic (exact-dupe
// prune) — honest: no model call, so it can't hallucinate a "merged" memory.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// The merged read helper (P2 read flip).
import { ledgerFacts, mergeFactSlugs } from "./ledger_read.js";
// Secret-refusal lives in secrets.js (format grammars + entropy gate) so no store —
// and no shell guard — can disagree. Callers import hasSecret directly from secrets.js
// (it is the one source of truth); recall no longer re-exports it, which previously
// created a needless ledger_read → lessons_store → recall import cycle.
import { hasSecret } from "./secrets.js";

export function defaultStore() {
  // Mutable personal memory. FORGE_HOME override wins (tests + recall-load.sh rely on it);
  // otherwise the XDG state dir — NEVER inside the install/source tree (P0-03). The old
  // default (~/.forge) was symlinked by install.sh into the clone, leaking personal facts
  // into the repo working tree.
  if (process.env.FORGE_HOME) return join(process.env.FORGE_HOME, "recall");
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "forgekit") : join(homedir(), ".local", "state", "forgekit");
  return join(base, "recall");
}

const factsDir = (store) => join(store, "facts");

import { ledgerOnly, slug as slugify } from "./util.js";

export function add(store, name, body) {
  if (hasSecret(`${name}\n${body}`)) {
    return {
      ok: false,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  }
  const slug = slugify(name) || "fact";
  // Legacy-store retirement: under FORGE_LEDGER_ONLY skip the fact file — the caller
  // shadows the fact into the ledger (`forge recall add`/`remember`), and readFact/list
  // resolve it from there. reindex still rebuilds MEMORY.md (a projection, not a store).
  if (!ledgerOnly()) {
    const dir = factsDir(store);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), `# ${name}\n\n${body.trim()}\n`);
  }
  reindex(store);
  return { ok: true, slug };
}

/** Parse one stored fact back into {name, text} — THE parser for the fact format
 *  (`# name\n\ntext`), CRLF-tolerant so a Windows checkout can't fork the format.
 *  Everything that reads fact files (bridge import, consolidation) must use this. */
export function readFact(store, slug) {
  const path = join(factsDir(store), `${slug}.md`);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    const m = raw.match(/^# (.*)\n\n([\s\S]*)$/);
    return m ? { name: m[1].trim(), text: m[2].trim() } : { name: slug, text: raw.trim() };
  }
  // No file — resolve from the ledger this store shadows into. Covers a merged teammate
  // fact and, under FORGE_LEDGER_ONLY, the fact's only home. null when neither has it.
  const f = ledgerFacts(join(store, "ledger")).find((x) => x.slug === slug);
  return f ? { name: f.name, text: f.text } : null;
}

/** File-backed fact slugs ONLY — the store the write path (add/consolidate) manages.
 *  The ledger bridge reconciles against THIS list: a merged teammate fact has no file,
 *  and treating it as "deleted from the store" would tombstone it away. */
export function listStored(store) {
  const dir = factsDir(store);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/** The read view (P2 read flip): file facts ∪ live facts from the personal ledger this
 *  store shadows into (`<store>/ledger` — see `forge recall add`). A file wins on slug
 *  collision (the file is the canonical local value). */
export function list(store) {
  return mergeFactSlugs(listStored(store), join(store, "ledger"));
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

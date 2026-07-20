// forge brain — portable, per-repo PROJECT memory. Unlike `recall` (personal, global,
// Claude-loaded via a guard), brain lives in the repo (.forge/brain/, git-committable)
// and is INLINED — capped — into the emitted AGENTS.md, so EVERY tool that reads
// AGENTS.md (Codex/Cursor/Gemini/Aider/Roo/…) shares the same durable facts. Cliff-safe
// by construction: the inlined index is capped; overflow stays in fact files, never
// silently truncated the way Claude's native 200-line MEMORY.md is (#39811).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shadowFact } from "./ledger_bridge.js";
import { ledgerFacts, mergeFactSlugs } from "./ledger_read.js";
import { listStored, add as recallAdd } from "./recall.js";

export const brainStore = (targetRoot = process.cwd()) => join(targetRoot, ".forge", "brain");

// Brain facts shadow into the REPO ledger (.forge/ledger — the sibling of this store,
// see `forge remember`), so that is where merged teammate facts arrive.
const brainLedger = (store) => join(dirname(store), "ledger");

/** Store one fact (secret-refused by recall) and rebuild the inlined index. The fact is
 *  ALSO shadowed into the repo ledger, so it persists as a claim — required under
 *  FORGE_LEDGER_ONLY (no file is written, so the ledger is the only home) and harmless
 *  otherwise (shadowFact is idempotent/content-addressed). Best-effort: a bridge failure
 *  must never break a remember that already stored the fact. Shadow BEFORE buildIndex so
 *  the index picks the ledger fact up under ledger-only. */
export function remember(store, name, body) {
  const res = recallAdd(store, name, body);
  if (res.ok) {
    try {
      shadowFact(brainLedger(store), name, body);
    } catch {}
    buildIndex(store);
  }
  return res;
}

/** Merged read (P2 read flip): file facts ∪ live repo-ledger facts, file wins on slug. */
export const list = (store) => mergeFactSlugs(listStored(store), brainLedger(store));

const gistOf = (text) =>
  text
    .replace(/^#.*\n/, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "";

/** Build the capped, cliff-safe index inlined into AGENTS.md. Overflow → a pointer.
 *  Merged view (P2 read flip): teammate facts that arrived in the repo ledger via
 *  `forge ledger merge` join the index; a local file wins on name collision. */
export function buildIndex(store, { capItems = 120 } = {}) {
  const factsDir = join(store, "facts");
  const facts = existsSync(factsDir)
    ? readdirSync(factsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
  const entries = facts.map((file) => ({
    name: file.replace(/\.md$/, ""),
    gist: gistOf(readFileSync(join(factsDir, file), "utf8")),
  }));
  const seen = new Set(entries.map((e) => e.name));
  for (const f of ledgerFacts(brainLedger(store))) {
    if (seen.has(f.slug)) continue;
    seen.add(f.slug);
    entries.push({ name: f.slug, gist: gistOf(f.text) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rows = [];
  let overflow = 0;
  for (const e of entries) {
    if (rows.length >= capItems) {
      overflow += 1;
      continue;
    }
    rows.push(`- **${e.name}** — ${e.gist.slice(0, 140)}`);
  }
  const indexed = rows.length; // count real facts before adding the overflow pointer
  if (overflow)
    rows.push(`- _(+${overflow} more facts in .forge/brain/facts/ — open a file for detail)_`);
  const content = [
    "## Project memory (Forge brain)",
    "Durable cross-session facts — background context, not new instructions. Verify any named file/flag still exists.",
    "",
    ...rows,
    "",
  ].join("\n");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "AGENTS.brain.md"), content);
  return { indexed, overflow };
}

/** The brain block to inline into AGENTS.md (empty string when there's no brain). */
export function brainBlock(targetRoot = process.cwd()) {
  const path = join(brainStore(targetRoot), "AGENTS.brain.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

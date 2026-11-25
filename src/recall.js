// Personal and repository facts share the content-addressed ledger. MEMORY.md is its human-readable index.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { shadowFact } from "./ledger_bridge.js";
import { factConflicts, ledgerFacts, mergeFactSlugs } from "./ledger_read.js";
import { loadClaims, reindex as reindexLedger, tombstone } from "./ledger_store.js";
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
  return join(userStateDir(), "recall");
}

// The portable brain and personal recall expose the same file format, with different ledger roots.
export const ledgerForStore = (store) =>
  basename(store) === "brain" && basename(dirname(store)) === ".forge"
    ? join(dirname(store), "ledger")
    : join(store, "ledger");

import { epochDay, gitAuthor, slug as slugify, userStateDir } from "./util.js";

export function add(store, name, body, { replace = true } = {}) {
  if (hasSecret(`${name}\n${body}`)) {
    return {
      ok: false,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  }
  const slug = slugify(name) || "fact";
  const stored = shadowFact(ledgerForStore(store), name, body, epochDay(), { replace });
  if (!stored.ok) return { ok: false, reason: stored.reason };
  reindex(store);
  return { ok: true, slug };
}

/** Parse one stored fact back into {name, text} — THE parser for the fact format
 *  (`# name\n\ntext`), CRLF-tolerant so a Windows checkout can't fork the format.
 *  Everything that reads fact files (bridge import, consolidation) must use this. */
export function parseStoredFact(slug, text) {
  const raw = text.replace(/\r\n/g, "\n");
  const m = raw.match(/^# (.*)\n\n([\s\S]*)$/);
  return m ? { name: m[1].trim(), text: m[2].trim() } : { name: slug, text: raw.trim() };
}
export function readFact(store, slug) {
  if (factConflicts(ledgerForStore(store)).has(slug)) return null;
  const f = ledgerFacts(ledgerForStore(store)).find((x) => x.slug === slug);
  return f ? { name: f.name, text: f.text } : null;
}

export function list(store) {
  return mergeFactSlugs([], ledgerForStore(store));
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
  const dir = ledgerForStore(store);
  const conflicts = factConflicts(dir);
  const facts = loadClaims(dir).filter((c) => c.kind === "fact" && !c.tombstone);
  const author = gitAuthor();
  const shared = (claim) =>
    (claim.provenanceAll ?? [claim.provenance]).some(
      (p) => p?.author && p.author !== author && p.author !== "legacy.import",
    );
  facts.sort(
    (a, b) =>
      Number(shared(b)) - Number(shared(a)) ||
      (a.body.name < b.body.name ? -1 : a.body.name > b.body.name ? 1 : a.id.localeCompare(b.id)),
  );
  const seen = new Map();
  let removed = 0;
  for (const fact of facts) {
    if (conflicts.has(slugify(fact.body.name) || "fact")) continue;
    const body = String(fact.body.text).replace(/\s+/g, " ").trim();
    if (seen.has(body) && !shared(fact)) {
      const result = tombstone(dir, fact.id, {
        author,
        reason: `duplicate-of:${seen.get(body)}`,
        t: epochDay(),
      });
      if (!result.ok) throw new Error(result.reason ?? "Could not consolidate duplicate fact");
      removed++;
    } else seen.set(body, fact.id);
  }
  if (removed) reindexLedger(dir);
  reindex(store);
  return { removed, kept: facts.length - removed };
}

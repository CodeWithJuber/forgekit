// forge CLI — the evidence-referenced memory commands — `ledger`, `reuse`, `context`. Moved verbatim out of src/cli.js (review A03: command dispatch
// and presentation are separated from domain operations; each domain's handlers live in one
// module, and the domain logic stays in the modules they import). cli.js registers these into
// its dispatch table; nothing here runs at import time.
import { BRAND, bar, heading, paint, table } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

HANDLERS.ledger = async (argv) => {
  const ls = await import("../ledger_store.js");
  const { epochDay, gitAuthor } = await import("../util.js");
  const root = process.cwd();
  // --personal targets the ledger beside the global recall store (~/.forge/recall/
  // ledger) — otherwise facts shadowed by `forge recall add` would be write-only,
  // with no command able to inspect or verify them.
  const personal = argv.includes("--personal");
  const args = argv.filter((a) => a !== "--json" && a !== "--personal");
  const dir = personal
    ? (await import("node:path")).join((await import("../recall.js")).defaultStore(), "ledger")
    : ls.repoLedger(root);
  const sub = args[1] || "stats";
  const json = argv.includes("--json");
  const nowDay = epochDay();
  if (sub === "stats") {
    const s = ls.stats(dir, nowDay);
    if (json) return console.log(JSON.stringify(s, null, 2));
    heading(`${BRAND.brand} ledger — proof-carrying memory\n`);
    console.log(`  claims: ${s.total}  (tombstoned ${s.tombstoned})`);
    for (const [kind, n] of Object.entries(s.byKind)) console.log(`    ${kind}: ${n}`);
    if (s.pendingRetractions)
      console.log(
        paint(
          `  ${s.pendingRetractions} claim(s) with an agent-proposed retraction — review, then \`forge ledger retract <full id> --reason …\``,
          "warn",
        ),
      );
    console.log(
      `  val: ${paint(`trusted ${s.val.trusted}`, "ok")} · ${paint(`uncertain ${s.val.uncertain}`, "warn")} · ${paint(`dormant ${s.val.dormant}`, "dim")}`,
    );
    console.log(
      paint("\n  stored in .forge/ledger/ (git-committable, conflict-free merge)", "dim"),
    );
    return;
  }
  if (sub === "verify") {
    // --fix re-addresses claims still stored under their pre-CRLF-fold id. Reads accept
    // that address either way, so this is not a repair — it is what stops one fact living
    // at two addresses once a teammate on another platform mints its current form.
    // `--fix --dry-run` previews the migration without writing (A11).
    const migration = args.includes("--fix")
      ? ls.migrateAddresses(dir, { dryRun: argv.includes("--dry-run") })
      : null;
    const r = ls.verify(dir);
    if (json) return console.log(JSON.stringify(migration ? { ...r, migration } : r, null, 2));
    if (migration) {
      const { migrated, merged, failed } = migration;
      console.log(
        `  ${migration.dryRun ? "(dry run) would migrate" : "migrated"} ${migrated.length} claim(s) to their current address, ${migration.dryRun ? "would merge" : "merged"} ${merged.length} into an existing twin${failed.length ? `, ${failed.length} failed` : ""}`,
      );
    }
    console.log(`  ${r.ok ? "OK" : "ISSUES"} — ${r.claims} claim(s), ${r.outcomes} outcome(s)`);
    for (const i of r.issues) console.log(`    - ${i}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (sub === "show") {
    const id = args[2];
    const hit = id && id.length >= 2 ? ls.getClaimByPrefix(dir, id, { attic: true }) : null;
    if (!hit) {
      console.error(
        id ? `  no claim matching ${id}` : "usage: forge ledger show <id-prefix (≥2 chars)>",
      );
      process.exitCode = 1;
      return;
    }
    const { val } = await import("../ledger.js");
    const pending = ls.retractionProposals(ls.loadClaims(dir)).get(hit.id);
    return console.log(
      JSON.stringify(
        { ...hit, val: val(hit, nowDay), ...(pending ? { pendingRetractions: pending } : {}) },
        null,
        2,
      ),
    );
  }
  if (sub === "merge") {
    const src = args[2];
    const { existsSync } = await import("node:fs");
    if (!src || !existsSync(src)) {
      console.error(
        src
          ? `  no ledger at ${src}`
          : "usage: forge ledger merge <path-to-ledger-dir>  (a teammate's checkout, a backup, a worktree)",
      );
      process.exitCode = 1;
      return;
    }
    const r = ls.mergeDirs(dir, src);
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`  merged: ${r.claims} new claim(s), ${r.records} new record(s) — conflict-free`);
    if (r.quarantined)
      console.log(
        `  quarantined: ${r.quarantined} invalid record(s) (forged hash or unresolvable ref — see quarantine/ in the ledger dir)`,
      );
    return;
  }
  if (sub === "blame") {
    const b = args[2] && args[2].length >= 2 ? ls.blame(dir, args[2], nowDay) : null;
    if (!b) {
      console.error(
        args[2] ? `  no claim matching ${args[2]}` : "usage: forge ledger blame <id-prefix>",
      );
      process.exitCode = 1;
      return;
    }
    if (json) return console.log(JSON.stringify(b, null, 2));
    heading(`${BRAND.brand} ledger blame — ${b.kind} ${b.id.slice(0, 12)}\n`);
    console.log(
      `  val ${bar(b.val)} ${b.val.toFixed(2)} (trust-weighted ${b.valTrustWeighted.toFixed(2)})`,
    );
    for (const p of b.minted)
      console.log(
        `  minted  day ${p.t}  by ${p.author || "(unknown)"}${p.agent ? ` · ${p.agent}` : ""}`,
      );
    for (const e of b.evidence)
      console.log(
        `  ${e.result === "confirm" ? paint("confirm ", "ok") : paint("contradic", "err")}  day ${e.t}  ${e.oracle} → ${e.ref}${e.author ? `  by ${e.author}` : ""}`,
      );
    for (const t of b.tombstones)
      console.log(
        paint(`  retract  day ${t.t}  ${t.reason}${t.author ? `  by ${t.author}` : ""}`, "dim"),
      );
    const trusts = Object.entries(b.trust);
    if (trusts.length) {
      console.log("\n  author trust (earned from oracle outcomes on their claims):");
      for (const [a, u] of trusts) console.log(`    ${u.toFixed(2)}  ${a}`);
    }
    return;
  }
  // The two writes (08-dashboard-ux.md §2) — CLI twins of the dashboard's POSTs, so
  // the dashboard stays a convenience, never a requirement. Both append-only.
  if (sub === "ratify") {
    const id = args[2];
    if (!id || id.length < 2) {
      console.error("usage: forge ledger ratify <id-prefix (≥2 chars)>");
      process.exitCode = 1;
      return;
    }
    // Human-only promotion: the author is YOUR git identity, minted as a decision claim.
    const r = ls.ratify(dir, id, { author: gitAuthor(), t: nowDay });
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(
      `  ratified ${r.ratifies.slice(0, 12)} → decision ${r.decisionId.slice(0, 12)}${r.existed ? " (already ratified — same decision)" : ""}`,
    );
    return;
  }
  if (sub === "retract") {
    const id = args[2];
    const ri = args.indexOf("--reason");
    const reason = ri >= 0 ? (args[ri + 1] ?? "") : "";
    if (!id || id === "--reason" || !reason) {
      console.error('usage: forge ledger retract <full claim id> --reason "<why>"');
      process.exitCode = 1;
      return;
    }
    // A tombstone is permanent, so it must name exactly one claim: the full 64-char id,
    // never a prefix (a short prefix used to retract the first sorted match).
    if (!ls.FULL_ID_RE.test(id)) {
      console.error(
        `  refused: retract needs the full 64-character claim id (got "${id}") — see \`forge ledger query\` or \`forge ledger show <prefix>\``,
      );
      process.exitCode = 1;
      return;
    }
    const hit = ls.getClaimByPrefix(dir, id);
    if (!hit) {
      console.error(`  no claim matching ${id}`);
      process.exitCode = 1;
      return;
    }
    const r = ls.tombstone(dir, hit.id, {
      author: gitAuthor(),
      reason,
      t: nowDay,
    });
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    if (json) return console.log(JSON.stringify({ ...r, id: hit.id }, null, 2));
    console.log(
      `  retracted ${hit.id.slice(0, 12)} — ${reason}${r.deduped ? " (already retracted with this record)" : ""}`,
    );
    return;
  }
  // `compact` — archive what this ledger's own history says will not be used again, and
  // near-duplicates, printing every learned number (ledger_retention.js). Reversible.
  if (sub === "compact") {
    const dryRun = argv.includes("--dry-run");
    const r = ls.compactLedger(dir, nowDay, { dryRun });
    if (json) return console.log(JSON.stringify(r, null, 2));
    const rt = r.retention;
    const d = r.duplicates;
    const lines = [
      `Forge ledger — compact (every cut-off learned from this ledger)${dryRun ? "  [dry run]" : ""}`,
      "",
      `  claims: ${r.claims} · claims with logged use: ${r.servedClaims}`,
      rt.learned
        ? `  retention: idle cut-off ${rt.cutoff} d = the longest idle stretch any claim came back from (${rt.comebacks} comebacks, typical gap ${rt.typicalGap} d; usage log spans ${rt.usageSpan} d)`
        : `  retention: not learned — ${rt.reason}`,
      d?.boundary != null
        ? `  duplicates: boundary ${d.boundary.toFixed(2)} (two components beat one: BIC ${d.bic2?.toFixed(1)} < ${d.bic1?.toFixed(1)}) · ${d.groups.length} group(s)`
        : `  duplicates: none — ${d?.compared ? `one component fits the ${d.compared} nearest-neighbour similarities better` : "fewer than two claims of one kind are still live to compare"}`,
      "",
      `  archive: ${r.archive.length}`,
    ];
    for (const a of r.archive.slice(0, 20)) lines.push(`    ${a.id.slice(0, 12)}  ${a.reason}`);
    if (r.archive.length > 20) lines.push(`    … ${r.archive.length - 20} more (--json for all)`);
    // Similar-but-opposite pairs are never archived as duplicates (review F16): a person decides.
    const conflicts = d?.conflicts ?? [];
    if (conflicts.length) {
      lines.push(
        "",
        `  kept apart — similar but conflicting (review, then retract one): ${conflicts.length}`,
      );
      for (const c of conflicts.slice(0, 10))
        lines.push(`    ${c.a.slice(0, 12)} ↔ ${c.b.slice(0, 12)}  ${c.conflicts}`);
    }
    lines.push(
      "",
      dryRun
        ? "  dry run: nothing written"
        : `  archived ${r.archived.length} claim(s) to .forge/ledger/attic/ — new evidence brings one back; show/blame still read it`,
    );
    return console.log(lines.join("\n"));
  }
  if (sub === "query") {
    const q = args.slice(2).join(" ");
    if (!q) {
      console.error('usage: forge ledger query "<what you are about to do>"');
      process.exitCode = 1;
      return;
    }
    const { retrieve, claimText } = await import("../ledger.js");
    // The embeddings tier (ADR-0005) is assembled HERE, not in ledger.js — the pure
    // core stays provider-free. No FORGE_EMBED (or a failing provider) → sim is
    // null and retrieval is the stock MinHash path.
    const { claimSim, simLabel } = await import("../embed.js");
    const claims = ls.loadClaims(dir);
    const sim = claimSim(root, q, claims, claimText);
    const ranked = retrieve(q, claims, { nowDay, budget: 8, sim });
    ls.recordUse(
      dir,
      ranked.map((r) => r.claim.id),
      { via: "cli.query", t: nowDay },
    );
    if (json)
      return console.log(
        JSON.stringify(
          {
            sim: simLabel(sim),
            results: ranked.map((r) => ({
              id: r.claim.id,
              kind: r.claim.kind,
              score: r.score,
            })),
          },
          null,
          2,
        ),
      );
    console.log(paint(`  sim: ${simLabel(sim)}`, "dim"));
    if (!ranked.length) return console.log("  no matching live claims");
    for (const r of ranked)
      console.log(
        `  ${bar(r.score, 8)} ${r.score.toFixed(3)}  ${paint(r.claim.kind.padEnd(9), "accent")} ${paint(r.claim.id.slice(0, 8), "dim")}  ${claimText(r.claim).slice(0, 90)}`,
      );
    return;
  }
  // `at` / `diff` / `root` — the temporal surface. The store is append-only and every
  // record carries its day, so a past day's beliefs are recomputed, never guessed.
  const parseDay = (s) => {
    if (/^\d{1,6}$/.test(s ?? "")) return Number(s); // bare epoch-day
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    // Round-trip check: Date.parse silently rolls impossible dates over (2026-02-31
    // → March 3rd), which would answer a temporal query for a day nobody asked about.
    if (new Date(t).toISOString().slice(0, 10) !== s) return null;
    return Math.floor(t / 86_400_000);
  };
  if (sub === "at") {
    const day = parseDay(args[2]);
    if (day === null) {
      console.error(`usage: ${BRAND.cli} ledger at <YYYY-MM-DD | epoch-day> [--json]`);
      process.exitCode = 1;
      return;
    }
    const lg = await import("../ledger.js");
    const live = lg.liveClaims(lg.stateAt(ls.loadState(dir), day));
    const rows = live
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        val: Number(lg.val(c, day).toFixed(4)),
        tombstoned: Boolean(c.tombstone),
        text: lg.claimText(c).slice(0, 90),
      }))
      .sort((a, b) => b.val - a.val || (a.id < b.id ? -1 : 1));
    if (json) return console.log(JSON.stringify({ day, claims: rows.length, rows }, null, 2));
    heading(`${BRAND.brand} ledger — beliefs as of day ${day}\n`);
    const byKind = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    console.log(
      `  claims: ${rows.length}  (${rows.filter((r) => r.tombstoned).length} tombstoned)`,
    );
    for (const [kind, n] of Object.entries(byKind)) console.log(`    ${kind}: ${n}`);
    for (const r of rows.slice(0, 10))
      console.log(
        `  ${bar(r.val, 8)} ${r.val.toFixed(3)}  ${paint(r.kind.padEnd(9), "accent")} ${paint(r.id.slice(0, 8), "dim")}  ${r.text}`,
      );
    return;
  }
  if (sub === "diff") {
    const a = parseDay(args[2]);
    const b = args[3] ? parseDay(args[3]) : nowDay;
    if (a === null || b === null) {
      console.error(
        `usage: ${BRAND.cli} ledger diff <since: YYYY-MM-DD | epoch-day> [<until>] [--json]`,
      );
      process.exitCode = 1;
      return;
    }
    if (a > b) {
      // beliefDiff's contract is dayA ≤ dayB; a reversed window would print silently
      // inverted appeared/retired classes, so refuse loudly instead.
      console.error(`  <since> (day ${a}) is after <until> (day ${b}) — swap the arguments`);
      process.exitCode = 1;
      return;
    }
    const lg = await import("../ledger.js");
    const d = lg.beliefDiff(ls.loadState(dir), a, b);
    if (json) return console.log(JSON.stringify({ since: a, until: b, ...d }, null, 2));
    heading(`${BRAND.brand} ledger — what changed, day ${a} → ${b}\n`);
    console.log(
      `  appeared ${d.appeared.length} · retired ${d.retired.length} · ${paint(`strengthened ${d.strengthened.length}`, "ok")} · ${paint(`weakened ${d.weakened.length}`, "warn")}`,
    );
    const row = (label, r) =>
      console.log(
        `  ${label}  ${paint(r.kind.padEnd(9), "accent")} ${paint(r.id.slice(0, 8), "dim")}  ${r.from === null ? "· " : r.from.toFixed(2)} → ${r.to === null ? "·" : r.to.toFixed(2)}  ${r.text.slice(0, 70)}`,
      );
    for (const r of d.appeared.slice(0, 5)) row(paint("new ", "ok"), r);
    for (const r of d.retired.slice(0, 5)) row(paint("gone", "err"), r);
    for (const r of d.strengthened.slice(0, 5)) row(paint("up  ", "ok"), r);
    for (const r of d.weakened.slice(0, 5)) row(paint("down", "warn"), r);
    return;
  }
  if (sub === "root") {
    const lg = await import("../ledger.js");
    const r = lg.stateRoot(ls.loadState(dir));
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.root); // bare hex on stdout — scriptable ("are we in sync?" is one diff)
    return;
  }
  if (sub === "sync") {
    const { ledgerSync, defaultRef } = await import("../ledger_sync.js");
    const di = args.indexOf("--dir");
    const re = args.indexOf("--remote");
    const rf = args.indexOf("--ref");
    const r = ledgerSync({
      dir,
      root,
      personal,
      dirTarget: di >= 0 ? args[di + 1] : undefined,
      remote: re >= 0 ? args[re + 1] : undefined,
      ref: rf >= 0 ? args[rf + 1] : undefined,
    });
    if (json) return console.log(JSON.stringify(r, null, 2));
    heading(`${BRAND.brand} ledger sync\n`);
    if (!r.ok) {
      console.error(`  ${paint(r.reason ?? "sync failed", "err")}`);
      process.exitCode = 1;
      return;
    }
    if (r.mode === "dir") {
      console.log(
        table([
          [paint("target", "dim"), r.dir],
          [paint("pulled", "dim"), `${r.pulled.claims} claim(s), ${r.pulled.records} record(s)`],
          [
            paint("pushed", "dim"),
            r.upToDate
              ? paint("up to date — state roots match, nothing to merge", "dim")
              : `${r.pushed.claims} claim(s), ${r.pushed.records} record(s)`,
          ],
        ]),
      );
    } else {
      console.log(
        table([
          [paint("ref", "dim"), `${r.remote} ${r.ref}`],
          [paint("pulled", "dim"), `${r.pulled.claims} claim(s), ${r.pulled.records} record(s)`],
          [
            paint("pushed", "dim"),
            r.upToDate
              ? paint("up to date — nothing to push", "dim")
              : `yes (retries ${r.retries})`,
          ],
        ]),
      );
    }
    for (const n of r.notes ?? []) console.log(paint(`  note: ${n}`, "warn"));
    if (r.mode === "ref" && r.ref === defaultRef(personal))
      console.log(paint("\n  synced through a git ref — CRDT, converges in any order", "dim"));
    return;
  }
  if (sub === "import") {
    const b = await import("../ledger_bridge.js");
    let r;
    if (personal) {
      // Personal import: facts from the global recall store into the personal ledger.
      const { defaultStore } = await import("../recall.js");
      r = {
        lessons: 0,
        outcomes: 0,
        ...b.importFacts(defaultStore(), dir, nowDay),
      };
    } else {
      const { brainStore } = await import("../brain.js");
      r = b.importLegacy(root, {
        recallStore: brainStore(root),
        recallLedger: dir,
        nowDay,
      });
    }
    if (json) return console.log(JSON.stringify(r, null, 2));
    console.log(`  imported: ${r.lessons} lesson(s), ${r.facts} fact(s), ${r.outcomes} outcome(s)`);
    for (const x of r.refused) console.log(`    refused: ${x}`);
    return;
  }
  console.error(
    `ledger: unknown subcommand "${sub}" (stats | verify | show <id> | blame <id> | query <text> | at <date> | diff <since> [<until>] | root | ratify <id> | retract <id> --reason "<why>" | merge <path> | sync [--dir <path>|--remote <name>|--ref <ref>] | import) [--personal] [--json]`,
  );
  process.exitCode = 1;
  return;
};

HANDLERS.reuse = async (argv) => {
  const ru = await import("../reuse.js");
  const { load: loadAtlas } = await import("../atlas.js");
  const { epochDay } = await import("../util.js");
  const root = process.cwd();
  const nowDay = epochDay();
  const json = argv.includes("--json");
  const flagVal = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const args = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--file" && argv[i - 1] !== "--ref",
  );
  const sub = args[1] || "stats";
  if (sub === "query") {
    const spec = args.slice(2).join(" ");
    if (!spec) {
      console.error('usage: forge reuse query "<what you are about to build>" [--json]');
      process.exitCode = 1;
      return;
    }
    const r = ru.reuseQuery(root, spec, { atlas: loadAtlas(root), nowDay });
    if (json)
      return console.log(
        JSON.stringify(
          {
            tier: r.tier,
            artifact: r.artifact?.id,
            jaccard: r.jaccard,
            similarity: r.similarity,
            sim: r.sim,
            revalidation: r.revalidation?.status,
            requiresRevalidation: r.requiresRevalidation === true,
            reasons: r.reasons,
          },
          null,
          2,
        ),
      );
    console.log(`  sim: ${r.sim}`);
    if (r.tier === "miss") {
      console.log("  miss — nothing verified matches; generate, then `forge reuse mint` it");
    } else {
      const a = r.artifact;
      console.log(
        `  ${r.tier.toUpperCase()} hit (similarity ${(r.similarity ?? r.jaccard ?? 1).toFixed(2)}) — ${a.body.form}${a.body.code?.path ? ` at ${a.body.code.path}` : ""}`,
      );
      console.log(
        `    claim ${a.id.slice(0, 12)} — \`forge ledger blame ${a.id.slice(0, 8)}\` for its proof`,
      );
      if (r.tier === "near")
        console.log("    near tier: a reworded match — review the diff before reusing it as-is");
      if (r.tier === "adapt")
        console.log("    adapt tier: inject as a verified starting point, generate only the delta");
      if (r.requiresRevalidation)
        console.log(
          `    NOT revalidated: ${(r.revalidation?.unknown ?? []).join(", ")} — check before use`,
        );
    }
    for (const why of r.reasons) console.log(`    note: ${why}`);
    return;
  }
  if (sub === "mint") {
    const spec = args.slice(2).join(" ");
    const file = flagVal("--file");
    const ref = flagVal("--ref");
    if (!spec || !file) {
      console.error(
        'usage: forge reuse mint "<task the code solves>" --file <path> [--ref <test-run/commit>] [--json]',
      );
      process.exitCode = 1;
      return;
    }
    const { repoLedger } = await import("../ledger_store.js");
    // With an atlas, each dependency's declaration is fingerprinted, so a later signature
    // change invalidates the artifact (review F05).
    const desc = ru.describeFile(root, file, { atlas: loadAtlas(root) });
    const r = ru.mintArtifact(
      repoLedger(root),
      { spec, form: "module", ...desc },
      ref
        ? {
            evidence: { oracle: "test.run", result: "confirm", ref },
            t: nowDay,
          }
        : { t: nowDay },
    );
    if (json) return console.log(JSON.stringify(r, null, 2));
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `  minted: ${r.id.slice(0, 12)} (${desc.iface.length} export(s), ${desc.deps.length} dep(s))`,
    );
    console.log(
      r.serves
        ? "  serving: yes — verification evidence attached"
        : "  serving: NOT YET — no evidence; attach a verified test/commit ref (--ref) or it stays at the 0.5 prior",
    );
    return;
  }
  if (sub === "stats") {
    const { summarize } = await import("../metrics.js");
    const s = summarize(root).cache ?? {
      events: 0,
      byOutcome: {},
      savedEstimate: 0,
    };
    if (json) return console.log(JSON.stringify(s, null, 2));
    heading(`${BRAND.brand} reuse — proof-carrying code cache\n`);
    console.log(`  lookups: ${s.events}`);
    for (const [o, n] of Object.entries(s.byOutcome)) console.log(`    ${o}: ${n}`);
    console.log(`  est. tokens saved: ${s.savedEstimate}`);
    return;
  }
  console.error(
    `reuse: unknown subcommand "${sub}" (query <spec> | mint <spec> --file <path> | stats)`,
  );
  process.exitCode = 1;
  return;
};

HANDLERS.context = async (argv) => {
  const { assemble, renderContext } = await import("../context.js");
  const { load: loadAtlas } = await import("../atlas.js");
  const { epochDay } = await import("../util.js");
  const json = argv.includes("--json");
  const bi = argv.indexOf("--budget");
  const budget = bi >= 0 ? Number(argv[bi + 1]) || undefined : undefined;
  const task = argv
    .filter((a, i) => i > 0 && !a.startsWith("--") && argv[i - 1] !== "--budget")
    .join(" ");
  if (!task) {
    console.error('usage: forge context "<task>" [--budget <tokens>] [--json]');
    process.exitCode = 1;
    return;
  }
  const r = assemble(process.cwd(), task, {
    atlas: loadAtlas(process.cwd()),
    nowDay: epochDay(),
    ...(budget ? { budget } : {}),
  });
  // --block delivers the assembled context itself — the spans the summary talks about (R13).
  const withBlock = argv.includes("--block");
  if (json) {
    const { block, ...rest } = r;
    console.log(JSON.stringify(withBlock ? r : rest, null, 2));
  } else if (withBlock) {
    console.log(r.block);
  } else console.log(renderContext(r));
  if (!r.ok) process.exitCode = 1;
  return;
};

export default HANDLERS;

#!/usr/bin/env node
// forge — zero-dependency dispatcher. Works identically whether installed via the
// npm bin, the hardened install.sh symlink, or the Claude Code plugin.
import { BRAND } from "./brand.js";
// The command surface lives in commands.js as data — docs_check.js reconciles the
// README/GUIDE tables against the same table this help is rendered from.
import { COMMANDS, GROUPS } from "./commands.js";
// Color is capability-gated (FORCE_COLOR > NO_COLOR > TERM=dumb > TTY) — piped
// output stays byte-plain, so nothing downstream ever parses an escape code.
import { bar, heading as fmtHeading, paint } from "./fmt.js";

const printVersion = () => console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

// Per-command title lines ("Forge <cmd> — …") are branding chrome, not results. They
// print only when asked (`--verbose` or FORGE_VERBOSE=1); by default a command emits
// just its output. The `--help`/`--version` banner is unaffected.
const VERBOSE = process.argv.includes("--verbose") || process.env.FORGE_VERBOSE === "1";
const heading = (text) => {
  if (VERBOSE) console.log(fmtHeading(text));
};

function printHelp() {
  printVersion();
  console.log(`\n${BRAND.tagline}\n`);
  console.log(`Usage: ${BRAND.cli} <command> [options]\n`);
  for (const [group, cmds] of Object.entries(GROUPS)) {
    console.log(`${group}:`);
    for (const name of cmds) {
      if (COMMANDS[name]) console.log(`  ${name.padEnd(12)} ${COMMANDS[name]}`);
    }
    console.log();
  }
  console.log(`Start here: \`${BRAND.cli} catalog\``);
  console.log(`Run \`${BRAND.cli} <command> --help\` for details.`);
}

async function run(argv) {
  const [cmd] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return printHelp();
  if (cmd === "-v" || cmd === "--version") return printVersion();
  if (cmd === "cortex-mcp") {
    const { serve } = await import("./cortex_mcp.js"); // stdio MCP server for other tools
    serve();
    return;
  }
  if (cmd === "brand") {
    const { brand, cli, pkg, version, layers } = BRAND;
    return console.log(JSON.stringify({ brand, cli, pkg, version, layers }, null, 2));
  }
  if (cmd === "init") {
    const { init } = await import("./init.js");
    const noSettings = argv.includes("--no-settings");
    const { report, bytes, settings, detected } = init({
      targetRoot: process.cwd(),
      noSettings,
    });
    const wrote = report.filter((r) => r.action === "written").map((r) => r.target);
    heading(`${BRAND.brand} init — this repo now speaks every AI tool from one source.\n`);
    console.log(`  emitted:  ${wrote.length ? wrote.join(", ") : "(all up to date)"}`);
    console.log(
      `  source:   AGENTS.md (${bytes} B) — edit rules in source/, re-run \`${BRAND.cli} sync\``,
    );
    if (settings?.action === "merged" && "added" in settings) {
      console.log(`  settings: merged ${settings.added.join(", ")} into ${settings.path}`);
    } else if (settings?.action === "unchanged" && "path" in settings) {
      console.log(`  settings: already up to date (${settings.path})`);
    } else if (settings?.action === "skipped") {
      console.log("  settings: skipped (--no-settings)");
    }
    if (detected) {
      console.log(`  provider: auto-detected ${detected.name} from ${detected.source}`);
    } else {
      console.log(
        `  provider: none detected — set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or LITELLM_BASE_URL`,
      );
    }
    console.log(`  active:   tools · crew · guards  →  \`${BRAND.cli} catalog\``);
    console.log(`  verify:   \`${BRAND.cli} doctor\``);
    return;
  }
  if (cmd === "update") {
    const { applyUpdate, applyUpdateTo, updateStatus } = await import("./update.js");
    const json = argv.includes("--json");
    const toIdx = argv.indexOf("--to");
    if (toIdx !== -1) {
      const r = applyUpdateTo(argv[toIdx + 1], {});
      if (json) return console.log(JSON.stringify(r, null, 2));
      heading(`${BRAND.brand} update — pin\n`);
      if (r.ok)
        console.log(
          r.changed
            ? `  pinned ${r.before} → ${r.after} (${r.tag}). ${r.note}`
            : `  already at ${r.tag}. ${r.note}`,
        );
      else if (r.instruction) console.log(`  ${r.reason}:\n    ${r.instruction}`);
      else {
        console.log(`  ${r.reason}`);
        process.exitCode = 1;
      }
      return;
    }
    if (argv.includes("--check")) {
      const s = updateStatus({});
      if (json) return console.log(JSON.stringify(s, null, 2));
      heading(`${BRAND.brand} update — check\n`);
      if (s.unknown)
        console.log(
          `  on v${s.current} (${s.mode}) — can't compare to upstream${s.network === "offline" ? " (offline)" : ""}; update with your installer.`,
        );
      else if (s.behind > 0)
        console.log(`  ${s.behind} commit(s) behind ${s.upstream} — run \`${BRAND.cli} update\`.`);
      else console.log(`  up to date (v${s.current}).`);
      return;
    }
    const r = applyUpdate({});
    if (json) return console.log(JSON.stringify(r, null, 2));
    heading(`${BRAND.brand} update\n`);
    if (r.ok)
      console.log(
        r.changed
          ? `  updated ${r.before} → ${r.after}. ${r.note}`
          : `  already up to date (v${BRAND.version}).`,
      );
    else if (r.instruction) console.log(`  ${r.reason}:\n    ${r.instruction}`);
    else {
      console.log(`  ${r.reason}`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "stack") {
    // Dynamic: read THIS repo's manifests and report its real stack (not a static menu).
    const { detectStack } = await import("./stack.js");
    const s = detectStack(process.cwd());
    if (argv.includes("--json")) return console.log(JSON.stringify(s, null, 2));
    heading(`${BRAND.brand} stack — detected from this repo's manifests\n`);
    const row = (label, arr) =>
      arr.length ? console.log(`  ${`${label}:`.padEnd(11)} ${arr.join(", ")}`) : undefined;
    if (!s.languages.length) {
      console.log("  no known stack detected (no package.json/go.mod/Cargo.toml/… found).");
      return;
    }
    row("languages", s.languages);
    row("frameworks", s.frameworks);
    row("pkg mgrs", s.packageManagers);
    row("test", s.testCommands);
    row("tools", s.tools);
    row("notes", s.notes);
    console.log(`  ${"evidence:".padEnd(11)} ${s.evidence.join(", ")}`);
    return;
  }
  if (cmd === "catalog") {
    const { catalog } = await import("./init.js");
    const c = catalog();
    heading(`${BRAND.brand} catalog — Start Here\n`);
    console.log("  TOOLS (model-invoked skills)");
    for (const t of c.tools) console.log(`    ${t.name.padEnd(18)} ${t.why.slice(0, 66)}`);
    console.log(`\n  CREW (isolated sub-agents)   ${c.crew.join(" · ")}`);
    console.log(`  GUARDS (enforced hooks)      ${c.guards.join(" · ")}`);
    if (c.taste?.length)
      console.log(
        `  TASTE (design directions)    ${c.taste.join(" · ")}  →  \`${BRAND.cli} taste <style>\``,
      );
    if (c.cortex) console.log(`\n  CORTEX (self-correcting memory)  ${c.cortex}`);
    if (c.preflight) console.log(`  PREFLIGHT (before you spend tokens)  ${c.preflight}`);
    console.log(`\n  Full detail: ARCHITECTURE.md · per-tool config: \`${BRAND.cli} sync\``);
    return;
  }
  if (cmd === "taste") {
    const t = await import("./taste.js");
    const style = argv[1];
    if (!style) {
      console.log(
        `${BRAND.brand} taste — pick ONE visual direction per repo (every tool then follows it):\n`,
      );
      for (const s of t.list()) console.log(`  ${s}`);
      console.log(`\n  apply: \`${BRAND.cli} taste <style>\`  (writes a managed DESIGN.md)`);
      return;
    }
    const res = t.apply(style, process.cwd());
    if (res.ok) {
      console.log(
        `  DESIGN.md ${res.action} → taste: ${res.style}. Every AI tool now builds in this direction.`,
      );
    } else {
      console.error(`  ${res.reason}`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "sync") {
    const { sync } = await import("./sync.js");
    const { report, warnings, bytes } = sync({ targetRoot: process.cwd() });
    heading(`${BRAND.brand} sync — one source → every tool\n`);
    for (const r of report) {
      console.log(
        `  ${r.action.padEnd(16)} ${String(r.target).padEnd(22)} ${r.tool}${r.note ? `  · ${r.note}` : ""}`,
      );
    }
    for (const w of warnings) console.warn(`  ! ${w}`);
    const written = report.filter((r) => r.action === "written").length;
    console.log(`\n${written} file(s) written · canonical ${bytes} B`);
    return;
  }
  if (cmd === "doctor") {
    const { doctor } = await import("./doctor.js");
    const { results, failed } = doctor({ targetRoot: process.cwd() });
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ results, failed }, null, 2));
      if (failed) process.exitCode = 1;
      return;
    }
    const icon = {
      ok: paint("✓", "ok"),
      warn: paint("!", "warn"),
      fail: paint("✗", "err"),
    };
    heading(`${BRAND.brand} doctor\n`);
    for (const r of results) console.log(`  ${icon[r.status]} ${r.label.padEnd(16)} ${r.note}`);
    console.log(
      `\n${failed === 0 ? paint("all clear", "ok") : paint(`${failed} problem(s)`, "err")}`,
    );
    if (failed) process.exitCode = 1;
    return;
  }
  if (cmd === "docs") {
    const json = argv.includes("--json");
    const sub = argv.slice(1).filter((a) => !a.startsWith("--"))[0] || "check";
    // `sync` sweeps THIS repo's diff for stale doc mentions (advisory by default —
    // it runs mid-repair from the completion gate's checklist; --strict for CI).
    if (sub === "sync") {
      const { docsSyncReport, renderDocsSync } = await import("./docs_sync.js");
      const baseIdx = argv.indexOf("--base");
      const r = docsSyncReport(process.cwd(), {
        base: baseIdx >= 0 ? argv[baseIdx + 1] : undefined,
      });
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(renderDocsSync(r));
      if (r.error || (argv.includes("--strict") && r.stale.length)) process.exitCode = 1;
      return;
    }
    // `check` — self-check of the forge package's own docs against its code (commands
    // table, env reads, MCP registry, CHANGELOG).
    const { docsCheck } = await import("./docs_check.js");
    const r = docsCheck();
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    heading(`${BRAND.brand} docs check — docs↔code drift\n`);
    if (!r.issues.length) console.log(`  ✓ docs and code agree (${r.checked.join(", ")})`);
    for (const i of r.issues)
      console.log(`  ${i.severity === "error" ? "✗" : "!"} [${i.check}] ${i.detail}`);
    if (!r.ok) {
      console.log(`\n${r.issues.filter((i) => i.severity === "error").length} problem(s)`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "recall") {
    const r = await import("./recall.js");
    const store = r.defaultStore();
    const sub = argv[1] || "list";
    if (sub === "list") {
      const items = r.list(store);
      console.log(items.length ? items.map((s) => `  - ${s}`).join("\n") : "  (no memories yet)");
    } else if (sub === "add") {
      const name = argv[2];
      const body = argv.slice(3).join(" ");
      if (!name || !body) {
        console.error('usage: forge recall add "<name>" "<fact>"');
        process.exitCode = 1;
        return;
      }
      const res = r.add(store, name, body);
      if (res.ok) {
        // Shadow the fact into the PERSONAL ledger beside the global store (repo
        // promotion stays an explicit act — docs/plans/substrate-v2/02-team-memory.md §3).
        // Best-effort INCLUDING the imports: a broken bridge module must never turn an
        // already-persisted fact into a CLI failure.
        try {
          const { join } = await import("node:path");
          const { shadowFact } = await import("./ledger_bridge.js");
          shadowFact(join(store, "ledger"), name, body);
        } catch {}
        // Re-index after the shadow so a ledger-only store's MEMORY.md includes the fact
        // (its only copy now lives in the ledger, written just above).
        r.reindex(store);
      }
      console.log(res.ok ? `  saved: ${res.slug}` : `  ${res.reason}`);
      if (!res.ok) process.exitCode = 1;
    } else if (sub === "consolidate") {
      const { removed, kept } = r.consolidate(store);
      try {
        // Deleted duplicates must not survive as live claims in the shadow ledger.
        const { join } = await import("node:path");
        const { reconcileFacts } = await import("./ledger_bridge.js");
        reconcileFacts(store, join(store, "ledger"));
      } catch {}
      console.log(`  consolidated: ${removed} duplicate(s) removed, ${kept} kept`);
    } else {
      console.error(`recall: unknown subcommand "${sub}" (list | add | consolidate)`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "ledger") {
    const ls = await import("./ledger_store.js");
    const { epochDay, gitAuthor } = await import("./util.js");
    const root = process.cwd();
    // --personal targets the ledger beside the global recall store (~/.forge/recall/
    // ledger) — otherwise facts shadowed by `forge recall add` would be write-only,
    // with no command able to inspect or verify them.
    const personal = argv.includes("--personal");
    const args = argv.filter((a) => a !== "--json" && a !== "--personal");
    const dir = personal
      ? (await import("node:path")).join((await import("./recall.js")).defaultStore(), "ledger")
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
      console.log(
        `  val: ${paint(`trusted ${s.val.trusted}`, "ok")} · ${paint(`uncertain ${s.val.uncertain}`, "warn")} · ${paint(`dormant ${s.val.dormant}`, "dim")}`,
      );
      console.log(
        paint("\n  stored in .forge/ledger/ (git-committable, conflict-free merge)", "dim"),
      );
      return;
    }
    if (sub === "verify") {
      const r = ls.verify(dir);
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(`  ${r.ok ? "OK" : "ISSUES"} — ${r.claims} claim(s), ${r.outcomes} outcome(s)`);
      for (const i of r.issues) console.log(`    - ${i}`);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    if (sub === "show") {
      const id = args[2];
      const hit = id && id.length >= 2 ? ls.getClaimByPrefix(dir, id) : null;
      if (!hit) {
        console.error(
          id ? `  no claim matching ${id}` : "usage: forge ledger show <id-prefix (≥2 chars)>",
        );
        process.exitCode = 1;
        return;
      }
      const { val } = await import("./ledger.js");
      return console.log(JSON.stringify({ ...hit, val: val(hit, nowDay) }, null, 2));
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
      if (!id || id.length < 2 || id === "--reason" || !reason) {
        console.error('usage: forge ledger retract <id-prefix> --reason "<why>"');
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
    if (sub === "query") {
      const q = args.slice(2).join(" ");
      if (!q) {
        console.error('usage: forge ledger query "<what you are about to do>"');
        process.exitCode = 1;
        return;
      }
      const { retrieve, claimText } = await import("./ledger.js");
      // The embeddings tier (ADR-0005) is assembled HERE, not in ledger.js — the pure
      // core stays provider-free. No FORGE_EMBED (or a failing provider) → sim is
      // null and retrieval is the stock MinHash path.
      const { claimSim, simLabel } = await import("./embed.js");
      const claims = ls.loadClaims(dir);
      const sim = claimSim(root, q, claims, claimText);
      const ranked = retrieve(q, claims, { nowDay, budget: 8, sim });
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
    if (sub === "import") {
      const b = await import("./ledger_bridge.js");
      let r;
      if (personal) {
        // Personal import: facts from the global recall store into the personal ledger.
        const { defaultStore } = await import("./recall.js");
        r = {
          lessons: 0,
          outcomes: 0,
          ...b.importFacts(defaultStore(), dir, nowDay),
        };
      } else {
        const { brainStore } = await import("./brain.js");
        r = b.importLegacy(root, {
          recallStore: brainStore(root),
          recallLedger: dir,
          nowDay,
        });
      }
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(
        `  imported: ${r.lessons} lesson(s), ${r.facts} fact(s), ${r.outcomes} outcome(s)`,
      );
      for (const x of r.refused) console.log(`    refused: ${x}`);
      return;
    }
    console.error(
      `ledger: unknown subcommand "${sub}" (stats | verify | show <id> | blame <id> | query <text> | ratify <id> | retract <id> --reason "<why>" | merge <path> | import) [--personal] [--json]`,
    );
    process.exitCode = 1;
    return;
  }
  if (cmd === "reuse") {
    const ru = await import("./reuse.js");
    const { load: loadAtlas } = await import("./atlas.js");
    const { epochDay } = await import("./util.js");
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
        if (r.tier === "adapt")
          console.log(
            "    adapt tier: inject as a verified starting point, generate only the delta",
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
      const { repoLedger } = await import("./ledger_store.js");
      const desc = ru.describeFile(root, file);
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
      const { summarize } = await import("./metrics.js");
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
  }
  if (cmd === "context") {
    const { assemble, renderContext } = await import("./context.js");
    const { load: loadAtlas } = await import("./atlas.js");
    const { epochDay } = await import("./util.js");
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
    if (json) {
      const { block, ...rest } = r;
      return console.log(JSON.stringify(rest, null, 2));
    }
    console.log(renderContext(r));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "atlas") {
    const a = await import("./atlas.js");
    const sub = argv[1] || "build";
    const need = () => {
      if (a.load()) return a.load();
      console.error("  no index — run `forge atlas build` first");
      process.exitCode = 1;
      return null;
    };
    if (sub === "build") {
      const at = a.build({ root: process.cwd() });
      console.log(
        `  indexed ${at.symbols.length} symbols in ${at.files} files → .forge/atlas.json${at.capped ? " (capped)" : ""}`,
      );
    } else if (sub === "query") {
      const at = need();
      if (!at) return;
      const hits = a.query(at, argv.slice(2).join(" "));
      console.log(
        hits.length
          ? hits
              .slice(0, 30)
              .map((s) => `  ${s.file}:${s.line}  ${s.kind} ${s.name}`)
              .join("\n")
          : "  no match",
      );
    } else if (sub === "has") {
      const at = need();
      if (!at) return;
      const name = argv[2];
      const yes = a.has(at, name);
      console.log(`  ${yes ? "✓ defined" : "✗ not found (possible hallucinated symbol)"}: ${name}`);
      if (!yes) process.exitCode = 1;
    } else {
      console.error(`atlas: unknown subcommand "${sub}" (build | query | has)`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "scan") {
    const { scan } = await import("./skillgate.js");
    const target = argv[1];
    if (!target) {
      console.error("usage: forge scan <SKILL.md | .mcp.json | path>");
      process.exitCode = 1;
      return;
    }
    const r = scan(target);
    heading(`${BRAND.brand} scan — skill-gate (${r.scanner})\n`);
    if (r.findings?.length) {
      for (const f of r.findings) console.log(`  [${f.sev}] ${f.msg}`);
    } else if (r.raw) {
      console.log(`  ${r.raw.trim().split("\n").slice(-6).join("\n  ")}`);
    } else {
      console.log("  no obvious red flags");
    }
    console.log(
      `\n  ${r.critical ? "BLOCKED — critical finding, do not install" : "ok to install"}`,
    );
    if (r.critical) process.exitCode = 1;
    return;
  }
  if (cmd === "verify") {
    const { verify } = await import("./verify.js");
    const json = argv.includes("--json");
    const r = verify({ targetRoot: process.cwd() });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    heading(`${BRAND.brand} verify\n`);
    console.log(`  changed files:    ${r.changedFiles.length}`);
    console.log(
      `  tests:            ${r.tests.ran ? (r.tests.passed ? "✓ pass" : "✗ FAIL") : "— none detected"}`,
    );
    console.log(`  symbols checked:  ${r.provenance.symbolsChecked}`);
    if (r.unknown.length)
      console.log(
        `  ! not in codebase (possible hallucination): ${r.unknown.slice(0, 12).join(", ")}`,
      );
    console.log(`  provenance:       .forge/provenance.json`);
    console.log(`\n  ${r.ok ? "PASS" : "BLOCKED — tests failing"}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "remember") {
    const b = await import("./brain.js");
    const name = argv[1];
    const body = argv.slice(2).join(" ");
    if (!name || !body) {
      console.error('usage: forge remember "<name>" "<fact>"');
      process.exitCode = 1;
      return;
    }
    const res = b.remember(b.brainStore(process.cwd()), name, body);
    if (res.ok) {
      // Brain is repo-scoped and git-committable → shadow into the REPO ledger.
      try {
        const { shadowFact } = await import("./ledger_bridge.js");
        const { repoLedger } = await import("./ledger_store.js");
        shadowFact(repoLedger(process.cwd()), name, body);
      } catch {}
      // Rebuild the inlined index after the shadow so a ledger-only brain's
      // AGENTS.brain.md includes the fact (its only copy now lives in the ledger).
      b.buildIndex(b.brainStore(process.cwd()));
    }
    console.log(
      res.ok
        ? `  remembered: ${res.slug} — run \`forge sync\` to inline it into every tool`
        : `  ${res.reason}`,
    );
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "brain") {
    const b = await import("./brain.js");
    const store = b.brainStore(process.cwd());
    const idx = b.buildIndex(store);
    const items = b.list(store);
    heading(`${BRAND.brand} brain — portable project memory\n`);
    console.log(
      items.length
        ? items.map((s) => `  - ${s}`).join("\n")
        : '  (no facts yet — forge remember "<name>" "<fact>")',
    );
    console.log(
      `\n  ${idx.indexed} inlined into AGENTS.md${idx.overflow ? `, ${idx.overflow} in overflow` : ""} · stored in .forge/brain/`,
    );
    return;
  }
  if (cmd === "cost") {
    // `--stages` is the P8 measured report (per-stage factors from .forge/metrics.jsonl);
    // the default path stays the ccusage per-day spend view, untouched.
    if (argv.includes("--stages")) {
      const { renderCostReport, report } = await import("./cost_report.js");
      const r = report(process.cwd());
      console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : renderCostReport(r));
      return;
    }
    const { execFileSync } = await import("node:child_process");
    const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", stdio: "pipe" });
    heading(`${BRAND.brand} cost — real per-day spend (ccusage)\n`);
    try {
      let out;
      try {
        out = run("ccusage", ["daily"]);
      } catch {
        // Pinned (verified 2026-07-05) — never @latest for code we execute; re-verify via dev-radar.
        out = run("npx", ["-y", "ccusage@20.0.14", "daily"]);
      }
      console.log(out.trim());
    } catch {
      const { estimateSpendFromLogs } = await import("./cost_report.js");
      const est = estimateSpendFromLogs();
      if (est && est.totalCost > 0) {
        console.log(
          `  $${est.totalCost.toFixed(2)} estimated from Claude session logs (${est.sessions} session(s))`,
        );
        if (est.byModel.length) {
          for (const m of est.byModel)
            console.log(
              `    ${m.model.padEnd(30)} $${m.cost.toFixed(4)}  (${m.inTokens} in / ${m.outTokens} out)`,
            );
        }
        console.log(paint("\n  install ccusage for precise tracking: npm i -g ccusage", "dim"));
      } else {
        console.log(
          "  ccusage not found. Install for real spend (reads local JSONL, nothing leaves your machine):\n    npm i -g ccusage    # then: forge cost",
        );
      }
    }
    console.log(
      paint(
        `\n  ceiling: FORGE_COST_CEILING (default $10) — the cost-budget guard warns when a day exceeds it.`,
        "dim",
      ),
    );
    return;
  }
  if (cmd === "spec") {
    const s = await import("./speclock.js");
    const sub = argv[1] || "check";
    if (sub === "init") {
      const { execFileSync } = await import("node:child_process");
      try {
        // Pinned (verified 2026-07-05) — never @latest for code we execute; re-verify via dev-radar.
        execFileSync("npx", ["-y", "@fission-ai/openspec@1.5.0", "init"], {
          stdio: "inherit",
        });
      } catch {
        console.log(
          "  OpenSpec not run. Scaffold spec-driven dev:\n    npx -y @fission-ai/openspec init   # lightweight (default)\n    # or GitHub Spec Kit for heavier/governed projects",
        );
      }
      return;
    }
    if (sub === "lock") {
      const { count } = s.snapshot(process.cwd());
      console.log(`  spec-lock: snapshotted ${count} spec(s) → .forge/spec-lock.json`);
      return;
    }
    const r = s.check(process.cwd());
    heading(`${BRAND.brand} spec check\n`);
    if (r.note) console.log(`  ${r.note}`);
    else if (r.drift.length) {
      for (const d of r.drift) {
        console.log(`  ✗ ${d.spec} claims \`${d.symbol}\` — no longer defined in the code`);
      }
    } else console.log("  ✓ no drift — every claimed symbol still exists");
    console.log(`\n  ${r.ok ? "PASS" : "DRIFT — update the spec or restore the symbol"}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "harden") {
    const { harden } = await import("./harden.js");
    const r = harden({ targetRoot: process.cwd() });
    heading(`${BRAND.brand} harden\n`);
    console.log(`  gitleaks:            ${r.gitleaks}`);
    console.log(`  pre-commit gate:     ${r.precommit}`);
    console.log(
      `  sandbox settings:    ${r.sandbox} — merge into ~/.claude/settings.json to enable (84% fewer prompts)`,
    );
    return;
  }
  if (cmd === "precommit") {
    // The commit-level rung of the gate lattice (turn ⊂ commit ⊂ PR): the harden-installed
    // pre-commit hook execs this, and it can be run by hand before committing. Exit code
    // carries the decision (1 = refuse the commit); fail-open inside commitGate.
    const { commitGate, renderCommitGate } = await import("./commit_gate.js");
    const r = commitGate(process.cwd());
    if (argv.includes("--json")) {
      console.log(JSON.stringify(r, null, 2));
      if (!r.allow) process.exitCode = 1;
      return;
    }
    heading(`${BRAND.brand} precommit — commit-level completeness + secret gate\n`);
    console.log(renderCommitGate(r));
    if (!r.allow) process.exitCode = 1;
    return;
  }
  if (cmd === "cortex") {
    const c = await import("./cortex.js");
    const root = process.cwd();
    const nowDay = Math.floor(Date.now() / 86400000);
    const sub = argv[1] || "status";
    if (sub === "why") {
      const key = argv[2];
      if (!key) {
        console.error("usage: forge cortex why <symbol|file>");
        process.exitCode = 1;
        return;
      }
      const { block, selected } = c.lessonsForContext(
        root,
        { symbols: [key], files: [key], keywords: [key] },
        { nowDay },
      );
      console.log(selected.length ? block : `  no lessons for ${key} yet`);
      return;
    }
    const s = c.summary(root, nowDay);
    heading(`${BRAND.brand} cortex — self-correcting project memory\n`);
    console.log(
      `  lessons: ${s.total}  (active ${s.active} · candidate ${s.candidate} · quarantined ${s.quarantined} · retired ${s.retired})`,
    );
    if (s.topActive.length) {
      console.log("\n  top active (by confidence):");
      for (const t of s.topActive)
        console.log(`    ${bar(t.confidence, 8)} ${t.confidence.toFixed(2)}  ${t.id}`);
    } else {
      console.log("\n  (no active lessons yet — Cortex learns from corrections as you work)");
    }
    console.log(paint("\n  stored in .forge/lessons/ (git-committable, auditable)", "dim"));
    return;
  }
  if (cmd === "preflight") {
    const { preflightRepo, clarifyBlock } = await import("./preflight.js");
    const json = argv.includes("--json");
    const task = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!task) {
      console.error('usage: forge preflight "<task description>" [--json]');
      process.exitCode = 1;
      return;
    }
    const r = preflightRepo(process.cwd(), task);
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    heading(`${BRAND.brand} preflight — assumption check\n`);
    console.log(
      `  info-gap: ${r.gap.toFixed(2)}  · completeness ${r.assumption.completeness.toFixed(2)}  (referenced ${r.entities.symbols.length} symbol(s), ${r.entities.files.length} file(s))`,
    );
    const block = clarifyBlock(r);
    console.log(
      block ? `\n${block}` : "\n  ✓ everything this task names is grounded in the codebase.",
    );
    return;
  }
  if (cmd === "impact") {
    const { predictImpact } = await import("./substrate.js");
    const json = argv.includes("--json");
    const target = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!target) {
      console.error("usage: forge impact <symbol|file> [--json]");
      process.exitCode = 1;
      return;
    }
    const r = predictImpact(process.cwd(), target);
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    heading(`${BRAND.brand} impact — blast radius\n`);
    console.log(`  target: ${target}  ${r.found ? "✓ found" : "not found"}`);
    console.log(`  impacted files: ${r.impactedFiles.length}`);
    for (const file of r.impactedFiles.slice(0, 20)) console.log(`    - ${file}`);
    if (r.impactedFiles.length > 20) console.log(`    … ${r.impactedFiles.length - 20} more`);
    return;
  }
  if (cmd === "substrate") {
    const { renderSubstrate, substrateCheck } = await import("./substrate.js");
    const json = argv.includes("--json");
    const task = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!task) {
      console.error('usage: forge substrate "<task>" [--json]');
      process.exitCode = 1;
      return;
    }
    const r = substrateCheck(process.cwd(), task);
    console.log(json ? JSON.stringify(r, null, 2) : renderSubstrate(r));
    return;
  }
  if (cmd === "config") {
    const sub = argv[1] || "show";
    const { loadProviders, activeProvider, setProvider, addProvider, listProviders, applyRoute } =
      await import("./providers.js");
    const json = argv.includes("--json");
    if (sub === "show") {
      const prov = activeProvider(process.cwd());
      const config = loadProviders(process.cwd());
      if (json)
        return console.log(JSON.stringify({ active: config.active, provider: prov }, null, 2));
      heading(`${BRAND.brand} config\n`);
      console.log(`  provider:  ${prov.name} (${prov.label || prov.name})`);
      if (prov._autoDetected) console.log(`  detected:  auto (from ${prov._source})`);
      console.log(`  base URL:  ${prov.baseUrl}`);
      console.log(
        `  env key:   ${prov.envKey || "(none)"}${prov.envKey ? (process.env[prov.envKey] ? " ✓ set" : " ✗ not set") : ""}`,
      );
      console.log(`  models:`);
      for (const [tier, id] of Object.entries(prov.models || {}))
        console.log(`    ${tier.padEnd(8)} ${id}`);
      return;
    }
    if (sub === "providers") {
      const list = listProviders(process.cwd());
      if (json) return console.log(JSON.stringify(list, null, 2));
      heading(`${BRAND.brand} config providers\n`);
      for (const p of list)
        console.log(
          `  ${p.active ? "▸" : " "} ${p.name.padEnd(14)} ${p.label.padEnd(20)} ${p.envKey ? (p.hasKey ? "✓ key set" : "✗ key missing") : ""}`,
        );
      console.log(`\n  switch: \`${BRAND.cli} config provider <name>\``);
      return;
    }
    if (sub === "provider") {
      const name = argv[2];
      if (!name) {
        console.error(
          `usage: ${BRAND.cli} config provider <name>   |   ${BRAND.cli} config provider add <name> --base-url <url> [--key-env <VAR>]`,
        );
        process.exitCode = 1;
        return;
      }
      if (name === "add") {
        const addName = argv[3];
        const flagVal = (f) => {
          const i = argv.indexOf(f);
          return i >= 0 ? argv[i + 1] : undefined;
        };
        const baseUrl = flagVal("--base-url");
        const envKey = flagVal("--key-env");
        const label = flagVal("--label");
        const r = addProvider(process.cwd(), addName, {
          baseUrl,
          envKey,
          label,
        });
        if (!r.ok) {
          console.error(`  ${r.reason}`);
          process.exitCode = 1;
          return;
        }
        console.log(`  added provider "${addName}" → ${r.provider.baseUrl}`);
        return;
      }
      const r = setProvider(process.cwd(), name);
      if (!r.ok) {
        console.error(`  ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  switched to provider "${name}" (${r.provider.label || name})`);
      return;
    }
    if (sub === "model") {
      const tier = argv[2];
      if (!tier) {
        console.error(`usage: ${BRAND.cli} config model <haiku|sonnet|opus|fable>`);
        process.exitCode = 1;
        return;
      }
      const r = applyRoute(tier);
      if (!r.ok) {
        console.error(`  ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  model set to ${r.model} (${r.modelId})${r.prev ? ` — was: ${r.prev}` : ""}`);
      console.log(`  written to ${r.path}`);
      return;
    }
    if (sub === "gateway") {
      const { emitGatewayConfig } = await import("./route.js");
      const result = emitGatewayConfig(process.cwd());
      if (typeof result === "object" && !result.ok) {
        console.log(`  ${result.reason}`);
        return;
      }
      console.log(`  wrote ${result}`);
      console.log(`\n  setup LiteLLM gateway:`);
      console.log(`    1. pip install "litellm[proxy]"    # pin an exact verified version`);
      console.log(`    2. litellm --config litellm.config.yaml`);
      console.log(`    3. export ANTHROPIC_BASE_URL=http://localhost:4000`);
      console.log(`\n  then switch to the gateway provider:`);
      console.log(`    ${BRAND.cli} config provider litellm`);
      console.log(`\n  routing flows through: forge route → tier alias → LiteLLM → model`);
      return;
    }
    if (sub === "setup") {
      const { providerStatus, listDetectedProviders } = await import("./providers.js");
      const prov = activeProvider(process.cwd());
      const status = providerStatus(process.cwd());
      const detected = listDetectedProviders();
      heading(`${BRAND.brand} config setup\n`);
      console.log(`  active provider: ${prov.name} (${prov.label || prov.name})`);
      if (prov._autoDetected) console.log(`  source: auto-detected from ${prov._source}`);
      console.log();
      for (const c of status.checks) {
        console.log(`  ${c.ok ? "✓" : "✗"} ${c.detail}`);
      }
      console.log(`\n  environment:`);
      for (const e of status.envScan) {
        console.log(`  ${e.set ? "✓" : "·"} ${e.key}${e.set ? " (set)" : ""}`);
      }
      if (detected.length) {
        console.log(`\n  available providers (auto-detected):`);
        for (const d of detected) {
          console.log(`    ${d.name.padEnd(18)} ${d.label.padEnd(24)} via ${d.source}`);
        }
      }
      console.log(`\n  Anthropic Console API key:`);
      console.log(`    1. Go to console.anthropic.com/settings/keys`);
      console.log(`    2. Create a key, then:  export ANTHROPIC_API_KEY=sk-ant-...`);
      console.log(`\n  OpenRouter API key:`);
      console.log(`    1. Go to openrouter.ai/keys`);
      console.log(`    2. Create a key, then:  export OPENROUTER_API_KEY=sk-or-...`);
      console.log(`\n  LiteLLM hosted gateway (no admin access needed):`);
      console.log(`    export LITELLM_BASE_URL=https://your-gateway.example.com`);
      console.log(`    export LITELLM_API_KEY=sk-...    # or uses ANTHROPIC_API_KEY`);
      console.log(`\n  LiteLLM self-hosted gateway:`);
      console.log(`    ${BRAND.cli} config gateway    # emit litellm.config.yaml`);
      console.log(`    ${BRAND.cli} config provider litellm`);
      console.log(`\n  quick start:`);
      console.log(`    ${BRAND.cli} config provider anthropic     # direct Anthropic API`);
      console.log(`    ${BRAND.cli} config provider openrouter    # OpenRouter multi-model`);
      console.log(`    ${BRAND.cli} config provider litellm       # LiteLLM self-hosted`);
      console.log(`    ${BRAND.cli} config model sonnet           # set default model tier`);
      console.log(`    ${BRAND.cli} route "<task>" --apply        # route + apply model`);
      return;
    }
    console.error(
      `config: unknown subcommand "${sub}" (show | providers | provider <name> | model <tier> | gateway | setup)`,
    );
    process.exitCode = 1;
    return;
  }
  if (cmd === "route") {
    const r = await import("./route.js");
    if (argv[1] === "gateway") {
      const result = r.emitGatewayConfig(process.cwd());
      if (typeof result === "object" && !result.ok) {
        console.log(`  ${result.reason}`);
        return;
      }
      console.log(
        `  wrote ${result} — LiteLLM tiers: forge-simple / forge-medium / forge-complex.`,
      );
      console.log("  next: pin+install litellm, run it, point ANTHROPIC_BASE_URL at it, then");
      console.log(
        "        REQUEST the tier `forge route` recommends (a plain claude-* request passes through).",
      );
      return;
    }
    if (argv[1] === "calibrate") {
      // Advisory → gated promotion (ROADMAP): measure whether an affine calibration of the
      // routing rubric beats the raw rubric on the held-out fixture. Advisory — routing
      // keeps the rubric unless the gate promotes AND a caller adopts the calibration.
      const res = r.calibrateRouting();
      if (argv.includes("--json")) return console.log(JSON.stringify(res, null, 2));
      heading(`${BRAND.brand} route calibrate — outcome-calibrated routing (measured gate)\n`);
      console.log(`  samples: ${res.n} labeled task(s)`);
      if (res.baselineMetric !== undefined)
        console.log(
          `  held-out MAE: rubric ${res.baselineMetric} · calibrated ${res.candidateMetric}`,
        );
      console.log(
        res.mode === "candidate"
          ? `  → PROMOTE calibration — ${res.reason} (a=${res.model.a.toFixed(3)}, b=${res.model.b.toFixed(3)})`
          : `  → keep the rubric — ${res.reason}`,
      );
      console.log(
        "\n  advisory — routing stays on the rubric until a promoted calibration is adopted",
      );
      return;
    }
    const json = argv.includes("--json");
    const apply = argv.includes("--apply");
    const providerIdx = argv.indexOf("--provider");
    const providerName = providerIdx >= 0 ? argv[providerIdx + 1] : undefined;
    const FLAGS = new Set(["--json", "--apply"]);
    const task = argv
      .slice(1)
      .filter((a, i) => !FLAGS.has(a) && a !== "--provider" && argv[i] !== "--provider")
      .join(" ");
    if (!task) {
      console.error(
        'usage: forge route "<task>" [--apply] [--provider <name>] [--json]   |   forge route gateway',
      );
      process.exitCode = 1;
      return;
    }
    if (providerName) {
      const { setProvider } = await import("./providers.js");
      const sr = setProvider(process.cwd(), providerName);
      if (!sr.ok) {
        console.error(`  ${sr.reason}`);
        process.exitCode = 1;
        return;
      }
    }
    const rec = r.routeTask(process.cwd(), task);
    r.meterRoute(process.cwd(), task, rec);
    if (json) {
      console.log(JSON.stringify(rec, null, 2));
    } else {
      heading(`${BRAND.brand} route — cheapest capable model\n`);
      console.log(
        `  → ${paint(rec.model.name, "accent")}  (${rec.tier}, $${rec.model.inCost}/$${rec.model.outCost} per M tok)`,
      );
      console.log(`    ${rec.model.use}`);
      console.log(
        `    complexity ${bar(rec.score, 8)} ${rec.score.toFixed(2)}${rec.reasons.length ? ` · driven by: ${rec.reasons.join(", ")}` : ""}`,
      );
      console.log(
        `    signals: ${rec.signals.files} file(s), fan-out ${rec.signals.fanout}, churn ${rec.signals.churn}, past-mistakes ${rec.signals.pastMistakes}, ambiguity ${rec.signals.ambiguity.toFixed(2)}`,
      );
    }
    if (apply) {
      const { applyRoute } = await import("./providers.js");
      const ar = applyRoute(rec.key);
      if (ar.ok) {
        if (!json)
          console.log(`\n  applied: model set to ${ar.model} (${ar.modelId}) in ${ar.path}`);
      } else {
        if (!json) console.error(`\n  apply failed: ${ar.reason}`);
        process.exitCode = 1;
      }
    } else if (!json) {
      console.log(
        `\n  advisory · apply: \`${BRAND.cli} route "<task>" --apply\` · gateway: \`${BRAND.cli} route gateway\``,
      );
    }
    return;
  }
  if (cmd === "anchor") {
    const { goalDrift, renderAnchor } = await import("./anchor.js");
    const { clearGoal, getGoal, setGoal } = await import("./goal.js");
    const json = argv.includes("--json");
    const args = argv.slice(1).filter((a) => a !== "--json");
    const sub = args[0];
    // Persistent goal management: `set` stores it, SessionStart re-injects it, and a
    // bare `forge anchor` checks against it — the goal survives the session that set it.
    if (sub === "set") {
      const r = setGoal(process.cwd(), args.slice(1).join(" "));
      if (!r.ok) {
        console.error(`${BRAND.cli} anchor set: ${r.reason}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `goal set: ${r.goal}\n(injected each session start; \`forge anchor\` checks against it)`,
      );
      return;
    }
    if (sub === "show") {
      const g = getGoal(process.cwd());
      console.log(g ? `active goal: ${g}` : 'no active goal — set one: forge anchor set "<goal>"');
      return;
    }
    if (sub === "clear") {
      clearGoal(process.cwd());
      console.log("goal cleared.");
      return;
    }
    const goal = args.join(" ") || getGoal(process.cwd());
    if (!goal) {
      console.error(
        `usage: ${BRAND.cli} anchor "<original goal>" [--json]\n       ${BRAND.cli} anchor set|show|clear — persist the goal across sessions`,
      );
      process.exitCode = 1;
      return;
    }
    const r = goalDrift(process.cwd(), goal);
    console.log(json ? JSON.stringify(r, null, 2) : renderAnchor(r));
    return; // advisory — never fails the process
  }
  if (cmd === "handoff") {
    const { writeState } = await import("./handoff.js");
    const json = argv.includes("--json");
    const args = argv.slice(1).filter((a) => a !== "--json");
    // Repeatable flags collect rows; positionals are "done" rows. Piped stdin (one row
    // per line) covers agents that assemble the summary programmatically.
    const fields = { done: [], next: [], gotchas: [], criteria: [] };
    const FLAG = {
      "--next": "next",
      "--gotcha": "gotchas",
      "--criteria": "criteria",
    };
    for (let i = 0; i < args.length; i += 1) {
      if (FLAG[args[i]]) fields[FLAG[args[i]]].push(args[++i] ?? "");
      else if (args[i] === "--phase") fields.phase = args[++i] ?? "";
      else fields.done.push(args[i]);
    }
    if (!fields.done.length && !process.stdin.isTTY) {
      try {
        const { readFileSync } = await import("node:fs");
        fields.done = readFileSync(0, "utf8").split("\n");
      } catch {}
    }
    const r = writeState(process.cwd(), fields);
    if (json) return console.log(JSON.stringify(r, null, 2));
    if (!r.ok) {
      console.error(
        `${BRAND.cli} handoff: ${r.reason}\nusage: ${BRAND.cli} handoff "<done>" [--next "<step>"] [--gotcha "<trap>"] [--criteria "<check>"] [--phase <p>]`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `  state written: ${r.path} (${r.lines} lines)\n  (re-injected at every session start — the next session resumes instead of re-assuming)`,
    );
    return;
  }
  if (cmd === "decide") {
    const { appendDecision, listDecisions } = await import("./decide.js");
    const json = argv.includes("--json");
    const text = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!text) {
      const rows = listDecisions(process.cwd(), { limit: 10 });
      if (json) return console.log(JSON.stringify(rows, null, 2));
      console.log(
        rows.length
          ? rows.map((d) => `  ${d.id} (${d.date}): ${d.text}`).join("\n")
          : `  no decisions recorded — ${BRAND.cli} decide "<what was decided — why>"`,
      );
      return;
    }
    const r = appendDecision(process.cwd(), text);
    if (json) return console.log(JSON.stringify(r, null, 2));
    if (!r.ok) {
      console.error(`${BRAND.cli} decide: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  recorded ${r.id}: ${r.text}`);
    return;
  }
  if (cmd === "know") {
    // A7 knowledge-router: total routing (T6) of a fact to its storage home — an unsure
    // fact still lands (ledger fallback), it is never dropped.
    const { HOMES, routeFact, storeFact } = await import("./knowledge_router.js");
    const json = argv.includes("--json");
    const dry = argv.includes("--dry-run");
    const text = argv
      .slice(1)
      .filter((a) => a !== "--json" && a !== "--dry-run")
      .join(" ");
    if (!text) {
      console.error(`usage: ${BRAND.cli} know "<fact>" [--dry-run] [--json]`);
      process.exitCode = 1;
      return;
    }
    const route = routeFact(text);
    const r = storeFact(process.cwd(), text, {
      mode: dry ? "advise" : "auto",
      route,
    });
    if (json) return console.log(JSON.stringify({ ...route, ...r, dryRun: dry }, null, 2));
    heading(`${BRAND.brand} know — knowledge routing (A7)\n`);
    const why =
      route.provenance === "fallback"
        ? "fallback — resembles no exemplar; the ledger absorbs unsure placements"
        : `confidence ${route.confidence}`;
    console.log(`  home:     ${route.home} (${why}) → ${HOMES[route.home].where}`);
    const near = route.neighbors[0];
    if (near) console.log(`  nearest:  "${near.text}" (${near.sim.toFixed(3)})`);
    if (!r.ok) {
      console.error(`  ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    if (r.stored) console.log(`  stored:   ${r.ref}`);
    else if (dry) console.log("  (dry-run — nothing written)");
    if (r.advice) console.log(`  advice:   ${r.advice}`);
    return;
  }
  if (cmd === "diagnose") {
    const { diagnose, THRASH_K } = await import("./diagnose.js");
    const json = argv.includes("--json");
    const flagVal = (name) => {
      const i = argv.indexOf(name);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const args = argv.filter(
      (a, i) => !a.startsWith("--") && argv[i - 1] !== "--file" && argv[i - 1] !== "--symbol",
    );
    const errorText = args.slice(1).join(" ");
    if (!errorText) {
      console.error('usage: forge diagnose "<error text>" [--file f] [--symbol s] [--json]');
      process.exitCode = 1;
      return;
    }
    const r = diagnose(process.cwd(), {
      errorText,
      file: flagVal("--file"),
      symbol: flagVal("--symbol"),
    });
    if (json) return console.log(JSON.stringify(r, null, 2));
    heading(`${BRAND.brand} diagnose — doom-loop check\n`);
    console.log(
      `  signature: ${r.signature.slice(0, 12)} · seen ${r.count}× in the recent failure window`,
    );
    if (r.thrash) {
      if (r.claimId)
        console.log(
          `  diagnosis claim: ${r.claimId.slice(0, 12)}  (\`forge ledger show ${r.claimId.slice(0, 8)}\`)`,
        );
      console.log(`\n  ${r.escalate ?? r.reason}`);
    } else {
      console.log(`  below the thrash threshold (${THRASH_K}) — recorded; keep going.`);
    }
    return; // advisory — halting the retry loop is the AGENT's move, not an exit code
  }
  if (cmd === "imagine") {
    const { dryRun, imagineTask, renderImagine } = await import("./imagine.js");
    const json = argv.includes("--json");
    const doRun = argv.includes("--run");
    const allowDirty = argv.includes("--allow-dirty");
    const FLAGS = new Set(["--json", "--run", "--allow-dirty"]);
    const task = argv
      .slice(1)
      .filter((a) => !FLAGS.has(a))
      .join(" ");
    if (!task) {
      console.error('usage: forge imagine "<task>" [--run] [--allow-dirty] [--json]');
      process.exitCode = 1;
      return;
    }
    const root = process.cwd();
    const r = imagineTask(root, task);
    if (!doRun) {
      console.log(json ? JSON.stringify(r, null, 2) : renderImagine(r));
      return;
    }
    // --run: the static prediction first (always), then the measured half. The sandbox
    // is a git worktree of HEAD — uncommitted changes are INVISIBLE to it — so a dirty
    // tree is refused by default rather than silently dry-running the wrong code.
    if (!json) console.log(renderImagine(r, { footer: false }));
    if (!allowDirty) {
      let dirty = "";
      try {
        const { execFileSync } = await import("node:child_process");
        dirty = execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {} // not a repo / no git → dryRun reports its own precondition failure
      if (dirty) {
        console.error(
          "\n  imagine --run refused: the working tree is dirty and the sandbox runs HEAD,\n" +
            "  so your uncommitted changes would NOT be in the dry-run. Commit or stash them,\n" +
            "  or pass --allow-dirty to knowingly measure the last commit instead.",
        );
        process.exitCode = 1;
        return;
      }
    }
    const d = dryRun(root, { tests: r.tests });
    // Metrics are best-effort telemetry (05-cost-model.md) — never let recording
    // failure break the verdict. Only a run that happened is worth counting.
    try {
      if (d.durationMs !== undefined) {
        const { record } = await import("./metrics.js");
        record(root, {
          stage: "imagine",
          outcome: d.ok && d.failed === 0 ? "clean" : "breaks",
          ref: task.slice(0, 120),
          durationMs: d.durationMs,
        });
      }
    } catch {}
    if (json) {
      console.log(JSON.stringify({ ...r, dryRun: d }, null, 2));
      return;
    }
    if (!d.ok) {
      console.log(`\n  dry-run: did not produce a verdict — ${d.reason}`);
      if (d.output) console.log(`\n${d.output.replace(/^/gm, "    ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  dry-run (sandboxed worktree of HEAD · ${d.runner}):`);
    console.log(
      `    pass ${d.passed} · fail ${d.failed} · ${d.durationMs}ms · worktree ${d.worktree}`,
    );
    if (d.perFile)
      for (const [t, s] of Object.entries(d.perFile))
        console.log(`    ${s === "pass" ? "ok  " : "FAIL"} ${t}`);
    if (d.failed > 0) {
      console.log("\n  measured consequence: the selected suite BREAKS at HEAD — output tail:");
      console.log(`\n${(d.output || "").replace(/^/gm, "    ")}`);
    } else {
      console.log("\n  measured consequence: the selected suite is green at HEAD.");
    }
    return;
  }
  if (cmd === "lean") {
    const { leanRepo, renderLean } = await import("./lean.js");
    const json = argv.includes("--json");
    const task = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!task) {
      console.error(
        'usage: forge lean "<task>" [--json]   (measures the working diff vs the task)',
      );
      process.exitCode = 1;
      return;
    }
    const r = leanRepo(process.cwd(), task);
    console.log(json ? JSON.stringify(r, null, 2) : renderLean(r));
    return; // advisory — never fails the process
  }
  if (cmd === "scope") {
    const { decompose } = await import("./scope.js");
    const json = argv.includes("--json");
    const files = argv.slice(1).filter((a) => a !== "--json");
    if (!files.length) {
      console.error("usage: forge scope <file> [file...] [--json]");
      process.exitCode = 1;
      return;
    }
    const d = decompose(process.cwd(), files);
    if (json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    heading(`${BRAND.brand} scope — task decomposition\n`);
    if (d.independentGroups > 1) {
      console.log(
        `  ${d.independentGroups} independent groups → consider a separate session per group:\n`,
      );
    }
    d.clusters.forEach((c, i) => {
      console.log(`  [${i + 1}] ${c.touched.join(", ")}`);
      if (c.coupled.length) {
        const shown = c.coupled.slice(0, 8).join(", ");
        console.log(
          `      ! also coupled (you didn't name): ${shown}${c.coupled.length > 8 ? " …" : ""}`,
        );
      }
    });
    if (d.independentGroups === 1) console.log("\n  all coupled — keep as one change.");
    return;
  }
  if (cmd === "uicheck") {
    const sub = argv[1];
    if (sub === "visual") {
      // The Playwright visual loop (spec §5): render in a real browser, fingerprint
      // the COMPUTED styles, run the same design gate. Playwright is an optional
      // tier (ADR-0005) — its absence is a note and exit 0, never a failure.
      const { visualGate } = await import("./uivisual.js");
      const args = argv.slice(2);
      const tasteIdx = args.indexOf("--taste");
      const tasteArg = tasteIdx >= 0 ? (args.splice(tasteIdx, 2)[1] ?? null) : null;
      const json = args.includes("--json");
      const remote = args.includes("--remote");
      const targets = args.filter((a) => !a.startsWith("--"));
      if (targets.length !== 1 || (tasteIdx >= 0 && !tasteArg)) {
        console.error(
          `usage: ${BRAND.cli} uicheck visual <file-or-url> [--taste <name>] [--json] [--remote]`,
        );
        process.exitCode = 1;
        return;
      }
      const r = await visualGate(targets[0], {
        taste: tasteArg,
        remote,
        root: process.cwd(),
      });
      if (!r.ok) {
        const reason = "reason" in r ? r.reason : "visual gate failed";
        if ("skipped" in r && r.skipped) {
          // Graceful absence (ADR-0005): a missing optional tier is not a failure.
          if (json) console.log(JSON.stringify({ skipped: true, reason }, null, 2));
          else {
            heading(`${BRAND.brand} uicheck visual — skipped (no browser runtime)\n`);
            console.log(`  ${reason}`);
            console.log(
              "  enable it: npm i -D playwright-core   (or point FORGE_PLAYWRIGHT at an existing install, e.g. FORGE_PLAYWRIGHT=/path/to/node_modules/playwright-core)",
            );
          }
          return; // exit 0 — the static gate still stands
        }
        console.error(reason);
        process.exitCode = 1;
        return;
      }
      if (json) {
        const { ok: _ok, fail: _fail, ...body } = r;
        console.log(JSON.stringify(body, null, 2));
      } else {
        heading(`${BRAND.brand} uicheck visual — rendered fingerprint + design gate\n`);
        console.log(`  rendered:      ${r.url} (${r.elements} visible element style(s))`);
        console.log(`  screenshots:   ${r.screenshots.join(", ")}`);
        if (r.taste) console.log(`  taste:         ${r.taste} (thresholds from its profile)`);
        console.log(
          `  slop distance: ${r.slop}  (need ≥ ${r.tauSlop} — farther from generic is better)`,
        );
        console.log(
          r.hasProjectFingerprint
            ? `  conformance:   ${r.conform}  (need ≤ ${r.tauConform} — closer to the project system is better)`
            : `  conformance:   (no project fingerprint claim — slop-only; mint one: \`${BRAND.cli} uicheck fingerprint <ui files> --mint\`)`,
        );
        for (const v of r.violations) console.log(`\n  ✗ ${v.detail}\n    fix: ${v.hint}`);
        console.log("");
        for (const c of r.checks)
          console.log(
            `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.detail}${c.pass || !c.hint ? "" : `\n    fix: ${c.hint}`}`,
          );
        console.log(`\n  ${r.fail ? "✗ FAIL" : "✓ PASS"}`);
      }
      if (r.fail) process.exitCode = 1;
      return;
    }
    if (sub === "interact") {
      // The Playwright interaction loop (ROADMAP "Next"): drive the page and check what
      // it DOES — keyboard reach, a visible focus ring, console cleanliness, reduced-
      // motion honesty. Advisory by default (the `behavioral` oracle is cross-family-
      // gated); --enforce or FORGE_ENFORCE=1 turns a fail into a non-zero exit. Playwright
      // is an optional tier (ADR-0005) — its absence is a note and exit 0, never a failure.
      const { runInteractions, recordInteraction } = await import("./uiinteract.js");
      const args = argv.slice(2);
      const json = args.includes("--json");
      const remote = args.includes("--remote");
      const record = args.includes("--record");
      const enforce = args.includes("--enforce") || process.env.FORGE_ENFORCE === "1";
      const targets = args.filter((a) => !a.startsWith("--"));
      if (targets.length !== 1) {
        console.error(
          `usage: ${BRAND.cli} uicheck interact <file-or-url> [--record] [--enforce] [--json] [--remote]`,
        );
        process.exitCode = 1;
        return;
      }
      const r = await runInteractions(targets[0], {
        remote,
        cwd: process.cwd(),
      });
      if (!r.ok) {
        const reason = "reason" in r ? r.reason : "interaction run failed";
        if ("skipped" in r && r.skipped) {
          // Graceful absence (ADR-0005): a missing optional tier is not a failure.
          if (json) console.log(JSON.stringify({ skipped: true, reason }, null, 2));
          else {
            heading(`${BRAND.brand} uicheck interact — skipped (no browser runtime)\n`);
            console.log(`  ${reason}`);
            console.log(
              "  enable it: npm i -D playwright-core   (or point FORGE_PLAYWRIGHT at an existing install)",
            );
          }
          return; // exit 0 — the advisory tier is absent
        }
        console.error(reason);
        process.exitCode = 1;
        return;
      }
      const recorded = record ? recordInteraction(process.cwd(), r.url, r.verdict) : null;
      if (json) {
        console.log(JSON.stringify({ url: r.url, ...r.verdict, recorded }, null, 2));
      } else {
        heading(`${BRAND.brand} uicheck interact — browser interaction checks\n`);
        console.log(`  driven:        ${r.url} (headless, prefers-reduced-motion)`);
        for (const c of r.verdict.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.id}: ${c.detail}`);
        console.log(`\n  ${r.verdict.pass ? "✓ PASS" : "✗ FAIL"}${enforce ? "" : "  (advisory)"}`);
        if (recorded)
          console.log(
            recorded.recorded
              ? `  recorded as behavioral evidence on design claim ${recorded.claimId.slice(0, 12)}`
              : `  not recorded: ${recorded.reason}`,
          );
      }
      if (!r.verdict.pass && enforce) process.exitCode = 1;
      return;
    }
    if (sub === "fingerprint" || sub === "design") {
      const ui = await import("./uifingerprint.js");
      // `--taste <name>` (design only) takes a VALUE — splice it out before the
      // file filter so the profile name is never mistaken for a file.
      const args = argv.slice(2);
      const tasteIdx = args.indexOf("--taste");
      const tasteArg = tasteIdx >= 0 ? (args.splice(tasteIdx, 2)[1] ?? null) : null;
      const json = args.includes("--json");
      const files = args.filter((a) => !a.startsWith("--"));
      if (!files.length || (tasteIdx >= 0 && !tasteArg)) {
        console.error(
          `usage: ${BRAND.cli} uicheck ${sub} <file...> [--json]${sub === "fingerprint" ? " [--mint]" : " [--taste <name>]"}`,
        );
        process.exitCode = 1;
        return;
      }
      const fp = ui.fingerprintFiles(process.cwd(), files);
      if (sub === "fingerprint") {
        let minted = null;
        if (argv.includes("--mint")) {
          const { epochDay } = await import("./util.js");
          minted = ui.mintProjectFingerprint(process.cwd(), files, {
            t: epochDay(),
          });
        }
        if (json) {
          console.log(JSON.stringify(minted ? { fingerprint: fp, minted } : fp, null, 2));
        } else {
          heading(`${BRAND.brand} uicheck fingerprint — the design feature vector\n`);
          console.log(
            `  palette:  ${fp.paletteSize} color(s), hue bins [${fp.hueBuckets.join(" ")}]`,
          );
          console.log(
            `  spacing:  ${fp.spacing.join(", ") || "(none)"} px — base ${fp.spacingBase ?? "(none)"}, ${Math.round(fp.spacingOnScale * 100)}% on-scale`,
          );
          console.log(`  type:     ${fp.fontFamilies.join(", ") || "(none)"}`);
          console.log(
            `  shape:    radii ${fp.radii.join(", ") || "(none)"} (${fp.radiusLevels} level(s)) · ${fp.shadowLevels} shadow level(s)`,
          );
          if (minted) {
            if (minted.ok)
              console.log(
                `\n  minted fingerprint claim ${minted.id.slice(0, 12)}${minted.existed ? " (already in ledger)" : ""} — the gate's "home"`,
              );
            else console.error(`\n  mint failed: ${"reason" in minted ? minted.reason : ""}`);
          }
        }
        if (minted && !minted.ok) process.exitCode = 1;
        return;
      }
      // design — the two-sided gate: fail when too close to generic OR (when the
      // project has minted its fingerprint) too far from the project's own system.
      // A taste profile (explicit --taste, else the style pinned by a
      // `forge taste`-managed DESIGN.md) overrides thresholds + adds its checks.
      const tasteName = tasteArg ?? ui.activeTasteStyle(process.cwd());
      const profile = tasteName ? ui.loadTasteProfile(tasteName) : null;
      if (tasteArg && !profile) {
        // Explicit --taste must exist; an auto-picked style without a JSON sibling
        // silently falls back to defaults (custom prose styles stay legal).
        console.error(
          `unknown taste profile "${tasteArg}" — run \`${BRAND.cli} taste\` to list styles`,
        );
        process.exitCode = 1;
        return;
      }
      const projectFp = ui.loadProjectFingerprint(process.cwd());
      const tauSlop = profile?.gate?.tau_slop ?? ui.UI_GATE_DEFAULTS.tauSlop;
      const tauConform = profile?.gate?.tau_conform ?? ui.UI_GATE_DEFAULTS.tauConform;
      const gate = ui.uiGate(fp, { projectFp, tauSlop, tauConform });
      const checks = [...ui.scaleChecks(fp), ...(profile ? ui.profileChecks(fp, profile) : [])];
      const fail = !gate.pass || checks.some((c) => !c.pass);
      if (json) {
        console.log(
          JSON.stringify(
            {
              ...gate,
              checks,
              hasProjectFingerprint: !!projectFp,
              taste: profile ? tasteName : null,
              tauSlop,
              tauConform,
            },
            null,
            2,
          ),
        );
      } else {
        heading(`${BRAND.brand} uicheck design — slop distance + project conformance\n`);
        if (profile) console.log(`  taste:         ${tasteName} (thresholds from its profile)`);
        console.log(
          `  slop distance: ${gate.slop}  (need ≥ ${tauSlop} — farther from generic is better)`,
        );
        console.log(
          projectFp
            ? `  conformance:   ${gate.conform}  (need ≤ ${tauConform} — closer to the project system is better)`
            : `  conformance:   (no project fingerprint claim — slop-only; mint one: \`${BRAND.cli} uicheck fingerprint <ui files> --mint\`)`,
        );
        for (const v of gate.violations) console.log(`\n  ✗ ${v.detail}\n    fix: ${v.hint}`);
        console.log("");
        for (const c of checks)
          console.log(
            `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.detail}${c.pass || !c.hint ? "" : `\n    fix: ${c.hint}`}`,
          );
        console.log(`\n  ${fail ? "✗ FAIL" : "✓ PASS"}`);
      }
      if (fail) process.exitCode = 1;
      return;
    }
    const { contrastRatio, wcagLevel, ASSERTABLE_CHECKS, ADVISORY_ONLY } = await import(
      "./uicheck.js"
    );
    // `uicheck contrast <fg> <bg>` is the named form; bare `uicheck <fg> <bg>` stays
    // supported (it predates the subcommands and hooks already call it).
    const [fg, bg] = sub === "contrast" ? [argv[2], argv[3]] : [argv[1], argv[2]];
    heading(`${BRAND.brand} uicheck — deterministic UI review\n`);
    if (fg && bg) {
      try {
        const g = wcagLevel(contrastRatio(fg, bg));
        console.log(
          `  contrast ${fg} on ${bg}: ${g.ratio}:1  →  ${g.level}${g.passesAA ? " (passes AA)" : " (FAILS AA)"}`,
        );
      } catch (e) {
        console.error(`  ${e.message}`);
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\n  ASSERT (deterministic): ${ASSERTABLE_CHECKS.map((c) => c.id).join(", ")}`);
    console.log(`  ADVISE (subjective, human-only): ${ADVISORY_ONLY.slice(0, 4).join(", ")} …`);
    return;
  }
  if (cmd === "dash") {
    const { serve } = await import("./dash.js");
    const i = argv.indexOf("--port");
    const port = i >= 0 ? Number(argv[i + 1]) : 4242;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error("usage: forge dash [--port N]");
      process.exitCode = 1;
      return;
    }
    const server = serve(process.cwd(), { port });
    server.on("listening", () => {
      const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
      heading(`${BRAND.brand} dash — read-only lens on .forge/\n`);
      console.log(`  http://127.0.0.1:${addr.port}  (localhost-only · Ctrl-C to stop)`);
    });
    server.on("error", (err) => {
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    });
    return; // the process stays alive serving — that's the command
  }
  if (!(cmd in COMMANDS)) {
    console.error(`Unknown command: ${cmd}\nRun \`${BRAND.cli} --help\` to see commands.`);
    process.exitCode = 1;
    return;
  }
  // ponytail: remaining subcommands land in their build phases; the stub keeps the
  // command surface honest and testable now.
  console.log(`${BRAND.cli} ${cmd}: not wired yet — coming in a later build phase.`);
}

run(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

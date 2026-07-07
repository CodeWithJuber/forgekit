#!/usr/bin/env node
// forge — zero-dependency dispatcher. Works identically whether installed via the
// npm bin, the hardened install.sh symlink, or the Claude Code plugin.
import { BRAND } from "./brand.js";

const COMMANDS = {
  init: "scaffold this repo's config — emits every tool from one shared source",
  sync: "recompile the canonical source into each tool's native config files",
  doctor: "health-check installed tools, guards, MCP auth, and config drift",
  taste: "enable one UI-taste tool for this repo (no arg = list)",
  atlas: "build / query the code-graph (where-is-Y, has-symbol)",
  recall: "manage cross-session memory (list / add / consolidate)",
  catalog: "Start Here — list every tool, crew, and guard with a one-line why",
  scan: "vet a skill/MCP for injection/RCE/exfil before install (skill-gate)",
  verify: "independent verification gate — tests + hallucinated-symbol + provenance",
  harden: "wire security controls — gitleaks pre-commit + sandbox settings",
  remember: "add a durable fact to this repo's portable memory (forge brain)",
  brain: "show / rebuild the portable project memory index",
  cost: "real per-day spend via ccusage + the cost ceiling",
  spec: "spec-as-contract — init (OpenSpec) / lock / check drift",
  cortex: "self-correcting project memory — status / why <symbol>",
  ledger: "proof-carrying memory — stats / verify / show / blame / query / merge / import",
  reuse: "proof-carrying code cache — query <spec> / mint <spec> --file <path> / stats",
  preflight: "assumption check — what a task names that the repo doesn't define",
  route: "recommend the cheapest capable model for a task (+ gateway config)",
  impact: "predict blast radius for a symbol or file from the atlas graph",
  substrate: "one pre-action gate: assumptions, route, impact, scope, memory, verify",
  scope: "decompose files into independent clusters (+ coupled files you didn't name)",
  anchor: "goal-drift check — are your actual (git) changes still on the stated goal?",
  diagnose:
    "doom-loop check — record a failure; 3× the same signature mints a diagnosis + escalation",
  imagine: "consequence simulation — predicted breaks + the minimal dry-run test suite for a task",
  lean: "scope-minimality (M5) — measure the diff's footprint vs what the task asked for",
  uicheck: "deterministic UI check — WCAG contrast <fg> <bg> (assertable, no guessing)",
  brand: "print the active brand token map",
};

const printVersion = () => console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

function printHelp() {
  printVersion();
  console.log(`\n${BRAND.tagline}\n`);
  console.log(`Usage: ${BRAND.cli} <command> [options]\n`);
  console.log("Commands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log(`\nRun \`${BRAND.cli} <command> --help\` for details.`);
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
    const { report, bytes } = init({ targetRoot: process.cwd() });
    const wrote = report.filter((r) => r.action === "written").map((r) => r.target);
    console.log(`${BRAND.brand} init — this repo now speaks every AI tool from one source.\n`);
    console.log(`  emitted:  ${wrote.length ? wrote.join(", ") : "(all up to date)"}`);
    console.log(
      `  source:   AGENTS.md (${bytes} B) — edit rules in source/, re-run \`${BRAND.cli} sync\``,
    );
    console.log(`  active:   tools · crew · guards  →  \`${BRAND.cli} catalog\``);
    console.log(`  verify:   \`${BRAND.cli} doctor\``);
    return;
  }
  if (cmd === "catalog") {
    const { catalog } = await import("./init.js");
    const c = catalog();
    console.log(`${BRAND.brand} catalog — Start Here\n`);
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
    console.log(`${BRAND.brand} sync — one source → every tool\n`);
    for (const r of report) {
      console.log(
        `  ${r.action.padEnd(16)} ${String(r.target).padEnd(22)} ${r.tool}${r.note ? "  · " + r.note : ""}`,
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
    const icon = { ok: "✓", warn: "!", fail: "✗" };
    console.log(`${BRAND.brand} doctor\n`);
    for (const r of results) console.log(`  ${icon[r.status]} ${r.label.padEnd(16)} ${r.note}`);
    console.log(`\n${failed === 0 ? "all clear" : failed + " problem(s)"}`);
    if (failed) process.exitCode = 1;
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
    const { epochDay } = await import("./util.js");
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
      console.log(`${BRAND.brand} ledger — proof-carrying memory\n`);
      console.log(`  claims: ${s.total}  (tombstoned ${s.tombstoned})`);
      for (const [kind, n] of Object.entries(s.byKind)) console.log(`    ${kind}: ${n}`);
      console.log(
        `  val: trusted ${s.val.trusted} · uncertain ${s.val.uncertain} · dormant ${s.val.dormant}`,
      );
      console.log("\n  stored in .forge/ledger/ (git-committable, conflict-free merge)");
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
      console.log(`${BRAND.brand} ledger blame — ${b.kind} ${b.id.slice(0, 12)}\n`);
      console.log(`  val ${b.val.toFixed(2)} (trust-weighted ${b.valTrustWeighted.toFixed(2)})`);
      for (const p of b.minted)
        console.log(
          `  minted  day ${p.t}  by ${p.author || "(unknown)"}${p.agent ? ` · ${p.agent}` : ""}`,
        );
      for (const e of b.evidence)
        console.log(
          `  ${e.result === "confirm" ? "confirm " : "contradic"}  day ${e.t}  ${e.oracle} → ${e.ref}${e.author ? `  by ${e.author}` : ""}`,
        );
      for (const t of b.tombstones)
        console.log(`  retract  day ${t.t}  ${t.reason}${t.author ? `  by ${t.author}` : ""}`);
      const trusts = Object.entries(b.trust);
      if (trusts.length) {
        console.log("\n  author trust (earned from oracle outcomes on their claims):");
        for (const [a, u] of trusts) console.log(`    ${u.toFixed(2)}  ${a}`);
      }
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
      const claims = ls.loadClaims(dir);
      const ranked = retrieve(q, claims, { nowDay, budget: 8 });
      if (json)
        return console.log(
          JSON.stringify(
            ranked.map((r) => ({ id: r.claim.id, kind: r.claim.kind, score: r.score })),
            null,
            2,
          ),
        );
      if (!ranked.length) return console.log("  no matching live claims");
      for (const r of ranked)
        console.log(
          `  ${r.score.toFixed(3)}  ${r.claim.kind.padEnd(9)} ${r.claim.id.slice(0, 8)}  ${claimText(r.claim).slice(0, 90)}`,
        );
      return;
    }
    if (sub === "import") {
      const b = await import("./ledger_bridge.js");
      let r;
      if (personal) {
        // Personal import: facts from the global recall store into the personal ledger.
        const { defaultStore } = await import("./recall.js");
        r = { lessons: 0, outcomes: 0, ...b.importFacts(defaultStore(), dir, nowDay) };
      } else {
        const { brainStore } = await import("./brain.js");
        r = b.importLegacy(root, { recallStore: brainStore(root), recallLedger: dir, nowDay });
      }
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(
        `  imported: ${r.lessons} lesson(s), ${r.facts} fact(s), ${r.outcomes} outcome(s)`,
      );
      for (const x of r.refused) console.log(`    refused: ${x}`);
      return;
    }
    console.error(
      `ledger: unknown subcommand "${sub}" (stats | verify | show <id> | blame <id> | query <text> | merge <path> | import) [--personal] [--json]`,
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
            { tier: r.tier, artifact: r.artifact?.id, jaccard: r.jaccard, reasons: r.reasons },
            null,
            2,
          ),
        );
      if (r.tier === "miss") {
        console.log("  miss — nothing verified matches; generate, then `forge reuse mint` it");
      } else {
        const a = r.artifact;
        console.log(
          `  ${r.tier.toUpperCase()} hit (similarity ${(r.jaccard ?? 1).toFixed(2)}) — ${a.body.form}${a.body.code?.path ? ` at ${a.body.code.path}` : ""}`,
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
          ? { evidence: { oracle: "test.run", result: "confirm", ref }, t: nowDay }
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
      const s = summarize(root).cache ?? { events: 0, byOutcome: {}, savedEstimate: 0 };
      if (json) return console.log(JSON.stringify(s, null, 2));
      console.log(`${BRAND.brand} reuse — proof-carrying code cache\n`);
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
    console.log(`${BRAND.brand} scan — skill-gate (${r.scanner})\n`);
    if (r.findings && r.findings.length) {
      for (const f of r.findings) console.log(`  [${f.sev}] ${f.msg}`);
    } else if (r.raw) {
      console.log("  " + r.raw.trim().split("\n").slice(-6).join("\n  "));
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
    console.log(`${BRAND.brand} verify\n`);
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
    console.log(`${BRAND.brand} brain — portable project memory\n`);
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
    const { execFileSync } = await import("node:child_process");
    const run = (bin, args) => execFileSync(bin, args, { encoding: "utf8", stdio: "pipe" });
    console.log(`${BRAND.brand} cost — real per-day spend (ccusage)\n`);
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
      console.log(
        "  ccusage not found. Install for real spend (reads local JSONL, nothing leaves your machine):\n    npm i -g ccusage    # then: forge cost",
      );
    }
    console.log(
      `\n  ceiling: FORGE_COST_CEILING (default $10) — the cost-budget guard warns when a day exceeds it.`,
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
    console.log(`${BRAND.brand} spec check\n`);
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
    console.log(`${BRAND.brand} harden\n`);
    console.log(`  gitleaks pre-commit: ${r.gitleaks}`);
    console.log(
      `  sandbox settings:    ${r.sandbox} — merge into ~/.claude/settings.json to enable (84% fewer prompts)`,
    );
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
    console.log(`${BRAND.brand} cortex — self-correcting project memory\n`);
    console.log(
      `  lessons: ${s.total}  (active ${s.active} · candidate ${s.candidate} · quarantined ${s.quarantined} · retired ${s.retired})`,
    );
    if (s.topActive.length) {
      console.log("\n  top active (by confidence):");
      for (const t of s.topActive) console.log(`    ${t.confidence.toFixed(2)}  ${t.id}`);
    } else {
      console.log("\n  (no active lessons yet — Cortex learns from corrections as you work)");
    }
    console.log("\n  stored in .forge/lessons/ (git-committable, auditable)");
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
    console.log(`${BRAND.brand} preflight — assumption check\n`);
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
    console.log(`${BRAND.brand} impact — blast radius\n`);
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
  if (cmd === "route") {
    const r = await import("./route.js");
    if (argv[1] === "gateway") {
      const path = r.emitGatewayConfig(process.cwd());
      console.log(`  wrote ${path} — LiteLLM tiers: forge-simple / forge-medium / forge-complex.`);
      console.log("  next: pin+install litellm, run it, point ANTHROPIC_BASE_URL at it, then");
      console.log(
        "        REQUEST the tier `forge route` recommends (a plain claude-* request passes through).",
      );
      return;
    }
    const json = argv.includes("--json");
    const task = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!task) {
      console.error('usage: forge route "<task>" [--json]   |   forge route gateway');
      process.exitCode = 1;
      return;
    }
    const rec = r.routeTask(process.cwd(), task);
    if (json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    console.log(`${BRAND.brand} route — cheapest capable model\n`);
    console.log(
      `  → ${rec.model.name}  (${rec.tier}, $${rec.model.inCost}/$${rec.model.outCost} per M tok)`,
    );
    console.log(`    ${rec.model.use}`);
    console.log(
      `    complexity ${rec.score.toFixed(2)}${rec.reasons.length ? ` · driven by: ${rec.reasons.join(", ")}` : ""}`,
    );
    console.log(
      `    signals: ${rec.signals.files} file(s), fan-out ${rec.signals.fanout}, churn ${rec.signals.churn}, past-mistakes ${rec.signals.pastMistakes}, ambiguity ${rec.signals.ambiguity.toFixed(2)}`,
    );
    console.log("\n  advisory · auto-routing: `forge route gateway`");
    return;
  }
  if (cmd === "anchor") {
    const { goalDrift, renderAnchor } = await import("./anchor.js");
    const json = argv.includes("--json");
    const goal = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!goal) {
      console.error('usage: forge anchor "<original goal>" [--json]');
      process.exitCode = 1;
      return;
    }
    const r = goalDrift(process.cwd(), goal);
    console.log(json ? JSON.stringify(r, null, 2) : renderAnchor(r));
    return; // advisory — never fails the process
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
    console.log(`${BRAND.brand} diagnose — doom-loop check\n`);
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
    const { imagineTask, renderImagine } = await import("./imagine.js");
    const json = argv.includes("--json");
    const task = argv
      .slice(1)
      .filter((a) => a !== "--json")
      .join(" ");
    if (!task) {
      console.error('usage: forge imagine "<task>" [--json]');
      process.exitCode = 1;
      return;
    }
    const r = imagineTask(process.cwd(), task);
    console.log(json ? JSON.stringify(r, null, 2) : renderImagine(r));
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
    console.log(`${BRAND.brand} scope — task decomposition\n`);
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
    const { contrastRatio, wcagLevel, ASSERTABLE_CHECKS, ADVISORY_ONLY } = await import(
      "./uicheck.js"
    );
    const [fg, bg] = [argv[1], argv[2]];
    console.log(`${BRAND.brand} uicheck — deterministic UI review\n`);
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

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
  brand: "print the active brand token map",
};

const printVersion = () =>
  console.log(`${BRAND.brand} (${BRAND.pkg}) v${BRAND.version}`);

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
  if (cmd === "brand") {
    const { brand, cli, pkg, version, layers } = BRAND;
    return console.log(
      JSON.stringify({ brand, cli, pkg, version, layers }, null, 2),
    );
  }
  if (cmd === "init") {
    const { init } = await import("./init.js");
    const { report, bytes } = init({ targetRoot: process.cwd() });
    const wrote = report
      .filter((r) => r.action === "written")
      .map((r) => r.target);
    console.log(
      `${BRAND.brand} init — this repo now speaks every AI tool from one source.\n`,
    );
    console.log(
      `  emitted:  ${wrote.length ? wrote.join(", ") : "(all up to date)"}`,
    );
    console.log(
      `  source:   AGENTS.md (${bytes} B) — edit rules in source/, re-run \`${BRAND.cli} sync\``,
    );
    console.log(
      `  active:   tools · crew · guards  →  \`${BRAND.cli} catalog\``,
    );
    console.log(`  verify:   \`${BRAND.cli} doctor\``);
    return;
  }
  if (cmd === "catalog") {
    const { catalog } = await import("./init.js");
    const c = catalog();
    console.log(`${BRAND.brand} catalog — Start Here\n`);
    console.log("  TOOLS (model-invoked skills)");
    for (const t of c.tools)
      console.log(`    ${t.name.padEnd(18)} ${t.why.slice(0, 66)}`);
    console.log(`\n  CREW (isolated sub-agents)   ${c.crew.join(" · ")}`);
    console.log(`  GUARDS (enforced hooks)      ${c.guards.join(" · ")}`);
    if (c.taste?.length)
      console.log(
        `  TASTE (design directions)    ${c.taste.join(" · ")}  →  \`${BRAND.cli} taste <style>\``,
      );
    console.log(
      `\n  Full detail: ARCHITECTURE.md · per-tool config: \`${BRAND.cli} sync\``,
    );
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
      console.log(
        `\n  apply: \`${BRAND.cli} taste <style>\`  (writes a managed DESIGN.md)`,
      );
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
    const icon = { ok: "✓", warn: "!", fail: "✗" };
    console.log(`${BRAND.brand} doctor\n`);
    for (const r of results)
      console.log(`  ${icon[r.status]} ${r.label.padEnd(16)} ${r.note}`);
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
      console.log(
        items.length
          ? items.map((s) => `  - ${s}`).join("\n")
          : "  (no memories yet)",
      );
    } else if (sub === "add") {
      const name = argv[2];
      const body = argv.slice(3).join(" ");
      if (!name || !body) {
        console.error('usage: forge recall add "<name>" "<fact>"');
        process.exitCode = 1;
        return;
      }
      const res = r.add(store, name, body);
      console.log(res.ok ? `  saved: ${res.slug}` : `  ${res.reason}`);
      if (!res.ok) process.exitCode = 1;
    } else if (sub === "consolidate") {
      const { removed, kept } = r.consolidate(store);
      console.log(
        `  consolidated: ${removed} duplicate(s) removed, ${kept} kept`,
      );
    } else {
      console.error(
        `recall: unknown subcommand "${sub}" (list | add | consolidate)`,
      );
      process.exitCode = 1;
    }
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
      console.log(
        `  ${yes ? "✓ defined" : "✗ not found (possible hallucinated symbol)"}: ${name}`,
      );
      if (!yes) process.exitCode = 1;
    } else {
      console.error(`atlas: unknown subcommand "${sub}" (build | query | has)`);
      process.exitCode = 1;
    }
    return;
  }
  if (!(cmd in COMMANDS)) {
    console.error(
      `Unknown command: ${cmd}\nRun \`${BRAND.cli} --help\` to see commands.`,
    );
    process.exitCode = 1;
    return;
  }
  // ponytail: remaining subcommands land in their build phases; the stub keeps the
  // command surface honest and testable now.
  console.log(
    `${BRAND.cli} ${cmd}: not wired yet — coming in a later build phase.`,
  );
}

run(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

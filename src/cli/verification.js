// forge CLI — the verification commands — `verify`, `imagine`, `uicheck`. Moved verbatim out of src/cli.js (review A03: command dispatch
// and presentation are separated from domain operations; each domain's handlers live in one
// module, and the domain logic stays in the modules they import). cli.js registers these into
// its dispatch table; nothing here runs at import time.
import { BRAND, bar, heading, paint, table } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

HANDLERS.verify = async (argv) => {
  const json = argv.includes("--json");
  if (argv.includes("--deep")) {
    const { verifyDeep, LENSES } = await import("../consensus.js");
    // `--llm` opts the reviewer panel in for this run; otherwise FORGE_LLM decides.
    const r = verifyDeep({
      targetRoot: process.cwd(),
      llm: argv.includes("--llm") ? true : undefined,
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1;
      return;
    }
    heading(`${BRAND.brand} verify --deep — multi-lens consensus\n`);
    console.log(
      table(
        r.lenses.map((l) => {
          const meta = LENSES[l.lens];
          const state =
            l.ran === false
              ? paint("— skipped", "dim")
              : l.s > 0
                ? paint("● finding", meta.solo ? "err" : "warn")
                : paint("✓ clean", "ok");
          return [l.lens, meta.family, `w=${meta.weight}`, state];
        }),
      ),
    );
    if (r.findings.length) {
      console.log();
      for (const f of r.findings) console.log(`  ! ${f}`);
    }
    console.log(
      `\n  defectRiskScore:  ${bar(r.p)} ${r.p.toFixed(2)} (heuristic, not a calibrated probability)${
        r.families.length ? `  (families: ${r.families.join(", ")})` : ""
      }`,
    );
    console.log(
      `  remainingUncheckedWeight: ${r.residual.toFixed(3)} — Theorem-D silent-miss bound (heuristic)`,
    );
    // The core tests state, spelled out — deep ok REQUIRES a passing core, so the
    // reader must see whether a verifier actually ran (RA-01).
    const t = r.tests ?? /** @type {import("../verify.js").VerifyTests} */ ({ ran: false });
    console.log(
      `  tests:            ${t.status ?? "unknown"}${t.runner ? ` (${t.runner})` : ""}${
        !t.runner && t.detected?.length ? ` (detected: ${t.detected.join(", ")})` : ""
      }`,
    );
    if (t.executed?.length)
      console.log(
        `  suites ran:       ${t.executed.map((s) => `${s.label}=${s.status}`).join(", ")}`,
      );
    if (t.notExecuted?.length)
      console.log(`  suites skipped:   ${t.notExecuted.join(", ")} (no built-in executor)`);
    const detail = t.output || (t.detected ?? []).join(", ");
    const verdictLine =
      r.status === "PASS"
        ? paint("PASS", "ok")
        : r.status === "NOT_CONFIGURED"
          ? paint("NOT VERIFIED — no test runner configured (NOT_CONFIGURED)", "warn")
          : r.status === "INCOMPLETE"
            ? paint(`NOT VERIFIED — tests incomplete${detail ? ` (${detail})` : ""}`, "warn")
            : paint("BLOCKED — cross-family consensus says defect", "err");
    console.log(`\n  ${verdictLine}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  const { verify } = await import("../verify.js");
  const r = verify({ targetRoot: process.cwd() });
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  heading(`${BRAND.brand} verify\n`);
  console.log(`  changed files:    ${r.changedFiles.length}`);
  // Honest four-state tests line (RA-09): "nothing ran" is never dressed up as a pass,
  // and a real run names the runner that actually executed.
  const t = r.tests;
  const testsLine =
    t.status === "PASS"
      ? `✓ pass (${t.runner ?? "project suite"})`
      : t.status === "FAIL"
        ? `✗ FAIL (${t.runner ?? "project suite"})`
        : t.status === "INCOMPLETE"
          ? `— INCOMPLETE: ${t.output || (t.detected ?? []).join(", ") || "test run did not complete"}`
          : "— NOT CONFIGURED (no test runner detected)";
  console.log(`  tests:            ${testsLine}`);
  // Per-suite honesty (HI-01): a polyglot repo runs every executable suite; name which
  // ones ran with what verdict, and which were detected but never executed.
  if (t.executed?.length)
    console.log(
      `  suites ran:       ${t.executed.map((s) => `${s.label}=${s.status}`).join(", ")}`,
    );
  if (t.notExecuted?.length)
    console.log(`  suites skipped:   ${t.notExecuted.join(", ")} (no built-in executor)`);
  // Coverage (review F08): which package dirs the verdict actually speaks for.
  const cov = t.coverage;
  if (cov && cov.required.length > 1)
    console.log(
      `  packages:         ${cov.covered.length}/${cov.required.length} covered${
        cov.uncovered.length ? ` — no verdict for ${cov.uncovered.join(", ")}` : ""
      }${cov.excluded.length ? ` (${cov.excluded.length} excluded)` : ""}`,
    );
  if (t.mutated)
    console.log("  ! the code changed while the tests ran — the verdict is not bound to it");
  console.log(`  symbols checked:  ${r.provenance.symbolsChecked}`);
  if (r.unknown.length)
    console.log(
      `  ! not in codebase (possible hallucination): ${r.unknown.slice(0, 12).join(", ")}`,
    );
  console.log(`  provenance:       .forge/provenance.json (run ${r.provenance.event?.runId})`);
  // BLOCKED is reserved for a runner that actually FAILED; anything that never ran
  // to completion is NOT VERIFIED (still exit 1 — unverified is not a pass).
  const verdict = r.ok
    ? "PASS"
    : t.status === "FAIL"
      ? "BLOCKED — tests failing"
      : `NOT VERIFIED — ${t.status}`;
  console.log(`\n  ${verdict}`);
  if (!r.ok) process.exitCode = 1;
  return;
};

HANDLERS.imagine = async (argv) => {
  const { dryRun, imagineTask, renderImagine } = await import("../imagine.js");
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
        "\n  imagine --run refused: the working tree is dirty and the isolated checkout runs HEAD,\n" +
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
      const { record } = await import("../metrics.js");
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
  console.log(
    `\n  dry-run (isolated checkout of HEAD — not a security sandbox · ${d.runner ?? "node --test"}):`,
  );
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
};

const VERDICT_LABEL = {
  pass: "✓ PASS",
  fail: "✗ FAIL",
  "insufficient-signal": "✗ INSUFFICIENT SIGNAL — nothing measurable, so this is not a PASS",
};

HANDLERS.uicheck = async (argv) => {
  const sub = argv[1];
  if (sub === "visual") {
    // The Playwright visual loop (spec §5): render in a real browser, fingerprint
    // the COMPUTED styles, run the same design gate. Playwright is an optional
    // tier (ADR-0005) — its absence is a note and exit 0, never a failure.
    const { visualGate } = await import("../uivisual.js");
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
    // The completion gate's UI evidence (a skipped run never reaches here, so a missing
    // browser can never count as a PASS).
    const { recordUiCheck } = await import("../gate.js");
    recordUiCheck(process.cwd(), { check: "visual", pass: !r.fail });
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
      console.log(`\n  ${VERDICT_LABEL[r.verdict]}`);
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
    const { runInteractions, recordInteraction } = await import("../uiinteract.js");
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
    const ui = await import("../uifingerprint.js");
    // `--taste <name>` (design only) takes a VALUE — splice it out before the
    // file filter so the profile name is never mistaken for a file.
    const args = argv.slice(2);
    const tasteIdx = args.indexOf("--taste");
    const tasteArg = tasteIdx >= 0 ? (args.splice(tasteIdx, 2)[1] ?? null) : null;
    // `--theme <file>` (repeatable) names the Tailwind theme sources explicitly;
    // without it they are discovered (@theme / @tailwind stylesheets, tailwind.config.*).
    /** @type {string[]} */
    const themeArgs = [];
    let themeMissing = false;
    for (let i = args.indexOf("--theme"); i >= 0; i = args.indexOf("--theme")) {
      const [, value] = args.splice(i, 2);
      if (!value || value.startsWith("--")) themeMissing = true;
      else themeArgs.push(value);
    }
    const json = args.includes("--json");
    const files = args.filter((a) => !a.startsWith("--"));
    if (!files.length || (tasteIdx >= 0 && !tasteArg) || themeMissing) {
      console.error(
        `usage: ${BRAND.cli} uicheck ${sub} <file...> [--theme <css|tailwind.config>]... [--json]${sub === "fingerprint" ? " [--mint]" : " [--taste <name>]"}`,
      );
      process.exitCode = 1;
      return;
    }
    // An explicitly named theme that isn't there is an error, not a silent no-op.
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const absent = themeArgs.filter((t) => !existsSync(resolve(process.cwd(), t)));
    if (absent.length) {
      console.error(`theme source not found: ${absent.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const theme = ui.loadThemeTokens(
      process.cwd(),
      ui.themeSourcesFor(process.cwd(), files, themeArgs),
    );
    const themeLine = theme.sources.length
      ? `${theme.sources.join(", ")} (${theme.colors.size} color · ${theme.radius.size} radius · ${theme.shadow.size} shadow token(s))`
      : "(none found — token utilities like rounded-card / bg-brand stay unresolved; name one with --theme <file>)";
    const themeSummary = {
      sources: theme.sources,
      colors: theme.colors.size,
      radius: theme.radius.size,
      shadow: theme.shadow.size,
    };
    const fp = ui.fingerprintFiles(process.cwd(), files, { theme });
    if (sub === "fingerprint") {
      let minted = null;
      if (argv.includes("--mint")) {
        const { epochDay } = await import("../util.js");
        minted = ui.mintProjectFingerprint(process.cwd(), files, {
          t: epochDay(),
          theme,
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
        console.log(`  theme:    ${themeLine}`);
        if (!ui.hasDesignSignal(fp))
          console.log(
            "\n  ! no measurable design feature in these files — `design` reports insufficient-signal",
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
    // insufficient-signal (an empty vector) exits non-zero like FAIL: nothing was
    // measured, so nothing passed.
    const verdict = ui.overallVerdict(gate, checks);
    // The completion gate's UI evidence: this verdict, bound to the current code state.
    // Only a real PASS counts; an empty measurement is not evidence.
    const { recordUiCheck } = await import("../gate.js");
    recordUiCheck(process.cwd(), { check: "design", pass: verdict === "pass", files });
    if (json) {
      console.log(
        JSON.stringify(
          {
            ...gate,
            verdict,
            checks,
            hasProjectFingerprint: !!projectFp,
            taste: profile ? tasteName : null,
            tauSlop,
            tauConform,
            theme: themeSummary,
          },
          null,
          2,
        ),
      );
    } else {
      heading(`${BRAND.brand} uicheck design — slop distance + project conformance\n`);
      if (profile) console.log(`  taste:         ${tasteName} (thresholds from its profile)`);
      console.log(`  theme:         ${themeLine}`);
      if (verdict !== "insufficient-signal") {
        console.log(
          `  slop distance: ${gate.slop}  (need ≥ ${tauSlop} — farther from generic is better)`,
        );
        console.log(
          projectFp
            ? `  conformance:   ${gate.conform}  (need ≤ ${tauConform} — closer to the project system is better)`
            : `  conformance:   (no project fingerprint claim — slop-only; mint one: \`${BRAND.cli} uicheck fingerprint <ui files> --mint\`)`,
        );
      }
      for (const v of gate.violations) console.log(`\n  ✗ ${v.detail}\n    fix: ${v.hint}`);
      if (verdict !== "insufficient-signal") {
        console.log("");
        for (const c of checks)
          console.log(
            `  ${c.pass ? "✓" : "✗"} ${c.id}: ${c.detail}${c.pass || !c.hint ? "" : `\n    fix: ${c.hint}`}`,
          );
      }
      console.log(`\n  ${VERDICT_LABEL[verdict]}`);
    }
    if (verdict !== "pass") process.exitCode = 1;
    return;
  }
  const { contrastReport, ASSERTABLE_CHECKS, ADVISORY_ONLY } = await import("../uicheck.js");
  // `uicheck contrast <fg> <bg>` is the named form; bare `uicheck <fg> <bg>` stays
  // supported (it predates the subcommands and hooks already call it). Both exit 1
  // when the pair fails AA — a failing contrast must fail the script that asked.
  const args = argv.slice(sub === "contrast" ? 2 : 1);
  const json = args.includes("--json");
  const large = args.includes("--large");
  const colors = args.filter((a) => !a.startsWith("--"));
  if (sub === "contrast" && colors.length !== 2) {
    console.error(
      `usage: ${BRAND.cli} uicheck contrast <fg> <bg> [--large] [--json]   (colors: #hex[alpha], rgb(), hsl(), oklch(), oklab())`,
    );
    process.exitCode = 1;
    return;
  }
  const [fg, bg] = colors;
  /** @type {ReturnType<typeof contrastReport>|null} */
  let r = null;
  if (fg && bg) {
    try {
      r = contrastReport(fg, bg, { large });
    } catch (e) {
      if (json) console.log(JSON.stringify({ error: e.message }, null, 2));
      else console.error(`  ${e.message}`);
      process.exitCode = 1;
      return;
    }
    if (!r.passesAA) process.exitCode = 1;
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
  }
  heading(`${BRAND.brand} uicheck — deterministic UI review\n`);
  if (r) {
    const kind = large ? "large text / UI" : "normal text";
    console.log(
      `  contrast ${fg} on ${bg}: ${r.ratio}:1  →  ${r.level}${r.passesAA ? ` (passes AA for ${kind})` : ` (FAILS AA — ${kind} needs ${r.required.aa}:1)`}`,
    );
    for (const n of r.notes) console.log(`  note: ${n}`);
  }
  console.log(`\n  ASSERT (deterministic): ${ASSERTABLE_CHECKS.map((c) => c.id).join(", ")}`);
  console.log(`  ADVISE (subjective, human-only): ${ADVISORY_ONLY.slice(0, 4).join(", ")} …`);
  return;
};

export default HANDLERS;

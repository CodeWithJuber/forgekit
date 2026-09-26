// forge CLI — the routing and cost commands — `route` (incl. `route universal`), `models`, `cost`. Moved verbatim out of src/cli.js (review A03: command dispatch
// and presentation are separated from domain operations; each domain's handlers live in one
// module, and the domain logic stays in the modules they import). cli.js registers these into
// its dispatch table; nothing here runs at import time.
import { BRAND, bar, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

HANDLERS.cost = async (argv) => {
  // `--stages` is the P8 measured report (per-stage factors from .forge/metrics.jsonl);
  // the default path stays the ccusage per-day spend view, untouched.
  if (argv.includes("--stages")) {
    const { renderCostReport, report } = await import("../cost_report.js");
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
    const { estimateSpendFromLogs } = await import("../cost_report.js");
    const est = estimateSpendFromLogs({ root: process.cwd() });
    if (est && est.totalCost > 0) {
      console.log(
        `  $${est.totalCost.toFixed(2)} estimated from Claude session logs (${est.sessions} session(s))`,
      );
      if (est.byModel.length) {
        for (const m of est.byModel)
          console.log(
            `    ${m.model.padEnd(30)} ${m.priced ? `$${m.cost.toFixed(4)}` : "unpriced"}  (${m.inTokens} in / ${m.outTokens} out)${m.priceSource ? ` · price: ${m.priceSource}` : ""}`,
          );
      }
      if (est.unpriced?.length)
        console.log(
          paint(
            `  not in the total — no catalog or snapshot price for: ${est.unpriced.join(", ")}`,
            "dim",
          ),
        );
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
};

HANDLERS.models = async (argv) => {
  // What each tier resolves to RIGHT NOW: family → newest model in the active provider's live
  // catalog (else the shipped snapshot), priced from OpenRouter's catalog (else the snapshot).
  const { describeResolution, PRICING_VERIFIED, resolveTiers } = await import("../model_tiers.js");
  const { activeProvider, envModelOverride } = await import("../providers.js");
  const root = process.cwd();
  const provider = activeProvider(root);
  const tiers = resolveTiers({ root, provider });
  const override = envModelOverride();
  if (argv.includes("--json"))
    return console.log(
      JSON.stringify(
        { provider: provider.name, override, pricingVerified: PRICING_VERIFIED, tiers },
        null,
        2,
      ),
    );
  heading(`${BRAND.brand} models — each tier's family, resolved to a concrete model\n`);
  console.log(`  provider  ${provider.name} (${provider.label || provider.name})`);
  if (override)
    console.log(
      `  override  ${override} — ANTHROPIC_MODEL/FORGE_MODEL pins every call; the tiers below apply without it`,
    );
  const priceText = (p) => (p ? `$${p.inCost}/$${p.outCost}` : "—");
  const priceFrom = (p) =>
    !p
      ? "unpriced"
      : p.source === "catalog"
        ? "catalog"
        : `snapshot${p.basis === "family" ? " (tier)" : ""}`;
  const width = Math.max(28, ...tiers.map((t) => (t.model?.id ?? "").length + 2));
  console.log(
    `\n  ${"tier".padEnd(8)} ${"family".padEnd(7)} ${"model".padEnd(width)} ${"created".padEnd(11)} ${"$/M tok".padEnd(10)} ${"id from".padEnd(9)} price from`,
  );
  for (const t of tiers) {
    console.log(
      `  ${t.class.padEnd(8)} ${t.family.padEnd(7)} ${(t.model?.id ?? "—").padEnd(width)} ${(t.model?.createdAt?.slice(0, 10) ?? "—").padEnd(11)} ${priceText(t.price).padEnd(10)} ${(t.model?.source ?? "—").padEnd(9)} ${priceFrom(t.price)}`,
    );
  }
  console.log("");
  for (const t of tiers) console.log(`  ${t.family.padEnd(7)} ${describeResolution(t.model)}`);
  const live = tiers.find((t) => t.price?.source === "catalog")?.price;
  console.log(
    live
      ? `\n  prices: live from ${live.catalog}${live.cache === "stale" ? " (last cached copy — catalog unreachable)" : ""}`
      : `\n  prices: shipped snapshot, verified ${PRICING_VERIFIED} (OpenRouter's catalog unavailable or unlisted)`,
  );
  console.log(
    paint(
      "  cache: .forge/cache/ — reused while the response's own Cache-Control/Expires says fresh, else revalidated (ETag); FORGE_NO_CATALOG_FETCH=1 stays offline",
      "dim",
    ),
  );
  return;
};

HANDLERS.route = async (argv) => {
  const r = await import("../route.js");
  if (argv[1] === "gateway") {
    const result = r.emitGatewayConfig(process.cwd());
    if (typeof result === "object" && !result.ok) {
      console.log(`  ${result.reason}`);
      return;
    }
    console.log(`  wrote ${result} — LiteLLM tiers: forge-simple / forge-medium / forge-complex.`);
    console.log("  next: pin+install litellm, run it, point ANTHROPIC_BASE_URL at it, then");
    console.log(
      "        REQUEST the tier `forge route` recommends (a plain claude-* request passes through).",
    );
    return;
  }
  if (argv[1] === "calibrate") {
    // Advisory → gated promotion (ROADMAP): measure whether an affine calibration of the
    // routing rubric beats the raw rubric on a held-out split of the HAND-LABELLED fixture
    // (there is no outcome data). Advisory — routing keeps the rubric unless the gate
    // promotes AND a caller adopts the calibration, which nothing in src/ does.
    const res = r.calibrateRouting();
    if (argv.includes("--json")) return console.log(JSON.stringify(res, null, 2));
    heading(`${BRAND.brand} route calibrate — rubric calibration check (measured gate)\n`);
    console.log(`  samples: ${res.n} hand-labelled task phrase(s) — no routing outcomes exist`);
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
      "\n  advisory — routing stays on the rubric; nothing adopts a promoted calibration yet,",
    );
    console.log("  and calibrating on real routing outcomes needs data forge does not record");
    return;
  }
  if (["universal", "outcome", "fit", "models"].includes(argv[1]) || argv.includes("--universal")) {
    return routeUniversalCli(argv);
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
    const { setProvider } = await import("../providers.js");
    const sr = setProvider(process.cwd(), providerName);
    if (!sr.ok) {
      console.error(`  ${sr.reason}`);
      process.exitCode = 1;
      return;
    }
  }
  const rec = r.routeTask(process.cwd(), task);
  r.meterRoute(process.cwd(), task, rec);
  // The recommendation is a tier (a model family); its concrete id and price are resolved here,
  // in the command — routeTask stays network-free because the hooks run it. BOTH output modes
  // resolve, so a script reading --json never sees a different model than the text prints.
  const { describeResolution, resolveTierModel, resolveTierPrice } = await import(
    "../model_tiers.js"
  );
  const { activeProvider } = await import("../providers.js");
  const opts = { root: process.cwd(), provider: activeProvider(process.cwd()) };
  const resolved = resolveTierModel(rec.key, opts);
  const price = resolveTierPrice(rec.key, { ...opts, resolved });
  if (json) {
    // `model` stays the snapshot row (its shape is public); `resolved` is what would be called.
    console.log(JSON.stringify({ ...rec, resolved, price }, null, 2));
  } else {
    heading(`${BRAND.brand} route — cheapest capable model\n`);
    const name =
      resolved?.source === "catalog" && resolved.displayName
        ? resolved.displayName
        : rec.model.name;
    console.log(
      `  → ${paint(name, "accent")}  (${rec.tier}, ${price ? `${price.inCost}/${price.outCost} per M tok, ${price.source === "catalog" ? "live price" : "current effective"}` : "price unknown"})`,
    );
    if (resolved) console.log(`    model: ${resolved.id} — ${describeResolution(resolved)}`);
    console.log(`    ${rec.model.use}`);
    console.log(
      `    complexity ${bar(rec.score, 8)} ${rec.score.toFixed(2)}${rec.reasons.length ? ` · driven by: ${rec.reasons.join(", ")}` : ""}`,
    );
    console.log(
      `    signals: ${rec.signals.files} file(s), fan-out ${rec.signals.fanout}, churn ${rec.signals.churn}, past-mistakes ${rec.signals.pastMistakes}, ambiguity ${rec.signals.ambiguity.toFixed(2)}`,
    );
  }
  if (apply) {
    const { applyRoute } = await import("../providers.js");
    const ar = applyRoute(rec.key);
    if (ar.ok) {
      if (!json) console.log(`\n  applied: model set to ${ar.model} (${ar.modelId}) in ${ar.path}`);
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
};
// Universal router (src/router): any provider's models, chosen by expected cost for the success
// probability asked for. Models come from data/models.json and .forge/models.json.

// Universal router (src/router): any provider's models, chosen by expected cost for the success
// probability asked for. Models come from data/models.json and .forge/models.json.
async function routeUniversalCli(argv) {
  const U = await import("../router/index.js");
  const { loadRegistry } = await import("../router/registry.js");
  const json = argv.includes("--json");
  const val = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const VALUED = new Set([
    "--objective",
    "--provider",
    "--model",
    "--cost",
    "--depth",
    "--attempt",
    "--verify-run",
  ]);
  const words = argv
    .slice(1)
    .filter((a, i, arr) => !a.startsWith("--") && !VALUED.has(arr[i - 1] ?? ""));
  const sub = ["outcome", "fit", "models", "universal"].includes(words[0])
    ? words.shift()
    : "universal";
  const root = process.cwd();
  if (sub === "models") {
    const reg = loadRegistry(root);
    const fit = U.loadRouterModel(root);
    const rows = reg.models.map((m) => ({
      id: m.id,
      org: m.org ?? null,
      status: fit?.models.includes(m.id) ? "fitted" : "cold",
      providers: Object.keys(m.providers ?? {}),
      price: m.price_in != null ? `${m.price_in}/${m.price_out}` : null,
    }));
    if (json)
      return console.log(
        JSON.stringify({ sources: reg.sources, fit: fit?.origin ?? null, models: rows }, null, 2),
      );
    heading(`${BRAND.brand} route models — registry (${reg.sources.join(" + ")})\n`);
    for (const r of rows)
      console.log(
        `  ${r.id.padEnd(22)} ${String(r.org ?? "").padEnd(16)} ${r.status.padEnd(7)} ${r.price ? `$${r.price}/Mtok`.padEnd(14) : "".padEnd(14)} ${r.providers.join(", ") || "(no provider id: advice only)"}`,
      );
    console.log(`\n  fit in use: ${fit?.origin ?? "none"}`);
    return;
  }
  if (sub === "fit") {
    const model = U.fitRouter(root);
    if (json) return console.log(JSON.stringify(model.provenance, null, 2));
    console.log(
      `  refit on ${model.provenance.local.outcomes} recorded outcome(s) over ${model.provenance.local.tasks} task(s); wrote .forge/router_model.json`,
    );
    return;
  }
  const task = words.join(" ");
  if (!task) {
    console.error(
      'usage: forge route universal "<task>" [--objective match-best-single|target:<p>|value:<$>|budget:<$>] [--provider <name>|any] [--depth <n>] [--json]\n' +
        '       forge route outcome "<task>" --model <id> --pass|--fail [--cost <usd>] [--attempt <id>] [--verify-run <run id>]\n' +
        "       forge route fit | forge route models",
    );
    process.exitCode = 1;
    return;
  }
  if (sub === "outcome") {
    const passed = argv.includes("--pass") ? true : argv.includes("--fail") ? false : undefined;
    const cost = val("--cost") !== undefined ? Number(val("--cost")) : null;
    try {
      const row = U.recordOutcome(root, {
        task,
        model: val("--model"),
        passed,
        cost,
        attemptId: val("--attempt") ?? null,
        verifyRunId: val("--verify-run") ?? null,
      });
      if (json) return console.log(JSON.stringify(row, null, 2));
      console.log(
        row.duplicate
          ? `  attempt ${row.attemptId} was already recorded — not counted twice`
          : `  recorded ${row.model} ${row.passed ? "pass" : "fail"} (${row.provenance}) for task ${row.task} (.forge/route_outcomes.jsonl)`,
      );
    } catch (e) {
      console.error(`  ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }
  let rec;
  try {
    rec = U.routeUniversal(root, task, {
      objective: val("--objective"),
      provider: val("--provider") ?? "any",
      maxDepth: val("--depth") ? Number(val("--depth")) : undefined,
    });
  } catch (e) {
    console.error(`  ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(JSON.stringify(rec, null, 2));
    if (!rec.ok) process.exitCode = 1;
    return;
  }
  if (!rec.ok) {
    console.error(`  ${rec.feasible === false ? "INFEASIBLE — " : ""}${rec.reason}`);
    // F12: the least-bad cascade is shown only as an explicit, labeled fallback.
    const fb = rec.fallback;
    if (fb)
      console.error(
        `  fallback (does NOT meet the objective): ${fb.cascade.map((c) => c.model).join(" → ")} · P(success) ${fb.pSuccess.toFixed(2)} · expected $${fb.expectedCost.toFixed(3)} (up to $${fb.maxPossibleCost.toFixed(3)} if every attempt runs)`,
      );
    process.exitCode = 1;
    return;
  }
  heading(
    `${BRAND.brand} route universal — ${rec.objective.kind}${rec.target != null ? ` (target ${rec.target.toFixed(2)})` : ""}\n`,
  );
  rec.cascade.forEach((c, i) => {
    console.log(
      `  ${i === 0 ? "→" : "then, if a check fails →"} ${paint(c.model, "accent")}  P(solve alone) ${c.pSolveAlone.toFixed(2)} · ~$${c.expectedAttemptCost.toFixed(3)}/attempt${c.status === "cold" ? " · cold (no outcomes yet)" : ""}`,
    );
  });
  console.log(
    `\n  P(success) ${rec.pSuccess.toFixed(2)} · expected cost $${rec.expectedCost.toFixed(3)} (not a cap; up to $${rec.maxPossibleCost.toFixed(3)} if every attempt runs) · best single: ${rec.bestSingle.model} ${rec.bestSingle.pSuccess.toFixed(2)} at $${rec.bestSingle.expectedCost.toFixed(3)}`,
  );
  console.log(
    `  ${rec.candidates} candidate model(s), ${rec.cascadesEvaluated} cascade(s) compared · fit: ${rec.fit.origin}`,
  );
  console.log(
    `  learn from results: \`${BRAND.cli} route outcome "<task>" --model <id> --pass|--fail --cost <usd>\`, then \`${BRAND.cli} route fit\``,
  );
}

export default HANDLERS;

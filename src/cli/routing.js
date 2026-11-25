// forge CLI — the routing and cost commands — `route` (incl. `route universal`), `models`, `cost`. Moved verbatim out of src/cli.js (review A03: command dispatch
// and presentation are separated from domain operations; each domain's handlers live in one
// module, and the domain logic stays in the modules they import). cli.js registers these into
// its dispatch table; nothing here runs at import time.
import { BRAND, heading, paint } from "./shared.js";

/** @type {Record<string, (argv: string[], cmd: string) => unknown>} */
const HANDLERS = {};

HANDLERS.cost = async (argv) => {
  if (argv[1] === "pilot") {
    const { rolloutCommand } = await import("../rollout_eval.js");
    return rolloutCommand(
      argv.slice(2).filter((arg) => arg !== "--json"),
      "cost",
    );
  }
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
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const schema = value("--schema");
  const valued = ["--profile", "--workload", "--capability", "--availability", "--max-age"];
  const filters = ["--refresh", "--offline", ...valued].some((flag) => argv.includes(flag));
  if (
    (argv.includes("--schema") && !["1", "2"].includes(schema)) ||
    (schema === "1" && filters) ||
    (argv.includes("--refresh") && argv.includes("--offline")) ||
    valued.some((flag) => argv.includes(flag) && (!value(flag) || value(flag).startsWith("--")))
  )
    throw new Error("Use --schema 1 or 2, one refresh mode, and a value for each filter");
  if (schema !== "1") {
    const { modelInventory } = await import("../model_inventory.js");
    const inv = modelInventory(process.cwd(), {
      profile: value("--profile"),
      workload: value("--workload"),
      capability: value("--capability"),
      availability: value("--availability"),
      maxAge: value("--max-age"),
      refresh: argv.includes("--offline") ? false : argv.includes("--refresh") ? true : undefined,
    });
    if (argv.includes("--json")) return console.log(JSON.stringify(inv, null, 2));
    heading(`${BRAND.brand} models — provider inventory (${inv.workload})\n`);
    for (const p of inv.profiles) {
      console.log(`  ${p.profile}  ${p.status}${p.checkedAt ? `  ${p.checkedAt}` : ""}`);
      for (const band of ["high", "medium", "low", "unrated"]) {
        const group = p.models.filter((m) => m.rating.band === band);
        if (!group.length) continue;
        console.log(`    ${band}`);
        for (const m of group) {
          const ops = m.capabilities?.join(", ") || "unknown";
          const price = m.price
            ? `USD ${m.price.input}/${m.price.output} per million input/output tokens (${m.price.source})`
            : "unknown";
          const last = m.lastCall ? `${m.lastCall.latencyMs} ms at ${m.lastCall.at}` : "unknown";
          const cost =
            m.lastCall?.costUsd != null ? `USD ${m.lastCall.costUsd} (provider report)` : "unknown";
          console.log(
            `      ${m.id}  ${m.availability}  checked ${m.availabilityEvidence.checkedAt ?? "unknown"}`,
          );
          console.log(
            `        capabilities ${ops} · price ${price} · last call latency ${last} · last call cost ${cost}`,
          );
          if (m.workloadAttemptCost)
            console.log(
              `        workload mean USD ${m.workloadAttemptCost.meanUsd} over ${m.workloadAttemptCost.n} operator-reported attempts`,
            );
        }
      }
      if (!p.models.length) console.log("    No matching model rows.");
    }
    for (const h of inv.nativeHosts)
      console.log(
        `  ${h.host}  host-managed  reported model ${h.reportedModel ?? "unknown"}${h.observedAt ? " at " + h.observedAt : ""}`,
      );
    return;
  }
  // What each tier resolves to RIGHT NOW: family → newest model in the active provider's live
  // catalog (else the shipped snapshot), priced from OpenRouter's catalog (else the snapshot).
  const { describeResolution, PRICING_VERIFIED, resolveTiers } = await import("../model_tiers.js");
  const { activeProvider, envModelOverride } = await import("../providers.js");
  const root = process.cwd();
  const provider = activeProvider(root);
  const tiers = resolveTiers({ root, provider });
  const override = envModelOverride(provider) || provider.selectedModel;
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
      "  cache: private user state — reused while the response's own Cache-Control/Expires says fresh, else revalidated (ETag); FORGE_NO_CATALOG_FETCH=1 stays offline",
      "dim",
    ),
  );
  return;
};

HANDLERS.route = async (argv) => {
  if (argv[1] === "monitor") {
    const args = argv.slice(2).filter((a) => a !== "--json");
    if (args.length !== 1 || args[0].startsWith("-"))
      throw new Error("Usage: forge route monitor <observations.json> [--json]");
    const { basename, dirname, join, resolve } = await import("node:path");
    const { realpathSync } = await import("node:fs");
    const { readBounded } = await import("../harness_verify.js");
    const { monitorModel } = await import("../model_monitor.js");
    const input = resolve(args[0]);
    const file = join(realpathSync.native(dirname(input)), basename(input));
    const data = readBounded(file, 16 * 1024 * 1024).bytes;
    console.log(JSON.stringify(monitorModel(JSON.parse(data.toString("utf8"))), null, 2));
    return;
  }
  const r = await import("../route.js");
  if (argv[1] === "gateway") {
    const result = r.emitGatewayConfig(process.cwd());
    if (typeof result === "object" && !result.ok) {
      console.log(`  ${result.reason}`);
      return;
    }
    console.log(`  wrote ${result} — LiteLLM tiers: forge-simple / forge-medium / forge-complex.`);
    console.log("  next: pin+install litellm, run it, point ANTHROPIC_BASE_URL at it, then");
    console.log("        REQUEST an explicit gateway alias or provider model ID.");
    return;
  }
  if (argv[1] === "calibrate") {
    const index = argv.indexOf("--workload");
    const result = r.calibrateRouting(process.cwd(), index < 0 ? undefined : argv[index + 1]);
    if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else if (!result.models.length)
      console.log("No model has two distinct verified tasks for leave-one-task-out calibration.");
    else
      for (const m of result.models)
        console.log(
          `  ${m.id} · ${m.interval.n} verified tasks · leave-one-task-out Brier ${m.leaveOneTaskOutBrier.toFixed(4)}`,
        );
    return;
  }
  if (["universal", "outcome", "fit", "models"].includes(argv[1]) || argv.includes("--universal")) {
    return routeUniversalCli(argv);
  }
  const json = argv.includes("--json");
  const apply = argv.includes("--apply");
  const flagValue = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const flags = new Set(["--json", "--apply", "--allow-top", "--read-only"]);
  const valued = new Set(["--provider", "--mode", "--workload", "--objective", "--band"]);
  const task = argv
    .slice(1)
    .filter((a, i) => !flags.has(a) && !valued.has(a) && !valued.has(argv[i]))
    .join(" ");
  if (!task)
    throw new Error(
      'Usage: forge route "<task>" [--provider NAME] [--workload NAME] [--objective SPEC] [--band BAND] [--apply] [--json]',
    );
  const mode = flagValue("--mode");
  if (mode && !["conservative", "unattended"].includes(mode)) throw new Error("Unknown route mode");
  const root = process.cwd();
  const rec = r.routeTask(root, task, {
    profile: flagValue("--provider"),
    workload: flagValue("--workload"),
    objective: flagValue("--objective"),
    band: flagValue("--band"),
    allowTop: argv.includes("--allow-top"),
  });
  r.meterRoute(root, task, rec);
  if (apply && rec.ok) {
    const { applyRoute, setProfileModel, inventoryProfiles } = await import("../providers.js");
    const profile = inventoryProfiles(root).find((p) => p.name === rec.profile);
    if (profile.type === "anthropic") {
      const applied = applyRoute(null, { exactId: rec.model.id });
      if (!applied.ok) throw new Error(applied.reason);
    } else setProfileModel(root, rec.profile, rec.model.id);
  }
  if (apply && !rec.ok) process.exitCode = 1;
  if (json) console.log(JSON.stringify({ ...rec, ...(apply ? { applied: rec.ok } : {}) }, null, 2));
  else {
    console.log(r.describeRoute(rec));
    if (apply && rec.ok) console.log(`Applied ${rec.model.id} to ${rec.profile}.`);
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
    "--band",
    "--workload",
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
      status: (fit?.observedModels ?? fit?.models)?.includes(m.id) ? "fitted" : "cold",
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
        workload: val("--workload"),
        profile: val("--provider"),
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
      if (row.provenanceNote) console.log(`  ! ${row.provenanceNote}`);
    } catch (e) {
      console.error(`  ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }
  let rec;
  try {
    const objective = val("--objective");
    const maxDepth = val("--depth") ? Number(val("--depth")) : undefined;
    if (
      argv.includes("--band") ||
      argv.includes("--workload") ||
      (val("--provider") && val("--provider") !== "any")
    ) {
      const { inventoryRoute } = await import("../model_inventory.js");
      rec = inventoryRoute(root, task, {
        profile: val("--provider"),
        band: val("--band"),
        workload: val("--workload"),
        refresh: argv.includes("--refresh"),
        allowTop: argv.includes("--allow-top"),
        objective,
        maxDepth,
      });
    } else {
      rec = U.routeUniversal(root, task, {
        provider: val("--provider") ?? "any",
        objective,
        maxDepth,
      });
    }
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
  if (!("cascade" in rec)) {
    console.error(
      `  ${"feasible" in rec && rec.feasible === false ? "INFEASIBLE — " : ""}${rec.reason}`,
    );
    // F12: the least-bad cascade is shown only as an explicit, labeled fallback.
    const fb = "fallback" in rec && rec.fallback;
    if (fb)
      console.error(
        `  fallback (does NOT meet the objective): ${fb.cascade.map((c) => c.model).join(" → ")} · P(success) ${fb.pSuccess.toFixed(2)} · expected $${fb.expectedCost.toFixed(3)} (an estimated $${fb.estimatedCostIfAllAttemptsRun.toFixed(3)} if every attempt runs)`,
      );
    process.exitCode = 1;
    return;
  }
  heading(
    `${BRAND.brand} route universal — ${rec.objective.kind}${rec.target != null ? ` (target ${rec.target.toFixed(2)})` : ""}\n`,
  );
  rec.cascade.forEach((c, i) => {
    console.log(
      `  ${i === 0 ? "→" : "then, if a check fails →"} ${paint(c.model, "accent")}  P(solve alone) ${c.pSolveAlone.toFixed(2)} · ~$${c.expectedAttemptCost.toFixed(3)}/attempt${c.status === "cold" ? " · cold (no outcomes yet)" : ""}${c.providers.length ? "" : " · no provider id"}`,
    );
  });
  // A07: a model in the registry is not a model you can call.
  if (!rec.applicable)
    console.log(
      `\n  ${paint("advice only", "warn")}: ${rec.unmapped.join(", ")} ${rec.unmapped.length === 1 ? "has" : "have"} no provider id — add one under "providers" in .forge/models.json, or pass --provider <name> to route among models you can call (\`${BRAND.cli} route models\` lists who serves what)`,
    );
  console.log(
    `\n  P(success) ${rec.pSuccess.toFixed(2)} · expected cost $${rec.expectedCost.toFixed(3)} (not a cap; an estimated $${rec.estimatedCostIfAllAttemptsRun.toFixed(3)} if every attempt runs) · best single: ${rec.bestSingle.model} ${rec.bestSingle.pSuccess.toFixed(2)} at $${rec.bestSingle.expectedCost.toFixed(3)}`,
  );
  console.log(
    `  ${rec.candidates} candidate model(s), ${rec.cascadesEvaluated} cascade(s) compared · fit: ${rec.fit.origin}`,
  );
  console.log(
    `  learn from results: \`${BRAND.cli} route outcome "<task>" --model <id> --pass|--fail --cost <usd>\`, then \`${BRAND.cli} route fit\``,
  );
}

export default HANDLERS;

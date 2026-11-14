// CLI presentation and validation. Large ingestion dependencies load only on demand.
import { parseArgs } from "node:util";

const print = (value) => console.log(JSON.stringify(value, null, 2));

/** @returns {{positionals:string[],values:Record<string,any>}} */
function parse(argv, flags = {}) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: "boolean" }, ...flags },
  });
}

function required(text, label) {
  if (typeof text !== "string" || !text.trim()) throw new Error(`Supply ${label}`);
  return text;
}

function arity(args, min, max, usage) {
  if (args.length < min || args.length > max) throw new Error(`Usage: ${usage}`);
}

async function evidence(argv) {
  const { positionals, values } = parse(argv.slice(1), { web: { type: "string" } });
  const task = required(positionals.join(" "), "a task");
  const { runEvidence } = await import("../evidence.js");
  const report = await runEvidence(task, { web: values.web });
  if (values.json) print(report);
  else console.log(report.text);
}

async function develop(argv) {
  const { positionals, values } = parse(argv.slice(1), {
    web: { type: "string" },
    verify: { type: "boolean" },
  });
  const task = required(positionals.join(" "), "a development task");
  const { runEvidence } = await import("../evidence.js");
  const { sourceWorkspaceRoot } = await import("../sources.js");
  const root = sourceWorkspaceRoot(process.cwd());
  const evidence = await runEvidence(task, { root, web: values.web });
  const { development, ...sources } = evidence;
  let verification = null;
  if (values.verify) {
    const { verify } = await import("../verify.js");
    verification = verify({ targetRoot: root });
    if (!verification.ok) process.exitCode = 1;
  }
  if (values.json) return print({ development, evidence: sources, verification });
  console.log(
    [
      development.text,
      ...development.stages.map((s) => `- ${s.phase} / ${s.id} [${s.status}]: ${s.action}`),
      sources.text,
      verification ? `Current verification: ${verification.tests.status}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function sources(argv) {
  const root = process.cwd();
  const [verb = "status", ...rest] = argv.slice(1);
  const { sourcesStatus, initSources, syncSources, getSource, searchSources } = await import(
    "../sources.js"
  );
  if (verb === "get" || verb === "sql") {
    const { mirrorGet, mirrorSql } = await import("../source_mirror.js");
    const { positionals, values } = parse(
      rest,
      verb === "get"
        ? { chunk: { type: "string" }, offset: { type: "string" }, limit: { type: "string" } }
        : { tables: { type: "string" } },
    );
    if (verb === "sql") {
      arity(positionals, 2, 2, 'forge sources sql <id> "SELECT ..."');
      print(
        await mirrorSql(root, positionals[0], positionals[1], {
          tables: values.tables === undefined ? undefined : JSON.parse(values.tables),
        }),
      );
    } else {
      arity(
        positionals,
        1,
        2,
        "forge sources get <source> [item-id] [--chunk N] [--offset N] [--limit N]",
      );
      const options = { id: positionals[1] };
      for (const k of ["chunk", "offset", "limit"])
        if (values[k] !== undefined) options[k] = Number(values[k]);
      print(await mirrorGet(root, positionals[0], options));
    }
    return;
  }
  if (verb === "search") {
    const { positionals, values } = parse(rest, {
      source: { type: "string" },
      budget: { type: "string" },
    });
    const query = required(positionals.join(" "), "a search query");
    const report = searchSources(root, query, {
      sourceId: values.source,
      budget: values.budget === undefined ? undefined : Number(values.budget),
    });
    if (values.json) print(report);
    else
      console.log([report.text || "No matching cached excerpts.", ...report.warnings].join("\n"));
    return;
  }
  if (verb === "aggregate") {
    const { positionals, values } = parse(rest, {
      sheet: { type: "string" },
      column: { type: "string" },
      "group-by": { type: "string" },
    });
    arity(
      positionals,
      3,
      3,
      "forge sources aggregate <source-id> <relative-path> <operation> [--sheet X] [--column Y] [--group-by Z]",
    );
    const [id, path, operation] = positionals;
    const source = getSource(root, id);
    if (source.provider !== "local") throw new Error("Aggregation needs a configured local source");
    const { aggregateLocalTable } = await import("../source_local.js");
    print(
      await aggregateLocalTable(source, {
        path,
        operation,
        column: values.column,
        groupBy: values["group-by"],
        sheet: values.sheet,
      }),
    );
    return;
  }
  if (verb === "route") {
    const { positionals, values } = parse(rest, {
      fresh: { type: "boolean" },
      mcp: { type: "boolean" },
      probe: { type: "boolean" },
    });
    arity(
      positionals,
      2,
      2,
      "forge sources route <source-id> <read|search|bulk|write> [--fresh] [--mcp]",
    );
    const [id, operation] = positionals;
    const { sourceRoute } = await import("../evidence_tools.js");
    print(
      await sourceRoute(root, id, operation, {
        fresh: !!values.fresh,
        mcpAvailable: !!values.mcp,
        probe: !!values.probe,
      }),
    );
    return;
  }
  if (verb === "read") {
    const { positionals, values } = parse(rest, {
      offset: { type: "string" },
      limit: { type: "string" },
    });
    arity(positionals, 2, 2, "forge sources read <source-id> <record-id> [--offset N] [--limit N]");
    const { readSourceRecord } = await import("../sources.js");
    print(
      await readSourceRecord(root, positionals[0], positionals[1], {
        offset: values.offset === undefined ? undefined : Number(values.offset),
        limit: values.limit === undefined ? undefined : Number(values.limit),
      }),
    );
    return;
  }
  if (verb === "update-page") {
    const { positionals, values } = parse(rest, {
      version: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
    });
    arity(
      positionals,
      2,
      2,
      "forge sources update-page <source> <id> --version N --title TITLE --body-file FILE",
    );
    if (!values["body-file"] || !values.title || !values.version)
      throw new Error("Supply --body-file, --title and the cached --version");
    const { readFileSync, statSync } = await import("node:fs");
    const info = statSync(values["body-file"]);
    if (!info.isFile() || info.size > 512 * 1024)
      throw new Error("Select a regular storage-format body file under 512 KiB");
    const { writeSourcePage } = await import("../sources.js");
    const result = await writeSourcePage(root, positionals[0], positionals[1], {
      expectedVersion: Number(values.version),
      title: values.title,
      storage: readFileSync(values["body-file"], "utf8"),
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const { positionals, values } = parse(rest, verb === "sync" ? { full: { type: "boolean" } } : {});
  if (verb === "probe") {
    arity(positionals, 1, 1, "forge sources probe <source-id>");
    const { probeSourceMcp } = await import("../source_mcp.js");
    print(await probeSourceMcp(getSource(root, positionals[0])));
    return;
  }
  if (verb === "sync") {
    arity(positionals, 0, 1, "forge sources sync [source-id]");
    const result = await syncSources(root, { sourceId: positionals[0], full: !!values.full });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (verb !== "init" && verb !== "status")
    throw new Error("Use sources init, status, sync, read, search, route or aggregate");
  arity(positionals, 0, 0, `forge sources ${verb}`);
  print(verb === "init" ? initSources(root) : sourcesStatus(root));
}

async function team(argv) {
  if (argv[1] === "evaluate")
    return (await import("../rollout_eval.js")).rolloutCommand(argv.slice(2));
  const { positionals, values } = parse(argv.slice(1), {
    run: { type: "string" },
    handoff: { type: "string" },
    brief: { type: "string" },
    "host-billing": { type: "boolean" },
    "timeout-seconds": { type: "string" },
    "max-workers": { type: "string" },
    "budget-usd": { type: "string" },
  });
  const task = required(positionals.join(" "), "a task");
  const { teamPlan, runTeam } = await import("../evidence_team.js");
  const { buildEvidence } = await import("../evidence.js");
  const { sourceWorkspaceRoot } = await import("../sources.js");
  const root = sourceWorkspaceRoot(process.cwd());
  let decomposition;
  if (values.brief) {
    const { readFileSync, statSync } = await import("node:fs");
    const stat = statSync(values.brief);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error("Supply a JSON decomposition file under 64 KiB");
    decomposition = JSON.parse(readFileSync(values.brief, "utf8"));
  }
  const options = {
    root,
    decomposition,
    maxWorkers: values["max-workers"] === undefined ? undefined : Number(values["max-workers"]),
    budgetUsd: values["budget-usd"] === undefined ? undefined : Number(values["budget-usd"]),
    evidence: buildEvidence(task, { root }),
  };
  if (values.handoff || values.run === "codex" || values.run === "kimi") {
    if (values.handoff && values.run) throw new Error("Choose handoff or run");
    const { portableBriefs, runPortableTeam } = await import("../portable_team.js");
    const plan = teamPlan(task, options);
    const host = values.handoff ?? values.run;
    const briefs = portableBriefs(plan, task, host, options.evidence.text);
    if (values.handoff) return print({ host, plan, briefs });
    if (values["budget-usd"] !== undefined || !values["host-billing"])
      throw new Error(
        "Use --host-billing for this CLI's configured provider, or use --handoff <host> for a local plan. This client has no dollar cap.",
      );
    const report = await runPortableTeam(root, host, briefs, {
      timeoutMs:
        values["timeout-seconds"] === undefined ? 90000 : Number(values["timeout-seconds"]) * 1000,
    });
    print({ ...report, plan });
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!values.run) return print(teamPlan(task, options));
  const report = await runTeam(root, task, { ...options, host: values.run });
  print(report);
  if (!report.ok) process.exitCode = 1;
}

export async function handleAdoption(argv) {
  const { sourceWorkspaceRoot } = await import("../sources.js");
  const root = sourceWorkspaceRoot(process.cwd());
  const [, , ...rest] = argv;
  if (argv[1] === "run") {
    arity(rest, 2, 2, "forge integrations run <id> <version>");
    const { runAdoption } = await import("../tool_adoption.js");
    const code = await runAdoption(rest[0], rest[1]);
    if (typeof code === "number") process.exitCode = code;
    return;
  }
  const { positionals, values } = parse(
    rest,
    argv[1] === "install" ? { version: { type: "string" } } : {},
  );
  if (argv[1] === "auto") {
    const { autoStatus, configureAuto } = await import("../auto_adoption.js");
    const [action = "status", ...ids] = positionals;
    print(action === "status" ? autoStatus(root) : configureAuto(root, action, ids));
    return;
  }
  const { findAdoption, installAdoption } = await import("../tool_adoption.js");
  if (argv[1] === "install") {
    arity(positionals, 1, 1, "forge integrations install <catalog-id>");
    const result = await installAdoption(root, positionals[0], { version: values.version });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  print(
    await findAdoption(required(positionals.join(" "), "a task to find an integration for"), {
      root,
    }),
  );
}

async function hikmah(argv) {
  const { positionals, values } = parse(argv.slice(2), {
    binary: { type: "string" },
    store: { type: "string" },
  });
  const { bindHikmah, hikmahStatus, recallHikmah } = await import("../hikmah_recall.js");
  const root = process.cwd();
  switch (argv[1] ?? "status") {
    case "on":
      return print(bindHikmah(root, { binary: values.binary, store: values.store }));
    case "off":
      return print(bindHikmah(root, null));
    case "status":
      return print(hikmahStatus(root));
    case "recall":
      return print(await recallHikmah(root, positionals.join(" ")));
    default:
      throw new Error("Use hikmah on, off, status or recall");
  }
}
export default { develop, evidence, sources, team, hikmah };

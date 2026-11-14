import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { initHarness, loadHarnessConfig, localVerifier, trustHarness } from "../harness_config.js";
import { readHarnessConfigData } from "../harness_config_data.js";
import { checkHarnessDrift } from "../harness_drift.js";
import { normalizeHarnessRequest } from "../harness_gateway.js";
import { approvalStore } from "../harness_policy.js";
import { describeHarnessRoutes, harnessSpend } from "../harness_router.js";
import {
  auditHarnessRun,
  harnessRunStats,
  pruneHarnessRuns,
  readHarnessRun,
  replayHarnessRun,
} from "../harness_trace.js";
import { sourceWorkspaceRoot } from "../sources.js";

async function setupHosts(root, chosen) {
  const { init } = await import("../init.js");
  const { HOOK_HOSTS, applyHooks } = await import("../emit/hooks.js");
  const { HOSTS } = await import("../hosts.js");
  const { writeForgeConfig } = await import("../repo_config.js");
  const result = init({ targetRoot: root, tools: chosen, noSettings: true, warm: false });
  if (result.aborted) throw new Error("Host setup failed");
  const ids = HOOK_HOSTS.filter((id) => chosen.includes(HOSTS[id].tool));
  const saved = writeForgeConfig(root, (cfg) => ({
    ...cfg,
    hooks: { ...cfg.hooks, project: true, hosts: ids },
  }));
  if (!saved.ok) throw new Error("Could not record project hooks");
  return ids.map((id) => applyHooks(root, id, { enable: true })).filter(Boolean);
}

async function command(root, op, args) {
  if (op === "verifier") {
    const [action = "show", file, ...rest] = args;
    if (action === "show" && !file) return localVerifier(root);
    if (action === "clear" && !file) return localVerifier(root, null);
    if (action === "set" && file && !rest.length)
      return localVerifier(root, readHarnessConfigData(resolve(file)));
    throw new Error("Use verifier show, set <container.json> or clear");
  }
  if (op === "jobs" || op === "council") {
    const { handleHarnessJobs } = await import("../harness_jobs_cli.js");
    const { runProjectHarness } = await import("../harness_runtime.js");
    return handleHarnessJobs(root, op, args, {
      config: loadHarnessConfig(root),
      run: (r, opts) => runProjectHarness(root, r, opts),
    });
  }
  if (op === "memory") {
    const { harnessMemoryCommand } = await import("../harness_memory_cli.js");
    return harnessMemoryCommand(root, args);
  }
  if (op === "extensions") {
    const ext = await import("../harness_extensions.js");
    const [action = "list", name, ...rest] = args;
    if (action === "list" && !name) return ext.listHarnessExtensions(root);
    if (action === "inspect" && name && !rest.length)
      return ext.inspectHarnessExtension(root, name);
    if (action === "pin" && name && rest.length === 2 && rest[0] === "--digest")
      return ext.pinHarnessExtension(root, name, rest[1]);
    if (action === "remove" && name && !rest.length) return ext.removeHarnessExtension(root, name);
    throw new Error(
      "Use extensions list, inspect <dir>, pin <dir> --digest <sha256>, or remove <name>",
    );
  }
  if (op === "approvals") {
    const [action = "list", id, ...extra] = args,
      store = approvalStore(root);
    if (action === "list" && !id) return store.list();
    if (id && !extra.length && ["get", "grant", "deny"].includes(action)) return store[action](id);
    throw new Error("Use approvals list or get|grant|deny <approval-id>");
  }
  const schemas = {
    init: { hosts: { type: "string" }, supervised: { type: "boolean" } },
    drift: { hosts: { type: "string" } },
    run: {
      id: { type: "string" },
      host: { type: "string" },
      profile: { type: "string" },
      priority: { type: "string" },
      accept: { type: "string", multiple: true },
      verifier: { type: "string" },
    },
    resume: { verifier: { type: "string" } },
  };
  const { positionals: p, values } = parseArgs({
    args,
    allowPositionals: true,
    options: schemas[op] ?? {},
  });
  const v = /** @type {Record<string, any>} */ (values);
  if (op === "init" || op === "drift") {
    if (p.length) throw new Error("Choose hosts with --hosts");
    let hosts;
    if (v.hosts) {
      const { parseTools, KNOWN_TOOLS } = await import("../repo_config.js");
      const choice = parseTools(v.hosts);
      if (choice.unknown.length || choice.tools?.length === 0)
        throw new Error(`Unknown coding hosts: ${choice.unknown.join(", ")}`);
      hosts = choice.tools ?? KNOWN_TOOLS;
    }
    if (op === "drift") {
      const cfg = loadHarnessConfig(root, { trusted: false });
      const result = checkHarnessDrift(
        root,
        hosts ?? (cfg.policy.hosts.length ? cfg.policy.hosts : undefined),
      );
      if (!result.ok) process.exitCode = 1;
      return result;
    }
    const result = initHarness(root, { hosts, supervised: v.supervised });
    // On a partially initialized checkout existing controls require an explicit review.
    const hooks = hosts && result.activated ? await setupHosts(root, hosts) : [];
    return { ...result, hooks };
  }
  if (op === "run" || op === "resume") {
    if (!p.length || (op === "resume" && p.length !== 1))
      throw new Error("Supply a task or resume ID");
    const { runProjectHarness } = await import("../harness_runtime.js");
    const request =
      op === "resume"
        ? { id: p[0] }
        : normalizeHarnessRequest(
            { task: p.join(" "), acceptance: v.accept ?? [] },
            { id: v.id, profile: v.profile, priority: v.priority },
          );
    const verifier = v.verifier ? readHarnessConfigData(resolve(v.verifier)) : undefined;
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const r = await runProjectHarness(root, request, {
        verifier,
        host: v.host,
        resume: op === "resume" ? p[0] : undefined,
        signal: controller.signal,
      });
      if (r.status !== "done") process.exitCode = 1;
      const { events, ...summary } = r;
      return summary;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  if (!p.length) {
    switch (op) {
      case "trust":
        return trustHarness(root);
      case "routes":
        return describeHarnessRoutes(loadHarnessConfig(root, { trusted: false }).routing);
      case "stats":
        return { runs: harnessRunStats(root), spend: harnessSpend(root) };
      case "prune":
        return pruneHarnessRuns(root);
      case "status": {
        const c = loadHarnessConfig(root);
        return {
          root,
          mode: c.policy.nativeMode,
          hosts: c.policy.hosts,
          digest: c.digest,
          profiles: Object.keys(c.policy.profiles),
        };
      }
    }
  }
  if (p.length === 1) {
    if (op === "recover")
      return (await import("../harness_trace.js")).recoverHarnessRun(root, p[0]);
    if (op === "show") return readHarnessRun(root, p[0]);
    if (op === "replay") return replayHarnessRun(root, p[0]);
    if (op === "audit") {
      const r = auditHarnessRun(root, p[0]);
      if (!r.ok) process.exitCode = 1;
      return r;
    }
  }
  throw new Error("Run forge harness --help for supported commands");
}
export async function handleHarness(argv) {
  const root = sourceWorkspaceRoot(process.cwd());
  const out = await command(root, argv[1] ?? "status", argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
}

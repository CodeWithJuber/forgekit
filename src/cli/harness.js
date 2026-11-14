import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  connectHarnessHosts,
  initHarness,
  loadHarnessConfig,
  localVerifier,
  trustHarness,
} from "../harness_config.js";
import { readHarnessConfigData } from "../harness_config_data.js";
import { checkHarnessDrift } from "../harness_drift.js";
import { normalizeHarnessRequest } from "../harness_gateway.js";
import {
  detectHarnessHosts,
  GENERIC_HOST,
  genericHarnessServer,
  parseHarnessHosts,
} from "../harness_hosts.js";
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

async function setupHosts(root, chosen, additive = false) {
  const selected = chosen.filter((id) => id !== GENERIC_HOST);
  if (!selected.length) return [];
  const { init } = await import("../init.js");
  const { HOOK_HOSTS, applyHooks } = await import("../emit/hooks.js");
  const { HOSTS } = await import("../hosts.js");
  const { KNOWN_TOOLS, parseTools, readForgeConfig, writeForgeConfig } = await import(
    "../repo_config.js"
  );
  const prior = readForgeConfig(root);
  if (prior.corrupt) throw new Error("Invalid project host configuration");
  const previous = additive && prior.tools ? (parseTools(prior.tools).tools ?? KNOWN_TOOLS) : [];
  const tools = [...new Set([...selected, ...previous])];
  const result = init({ targetRoot: root, tools, noSettings: true, warm: false });
  if (result.aborted) throw new Error("Host setup failed");
  const ids = HOOK_HOSTS.filter((id) => selected.includes(HOSTS[id].tool));
  const installed = additive && Array.isArray(prior.hooks?.hosts) ? prior.hooks.hosts : [];
  const saved = writeForgeConfig(root, (cfg) => ({
    ...cfg,
    hooks: { ...cfg.hooks, project: true, hosts: [...new Set([...installed, ...ids])] },
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
    connect: { hosts: { type: "string" } },
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
  if (op === "init" || op === "drift" || op === "connect") {
    if (p.length) throw new Error("Choose hosts with --hosts");
    let hosts = v.hosts === undefined ? undefined : parseHarnessHosts(v.hosts);
    if (!hosts && op === "init" && v.supervised) hosts = detectHarnessHosts(root);
    if (op === "drift") {
      const cfg = loadHarnessConfig(root, { trusted: false });
      const result = checkHarnessDrift(
        root,
        hosts ?? (cfg.policy.hosts.length ? cfg.policy.hosts : undefined),
      );
      if (!result.ok) process.exitCode = 1;
      return result;
    }
    if (op === "connect" && !hosts?.length)
      throw new Error("Choose hosts with forge harness connect --hosts <names>");
    const result =
      op === "connect"
        ? await connectHarnessHosts(root, hosts, (chosen) => setupHosts(root, chosen, true))
        : initHarness(root, { hosts, supervised: v.supervised });
    const wired = "hosts" in result ? result.hosts : result.activated ? hosts : [];
    const hooks =
      "hooks" in result ? result.hooks : wired?.length ? await setupHosts(root, wired) : [];
    return {
      ...result,
      hooks,
      ...(wired?.includes(GENERIC_HOST)
        ? { mcpServers: { "forge-cortex": genericHarnessServer(root) } }
        : {}),
    };
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

// Read-only localhost dashboard projection. Keep the private run store out of
// shared reports and /api/data, which are also exported through MCP.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadHarnessConfig, nativeHarnessPolicy } from "./harness_config.js";
import { checkHarnessDrift } from "./harness_drift.js";
import { GENERIC_HOST, parseHarnessHosts } from "./harness_hosts.js";
import { recentHarnessRuns } from "./harness_trace.js";
import { HOSTS } from "./hosts.js";
import { detectTools, KNOWN_TOOLS } from "./repo_config.js";
import { redactSecrets } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";

const extraLabels = {
  zed: "Zed",
  aider: "Aider",
  continue: "Continue",
  roo: "Roo Code",
  openclaw: "OpenClaw",
  [GENERIC_HOST]: "Other MCP client",
};
const hostIds = [...KNOWN_TOOLS, GENERIC_HOST];
const action = {
  done: "Inspect the verification result.",
  approval_pending: "Review the requested action before resuming.",
  budget_exhausted: "Review usage and limits before resuming.",
  interrupted: "Reconcile the last operation before starting more work.",
  recovered: "Review the saved checkpoint before resuming.",
  verification_failed: "Inspect the failed check and correct the change.",
  provider_failed: "Check the configured model route and its availability.",
  running: "Check the latest saved checkpoint.",
};
const numeric = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

function runSummary(record) {
  // Render shell commands only with a legal, unchanged public identifier.
  const rawId = String(record.id);
  const id = redactSecrets(rawId);
  const printableId = id === rawId && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(id);
  const status = /^[a-z_]{1,48}$/.test(record.status) ? record.status : "unknown";
  const updatedAt = Number.isFinite(Date.parse(record.updatedAt)) ? record.updatedAt : null;
  return {
    id,
    status,
    updatedAt,
    task: record.prunedAt ? null : redactSecrets(record.request?.task ?? "").slice(0, 220),
    reason: redactSecrets(record.reason ?? "").slice(0, 320),
    turns: numeric(record.usage?.turns),
    toolCalls: numeric(record.usage?.toolCalls),
    costUsd: numeric(record.usage?.costUsd),
    verified:
      status === "done" &&
      record.evidence?.ok === true &&
      record.events.some((e) => e.type === "verify.passed") &&
      record.events.some((e) => e.type === "run.completed"),
    nextAction: Object.hasOwn(action, status) ? action[status] : "Inspect the recorded outcome.",
    command: printableId ? `forge harness show ${id}` : null,
  };
}

function hostRows(root, selected, inspect) {
  const detected = detectTools(root);
  let checks = [];
  let failed = false;
  if (inspect && selected.length) {
    try {
      checks = checkHarnessDrift(root, selected).checks;
    } catch {
      failed = true;
    }
  }
  return hostIds.map((id) => {
    const native = Object.entries(HOSTS).find(([, host]) => host.tool === id);
    const capability = native
      ? "native"
      : id === GENERIC_HOST
        ? "manual"
        : id === "aider"
          ? "instructions"
          : "mcp";
    const rows = checks.filter((c) => c.host === (native?.[0] ?? id));
    let wiring = "not-checked";
    if (selected.includes(id) && inspect && (failed || rows.length)) {
      if (failed || rows.some((c) => c.status === "drift")) wiring = "needs-attention";
      else if (rows.some((c) => c.status === "manual") || !rows.some((c) => c.status === "pass"))
        wiring = "manual";
      else wiring = "configured";
    }
    const label = native?.[1].label ?? extraLabels[id] ?? id;
    let note = native?.[1].trust ?? "Register the project MCP server in this client.";
    if (id === GENERIC_HOST) note = "Register forge cortex-mcp as a stdio server in the project.";
    if (id === "aider") note = "Use the project instructions and the ForgeKit CLI.";
    return {
      id,
      label,
      selected: selected.includes(id),
      detected: detected.includes(id),
      capability,
      wiring,
      note,
    };
  });
}

/** Inspect only the project served by this local dashboard. No provider or tool is called. */
export function dashHarness(root, local = true) {
  if (!local)
    return {
      state: "private",
      mode: null,
      hosts: [],
      runs: [],
      moreRuns: false,
      runsUnavailable: false,
    };
  let state = "unconfigured",
    mode = null,
    selected = [];
  let workspace = root;
  try {
    workspace = nativeHarnessPolicy(root)?.root ?? sourceWorkspaceRoot(root);
    if (existsSync(join(workspace, "harness"))) {
      const config = loadHarnessConfig(workspace);
      mode = config.policy.nativeMode;
      selected = config.policy.hosts.length ? parseHarnessHosts(config.policy.hosts) : [];
      state = "active";
    }
  } catch (error) {
    workspace = error.harnessRoot ?? workspace;
    state =
      error.message === "Review harness/ and run forge harness trust in this worktree"
        ? "needs-trust"
        : "invalid";
  }
  const hosts = hostRows(workspace, selected, state === "active");
  try {
    return { state, mode, hosts, ...recentHarnessRuns(workspace, runSummary) };
  } catch {
    return { state, mode, hosts, runs: [], moreRuns: false, runsUnavailable: true };
  }
}

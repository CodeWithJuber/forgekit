import { createHarnessIntake } from "./harness_gateway.js";

const intake = createHarnessIntake();
export const HARNESS_MCP_TOOLS = [
  {
    name: "forge_harness_run",
    description:
      "Run a coding task through the trusted project harness with scoped tools, budgets and project verification. May return a pending human approval or verification failure.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        acceptance: { type: "array", items: { type: "string" } },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "forge_harness_status",
    description:
      "Inspect the outcome, scoped verification evidence and budget usage for one supervised run in this worktree.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
export async function harnessMcp(root, name, args, host = undefined) {
  const { sourceWorkspaceRoot } = await import("./sources.js");
  const { loadHarnessConfig, nativeHarnessPolicy } = await import("./harness_config.js");
  root = nativeHarnessPolicy(root)?.root ?? sourceWorkspaceRoot(root);
  const config = loadHarnessConfig(root);
  let result;
  if (name === "forge_harness_run") {
    if (Object.keys(args).some((k) => !["task", "acceptance"].includes(k)))
      throw new Error("Expected only task and acceptance");
    const { runProjectHarness } = await import("./harness_runtime.js");
    const request = intake(args, {
      channel: "mcp",
      actor: "host",
      profile: config.policy.nativeProfile,
    });
    result = await runProjectHarness(root, request, { host });
  } else {
    const { readHarnessRun } = await import("./harness_trace.js");
    result = readHarnessRun(root, args.id);
  }
  const { id, status, reason, usage, evidence, answer, approval, certainty } = result;
  return JSON.stringify({
    id,
    status,
    reason,
    usage,
    certainty,
    evidence,
    answer,
    approval: approval ? { id: approval.id } : undefined,
  });
}

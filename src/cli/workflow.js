import { parseArgs } from "node:util";
import { sourceWorkspaceRoot } from "../sources.js";
import {
  approveWorkflow,
  createWorkflow,
  getWorkflow,
  retryWorkflow,
  runWorkflow,
} from "../workflow.js";

export async function handleWorkflow(argv) {
  const root = sourceWorkspaceRoot(process.cwd());
  const action = argv[1];
  const schemas = {
    create: { size: { type: "string" }, accept: { type: "string", multiple: true } },
    approve: { stage: { type: "string" }, digest: { type: "string" } },
    retry: { from: { type: "string" }, reason: { type: "string" } },
    status: {},
    run: {},
    resume: {},
  };
  if (!Object.hasOwn(schemas, action))
    throw new Error("Use workflow create, status, run, resume, approve or retry; see --help");
  const { positionals, values } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: { ...schemas[action], json: { type: "boolean" } },
  });
  const v = /** @type {Record<string, any>} */ (values);
  if (!positionals.length || (action !== "create" && positionals.length !== 1))
    throw new Error("Supply a task for create or one workflow ID");
  const id = positionals[0];
  let result;
  if (action === "create")
    result = createWorkflow(root, {
      task: positionals.join(" "),
      size: v.size,
      acceptance: v.accept,
    });
  else if (action === "status") result = getWorkflow(root, id);
  else if (action === "approve")
    result = approveWorkflow(root, id, { stage: v.stage, digest: v.digest });
  else if (action === "retry") result = retryWorkflow(root, id, { from: v.from, reason: v.reason });
  else {
    const { runProjectHarness } = await import("../harness_runtime.js");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      result = await runWorkflow(
        root,
        id,
        (request, options) => runProjectHarness(root, request, options),
        {
          resume: action === "resume",
          signal: controller.signal,
        },
      );
      if (result.status === "blocked") process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

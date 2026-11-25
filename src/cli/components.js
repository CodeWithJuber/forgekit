import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parseArgs } from "node:util";
import { installAgent, installSkill } from "../component_install.js";
import {
  COMPONENT_CATALOG_VERSION,
  componentCatalog,
  invokeComponentHook,
  runSkillBinding,
} from "../components.js";
import { redactSecrets } from "../secrets.js";
import { sourceWorkspaceRoot } from "../sources.js";

const inputLimit = 1024 * 1024;
function inputObject(file) {
  const stdin = file === "-";
  const fd = stdin ? 0 : openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!stdin && (!fstatSync(fd).isFile() || fstatSync(fd).size > inputLimit))
      throw new Error("Input must be a regular JSON file of at most 1 MiB");
    const buf = Buffer.alloc(inputLimit + 1);
    let used = 0;
    while (used < buf.length) {
      const count = readSync(fd, buf, used, buf.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > inputLimit) throw new Error("Input exceeds 1 MiB");
    let obj;
    try {
      obj = JSON.parse(buf.toString("utf8", 0, used));
    } catch {
      throw new Error("Invalid JSON input");
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
      throw new Error("Expected an input object");
    return obj;
  } finally {
    if (!stdin) closeSync(fd);
  }
}

async function runBrief(component, task, values, root) {
  const host = values.host;
  const runner = values.runner ?? (host ? "native" : "handoff");
  if (host && runner !== "native") throw new Error("Choose a native host or a runner");
  const brief = [component.instructions, task ? `Task\n${task}` : ""].filter(Boolean).join("\n\n");
  if (runner === "handoff") return { ok: true, id: component.id, mode: "handoff", brief };
  if (!task?.trim()) throw new Error("Execution requires a nonempty --task or input.task");
  if (runner === "native") {
    if (!["codex", "kimi"].includes(host) || !values["host-billing"])
      throw new Error("Use --host codex|kimi --host-billing for a native read-only worker");
    const { runPortableTeam } = await import("../portable_team.js");
    return runPortableTeam(root, host, [{ id: component.id, brief: redactSecrets(brief) }]);
  }
  if (runner !== "forge") throw new Error("Unknown runner. Choose forge or handoff");
  const { runProjectHarness } = await import("../harness_runtime.js");
  const result = await runProjectHarness(
    root,
    { task: redactSecrets(brief), profile: "reviewer" },
    { route: values.route, model: values.model, modelProfile: values["model-profile"] },
  );
  const { events, ...summary } = result;
  return { ok: result.status === "done", id: component.id, mode: "harness", result: summary };
}

export async function componentCommand(kind, args, root = sourceWorkspaceRoot(process.cwd())) {
  const [op = "list", ...flags] = args;
  /** @type {import("node:util").ParseArgsOptionsConfig} */
  const options = { json: { type: "boolean" } };
  if (["invoke", "run", "capture-script", "replay-script"].includes(op))
    options.input = { type: "string" };
  if (["verify-script", "pin-script"].includes(op)) options.digest = { type: "string" };
  if (op === "run")
    Object.assign(options, {
      task: { type: "string" },
      runner: { type: "string" },
      route: { type: "string" },
      model: { type: "string" },
      "model-profile": { type: "string" },
      "host-billing": { type: "boolean" },
    });
  if (["run", "install", "uninstall", "enable", "disable"].includes(op))
    options.host = { type: "string" };
  const { positionals, values } = parseArgs({ args: flags, options, allowPositionals: true });
  if (
    kind === "skills" &&
    ["scripts", "capture-script", "verify-script", "pin-script", "replay-script"].includes(op)
  ) {
    const { listScripts, scriptCommand } = await import("../skill_scripts.js");
    if (op === "scripts") {
      if (positionals.length) throw new Error("scripts takes no ID");
      return { schemaVersion: 1, kind: "scripts", scripts: listScripts(root) };
    }
    if (positionals.length !== 1) throw new Error("Supply one script ID");
    if (["capture-script", "replay-script"].includes(op) && !values.input)
      throw new Error("Supply JSON via --input FILE or --input -");
    return scriptCommand(op, root, positionals[0], {
      hash: values.digest,
      input: values.input ? inputObject(values.input) : undefined,
    });
  }
  const catalog = componentCatalog(kind);
  if (op === "list") {
    if (positionals.length) throw new Error("list takes no component ID");
    return {
      schemaVersion: COMPONENT_CATALOG_VERSION,
      kind,
      components: catalog.map(({ instructions, ...entry }) => entry),
    };
  }
  if (positionals.length !== 1) throw new Error("Supply one component ID");
  const item = catalog.find((c) => c.id === positionals[0]);
  if (!item) throw new Error(`Unknown component: ${positionals[0]}`);
  if (op === "show") return { schemaVersion: 1, kind, ...item };
  if (kind === "skills" && ["install", "uninstall"].includes(op)) {
    if (!values.host) throw new Error("Choose the destination with --host");
    return installSkill(item, root, values.host, op === "uninstall");
  }
  if (kind === "agents" && ["install", "uninstall"].includes(op)) {
    if (!values.host) throw new Error("Choose the destination with --host");
    return installAgent(item, root, values.host, op === "uninstall");
  }
  if (kind === "hooks" && ["enable", "disable"].includes(op)) {
    if (values.host !== "claude")
      throw new Error(
        "Individual lifecycle hooks support --host claude in project-local settings.",
      );
    const { installLocalHook } = await import("../emit/local_hook.js");
    return installLocalHook(root, item, op === "enable");
  }
  if (op === "invoke" && kind === "hooks") {
    if (!values.input) throw new Error("Supply a normalized event via --input FILE or --input -");
    return invokeComponentHook(item, inputObject(values.input), root);
  }
  if (op !== "run" || kind === "hooks") throw new Error(`Unknown ${kind} operation: ${op}`);
  if (values.task && values.input) throw new Error("Choose --task or --input");
  if ((values.route || values.model || values["model-profile"]) && values.runner !== "forge")
    throw new Error(
      "Model and route selection require --runner forge. Native hosts manage their own model.",
    );
  if (values["host-billing"] && !values.host) throw new Error("--host-billing requires --host");
  const input = values.input ? inputObject(values.input) : {};
  if (item.binding && !values.runner && !values.host) {
    if (values.task) throw new Error("Bound skills take typed --input or an explicit runner");
    return runSkillBinding(item, input, root);
  }
  if (
    Object.keys(input).some((k) => k !== "task") ||
    (Object.hasOwn(input, "task") && typeof input.task !== "string")
  )
    throw new Error("Brief input accepts a single text task");
  return runBrief(item, values.task ?? input.task, values, root);
}

export async function runComponentCli(kind, args) {
  const report = await componentCommand(kind, args);
  if ("ok" in report && report.ok === false) process.exitCode = 1;
  if (args.includes("--json")) return console.log(JSON.stringify(report, null, 2));
  if (report.components)
    return console.log(
      report.components.map((c) => `${c.id}\t${c.description ?? c.event}`).join("\n"),
    );
  if (report.instructions || report.brief) return console.log(report.instructions ?? report.brief);
  console.log(JSON.stringify(report, null, 2));
}

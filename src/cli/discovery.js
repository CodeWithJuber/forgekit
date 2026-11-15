import { parseArgs } from "node:util";
import { discoverTools } from "../discovery.js";
import { configureAdvisor, discoveryStatus } from "../discovery_config.js";
import { sourceWorkspaceRoot } from "../sources.js";

export async function discover(argv) {
  const { positionals, values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      global: { type: "boolean" },
      decisions: { type: "string" },
      recommendations: { type: "string" },
      search: { type: "string" },
      model: { type: "string" },
      web: { type: "string" },
    },
  });
  const [action = "status", ...rest] = positionals;
  const root = sourceWorkspaceRoot(process.cwd());
  const configFlags = ["decisions", "recommendations", "search", "model"];
  if (action !== "setup" && configFlags.some((k) => values[k] !== undefined))
    throw new Error("Configuration flags apply only to discover setup");
  if (values.global && !["setup", "reset"].includes(action))
    throw new Error("--global applies to discover setup or reset");
  if (values.web !== undefined && action !== "find")
    throw new Error("--web applies only to discover find");
  let data, text;
  if (action === "find" && rest.length) {
    const task = rest.join(" ");
    data = await discoverTools(task, { root, web: values.web, fresh: true });
    text = [
      data.text || "No public task terms recognized. Supply a separate public query with --web.",
      ...data.warnings,
    ].join("\n");
  } else if (action === "setup" && !rest.length) {
    const patch = {};
    for (const k of ["decisions", "recommendations"]) {
      if (values[k] === undefined) continue;
      if (!["on", "off"].includes(values[k])) throw new Error(`--${k} expects on or off`);
      patch[k] = values[k] === "on";
    }
    for (const k of ["search", "model"]) if (values[k] !== undefined) patch[k] = values[k];
    if (!Object.keys(patch).length)
      Object.assign(patch, { recommendations: true, decisions: true });
    data = {
      ...configureAdvisor(root, patch, { global: values.global }),
      status: discoveryStatus(root),
    };
    text = `Saved ${data.scope} discovery preferences.\n${statusText(data.status)}`;
  } else if (action === "reset" && !rest.length) {
    data = configureAdvisor(root, null, { global: values.global });
    text = `Reset ${data.scope} discovery preferences; inherited defaults now apply.`;
  } else if (action === "status" && !rest.length) {
    data = discoveryStatus(root);
    text = statusText(data);
  } else
    throw new Error(
      'Use forge discover status | setup [--global] | reset [--global] | find "<task>" [--web "<public terms>"]',
    );
  console.log(values.json ? JSON.stringify(data, null, 2) : text);
}

function statusText(s) {
  return [
    `Automatic recommendations: ${s.recommendations ? "on" : "off"}; public network: ${s.offline ? "offline" : "available"}`,
    `Jev decisions: ${s.decisions ? "on" : "off"} (${s.model}); key: ${s.jevReady ? "ready" : "not ready"}`,
    `Web search: ${s.search}; key: ${s.searchReady ? "ready" : "not ready"}`,
    ...s.setup,
    ...s.warnings,
  ].join("\n");
}

// No lookup or install happens while browsing choices. The host's existing tool set
// determines which configs an explicit selection can affect.
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { autoStatus } from "../auto_adoption.js";
import { readForgeConfig, recordedTools } from "../repo_config.js";
import { sourceWorkspaceRoot } from "../sources.js";
import { adoptionCatalog, registerCatalogTool, unregisterCatalogTool } from "../tool_adoption.js";

export function integrationChoices(root, presets) {
  const cfg = readForgeConfig(root);
  if (cfg.corrupt)
    throw new Error("Repair the workspace Forge config before selecting integrations");
  const active = new Set(Array.isArray(cfg.mcp?.integrations) ? cfg.mcp.integrations : []);
  const auto = autoStatus(root);
  const packages = adoptionCatalog(root).map((p) => ({
    id: p.id,
    kind: "package",
    description: p.permissions,
    package: p.npm,
  }));
  const binaryPreset = {
    id: "codebase-memory-mcp",
    kind: "binary",
    description: "Optional local code-graph pilot; supply the installed executable with --binary",
  };
  const remoteIds = new Set([...presets.map((p) => p.id), binaryPreset.id]);
  const custom = [...active].filter(
    (id) => !packages.some((p) => p.id === id) && !remoteIds.has(id),
  );
  return {
    hosts: recordedTools(cfg),
    choices: [
      ...packages,
      binaryPreset,
      ...presets.map((p) => ({ id: p.id, kind: "endpoint", description: p.description })),
      ...custom.map((id) => ({
        id,
        kind: "configured",
        description: "Configured workspace integration",
      })),
    ].map((p) => ({
      ...p,
      enabled: active.has(p.id),
      autoInstall: auto.allowed.includes(p.id),
    })),
  };
}

export async function handleChoices(argv, presets, connect) {
  const root = sourceWorkspaceRoot(process.cwd());
  const [, , ...args] = argv;
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      url: { type: "string" },
      "token-env": { type: "string" },
      version: { type: "string" },
      binary: { type: "string" },
    },
  });
  const action = argv[1] ?? "list";
  if (action === "register" || action === "unregister") {
    if (positionals.length !== 1)
      throw new Error("Use integrations register <descriptor.json> or unregister <id>");
    let result;
    if (action === "register") {
      const file = positionals[0];
      const info = statSync(file);
      if (!info.isFile() || info.size > 65536)
        throw new Error("Select a descriptor JSON file of at most 64 KiB");
      result = registerCatalogTool(root, JSON.parse(readFileSync(file, "utf8")));
    } else {
      result = unregisterCatalogTool(root, positionals[0]);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const data = integrationChoices(root, presets);
  const printList = () => {
    for (const [i, p] of data.choices.entries())
      console.log(
        `${i + 1}. ${p.id} [${p.kind}, ${p.enabled ? "enabled" : "available"}] ${p.description}`,
      );
  };
  if (action !== "select") {
    if (positionals.length) throw new Error("Use integrations list or integrations select <id>");
    if (values.json) console.log(JSON.stringify(data, null, 2));
    else {
      printList();
      console.log(
        "\nChoose one: forge integrations select [id]\nPrivate server: forge integrations connect <id> --url <endpoint>\nInstalled executable: forge integrations local <id> --binary /path/to/server\nCustom npm tool: forge integrations register descriptor.json\nRemove from this project: forge integrations remove <id>",
      );
    }
    return;
  }
  let id = positionals[0];
  if (positionals.length > 1) throw new Error("Choose one integration ID at a time");
  if (!id) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "Pass an ID to integrations select in a noninteractive shell. Use integrations list to see choices.",
      );
    printList();
    const io = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await io.question("Integration number or ID (Enter to cancel): ")).trim();
      if (!answer) return;
      id = /^\d+$/.test(answer) ? data.choices[Number(answer) - 1]?.id : answer;
    } finally {
      io.close();
    }
  }
  const choice = data.choices.find((p) => p.id === id);
  if (!choice)
    throw new Error(
      "Unknown integration. Use integrations connect <id> --url <endpoint> for a custom server, or register its npm descriptor.",
    );
  if (choice.kind === "binary") {
    if (!values.binary || values.url || values.version || values["token-env"])
      throw new Error(
        "Use integrations select codebase-memory-mcp --binary /absolute/path/to/installed/server",
      );
    return connect(["integrations", "local", id, "--binary", values.binary]);
  }
  if (values.binary)
    throw new Error("Use integrations local <id> --binary PATH to bind a local server");
  if (choice.kind === "configured") {
    console.log(`${id} is configured. Use integrations remove ${id} to disconnect.`);
    return;
  }
  if (choice.kind === "endpoint") {
    if (values.version) throw new Error("--version is for npm tools");
    return connect([
      "integrations",
      "connect",
      id,
      ...(values.url ? ["--url", values.url] : []),
      ...(values["token-env"] ? ["--token-env", values["token-env"]] : []),
    ]);
  }
  if (values.url || values["token-env"])
    throw new Error("--url and --token-env are for hosted endpoints");
  const { installAdoption } = await import("../tool_adoption.js");
  const result = await installAdoption(root, id, { version: values.version });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

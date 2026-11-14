import { parseArgs } from "node:util";
import { addIntegration } from "./integrations.js";
import { ENDPOINTS, remoteDefinition } from "./remote_endpoints.js";
import { probeMcpEndpoint } from "./source_mcp.js";
import { sourceWorkspaceRoot } from "./sources.js";

/** Register a remote server only for a user's selected repository and host set. */
export async function handleRemoteIntegration(argv) {
  if (["local", "serve-local"].includes(argv[1])) {
    const { connectLocal, serveLocal } = await import("./local_integration.js");
    const root = sourceWorkspaceRoot(process.cwd());
    if (argv[1] === "serve-local") {
      if (argv.length !== 3) throw new Error("Supply one local server ID");
      process.exitCode = await serveLocal(root, argv[2]);
      return;
    }
    const { positionals, values } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: {
        binary: { type: "string" },
        arg: { type: "string", multiple: true },
        "pass-env": { type: "string", multiple: true },
        adopt: { type: "boolean" },
      },
    });
    if (positionals.length !== 1 || !values.binary)
      throw new Error(
        "Usage: forge integrations local <id> --binary /absolute/installed/server [--arg value] [--pass-env NAME]",
      );
    const result = connectLocal(
      root,
      positionals[0],
      values.binary,
      values.arg,
      values["pass-env"],
      values.adopt,
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const { positionals, values } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "token-env": { type: "string" },
      adopt: { type: "boolean" },
      probe: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (argv[1] === "endpoints") {
    if (positionals.length || Object.keys(values).some((k) => k !== "json"))
      throw new Error("Usage: forge integrations endpoints [--json]");
    console.log(JSON.stringify(ENDPOINTS, null, 2));
    return;
  }
  if (positionals.length !== 1)
    throw new Error(
      "Usage: forge integrations connect <id> [--url https://host/mcp] [--token-env NAME] [--probe]",
    );
  const [id] = positionals;
  const url = values.url ?? (Object.hasOwn(ENDPOINTS, id) ? ENDPOINTS[id].url : null);
  if (!url) throw new Error("Supply --url with your Streamable HTTP endpoint");
  const remote = remoteDefinition(id, url, values["token-env"]);
  // Probe only on explicit request; host OAuth usually runs during the first host session.
  const probe = values.probe ? await probeMcpEndpoint(remote) : undefined;
  const result = addIntegration(id, {
    targetRoot: sourceWorkspaceRoot(process.cwd()),
    remote,
    adopt: values.adopt,
  });
  console.log(JSON.stringify({ ...result, probe }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

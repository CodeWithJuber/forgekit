import { readFileSync } from "node:fs";
import {
  cloudStatus,
  configureCloud,
  previewCloud,
  pushCloud,
  readRelay,
  removeCloud,
} from "../cloud_client.js";
import { cloudService } from "../cloud_server.js";

const cloudUsage = [
  "forge cloud configure --full-workspace --url <origin> --workspace <id> --token-env <variable>",
  "forge cloud preview [--json] | push [--replace-remote --confirm] | watch [--interval <seconds>] | status [--remote]",
  "forge cloud logout | delete --confirm",
  "forge cloud serve --config <server.json>",
].join("\n");

const relayUsage = [
  "forge relay configure --full-workspace --url <origin> --tenant <id> --workspace <id> --token-env <variable> --key-env <variable>",
  "forge relay preview | push [--replace-remote --confirm] | watch [--interval <seconds>] | status [--remote]",
  "forge relay list [--revision <id>] | read <path>|--path=<path> [--revision <id>] [--json]",
  "forge relay logout | delete --confirm | serve --config <server.json>",
].join("\n");

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
async function runCloud(args, transport) {
  const relay = transport === "relay";
  const usage = relay ? relayUsage : cloudUsage;
  const op = args[1] || "help",
    root = process.cwd();
  if (["help", "--help", "-h"].includes(op) || args.includes("--help")) {
    console.log(usage);
    return;
  }
  let result;
  switch (op) {
    case "configure":
      if (!args.includes("--full-workspace"))
        throw new Error(
          "Confirm --full-workspace to include project files and recorded sessions, prompts, traces and repo memory.",
        );
      result = await configureCloud(
        root,
        {
          url: flag(args, "--url"),
          workspace: flag(args, "--workspace"),
          tokenEnv: flag(args, "--token-env"),
          fullWorkspace: true,
          ...(relay ? { tenant: flag(args, "--tenant"), keyEnv: flag(args, "--key-env") } : {}),
        },
        transport,
      );
      break;
    case "preview":
      result = previewCloud(root, transport);
      break;
    case "status":
      result = await cloudStatus(root, args.includes("--remote"), transport);
      break;
    case "push":
      result = await pushCloud(
        root,
        {
          replaceRemote: args.includes("--replace-remote"),
          confirmed: args.includes("--confirm"),
        },
        transport,
      );
      break;
    case "list":
    case "read": {
      if (!relay) throw new Error(usage);
      const argument = op === "read" ? args[2] : undefined;
      const path = argument?.startsWith("--path=") ? argument.slice("--path=".length) : argument;
      if (
        (op === "read" && (!path || argument === "--json" || argument === "--revision")) ||
        (args.includes("--revision") && !flag(args, "--revision"))
      )
        throw new Error(usage);
      result = await readRelay(root, path, flag(args, "--revision"));
      if (op === "read" && !args.includes("--json")) {
        process.stdout.write(Buffer.from(result.content, "base64"));
        return;
      }
      break;
    }
    case "logout":
      result = await removeCloud(root, false, false, transport);
      break;
    case "delete":
      result = await removeCloud(root, true, args.includes("--confirm"), transport);
      break;
    case "watch": {
      const interval = Number(flag(args, "--interval") ?? 30);
      if (!Number.isFinite(interval) || interval < 1 || interval > 86400)
        throw new Error("Interval must be 1 to 86400 seconds");
      let delay = interval;
      while ((await cloudStatus(root, false, transport)).enrolled) {
        try {
          console.log(JSON.stringify(await pushCloud(root, {}, transport)));
          delay = interval;
        } catch (e) {
          if ([400, 401, 403, 409, 413].includes(e.status)) throw e;
          console.error(e.message);
          delay = Math.min(Math.max(interval, 300), delay * 2);
        }
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
      return;
    }
    case "serve": {
      const path = flag(args, "--config");
      if (!path) throw new Error("Cloud serve requires operator --config");
      const config = JSON.parse(readFileSync(path, "utf8"));
      const server = cloudService({ ...config, transport });
      const port = config.port ?? 4243;
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("Invalid server port");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(undefined));
      });
      const address = server.address();
      if (address && typeof address === "object")
        console.log(
          `ForgeKit ${relay ? "encrypted relay" : "cloud dashboard"} http://127.0.0.1:${address.port}/`,
        );
      return;
    }
    default:
      throw new Error(usage);
  }
  console.log(JSON.stringify(result, null, 2));
}
export const cloudHandlers = {
  cloud: (args) => runCloud(args, "cloud"),
  relay: (args) => runCloud(args, "relay"),
};
export default cloudHandlers;

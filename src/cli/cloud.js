import { readFileSync } from "node:fs";
import {
  cloudStatus,
  configureCloud,
  previewCloud,
  pushCloud,
  removeCloud,
} from "../cloud_client.js";
import { cloudService } from "../cloud_server.js";

const usage = [
  "forge cloud configure --full-workspace --url <origin> --workspace <id> --token-env <variable>",
  "forge cloud preview [--json] | push [--replace-remote --confirm] | watch [--interval <seconds>] | status [--remote]",
  "forge cloud logout | delete --confirm",
  "forge cloud serve --config <server.json>",
].join("\n");

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
export const cloudHandlers = {
  cloud: async (args) => {
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
        result = await configureCloud(root, {
          url: flag(args, "--url"),
          workspace: flag(args, "--workspace"),
          tokenEnv: flag(args, "--token-env"),
          fullWorkspace: true,
        });
        break;
      case "preview":
        result = previewCloud(root);
        break;
      case "status":
        result = await cloudStatus(root, args.includes("--remote"));
        break;
      case "push":
        result = await pushCloud(root, {
          replaceRemote: args.includes("--replace-remote"),
          confirmed: args.includes("--confirm"),
        });
        break;
      case "logout":
        result = await removeCloud(root);
        break;
      case "delete":
        result = await removeCloud(root, true, args.includes("--confirm"));
        break;
      case "watch": {
        const interval = Number(flag(args, "--interval") ?? 30);
        if (!Number.isFinite(interval) || interval < 1 || interval > 86400)
          throw new Error("Interval must be 1 to 86400 seconds");
        let delay = interval;
        while ((await cloudStatus(root)).enrolled) {
          try {
            console.log(JSON.stringify(await pushCloud(root)));
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
        const server = cloudService(config);
        const port = config.port ?? 4243;
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new Error("Invalid server port");
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => resolve(undefined));
        });
        const address = server.address();
        if (address && typeof address === "object")
          console.log(`ForgeKit cloud dashboard http://127.0.0.1:${address.port}/`);
        return;
      }
      default:
        throw new Error(usage);
    }
    console.log(JSON.stringify(result, null, 2));
  },
};
export default cloudHandlers;

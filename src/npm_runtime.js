import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { containsPath } from "./private_paths.js";

// Use npm's JS entry point directly. Windows npm.cmd needs a shell, and resolving
// npm relative to the project can select a checkout-owned package or launcher.
export function npmCliPath(root, override = process.env.FORGE_NPM_PATH) {
  if (override && !isAbsolute(override))
    throw new Error("FORGE_NPM_PATH requires an absolute npm-cli.js path");
  const dir = dirname(process.execPath);
  const candidate =
    override ||
    [
      join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      join(dir, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
    ].find((path) => existsSync(path));
  if (!candidate)
    throw Object.assign(
      new Error("Install npm alongside Node or set FORGE_NPM_PATH to the installed npm-cli.js"),
      { code: "ENOENT" },
    );
  const cli = realpathSync.native(candidate);
  if (containsPath(realpathSync.native(root), cli) || !statSync(cli).isFile())
    throw new Error("The npm CLI must be a file outside the workspace");
  const npmRoot = dirname(dirname(cli));
  const pkg = JSON.parse(readFileSync(join(npmRoot, "package.json"), "utf8"));
  if (pkg.name !== "npm" || pkg.bin?.npm !== "bin/npm-cli.js" || cli !== join(npmRoot, pkg.bin.npm))
    throw new Error("The selected file must identify the installed npm package's CLI");
  return cli;
}

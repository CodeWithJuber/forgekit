import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { containsPath } from "./private_paths.js";

function installedCli(candidate, workspace) {
  const cli = realpathSync.native(candidate);
  if (containsPath(workspace, cli) || !statSync(cli).isFile())
    throw new Error("The npm CLI must be a file outside the workspace");
  const npmRoot = dirname(dirname(cli));
  const pkg = JSON.parse(readFileSync(join(npmRoot, "package.json"), "utf8"));
  if (pkg.name !== "npm" || pkg.bin?.npm !== "bin/npm-cli.js" || cli !== join(npmRoot, pkg.bin.npm))
    throw new Error("The selected file must identify the installed npm package's CLI");
  return cli;
}

// Discover npm without running a shell wrapper. Independently installed npm can
// expose its real entry point to an npm child or via a system PATH symlink.
export function npmCliPath(
  root,
  override = process.env.FORGE_NPM_PATH,
  { execPath = process.execPath, env = process.env } = {},
) {
  const workspace = realpathSync.native(root);
  if (override) {
    if (!isAbsolute(override))
      throw new Error("FORGE_NPM_PATH requires an absolute npm-cli.js path");
    return installedCli(override, workspace);
  }
  const dir = dirname(execPath);
  const candidates = [
    env.npm_execpath,
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ];
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(entry) || containsPath(workspace, entry)) continue;
    candidates.push(join(entry, "npm"), join(entry, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const candidate of new Set(candidates)) {
    if (!candidate || !isAbsolute(candidate) || containsPath(workspace, candidate)) continue;
    try {
      return installedCli(candidate, workspace);
    } catch {}
  }
  throw Object.assign(
    new Error("Install npm on PATH or set FORGE_NPM_PATH to the installed npm-cli.js"),
    { code: "ENOENT" },
  );
}

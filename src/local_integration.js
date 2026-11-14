// The repository holds an integration ID/digest. The executable and all its
// arguments must be explicitly authorized in private state on this machine.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, sep } from "node:path";
import { validateServerName } from "./emit/mcp.js";
import { addIntegration } from "./integrations.js";
import {
  bindingDigest,
  forgetBinding,
  readPrivateBinding,
  savePrivateBinding,
  validBinding,
} from "./remote_endpoints.js";
import { readForgeConfig } from "./repo_config.js";
import { hasSecret } from "./secrets.js";

const ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
function pin(path, root, executable) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length > 2048 ||
    /[\p{Cc}\p{Cf}]/u.test(path)
  )
    throw new Error("Choose an absolute path to an installed program or argument file");
  const physical = realpathSync.native(path);
  const rel = relative(realpathSync.native(root), physical);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    throw new Error("The installed program and its argument files must be outside the checkout");
  if (executable) accessSync(physical, constants.X_OK);
  const fd = openSync(
    physical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 512 * 1024 * 1024)
      throw new Error("Choose a regular installed file under 512 MiB");
    const h = createHash("sha256"),
      buf = Buffer.allocUnsafe(65536);
    let bytes = 0;
    for (let n = readSync(fd, buf); n; n = readSync(fd, buf)) {
      bytes += n;
      if (bytes > before.size)
        throw new Error("Installed file changed while checking its identity");
      h.update(buf.subarray(0, n));
    }
    const after = statSync(physical);
    if (
      bytes !== before.size ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Installed file changed while checking its identity");
    return { path: physical, sha256: h.digest("hex") };
  } finally {
    closeSync(fd);
  }
}
function descriptor(root, binary, args, passEnv) {
  if (
    !Array.isArray(args) ||
    args.length > 16 ||
    !args.every(
      (x) =>
        typeof x === "string" && x.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(x) && !hasSecret(x),
    )
  )
    throw new Error("Use up to 16 non-secret arguments");
  if (
    !Array.isArray(passEnv) ||
    passEnv.length > 16 ||
    !passEnv.every(
      (n) =>
        typeof n === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,126}$/.test(n) &&
        !/^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|DYLD_|LD_|BASH_ENV|ENV$)/i.test(n),
    )
  )
    throw new Error("Use explicit credential environment names");
  const server = pin(binary, root, true);
  // An interpreter needs a separately pinned installed entry point; a checkout
  // cannot supply its own script, module or command via these portable references.
  const runtime = /^(?:node|python(?:[23](?:\.\d+)?)?|ruby|perl|php|deno|bun)(?:\.exe)?$/i.test(
    basename(server.path),
  );
  if (runtime && !isAbsolute(args[0] ?? ""))
    throw new Error(
      "For a runtime supply the absolute installed MCP entry-point script as the first --arg",
    );
  if (
    /^(?:sh|bash|zsh|fish|dash|cmd|powershell|pwsh|env|npx|npm|uvx|uv|pip|pipx|rundll32|wscript|cscript)(?:\.exe)?$/i.test(
      basename(server.path),
    )
  )
    throw new Error(
      "Use the installed MCP executable or interpreter with its absolute entry point",
    );
  const files = args.filter((a) => isAbsolute(a)).map((a) => pin(a, root, false));
  let i = 0;
  return {
    type: "stdio",
    server,
    args: args.map((a) => (isAbsolute(a) ? files[i++].path : a)),
    files,
    passEnv: [...new Set(passEnv)].sort(),
  };
}
export function connectLocal(root, id, binary, args = [], passEnv = [], adopt = false) {
  validateServerName(id);
  if (id in Object.prototype || id === "forge-cortex") throw new Error("Reserved integration ID");
  const value = descriptor(root, binary, args, passEnv);
  const before = readForgeConfig(root);
  const old = before.mcp?.local?.[id];
  if (old && old !== bindingDigest(value))
    throw new Error("Remove this local integration before changing the approved program");
  const digest = savePrivateBinding(root, id, value);
  const result = addIntegration(id, { targetRoot: root, localBinding: digest, adopt });
  if (!result.ok && !old) forgetBinding(root, id, digest);
  return result;
}
export async function serveLocal(root, id) {
  validateServerName(id);
  const cfg = readForgeConfig(root);
  const digest = cfg.mcp?.local?.[id];
  if (cfg.corrupt || !cfg.mcp?.integrations?.includes(id) || !validBinding(digest))
    throw new Error("Install this local integration in the workspace first");
  const value = readPrivateBinding(root, id, digest);
  if (value?.type !== "stdio")
    throw new Error("This user has not approved this local executable in this workspace");
  const check = descriptor(root, value.server.path, value.args, value.passEnv);
  if (bindingDigest(check) !== digest)
    throw new Error("Installed program or script changed; remove and bind the reviewed version");
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.create(null);
  for (const name of [...ENVIRONMENT, ...value.passEnv])
    if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  const child = spawn(check.server.path, check.args, {
    cwd: root,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const terminate = () => child.kill();
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("Failed to start the approved MCP executable")));
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
}

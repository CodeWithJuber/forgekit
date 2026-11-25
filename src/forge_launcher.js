// Portable argv for a trusted checkout or an explicitly installed project package.
// A global install uses its published bin. No paths from the machine emitting config are needed.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { BRAND } from "./brand.js";

export function projectForgeLauncher(root) {
  if (resolve(root) === resolve(BRAND.root)) return { command: "node", args: ["./src/cli.js"] };
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const name = "@codewithjuber/forgekit";
    if (
      [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(
        (deps) => deps && Object.hasOwn(deps, name),
      )
    )
      return { command: "node", args: [`./node_modules/${name}/src/cli.js`] };
  } catch {}
  return { command: BRAND.cli, args: [] };
}

/** Resolve a configured executable without running project-provided commands during doctor. */
export function executableAvailable(command, env = process.env) {
  if (typeof command !== "string" || !command) return false;
  const paths = isAbsolute(command)
    ? [command]
    : (env.PATH || env.Path || "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, command));
  return paths.some((path) => {
    const suffixes =
      process.platform === "win32"
        ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")]
        : [""];
    return suffixes.some((ext) => {
      try {
        accessSync(path + ext, constants.X_OK);
        return statSync(path + ext).isFile();
      } catch {
        return false;
      }
    });
  });
}

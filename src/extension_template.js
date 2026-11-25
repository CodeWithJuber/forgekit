import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BRAND } from "./brand.js";
import { httpDiscoveryVersions, stdioVersions } from "./mcp_protocol.js";
import { containsPath } from "./private_paths.js";

const source = join(BRAND.root, "templates", "integration-developer");
export function integrationTemplate(root, out) {
  const descriptor = JSON.parse(readFileSync(join(source, "catalog.json"), "utf8"));
  const report = {
    ...descriptor,
    protocols: { stdio: stdioVersions, httpDiscovery: httpDiscoveryVersions },
    source,
  };
  if (out === undefined) return report;
  const work = realpathSync.native(root),
    destination = resolve(work, out);
  if (
    !out ||
    isAbsolute(out) ||
    !relative(work, destination) ||
    !containsPath(work, destination) ||
    realpathSync.native(dirname(destination)) !== dirname(destination)
  )
    throw new Error(
      "Choose a new directory inside the workspace under an existing physical parent",
    );
  if (lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error("Template destination already exists");
  // mkdir atomically claims this name; copying individual files never overwrites user content.
  mkdirSync(destination, { mode: 0o700 });
  for (const name of readdirSync(source))
    cpSync(join(source, name), join(destination, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  return { ...report, destination };
}
export function templateCommand(args, root) {
  const { values } = parseArgs({
    args,
    options: { json: { type: "boolean" }, out: { type: "string" } },
  });
  const result = integrationTemplate(root, values.out);
  if (values.json) return console.log(JSON.stringify(result, null, 2));
  console.log(
    [
      result.destination ?? result.source,
      ...result.adapters.map((a) => `${a.id}  ${a.permissions}`),
    ].join("\n"),
  );
}

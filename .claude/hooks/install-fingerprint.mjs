// Identify the dependency inputs and the installed file inventory. A surviving .bin
// shim is insufficient when part of TypeScript or its platform binary was deleted.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const hash = createHash("sha256");
function record(value) {
  hash.update(JSON.stringify(value)).update("\n");
}
record([process.version, process.platform, process.arch, process.argv[2]]);
for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
  try {
    record([name, createHash("sha256").update(readFileSync(name)).digest("hex")]);
  } catch (error) {
    if (name !== ".npmrc" || error.code !== "ENOENT") throw error;
    record([name, null]);
  }
}
function inventory(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (path === join("node_modules", ".forge-install-fingerprint")) continue;
    const st = lstatSync(path);
    if (st.isDirectory()) inventory(path);
    else record([path, st.mode, st.isSymbolicLink() ? readlinkSync(path) : st.size]);
  }
}
inventory("node_modules");
console.log(hash.digest("hex"));

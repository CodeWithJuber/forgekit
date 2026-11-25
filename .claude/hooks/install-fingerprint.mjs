// Identify the dependency inputs and the installed file inventory. A surviving .bin
// shim is insufficient when part of TypeScript or its platform binary was deleted.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = createHash("sha256");
function record(value) {
  hash.update(JSON.stringify(value)).update("\n");
}
record([process.version, process.platform, process.arch, process.argv[3]]);
for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
  try {
    record([name, createHash("sha256").update(readFileSync(name)).digest("hex")]);
  } catch (error) {
    if (name !== ".npmrc" || error.code !== "ENOENT") throw error;
    record([name, null]);
  }
}
const inputs = hash.digest("hex");
const marker = join("node_modules", ".forge-install-fingerprint");
const files = new Map();
function inventory(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (path === marker) continue;
    const st = lstatSync(path);
    if (st.isDirectory()) inventory(path);
    else files.set(path, JSON.stringify([st.mode, st.isSymbolicLink() ? readlinkSync(path) : st.size]));
  }
}
inventory("node_modules");
if (process.argv[2] === "record") {
  writeFileSync(marker, JSON.stringify({ inputs, installed: [...files] }));
} else {
  let saved;
  try {
    saved = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    process.exit(1);
  }
  // Extra user caches may appear later. Only the inventory npm actually installed
  // determines whether any dependency was removed or truncated.
  const ready = saved?.inputs === inputs && Array.isArray(saved.installed) &&
    saved.installed.length > 0 && saved.installed.every((item) =>
      Array.isArray(item) && typeof item[1] === "string" && files.get(item[0]) === item[1]);
  process.exitCode = ready ? 0 : 1;
}

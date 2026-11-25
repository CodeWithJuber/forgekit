// Runs against the archive and launcher that a consumer would receive on this OS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "forge packed consumer "));
const consumer = join(temp, "project");
const env = {
  ...process.env,
  FORGE_HOME: join(temp, "state"),
  FORGE_NO_HINT: "1",
  FORGE_NO_CATALOG_FETCH: "1",
  FORGE_NO_UPDATE_CHECK: "1",
};
const run = (exe, args, cwd) => execFileSync(exe, args, { cwd, env, encoding: "utf8" }).trim();
try {
  mkdirSync(consumer);
  // npm's JS launcher works on Windows without invoking a shell with user data.
  const binDir = dirname(process.execPath);
  const npmPath = [
    process.env.npm_execpath,
    process.env.FORGE_NPM_PATH,
    join(binDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(binDir, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ].find((path) => path && existsSync(path));
  if (!npmPath) throw new Error("Install npm with Node or set FORGE_NPM_PATH");
  const npm = (args, cwd) => run(process.execPath, [npmPath, ...args], cwd);
  const [{ filename }] = JSON.parse(npm(["pack", "--json", "--pack-destination", temp], source));
  npm(
    [
      "install",
      "--prefix",
      consumer,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temp, filename),
    ],
    consumer,
  );
  const forge = (...args) => npm(["exec", "--offline", "--no", "--", "forge", ...args], consumer);
  assert.match(forge("--version"), /\d+\.\d+\.\d+/);
  for (const kind of ["agents", "skills", "hooks"])
    assert.ok(JSON.parse(forge(kind, "list", "--json")));
  assert.equal(
    JSON.parse(forge("agents", "run", "scout", "--task", "Read the setup notes", "--json")).mode,
    "handoff",
  );
  assert.equal(JSON.parse(forge("skills", "run", "forge-ledger", "--json")).ok, true);
  assert.equal(
    JSON.parse(forge("agents", "install", "scout", "--host", "claude", "--json")).status,
    "installed",
  );
  assert.equal(
    JSON.parse(forge("agents", "uninstall", "scout", "--host", "claude", "--json")).status,
    "removed",
  );
  forge("init", "--tools", "codex", "--no-settings");
  JSON.parse(forge("hooks", "status", "--json"));
  const doctor = JSON.parse(forge("doctor", "--json"));
  assert.ok(doctor);
  console.log("Packed CLI, registries, Codex setup and doctor passed on", process.platform);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

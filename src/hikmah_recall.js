// Use the kernel's existing hybrid retrieval and provenance. Only an explicit local
// binding can name a binary or ledger, never a project file or MCP argument.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const invoke = promisify(execFile);
const inside = (base, p) => {
  const r = relative(base, p);
  return !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`);
};
const file = (root) => privateWorkspaceFile(root, "hikmah-bindings");
const clean = (s, n) =>
  redactSecrets(String(s ?? ""))
    .replace(/[\p{Cf}\p{Cc}]/gu, " ")
    .slice(0, n);
function validate(root, binary, store) {
  if (![binary, store].every((v) => typeof v === "string" && isAbsolute(v)))
    throw new Error("Supply absolute --binary and --store paths");
  const program = realpathSync.native(binary),
    ledger = realpathSync.native(store);
  if (
    inside(realpathSync.native(sourceWorkspaceRoot(root)), program) ||
    !statSync(program).isFile()
  )
    throw new Error("Use a trusted installed Hikmah binary outside the worktree");
  if (!statSync(ledger).isFile()) throw new Error("Select a regular Hikmah ledger");
  accessSync(program, constants.X_OK);
  return { binary: program, store: ledger };
}
function current(root) {
  try {
    const path = file(root);
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 16384) throw new Error("Invalid Hikmah binding");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function bindHikmah(root, options) {
  const path = file(root);
  if (options === null) {
    rmSync(path, { force: true });
    return { enabled: false };
  }
  const cfg = validate(root, options.binary, options.store);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const temp = path + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(cfg), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return { enabled: true };
}
export function hikmahStatus(root) {
  return { enabled: !!current(root) };
}
export async function recallHikmah(root, query, { limit = 3 } = {}) {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10
  )
    throw new Error("Supply a query and a limit between 1 and 10");
  const cfg = current(root);
  if (!cfg) return { enabled: false, hits: [] };
  if (
    realpathSync.native(cfg.binary) !== cfg.binary ||
    realpathSync.native(cfg.store) !== cfg.store
  )
    throw new Error("The bound kernel or ledger path has changed");
  if (statSync(cfg.store).size > 64 * 1024 * 1024)
    throw new Error("Use a scoped Hikmah ledger under 64 MiB");
  let rows;
  try {
    // Only the read-only recall subcommand, using the selected binary's own policy defaults.
    const env = { ...process.env };
    delete env.HIKMAH_POLICY;
    const { stdout } = await invoke(
      cfg.binary,
      [
        "recall",
        "--store",
        cfg.store,
        "--query",
        redactSecrets(query.slice(0, 1200)),
        "--limit",
        "16",
      ],
      { cwd: dirname(cfg.binary), env, timeout: 1800, maxBuffer: 512 * 1024, windowsHide: true },
    );
    rows = JSON.parse(stdout);
  } catch {
    throw new Error("Hikmah recall could not read the configured ledger");
  }
  if (!Array.isArray(rows)) throw new Error("Unexpected Hikmah result");
  const hits = rows
    .filter(
      ({ trace: t, conflicts, superseded_by }) =>
        t?.provenance?.verified === true &&
        t.privacy === "public" &&
        !String(t.provenance.source).startsWith("model:") &&
        !superseded_by &&
        Array.isArray(conflicts) &&
        !conflicts.length,
    )
    .slice(0, limit)
    .map(({ trace: t }) => ({
      id: clean(t.id, 100),
      text: clean(t.content, 360),
      source: clean(t.provenance.source, 100),
      locator: clean(t.provenance.locator, 140),
    }));
  return { enabled: true, hits };
}

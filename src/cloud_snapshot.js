// Explicitly enrolled local workspace. Each snapshot is a view of regular files
// observed while walking the tree, rather than a point-in-time filesystem backup.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedHarnessProgram, installedHarnessPython } from "./harness_python.js";
import { containsPath, outsideWorkspace } from "./private_paths.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { userStateDir } from "./util.js";

export const MAX_FILE = 24 * 1024 * 1024;
export const MAX_TOTAL = 128 * 1024 * 1024;
export const MAX_FILES = 20000;
export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const workspaceId = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s);
export const validPath = (s) =>
  typeof s === "string" &&
  s.length <= 4096 &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: transmitted paths must exclude control bytes.
  !/[\\:\x00-\x1f\x7f]/u.test(s) &&
  s.split("/").every((p) => p && p !== "." && p !== "..");

const skipFolders = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".npm",
  ".cache",
  ".terraform",
  ".pki",
]);
const sqliteHeader = Buffer.from("SQLite format 3\0");
const journalHeader = Buffer.from("d9d505f920a163d7", "hex");
function isDatabaseHeader(prefix) {
  if (prefix.subarray(0, sqliteHeader.length).equals(sqliteHeader)) return true;
  if (prefix.subarray(0, journalHeader.length).equals(journalHeader)) return true;
  if (prefix.length < 4) return false;
  const magic = prefix.readUInt32BE(0);
  return magic === 0x377f0682 || magic === 0x377f0683;
}
function credentialPath(name) {
  return (
    /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.gitconfig|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?|auth\.json|keychain|signing\.key)$/i.test(
      name,
    ) || /\.(?:pem|p12|pfx|key|keystore|kdbx)$/i.test(name)
  );
}

export function cloudSnapshotPaths(root) {
  root = realpathSync.native(root);
  if (root === resolve(root, "..") || containsPath(root, realpathSync.native(homedir())))
    throw new Error("Select a project directory beneath the filesystem and home roots");
  const reason = "The cloud workspace and private ForgeKit state must be separate directories";
  const privateHome = outsideWorkspace(root, userStateDir(), reason);
  if (containsPath(privateHome, root)) throw new Error(reason);
  return { root, privateHome };
}

export function workspaceSnapshot(workspace, secrets = []) {
  const { root, privateHome } = cloudSnapshotPaths(workspace);
  const files = [];
  const skipped = {};
  let bytes = 0;
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  function walk(dir, prefix) {
    // Visit each database before any sidecars that share its name.
    const databaseNames = new Set();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      const rel = prefix + entry.name;
      if (
        !validPath(rel) ||
        secrets.some((s) => s && rel.includes(s)) ||
        hasSecret(entry.name, { entropy: false }) ||
        credentialPath(entry.name) ||
        skipFolders.has(entry.name.toLowerCase())
      ) {
        skip("private-or-generated");
        continue;
      }
      if (entry.isSymbolicLink()) {
        skip("link");
        continue;
      }
      if (realpathSync.native(path) !== path)
        throw new Error("Workspace changed while taking snapshot");
      if (entry.isDirectory()) {
        walk(path, `${rel}/`);
        continue;
      }
      if (!entry.isFile()) {
        skip("special-file");
        continue;
      }
      const sidecar = /^(.*)-(?:wal|shm|journal)$/i.exec(entry.name);
      if (
        /\.(?:sqlite3?|db3?|s3db)(?:-wal|-shm|-journal)?$/i.test(entry.name) ||
        (sidecar && databaseNames.has(sidecar[1]))
      ) {
        skip("database-requires-logical-export");
        continue;
      }
      const before = lstatSync(path);
      if (before.nlink > 1) {
        skip("hard-link");
        continue;
      }
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      );
      let data;
      try {
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.ino !== before.ino ||
          opened.dev !== before.dev ||
          opened.size !== before.size ||
          realpathSync.native(path) !== path
        )
          throw new Error("Workspace changed during read");
        const header = Buffer.alloc(sqliteHeader.length);
        const headerBytes = readSync(fd, header, 0, header.length, 0);
        if (isDatabaseHeader(header.subarray(0, headerBytes))) {
          databaseNames.add(entry.name);
          skip("database-requires-logical-export");
          continue;
        }
        if (opened.size > MAX_FILE)
          throw new Error(`File exceeds the 24 MiB snapshot limit: ${rel}`);
        data = Buffer.allocUnsafe(opened.size);
        let bytesRead = 0;
        while (bytesRead < data.length) {
          const n = readSync(fd, data, bytesRead, data.length - bytesRead, bytesRead);
          if (!n) break;
          bytesRead += n;
        }
        const after = fstatSync(fd);
        if (
          bytesRead !== opened.size ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        )
          throw new Error("Retry snapshot after concurrent file change");
      } finally {
        closeSync(fd);
      }
      addFile(rel, data);
    }
  }
  function addFile(rel, data) {
    const raw = data.toString("utf8");
    let kind = "binary",
      redacted = false;
    if (!raw.includes("\0") && Buffer.from(raw).equals(data)) {
      kind = "text";
      let safe = redactSecrets(raw);
      for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
      redacted = raw !== safe;
      data = Buffer.from(safe);
    } else if (
      secrets.some((s) => s && data.includes(Buffer.from(s))) ||
      hasSecret(data.toString("latin1"), { entropy: false })
    ) {
      skip("sensitive-binary");
      return;
    }
    bytes += data.length;
    if (bytes > MAX_TOTAL || files.length >= MAX_FILES)
      throw new Error("Workspace exceeds snapshot capacity");
    files.push({
      path: rel,
      sha256: sha(data),
      content: data.toString("base64"),
      bytes: data.length,
      kind,
      redacted,
    });
  }
  const reserved = ".forge-cloud-export/";
  if (existsSync(join(root, ".forge-cloud-export")))
    throw new Error("Reserved namespace .forge-cloud-export already exists");
  walk(root, "");
  const repoKey = sha(root);
  for (const [dir, name] of [
    [join(privateHome, "workspace-memory", repoKey), "workspace-memory"],
    [join(privateHome, "harness-runs", repoKey), "harness-runs"],
    [join(privateHome, "skill-scripts", `${repoKey}.json.d`), "skill-scripts"],
  ]) {
    if (!existsSync(dir)) continue;
    if (realpathSync.native(dir) !== dir || !lstatSync(dir).isDirectory())
      throw new Error("Unsafe workspace runtime directory");
    walk(dir, `${reserved + name}/`);
  }
  const stores = [
    {
      name: "memory",
      db: join(privateHome, "harness-memory", "memory.sqlite"),
      scope: `repo-${repoKey}`,
    },
    { name: "jobs", db: join(privateHome, "harness-jobs", repoKey, "jobs.sqlite3"), scope: "" },
    {
      name: "audit",
      db: join(privateHome, "harness-native-audit", `${repoKey}.sqlite`),
      scope: "",
    },
  ];
  const spend = join(privateHome, "harness-spend", "spend.sqlite");
  if (existsSync(spend)) {
    const git = spawnSync(
      installedHarnessProgram(root, "git"),
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: 4000,
        env: {
          PATH: process.env.PATH,
          HOME: homedir(),
          LC_ALL: "C",
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
    );
    const common = git.status === 0 ? realpathSync.native(git.stdout.trim()) : root;
    if (git.status !== 0 && !(git.status === 128 && git.stderr?.includes("not a git repository")))
      throw new Error("Cannot resolve workspace spending identity");
    stores.push({ name: "spending", db: spend, scope: sha(common) });
  }
  for (const { name, db: memory, scope } of stores) {
    if (!existsSync(memory)) continue;
    for (const f of [memory, `${memory}-wal`, `${memory}-shm`, `${memory}-journal`]) {
      const st = lstatSync(f, { throwIfNoEntry: false });
      if (st && (!st.isFile() || st.nlink !== 1 || realpathSync.native(f) !== f))
        throw new Error("Unsafe private harness memory file");
    }
    const worker = fileURLToPath(new URL("./cloud_export.py", import.meta.url));
    const result = spawnSync(installedHarnessPython(root), ["-I", worker, memory, scope, name], {
      encoding: "buffer",
      timeout: 20000,
      maxBuffer: MAX_FILE + 1,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length > MAX_FILE)
      throw new Error(`Workspace harness ${name} export incomplete`);
    addFile(`${reserved}harness-${name}.json`, result.stdout);
  }
  return { files, bytes, skipped };
}

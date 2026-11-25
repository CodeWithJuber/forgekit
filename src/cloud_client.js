// Enrollment, pending bytes and the acknowledged cursor belong to the local user.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cloudSnapshotPaths, sha, workspaceId, workspaceSnapshot } from "./cloud_snapshot.js";
import { outsideWorkspace } from "./private_paths.js";
import { userStateDir } from "./util.js";

function directory(root) {
  const home = outsideWorkspace(
    root,
    join(userStateDir(), "cloud"),
    "Cloud enrollment requires private state outside the workspace",
  );
  const dir = join(home, sha(realpathSync.native(root)));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = lstatSync(dir);
  if (
    realpathSync.native(dir) !== dir ||
    !s.isDirectory() ||
    (process.platform !== "win32" && (s.mode & 0o077 || s.uid !== process.getuid()))
  )
    throw new Error("Private cloud state is unsafe");
  return dir;
}
function get(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Invalid local cloud state");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function save(path, value) {
  const tmp = `${path}.${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
async function locked(dir, fn) {
  const path = join(dir, "lock"),
    temp = `${path}.${randomUUID()}`;
  writeFileSync(temp, String(process.pid), { mode: 0o600, flag: "wx" });
  try {
    try {
      linkSync(temp, path);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Serialize stale-owner recovery. Re-read the owner inside the recovery section.
      const gate = `${path}.recovery`;
      try {
        mkdirSync(gate, { mode: 0o700 });
      } catch {
        throw new Error("Cloud operation in progress");
      }
      try {
        if (existsSync(path)) {
          const pid = Number(readFileSync(path, "utf8"));
          if (!Number.isSafeInteger(pid) || pid < 1)
            throw new Error("Invalid cloud operation lock");
          try {
            process.kill(pid, 0);
            throw new Error("Cloud operation in progress");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          rmSync(path);
        }
        linkSync(temp, path);
      } finally {
        rmSync(gate, { recursive: true });
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
export function endpoint(value) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw new Error("Use a private HTTPS endpoint origin or loopback HTTP origin");
  return u.origin;
}
function publicConfig(config) {
  return {
    endpoint: config.endpoint,
    workspace: config.workspace,
    tokenEnv: config.tokenEnv,
    scope: "full-workspace",
  };
}
export async function configureCloud(root, { url, workspace, tokenEnv, fullWorkspace }) {
  if (!fullWorkspace)
    throw new Error(
      "Full workspace content includes source, prompts, memory and recorded artifacts. Configure with --full-workspace to enroll.",
    );
  if (
    !workspaceId(workspace) ||
    typeof tokenEnv !== "string" ||
    !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)
  )
    throw new Error("Provide a workspace ID and credential environment-variable name");
  cloudSnapshotPaths(root);
  const dir = directory(root);
  return locked(dir, () => {
    const path = join(dir, "config.json");
    if (existsSync(path))
      throw new Error("Workspace already enrolled. Use logout before changing enrollment.");
    const config = { endpoint: endpoint(url), workspace, tokenEnv };
    save(path, config);
    return publicConfig(config);
  });
}
function configured(dir) {
  const config = get(join(dir, "config.json"));
  if (!config) throw new Error("Workspace has no cloud enrollment");
  return config;
}
function authorization(config) {
  const token = process.env[config.tokenEnv];
  if (!token || token.length < 32)
    throw new Error("A scoped cloud credential of at least 32 characters is required");
  return token;
}
async function request(config, method, sub = "", body = undefined) {
  const r = await fetch(`${config.endpoint}/v1/workspaces/${config.workspace}${sub}`, {
    method,
    headers: {
      Authorization: `Bearer ${authorization(config)}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw Object.assign(
      new Error(
        "Cloud request failed (HTTP " +
          r.status +
          ")" +
          (r.status === 409
            ? ". Remote revision changed. Compare this checkout with the remote manifest."
            : ""),
      ),
      { status: r.status },
    );
  }
  return r.json();
}
export function previewCloud(root) {
  const dir = directory(root),
    config = get(join(dir, "config.json"));
  const token = config ? process.env[config.tokenEnv] : undefined;
  const snapshot = workspaceSnapshot(root, token ? [token] : []);
  return {
    bytes: snapshot.bytes,
    skipped: snapshot.skipped,
    files: snapshot.files.map(({ content, ...meta }) => meta),
  };
}
export async function cloudStatus(root, remote = false) {
  const dir = directory(root),
    config = get(join(dir, "config.json"));
  if (!config) return { enrolled: false };
  const state = get(join(dir, "cursor.json"));
  return {
    enrolled: true,
    ...publicConfig(config),
    revision: state?.revision ?? null,
    pending: existsSync(join(dir, "pending.json")),
    ...(remote ? { remote: await request(config, "GET") } : {}),
  };
}
export async function pushCloud(root, { replaceRemote = false, confirmed = false } = {}) {
  if (replaceRemote && !confirmed)
    throw new Error("Replacing the remote baseline requires --confirm");
  cloudSnapshotPaths(root);
  const dir = directory(root);
  return locked(dir, async () => {
    const config = configured(dir),
      token = authorization(config);
    const queued = join(dir, "pending.json"),
      cursor = join(dir, "cursor.json");
    if (replaceRemote) {
      const remote = await request(config, "GET");
      const files = Object.fromEntries(
        remote.files.map((f) => [f.path, `${f.sha256}:${f.kind}:${f.redacted}`]),
      );
      save(cursor, { revision: remote.revision, files });
      rmSync(queued, { force: true });
    }
    let change = get(queued);
    const prior = get(cursor) ?? { revision: null, files: {} };
    let skipped = {};
    if (!change) {
      const snapshot = workspaceSnapshot(root, [token]);
      skipped = snapshot.skipped;
      const old = new Map(Object.entries(prior.files));
      const files = [];
      for (const file of snapshot.files) {
        const fingerprint = `${file.sha256}:${file.kind}:${file.redacted}`;
        if (old.get(file.path) !== fingerprint) files.push(file);
        old.delete(file.path);
      }
      const removed = [...old.keys()];
      if (prior.revision && files.length === 0 && removed.length === 0)
        return { revision: prior.revision, modified: 0, removed: 0, skipped };
      change = { id: randomUUID(), parent: prior.revision, files, removed };
      save(queued, change);
    }
    const answer = await request(config, "POST", "/sync", change);
    if (answer.revision !== change.id)
      throw new Error("Invalid acknowledgement; snapshot is pending");
    const next = new Map(Object.entries(prior.files));
    for (const f of change.files) next.set(f.path, `${f.sha256}:${f.kind}:${f.redacted}`);
    for (const path of change.removed) next.delete(path);
    save(cursor, { revision: answer.revision, files: Object.fromEntries(next) });
    rmSync(queued);
    return {
      revision: answer.revision,
      modified: change.files.length,
      removed: change.removed.length,
      skipped,
    };
  });
}
export async function removeCloud(root, remote = false, confirmed = false) {
  if (remote && !confirmed)
    throw new Error("Cloud delete requires --confirm and an admin credential");
  const dir = directory(root);
  return locked(dir, async () => {
    if (remote) await request(configured(dir), "DELETE");
    for (const name of ["config.json", "pending.json", "cursor.json"])
      rmSync(join(dir, name), { force: true });
    return { enrolled: false, remoteDeleted: remote };
  });
}

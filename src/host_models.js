// Last model explicitly reported by an enabled host at session start, scoped to one
// checkout. A missing report does not imply that any particular model is configured.
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOSTS } from "./hosts.js";
import { SAFE_MODEL_ID } from "./model_catalog.js";
import { privateMemoryDir } from "./private_memory.js";
import { hasSecret } from "./secrets.js";

const validId = (id) =>
  typeof id === "string" &&
  SAFE_MODEL_ID.test(id) &&
  !/^(auto|default|unknown|unspecified|none)$/i.test(id) &&
  !hasSecret(id);
const snapshotNames = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d{13}-[a-f0-9-]{36}\.json$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();

export function recordHostModel(host, event, payload, { now = Date.now() } = {}) {
  try {
    if (
      !Object.hasOwn(HOSTS, host) ||
      HOSTS[host].events[event]?.as !== "SessionStart" ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return false;
    const declaredEvent = payload.hook_event_name ?? payload.hookEventName;
    if (declaredEvent !== undefined && declaredEvent !== event && declaredEvent !== "SessionStart")
      return false;
    const root = payload.cwd ?? payload.workspace_roots?.[0];
    const session =
      payload.session_id ?? payload.sessionId ?? payload.conversation_id ?? payload.trajectory_id;
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      typeof session !== "string" ||
      !session.trim()
    )
      return false;
    const ids = [
      ...new Set([payload.model_id, payload.modelId, payload.model].filter((v) => v !== undefined)),
    ];
    if (ids.length !== 1 || !validId(ids[0])) return false;
    const observedAt = new Date(now).toISOString();
    const dir = join(privateMemoryDir(root, "host-models"), host);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${String(now).padStart(13, "0")}-${randomUUID()}.json`,
      path = join(dir, name);
    const temp = `${path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ id: ids[0], observedAt, source: "session-start" }), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    // Two overlapping starts cannot delete a later report. Older snapshots are disposable.
    for (const old of snapshotNames(dir).slice(1)) rmSync(join(dir, old), { force: true });
    return true;
  } catch {
    return false;
  }
}
export function readHostModelReports(root) {
  const reports = {};
  let base;
  try {
    base = privateMemoryDir(root, "host-models");
  } catch {
    return reports;
  }
  for (const host of Object.keys(HOSTS)) {
    try {
      const dir = join(base, host),
        [name] = snapshotNames(dir);
      if (!name) continue;
      const path = join(dir, name);
      if (statSync(path).size > 1024) continue;
      const { id, observedAt, source } = JSON.parse(readFileSync(path, "utf8"));
      if (
        validId(id) &&
        source === "session-start" &&
        new Date(Number(name.slice(0, 13))).toISOString() === observedAt
      )
        reports[host] = { id, observedAt, source };
    } catch {}
  }
  return reports;
}

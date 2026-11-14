// Atomic run checkpoints. Mark an operation in flight before crossing an effect
// boundary. A process crash leaves an inspectable record; recovery never guesses
// whether a provider, tool or verifier already performed an external operation.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedHarnessPython } from "./harness_python.js";
import { canonicalize } from "./ledger.js";
import { redactSecrets } from "./secrets.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

export function harnessDigest(value) {
  return createHash("sha256")
    .update(canonicalize(value, (s) => s))
    .digest("hex");
}

function runDir(root, id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(id))
    throw new Error("Invalid harness run ID");
  return join(privateWorkspaceFile(root, "harness-runs").replace(/\.json$/, ""), harnessDigest(id));
}

function readState(dir) {
  const file = join(dir, "record.json");
  const st = lstatSync(file);
  if (
    !st.isFile() ||
    st.nlink !== 1 ||
    realpathSync.native(dir) !== dir ||
    st.size > 64 * 1024 * 1024
  )
    throw new Error("Unsafe harness record");
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.version !== 1 || !Array.isArray(record.events))
    throw new Error("Invalid harness run record");
  if (harnessDigest(record.id) !== dir.split(/[\\/]/).at(-1))
    throw new Error("Mismatched harness run ID");
  replay(record);
  return record;
}

function publicRecord(record, dir) {
  const {
    id,
    status,
    reason,
    usage,
    budget,
    evidence,
    answer,
    approval,
    request,
    events,
    updatedAt,
    certainty,
    prunedAt,
  } = record;
  return {
    id,
    status,
    reason,
    usage,
    budget,
    evidence,
    answer,
    approval,
    request,
    events,
    updatedAt,
    certainty,
    prunedAt,
    tracePath: join(dir, "record.json"),
  };
}

export function readHarnessRun(root, id) {
  const dir = runDir(root, id);
  return publicRecord(readState(dir), dir);
}

/** A passed audit requires an actual execution result for each named tool.
 * Report denied and interrupted attempts separately from commands that ran. */
export function auditHarnessRun(root, id, tools = undefined) {
  const { events } = replayHarnessRun(root, id);
  const executed = new Set(
    events.filter((e) => ["tool.executed", "tool.failed"].includes(e.type)).map((e) => e.data.tool),
  );
  const registry = events.filter((e) => e.type === "tools.registered").flatMap((e) => e.data.names);
  if (!tools && !events.some((e) => e.type === "tools.registered"))
    return {
      id,
      ok: false,
      executed: [...executed],
      missing: [],
      reason: "No tool registry snapshot",
    };
  const audited = tools ?? [...new Set(registry)];
  const gaps = audited
    .map((t) => (typeof t === "string" ? t : t.name))
    .filter((name) => !executed.has(name));
  return { id, ok: gaps.length === 0, executed: [...executed], missing: gaps };
}

// Each lease generation is immutable. Hard-link publication arbitrates concurrent
// claimants, including two processes that both proved the previous owner died.
// No check-then-unlink can accidentally remove a newer writer's lease.
function claimLease(dir) {
  const host = hostname();
  const ownerPath = (n) => join(dir, `writer-${n}.json`);
  const latest = readdirSync(dir).reduce((max, file) => {
    const m = /^writer-([1-9][0-9]{0,9})\.json$/.exec(file);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  let recovered = false;
  if (latest) {
    const owner = JSON.parse(readFileSync(ownerPath(latest), "utf8"));
    const released = join(dir, `released-${latest}.json`);
    if (existsSync(released)) {
      if (JSON.parse(readFileSync(released, "utf8")).token !== owner.token)
        throw new Error("Invalid harness lease release");
    } else {
      if (owner.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
        throw new Error("Harness run has an active or unverifiable writer");
      try {
        process.kill(owner.pid, 0);
        throw new Error("Harness run already has a writer");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      recovered = true;
    }
  }
  const n = latest + 1,
    token = randomUUID();
  function publish(path, data) {
    const temp = join(dir, `${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } finally {
      unlinkSync(temp);
    }
  }
  try {
    publish(ownerPath(n), { host, pid: process.pid, token });
  } catch (e) {
    if (e.code === "EEXIST") throw new Error("Harness run already has a writer");
    throw e;
  }
  return { recovered, release: () => publish(join(dir, `released-${n}.json`), { token }) };
}

/** A running checkpoint without an in-flight action is a safe continuation.
 * An interrupted tool/provider/verifier is terminal until its effect is
 * reconciled externally. Never replay an unknown action. */
export function recoverHarnessRun(root, id) {
  const record = openHarnessRun(root, id);
  try {
    const s = record.state;
    if (!s)
      throw new Error(
        "No persisted harness checkpoint; submit the original request using the same ID",
      );
    if (s.status !== "running") return record.view(s);
    if (s.inFlight) {
      if (s.inFlight.kind === "provider") {
        s.usage.tokens += s.inFlight.maxTokens;
        s.usage.costUsd += s.inFlight.maxCostUsd;
      }
      s.status = "interrupted";
      s.reason = `Outcome unknown at ${s.inFlight.kind} boundary; reconcile before starting further work`;
    } else {
      s.status = "recovered";
      s.reason = "Last persisted checkpoint has no in-flight action";
    }
    appendHarnessEvent(s, "reflect", `run.${s.status}`, { reason: s.reason });
    record.save(s);
    return record.view(s);
  } finally {
    record.release();
  }
}

export function openHarnessRun(root, id = randomUUID()) {
  const dir = runDir(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync.native(dir) !== dir) throw new Error("Unsafe harness run directory");
  const file = join(dir, "record.json");
  const lease = claimLease(dir);
  try {
    const state = existsSync(file) ? readState(dir) : null;
    function save(s) {
      s.updatedAt = new Date().toISOString();
      const temp = join(dir, `${randomUUID()}.tmp`);
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(s));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temp, file);
      } catch (e) {
        unlinkSync(temp);
        throw e;
      }
    }
    return {
      id,
      state,
      save,
      view: (s) => publicRecord(s, dir),
      release: lease.release,
      recovered: lease.recovered,
    };
  } catch (e) {
    lease.release();
    throw e;
  }
}

/** Redact actual text before retaining or sending tool evidence onward. */
export function evidenceText(value, limit = 20000) {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const data = Buffer.from(redactSecrets(raw), "utf8");
  if (data.length <= limit) return data.toString();
  const keep = Math.floor((limit - 64) / 2);
  return (
    data.subarray(0, keep).toString() +
    "\n[truncated; " +
    data.length +
    " bytes]\n" +
    data.subarray(-keep).toString()
  );
}

/** Seal events in order. An independent durable head detects truncation and disclosure-safe
 * pruning leaves the original content digests available. This detects accidental corruption;
 * an actor with unrestricted access to the private directory can regenerate the chain. */
const retainedKeys = new Set([
  "tool",
  "names",
  "durationMs",
  "level",
  "count",
  "status",
  "turn",
  "argsDigest",
  "resultDigest",
  "route",
  "tokens",
  "costUsd",
]);
function retainedData(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => retainedKeys.has(key)));
}
export function appendHarnessEvent(state, phase, type, data = {}) {
  const prior = state.events.at(-1)?.digest ?? null;
  const payloadDigest = harnessDigest(data);
  const retainedDigest = harnessDigest(retainedData(data));
  const n = state.events.length + 1,
    at = new Date().toISOString();
  const digest = harnessDigest([
    state.id,
    n,
    at,
    phase,
    type,
    payloadDigest,
    retainedDigest,
    prior,
  ]);
  state.events.push({ n, at, phase, type, data, payloadDigest, retainedDigest, digest });
  state.eventHead = digest;
  return n;
}

function replay(state) {
  let prior = null;
  for (const [index, event] of state.events.entries()) {
    const { n, at, phase, type, payloadDigest, retainedDigest, digest } = event;
    if (
      n !== index + 1 ||
      retainedDigest !== harnessDigest(retainedData(event.data)) ||
      (!state.prunedAt && harnessDigest(event.data) !== payloadDigest) ||
      digest !== harnessDigest([state.id, n, at, phase, type, payloadDigest, retainedDigest, prior])
    )
      throw new Error(`Invalid harness event chain at event ${index + 1}`);
    prior = digest;
  }
  if (prior !== (state.eventHead ?? null)) throw new Error("Incomplete harness event chain");
  return {
    id: state.id,
    status: state.status,
    verifiedChain: true,
    digest: prior,
    events: state.events,
    prunedAt: state.prunedAt ?? null,
  };
}
export function replayHarnessRun(root, id) {
  return replay(readState(runDir(root, id)));
}
function records(root) {
  const parent = dirname(runDir(root, "index"));
  if (!existsSync(parent)) return [];
  if (realpathSync.native(parent) !== parent) throw new Error("Unsafe harness records directory");
  return readdirSync(parent, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        /^[a-f0-9]{64}$/.test(e.name) &&
        existsSync(join(parent, e.name, "record.json")),
    )
    .map((e) => readState(join(parent, e.name)));
}
export function harnessRunStats(root) {
  const statuses = {},
    gateCounts = {},
    repairCounts = {},
    profiles = Object.create(null);
  let costUsd = 0,
    verified = 0;
  const runs = records(root);
  for (const s of runs) {
    replay(s);
    const profile = s.request?.profile ?? "coder";
    const group = (profiles[profile] ??= {
      runs: 0,
      verified: 0,
      costUsd: 0,
      costPerVerifiedUsd: null,
    });
    group.runs++;
    group.costUsd += s.usage.costUsd;
    costUsd += s.usage.costUsd;
    if (s.status === "done") {
      group.verified++;
      verified++;
    }
    group.costPerVerifiedUsd = group.verified ? group.costUsd / group.verified : null;
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    for (const e of s.events) {
      if (e.type.startsWith("gate.")) gateCounts[e.type] = (gateCounts[e.type] ?? 0) + 1;
      if (e.type === "repair.planned") {
        const level = e.data?.level ?? "unknown";
        repairCounts[level] = (repairCounts[level] ?? 0) + 1;
      }
    }
  }
  return {
    runs: runs.length,
    verified,
    costUsd,
    costPerVerifiedUsd: verified ? costUsd / verified : null,
    statuses,
    profiles,
    gateCounts,
    nativeDenials: readHarnessNativeAudit(root).denied,
    repairCounts,
  };
}

/** Terminal payloads age out after thirty days. Active, paused and ambiguous runs
 * retain the original evidence needed to continue or reconcile their effects. */
export function pruneHarnessRuns(root, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error("Invalid retention clock");
  let pruned = 0,
    kept = 0;
  for (const row of records(root)) {
    if (
      row.prunedAt ||
      now - Date.parse(row.updatedAt) < 30 * 86400000 ||
      [
        "running",
        "recovered",
        "approval_pending",
        "interrupted",
        "budget_exhausted",
        "killed",
      ].includes(row.status)
    ) {
      kept++;
      continue;
    }
    const record = openHarnessRun(root, row.id);
    try {
      const s = record.state;
      if (s.prunedAt || s.updatedAt !== row.updatedAt) {
        kept++;
        continue;
      }
      replay(s);
      for (const e of s.events) e.data = retainedData(e.data);
      s.request = {
        profile: s.request.profile,
        channel: s.request.channel,
        priority: s.request.priority,
        taskDigest: harnessDigest(s.request.task),
      };
      const output = s.evidence?.output;
      s.evidence = s.evidence ? { ok: s.evidence.ok, digest: harnessDigest(output) } : null;
      s.prunedAt = new Date(now).toISOString();
      s.answer = null;
      s.reason = s.status;
      s.history = [];
      s.pending = [];
      s.approval = null;
      s.lastVerified = "";
      s.lastReceipt = null;
      s.inFlight = null;
      s.changes = {};
      record.save(s);
      pruned++;
    } finally {
      record.release();
    }
  }
  return { pruned, kept };
}

// Record only metadata that identifies a host-denied tool. Names received from
// host payloads are untrusted; all variable strings are hashed before storage.
// The rolling 512-event detail and lifetime per-host counters commit together.
const auditScript = fileURLToPath(new URL("./harness_native_audit.py", import.meta.url));
const nativeHosts = new Set(["claude", "kimi", "codex", "gemini", "copilot", "cursor", "devin"]);
function nativeAudit(root, request) {
  const file = privateWorkspaceFile(root, "harness-native-audit").replace(/\.json$/, ".sqlite");
  if (request.op === "read" && !existsSync(file)) return { denied: 0, byHost: {}, events: [] };
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (
    realpathSync.native(dir) !== dir ||
    !directory.isDirectory() ||
    (process.platform !== "win32" && directory.mode & 0o077)
  )
    throw new Error("Unsafe native audit directory");
  for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    const st = lstatSync(name, { throwIfNoEntry: false });
    if (st && (!st.isFile() || st.nlink !== 1)) throw new Error("Unsafe native audit database");
  }
  const result = spawnSync(installedHarnessPython(root), ["-I", "-B", auditScript, file], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 2500,
    maxBuffer: 512 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error("Native denial audit could not persist its record");
  return JSON.parse(result.stdout);
}
export function recordHarnessNativeEvent(root, { host, event, tool, reason, decision = "denied" }) {
  if (decision !== "denied")
    throw new Error("Only host-denied actions belong in native denial history");
  const identity = (v) => harnessDigest(typeof v === "string" ? v.slice(0, 4096) : null);
  return nativeAudit(root, {
    op: "record",
    host: nativeHosts.has(host) ? host : "other",
    event: identity(event),
    tool: identity(tool),
    reason: identity(reason),
  });
}
export function readHarnessNativeAudit(root) {
  return nativeAudit(root, { op: "read" });
}

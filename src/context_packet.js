// Immutable revision manifests contain only SHA-256 values. Source text travels to the client.
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tokensOf } from "./context.js";
import { canonicalize } from "./ledger.js";
import { contentHash } from "./util.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const digest = (value) => contentHash(canonicalize(value, (s) => s));
const fingerprint = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const manifestLimit = 1024 * 1024;
const retainedRevisions = 32;
function manifest(scope, context, order) {
  return { version: 1, scope, contextHash: digest(context), order };
}
function readManifest(dir, ack, scope) {
  if (!fingerprint(ack)) return null;
  try {
    const path = join(dir, ack);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > manifestLimit) return null;
    const prior = JSON.parse(readFileSync(path, "utf8"));
    return prior.version === 1 &&
      prior.scope === scope &&
      fingerprint(prior.contextHash) &&
      Array.isArray(prior.order) &&
      prior.order.every(fingerprint) &&
      digest(prior) === ack
      ? prior
      : null;
  } catch {
    return null;
  }
}
function remember(dir, revision, m) {
  const data = JSON.stringify(m);
  if (Buffer.byteLength(data) > manifestLimit) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
    renameSync(tmp, join(dir, revision));
  } finally {
    rmSync(tmp, { force: true });
  }
  const files = readdirSync(dir).filter((f) => fingerprint(f) && f !== revision);
  if (files.length >= retainedRevisions) {
    const latest = files
      .map((name) => {
        try {
          return { name, time: lstatSync(join(dir, name)).mtimeMs };
        } catch {
          return { name, time: 0 };
        }
      })
      .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    for (const { name } of latest.slice(retainedRevisions - 1))
      rmSync(join(dir, name), { force: true });
  }
  return true;
}

/** Assemble with includeSegments:true. Acknowledgements are meaningful only for a retaining client. */
export function createContextPacket(root, task, result, ack = undefined) {
  const { block, segments, ...context } = result;
  if (
    !Array.isArray(segments) ||
    !segments.every((s) => typeof s === "string") ||
    segments.join("\n\n") !== block
  )
    throw new Error("Missing context segments");
  if (
    !Number.isSafeInteger(context.budget) ||
    context.budget < 0 ||
    tokensOf(block) !== context.tokens ||
    context.tokens > context.budget
  )
    throw new Error("Context exceeds its declared budget or token count");
  const scope = digest([realpathSync.native(root), task]);
  const order = segments.map(contentHash);
  const chunks = Object.fromEntries(order.map((id, i) => [id, segments[i]]));
  const m = manifest(scope, context, order);
  const revision = digest(m);
  let prior,
    stored = false;
  try {
    const dir = privateWorkspaceFile(root, "context-packets-v1").replace(/\.json$/, "");
    prior = readManifest(dir, ack, scope);
    stored = remember(dir, revision, m);
  } catch {
    /* A private cache failure must still deliver the complete packet. */
  }
  const current = {
    version: 1,
    mode: "full",
    scope,
    revision,
    observedAt: new Date().toISOString(),
    context,
    order,
    chunks,
  };
  if (stored && prior) {
    const known = new Set(prior.order);
    const removed = [...known].filter((id) => !Object.hasOwn(chunks, id));
    const delta = {
      ...current,
      mode: "delta",
      base: ack,
      removed,
      chunks: Object.fromEntries(Object.entries(chunks).filter(([id]) => !known.has(id))),
    };
    if (Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(current)))
      return delta;
    return { ...current, reason: "full-is-smaller" };
  }
  return {
    ...current,
    ...(stored
      ? ack !== undefined
        ? { reason: "base-unavailable-or-mismatched" }
        : {}
      : { reason: "private-cache-unavailable" }),
  };
}

/** Consumer API: verify the exact base and every retained or delivered chunk before acknowledging. */
export function applyContextPacket(packet, retained = undefined) {
  const { scope, version, mode, revision, context, order, chunks } = packet;
  if (
    version !== 1 ||
    !["full", "delta"].includes(mode) ||
    !fingerprint(scope) ||
    !fingerprint(revision) ||
    !Array.isArray(order) ||
    !order.every(fingerprint) ||
    !chunks ||
    typeof chunks !== "object" ||
    Array.isArray(chunks) ||
    !context ||
    !Number.isSafeInteger(context.budget) ||
    context.budget < 0 ||
    digest(manifest(scope, context, order)) !== revision
  )
    throw new Error("Invalid context packet manifest");
  let available = new Map();
  if (mode === "delta") {
    if (retained?.mode !== "full" || retained.scope !== scope || retained.revision !== packet.base)
      throw new Error("Missing acknowledged base; request a full packet");
    const base = applyContextPacket(retained);
    available = new Map(Object.entries(base.snapshot.chunks));
    const kept = new Set(order);
    const removed = [...available.keys()].filter((id) => !kept.has(id)).sort();
    if (
      digest(removed) !== digest(Array.isArray(packet.removed) ? [...packet.removed].sort() : null)
    )
      throw new Error("Invalid context packet removals");
  }
  const needed = new Set(order);
  for (const [id, text] of Object.entries(chunks)) {
    if (!needed.has(id) || typeof text !== "string" || contentHash(text) !== id)
      throw new Error("Invalid context chunk");
    available.set(id, text);
  }
  const parts = order.map((id) => {
    if (!available.has(id)) throw new Error("Missing context chunk; request a full packet");
    return available.get(id);
  });
  const block = parts.join("\n\n");
  if (tokensOf(block) !== context.tokens || context.tokens > context.budget)
    throw new Error("Reconstructed context exceeds its declared budget or token count");
  // A single validated snapshot suffices for the next acknowledgement, even after many deltas.
  const snapshot = {
    version,
    mode: "full",
    scope,
    revision,
    observedAt: packet.observedAt,
    context,
    order,
    chunks: Object.fromEntries(order.map((id, i) => [id, parts[i]])),
  };
  return { block, context, revision, snapshot };
}

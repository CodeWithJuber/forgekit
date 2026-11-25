// Protocol v1. The receiver stores opaque rows. Only installed clients handle workspace keys.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { MAX_FILE, MAX_FILES, MAX_TOTAL, sha, validPath } from "./cloud_snapshot.js";

export const RELAY_MANIFEST = "manifest";
export const RELAY_VERSION = 1;
const NONCE = 12;
const TAG = 16;
export const RELAY_OVERHEAD = 1 + NONCE + TAG;
const hash = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export const isRevision = (s) =>
  typeof s === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const encode = (parts) => Buffer.from(JSON.stringify(parts));
function invalid() {
  throw new Error("Encrypted relay data failed authentication or validation");
}

export function relayKeys(config, value = process.env[config.keyEnv]) {
  if (typeof value !== "string" || value.length !== 44)
    throw new Error("The relay key must be 32 random bytes encoded as standard base64");
  const master = Buffer.from(value, "base64");
  if (master.length !== 32 || master.toString("base64") !== value)
    throw new Error("The relay key must be 32 random bytes encoded as standard base64");
  const bearer = process.env[config.tokenEnv];
  if (
    [value, master.toString("hex"), master.toString("base64url")].some((secret) =>
      bearer?.includes(secret),
    )
  )
    throw new Error("Use independent credentials for relay access and encryption");
  const scope = ["forgekit-relay", RELAY_VERSION, config.tenant, config.workspace];
  const derive = (purpose) => Buffer.from(hkdfSync("sha256", master, encode(scope), purpose, 32));
  const binding = derive("local enrollment").toString("hex");
  if (config.keyBinding && binding !== config.keyBinding)
    throw new Error("The relay key changed since enrollment");
  return {
    scope,
    binding,
    encryption: derive("encryption"),
    names: derive("object names"),
    outbox: derive("local outbox authentication"),
  };
}

// Authenticate the entire private queue before a retry can send it to the receiver.
// This also covers optional or unknown fields added to a serialized request.
function outboxTag(keys, payload, version) {
  const mac = createHmac("sha256", keys.outbox);
  if (version === 2) mac.update("forgekit/outbox/v2\0");
  return mac.update(payload).digest();
}
export function queueRelayChange(keys, change) {
  const payload = JSON.stringify(change);
  return { version: 2, payload, tag: outboxTag(keys, payload, 2).toString("hex") };
}
export function pendingRelayChange(keys, stored) {
  // Existing v1 queues signed their change object in insertion order. New envelopes
  // retain the exact signed payload, independent of the outer JSON serializer.
  const legacy = stored && !Object.hasOwn(stored, "version") && stored.change;
  const payload = legacy ? JSON.stringify(stored.change) : stored?.payload;
  if (
    (!legacy && stored?.version !== 2) ||
    typeof payload !== "string" ||
    !hash(stored.tag) ||
    !timingSafeEqual(outboxTag(keys, payload, legacy ? 1 : 2), Buffer.from(stored.tag, "hex"))
  )
    throw new Error("The pending relay upload failed authentication");
  return JSON.parse(payload);
}

const objectId = (keys, path) => createHmac("sha256", keys.names).update(path).digest("hex");
function recordKey(keys, path, revision) {
  return hkdfSync("sha256", keys.encryption, Buffer.alloc(0), encode([path, revision]), 32);
}
function seal(keys, path, revision, bytes) {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", recordKey(keys, path, revision), nonce, {
    authTagLength: TAG,
  });
  cipher.setAAD(encode([...keys.scope, path, revision]));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const wire = Buffer.concat([Buffer.from([RELAY_VERSION]), nonce, cipher.getAuthTag(), encrypted]);
  return {
    path,
    kind: "binary",
    redacted: false,
    bytes: wire.length,
    sha256: sha(wire),
    content: wire.toString("base64"),
  };
}

function unseal(keys, path, revision, artifact, expected) {
  if (
    !artifact ||
    typeof artifact.content !== "string" ||
    artifact.kind !== "binary" ||
    artifact.content.length > Math.ceil((MAX_FILE + RELAY_OVERHEAD) / 3) * 4 ||
    !hash(expected) ||
    expected !== artifact.sha256
  )
    invalid();
  const wire = Buffer.from(artifact.content, "base64");
  if (
    wire.toString("base64") !== artifact.content ||
    wire.length < RELAY_OVERHEAD ||
    wire.length > MAX_FILE + RELAY_OVERHEAD ||
    wire[0] !== RELAY_VERSION ||
    sha(wire) !== expected
  )
    invalid();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    recordKey(keys, path, revision),
    wire.subarray(1, 1 + NONCE),
    { authTagLength: TAG },
  );
  decipher.setAAD(encode([...keys.scope, path, revision]));
  decipher.setAuthTag(wire.subarray(1 + NONCE, RELAY_OVERHEAD));
  try {
    return Buffer.concat([decipher.update(wire.subarray(RELAY_OVERHEAD)), decipher.final()]);
  } catch {
    invalid();
  }
}

export function manifestFiles(keys, state) {
  if (!state.manifest) return [];
  const raw = unseal(keys, RELAY_MANIFEST, state.revision, state.manifest, state.manifest.sha256);
  let index;
  try {
    index = JSON.parse(raw.toString("utf8"));
  } catch {
    invalid();
  }
  if (
    !index ||
    index.version !== RELAY_VERSION ||
    index.revision !== state.revision ||
    !(index.parent === null || isRevision(index.parent)) ||
    !Array.isArray(index.files) ||
    index.files.length > MAX_FILES
  )
    invalid();
  const names = new Set();
  let total = 0;
  for (const row of index.files) {
    if (
      !row ||
      !validPath(row.path) ||
      names.has(row.path) ||
      !hash(row.sha256) ||
      !hash(row.cipherHash) ||
      !isRevision(row.revision) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > MAX_FILE ||
      !["text", "binary"].includes(row.kind) ||
      typeof row.redacted !== "boolean"
    )
      invalid();
    names.add(row.path);
    total += row.bytes;
  }
  if (total > MAX_TOTAL) invalid();
  return index.files;
}

export function relayChange(keys, prior, snapshot) {
  const old = new Map(manifestFiles(keys, prior).map((f) => [f.path, f]));
  const revision = randomUUID();
  const index = [];
  const files = [];
  for (const f of snapshot.files) {
    const prev = old.get(f.path);
    old.delete(f.path);
    if (
      prev &&
      prev.sha256 === f.sha256 &&
      prev.bytes === f.bytes &&
      prev.kind === f.kind &&
      prev.redacted === f.redacted
    ) {
      index.push(prev);
      continue;
    }
    const { content, ...meta } = f;
    const artifact = seal(keys, objectId(keys, f.path), revision, Buffer.from(content, "base64"));
    index.push({ ...meta, revision, cipherHash: artifact.sha256 });
    files.push(artifact);
  }
  const removed = [...old.keys()].map((path) => objectId(keys, path));
  if (prior.manifest && !files.length && !removed.length) return null;
  const bytes = encode({ version: RELAY_VERSION, revision, parent: prior.revision, files: index });
  if (
    bytes.length > MAX_FILE ||
    bytes.length + snapshot.bytes + RELAY_OVERHEAD * (index.length + 1) > MAX_TOTAL
  )
    throw new Error("Encrypted workspace exceeds relay storage capacity");
  files.push(seal(keys, RELAY_MANIFEST, revision, bytes));
  return { version: RELAY_VERSION, id: revision, parent: prior.revision, files, removed };
}

export async function remoteRelayIndex(keys, getRemote, expectedRevision) {
  if (expectedRevision !== undefined && !isRevision(expectedRevision))
    throw new Error("Provide a valid expected relay revision");
  const status = await getRemote("");
  if (
    !status ||
    !(status.revision === null || isRevision(status.revision)) ||
    !Array.isArray(status.files) ||
    status.files.length > MAX_FILES + 1
  )
    invalid();
  if (expectedRevision !== undefined && expectedRevision !== status.revision)
    throw new Error("Remote revision differs from the expected relay revision");
  const { revision } = status;
  if (!status.files.length) {
    if (expectedRevision !== undefined || status.events?.length) invalid();
    return { revision, manifest: null, files: [] };
  }
  if (!revision) invalid();
  if (status.files.some((row) => !row || typeof row.path !== "string")) invalid();
  const remote = new Map(status.files.map((f) => [f.path, f]));
  const advertised = remote.get(RELAY_MANIFEST);
  if (!advertised || remote.size !== status.files.length) invalid();
  const manifest = await getRemote("/artifact?path=manifest&revision=" + revision);
  if (
    !manifest ||
    advertised.sha256 !== manifest.sha256 ||
    advertised.kind !== "binary" ||
    advertised.redacted !== false ||
    typeof manifest.content !== "string" ||
    advertised.bytes !== Buffer.byteLength(manifest.content, "base64")
  )
    invalid();
  const files = manifestFiles(keys, { revision, manifest });
  if (remote.size !== files.length + 1) invalid();
  for (const f of files) {
    const sealed = remote.get(objectId(keys, f.path));
    if (
      !sealed ||
      sealed.sha256 !== f.cipherHash ||
      sealed.bytes !== f.bytes + RELAY_OVERHEAD ||
      sealed.kind !== "binary" ||
      sealed.redacted !== false
    )
      invalid();
  }
  return { revision, manifest, files };
}

export async function inspectRelay(keys, getRemote, path, expectedRevision) {
  const index = await remoteRelayIndex(keys, getRemote, expectedRevision);
  if (path === undefined) {
    const files = index.files.map(({ cipherHash, revision, ...metadata }) => metadata);
    return { revision: index.revision, authenticated: Boolean(index.manifest), files };
  }
  if (!validPath(path)) throw new Error("Provide a workspace-relative artifact path");
  const row = index.files.find((f) => f.path === path);
  if (!row) throw new Error("Artifact is absent from the relay manifest");
  const id = objectId(keys, path);
  const reply = await getRemote("/artifact?path=" + id + "&revision=" + index.revision);
  const bytes = unseal(keys, id, row.revision, reply, row.cipherHash);
  if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) invalid();
  return {
    revision: index.revision,
    path,
    kind: row.kind,
    redacted: row.redacted,
    sha256: row.sha256,
    bytes: row.bytes,
    content: bytes.toString("base64"),
  };
}

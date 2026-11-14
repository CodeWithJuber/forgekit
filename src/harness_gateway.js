// Intake is a trust boundary. Channel and actor come from the local transport or verified
// webhook credential, never from a task body. Enqueue authenticated jobs before dispatch.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/;
const CHANNELS = new Set(["cli", "ide", "chat", "webhook", "schedule", "mcp", "worker", "api"]);

function text(value, maximum, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > maximum ||
    /\p{Cc}/u.test(value.replace(/[\r\n\t]/g, ""))
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

function validId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** The caller selects its authenticated principal and authorization scope.
 * @param {any} raw
 * @param {{channel?:string,actor?:string,profile?:string,priority?:string,id?:string}} [options]
 */
export function normalizeHarnessRequest(
  raw,
  { channel = "cli", actor = "local", profile, priority, id } = {},
) {
  if (!CHANNELS.has(channel)) throw new Error("Unknown intake channel");
  const input = typeof raw === "string" ? { task: raw } : raw;
  if (!input || Array.isArray(input) || typeof input !== "object")
    throw new Error("Expected a task request");
  const acceptance = input.acceptance ?? [];
  if (!Array.isArray(acceptance) || acceptance.length > 32)
    throw new Error("Invalid acceptance criteria");
  const task = text(input.task, 16384, "task");
  const rank = priority ?? (channel === "schedule" ? "P2" : "P1");
  if (!/^P[0-3]$/.test(rank)) throw new Error("Invalid priority");
  return {
    id: validId(id ?? randomUUID(), "request id"),
    channel,
    actor: validId(actor, "actor"),
    profile: validId(profile ?? "coder", "profile"),
    priority: rank,
    task,
    acceptance: acceptance.map((item) => text(item, 2048, "acceptance criterion")),
  };
}

/** Protocol v1 signs the exact bytes "timestamp.delivery_id." + body; timestamp is UTC
 * epoch seconds. Persist delivery IDs in the queue so restarts cannot replay a job. */
export function verifyHarnessWebhook({
  body,
  timestamp,
  id,
  signature,
  secret,
  now = Date.now(),
  actor = "webhook",
}) {
  const payload = typeof body === "string" ? Buffer.from(body) : body;
  if (
    !Buffer.isBuffer(payload) ||
    payload.length < 2 ||
    payload.length > 65536 ||
    typeof timestamp !== "string" ||
    !/^\d{10,12}$/.test(timestamp) ||
    !Number.isFinite(now) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    typeof secret !== "string" ||
    Buffer.byteLength(secret) < 32 ||
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  )
    throw new Error("Invalid or expired webhook");
  validId(id, "delivery id");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${id}.`)
    .update(payload)
    .digest();
  const supplied = Buffer.from(signature.slice(7), "hex");
  if (!timingSafeEqual(expected, supplied)) throw new Error("Webhook authentication failed");
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  return normalizeHarnessRequest(raw, {
    id,
    channel: "webhook",
    actor,
    profile: "reviewer",
    priority: "P1",
  });
}

/** In-process fixed-window admission limit for interactive gateways. Durable webhook
 * delivery deduplication and trigger quotas are provided by the job store. */
export function createHarnessIntake({
  maximum = 60,
  windowMs = 60000,
  now = () => Date.now(),
} = {}) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1
  )
    throw new Error("Invalid intake rate limit");
  const buckets = new Map();
  return (raw, identity) => {
    const request = normalizeHarnessRequest(raw, identity);
    const time = now();
    // Bounded number of principals. Forget expired buckets before admitting new ones.
    if (buckets.size >= 4096) for (const [k, v] of buckets) if (time >= v.until) buckets.delete(k);
    let bucket = buckets.get(request.actor);
    if (!bucket || time >= bucket.until) {
      if (!bucket && buckets.size >= 4096) throw new Error("Gateway principal limit");
      bucket = { until: time + windowMs, count: 0 };
      buckets.set(request.actor, bucket);
    }
    if (bucket.count >= maximum) throw new Error("Gateway rate limit");
    bucket.count++;
    return request;
  };
}

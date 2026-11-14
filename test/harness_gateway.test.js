import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  createHarnessIntake,
  normalizeHarnessRequest,
  verifyHarnessWebhook,
} from "../src/harness_gateway.js";

test("gateway bounds task/criteria and derives identity, scope, priority from the authenticated transport", () => {
  const input = {
    task: "Fix CSV import",
    actor: "owner",
    profile: "admin",
    priority: "P0",
    id: "other",
    channel: "worker",
    stage: 7,
    acceptance: ["tests pass"],
  };
  const r = normalizeHarnessRequest(input, {
    channel: "ide",
    actor: "dev",
    id: "42",
    profile: "reviewer",
  });
  assert.deepEqual(r, {
    id: "42",
    channel: "ide",
    actor: "dev",
    profile: "reviewer",
    priority: "P1",
    task: input.task,
    acceptance: input.acceptance,
  });
  assert.throws(() => normalizeHarnessRequest({ task: "a".repeat(20000) }));
  assert.throws(() => normalizeHarnessRequest({ task: "x", acceptance: Array(33).fill("oops") }));
  assert.throws(() => normalizeHarnessRequest({ task: "bad\0" }));
});

test("verify a webhook signature on raw bytes and delivery ID, reject a changed identity or stale delivery", () => {
  const secret = "a".repeat(32),
    id = "delivery-1",
    timestamp = "1700000000",
    now = 1700000000100;
  const body = Buffer.from('{"task":"Read contracts", "actor":"admin","profile":"admin","id":"-"}');
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${id}.`).update(body).digest("hex")}`;
  const proof = { secret, id, timestamp, signature, now, body };
  const request = verifyHarnessWebhook(proof);
  assert.equal(request.id, id);
  assert.equal(request.actor, "webhook");
  assert.equal(request.profile, "reviewer");
  for (const tamper of [
    { now: now + 300000 },
    { id: "delivery-2" },
    { signature: "X" },
    { body: Buffer.concat([body, Buffer.from(" ")]) },
  ])
    assert.throws(() => verifyHarnessWebhook({ ...proof, ...tamper }));
});

test("interactive admission throttle is separate per authenticated actor, releases after its window", () => {
  let now = 0;
  const intake = createHarnessIntake({ maximum: 1, windowMs: 50, now: () => now });
  intake("one", { actor: "a" });
  assert.throws(() => intake({ task: "another", actor: "b" }, { actor: "a" }), /rate limit/);
  intake("another", { actor: "b" });
  now = 50;
  intake("next", { actor: "a" });
});

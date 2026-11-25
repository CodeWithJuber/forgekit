import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runJourney, validateJourney } from "../src/uijourney.js";
import { resolvePlaywright } from "../src/uivisual.js";

import { serveFixture } from "./_ui_server.js";

const steps = [
  { key: "Tab", role: "button", name: "Show order", expect: "focused" },
  { key: "Enter", role: "heading", name: "Order ready", expect: "visible" },
];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-journey-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "sample.html");
  writeFileSync(
    target,
    "<!doctype html><title>Orders</title><button onclick=\"document.querySelector('h1').hidden=false\">Show order</button><h1 hidden>Order ready</h1>",
  );
  return { root, target };
}
test("journey rejects a missing role and ambiguous action contracts", () => {
  assert.throws(
    () => validateJourney({ steps: [{ key: "Enter", expect: "visible", name: "Example" }] }),
    /role/,
  );
  assert.throws(() => validateJourney({ steps: [{ ...steps[0], key: "Delete" }] }), /role/);
});
test("journey records missing browser as incomplete", async (t) => {
  const { root, target } = fixture(t);
  const r = await runJourney(target, { steps }, { root, resolve: async () => null });
  assert.equal(r.status, "incomplete");
  assert.equal(JSON.parse(readFileSync(r.receipt, "utf8")).status, "incomplete");
});
test("real browser checks role and keyboard, saves screenshot digests and detects a missing expected result", async (t) => {
  const pw = await resolvePlaywright();
  if (!pw) {
    t.skip("Install optional Playwright and Chromium to run native journey");
    return;
  }
  const { root, target: file } = fixture(t);
  const target = await serveFixture(t, file);
  const good = await runJourney(target, { steps }, { root });
  assert.equal(good.status, "pass", good.detail);
  assert.equal(good.steps.length, 2);
  for (const entry of good.steps) {
    const bytes = readFileSync(join(good.receipt, "..", entry.screenshot));
    assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  const bad = await runJourney(
    target,
    { timeoutMs: 300, steps: [{ ...steps[0], name: "Other button" }] },
    { root },
  );
  assert.equal(bad.status, "fail", bad.detail);
});

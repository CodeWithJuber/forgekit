import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validOutcome } from "../src/ledger.js";
import {
  INTERACTION_CHECK_IDS,
  recordInteraction,
  runInteractions,
  summarizeVerdict,
  verdictOutcome,
} from "../src/uiinteract.js";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "forge-uiint-"));

test("INTERACTION_CHECK_IDS names the four interaction checks", () => {
  assert.deepEqual(INTERACTION_CHECK_IDS, [
    "console-clean",
    "keyboard-reachable",
    "focus-visible",
    "reduced-motion",
  ]);
});

test("summarizeVerdict: all ok → pass; any fail → fail; empty → fail", () => {
  assert.equal(summarizeVerdict([{ ok: true }, { ok: true }]).pass, true);
  assert.equal(summarizeVerdict([{ ok: true }, { ok: false }]).pass, false);
  assert.equal(summarizeVerdict([]).pass, false);
  assert.equal(summarizeVerdict(undefined).pass, false);
});

test("verdictOutcome: pass → behavioral confirm; fail → contradict; both valid", () => {
  const pass = verdictOutcome("http://localhost/x", {
    pass: true,
    checks: [{ id: "a", ok: true }],
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.outcome.oracle, "behavioral");
  assert.equal(pass.outcome.result, "confirm");
  assert.ok(pass.outcome.ref.startsWith("ui-interact:http://localhost/x#"));
  assert.equal(validOutcome(pass.outcome), true);

  const fail = verdictOutcome("http://localhost/x", {
    pass: false,
    checks: [{ id: "a", ok: false }],
  });
  assert.equal(fail.outcome.result, "contradict");
  assert.equal(validOutcome(fail.outcome), true);
});

test("verdictOutcome: ref is content-addressed on the checks (idempotent)", () => {
  const v = { pass: true, checks: [{ id: "a", ok: true }] };
  const a = verdictOutcome("http://localhost/x", v);
  const b = verdictOutcome("http://localhost/x", v);
  assert.equal(a.outcome.ref, b.outcome.ref);
  const c = verdictOutcome("http://localhost/x", { pass: true, checks: [{ id: "b", ok: true }] });
  assert.notEqual(a.outcome.ref, c.outcome.ref);
});

test("runInteractions: no browser runtime → graceful skip (available:false)", async () => {
  const r = await runInteractions("http://localhost:3000/", { resolve: async () => null });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(r.available, false);
  assert.match(r.reason, /no browser runtime/);
});

test("runInteractions: refused target (remote host, no --remote) → refusal before any browser", async () => {
  let resolverCalled = false;
  const r = await runInteractions("http://example.com/x", {
    resolve: async () => {
      resolverCalled = true;
      return null;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.equal(resolverCalled, false, "target guard must run before the browser resolver");
});

test("recordInteraction: no project fingerprint claim → no-op with guidance", () => {
  const root = tmpRoot();
  const r = recordInteraction(root, "http://localhost/x", { pass: true, checks: [] });
  assert.equal(r.recorded, false);
  assert.match(r.reason, /no project fingerprint claim/);
});

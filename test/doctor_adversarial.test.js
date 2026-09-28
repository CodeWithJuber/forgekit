import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { doctor } from "../src/doctor.js";
import { adversarialProbes } from "../src/doctor_adversarial.js";

const guardsDir = join(BRAND.root, "global", "guards");
const byLabel = (results) => Object.fromEntries(results.map((r) => [r.label, r]));
// Faking $HOME does not move os.homedir() on Windows (it reads USERPROFILE),
// so the fake-home bypass tests are POSIX-only — same convention as the
// forge-stub guard tests.
const noFakeHomeSkip =
  process.platform === "win32" && "fake $HOME does not move os.homedir() on win32";
const ATTACK_IDS = [
  "sed-inplace",
  "heredoc-write",
  "append-authkeys",
  "tee-secret",
  "cp-exfil",
  "mv-key",
  "read-secret",
];

test("adversarial probes fire real payloads at the real guard: 16 probes", () => {
  const results = adversarialProbes({ guardsDir });
  assert.equal(results.length, 16);
  for (const r of results) {
    assert.ok(["ok", "warn", "fail", "na"].includes(r.status), `${r.label}: valid status`);
    assert.ok(r.label.startsWith("adv: "), `${r.label}: adv prefix`);
    assert.ok(r.note.length > 0, `${r.label}: has a note`);
  }
});

test("rerouting attacks are all blocked by the real guard", () => {
  const m = byLabel(adversarialProbes({ guardsDir }));
  for (const id of ATTACK_IDS) {
    const r = m[`adv: ${id}`];
    assert.ok(r, `probe adv: ${id} ran`);
    assert.equal(r.status, "ok", `adv: ${id} blocked — ${r.note}`);
  }
});

test("benign controls still pass (the guard is not a wall)", () => {
  const m = byLabel(adversarialProbes({ guardsDir }));
  for (const id of ["grep-env", "env-template"]) {
    const r = m[`adv: ${id}`];
    assert.ok(r, `probe adv: ${id} ran`);
    assert.equal(r.status, "ok", `adv: ${id} allowed — ${r.note}`);
  }
});

test("malformed hook JSON is denied fail-closed", () => {
  const m = byLabel(adversarialProbes({ guardsDir }));
  for (const id of ["truncated-json", "garbage-stdin"]) {
    const r = m[`adv: ${id}`];
    assert.equal(r.status, "ok", `adv: ${id} denied — ${r.note}`);
  }
});

test("wrong-shape payloads are warn, not fail (not attacker-reachable)", () => {
  const m = byLabel(adversarialProbes({ guardsDir }));
  for (const id of ["empty-stdin", "empty-object", "string-tool-input"]) {
    const r = m[`adv: ${id}`];
    assert.equal(r.status, "warn", `adv: ${id} is a robustness warn — ${r.note}`);
  }
});

test("missing guard binary yields na probes, never a throw", () => {
  const results = adversarialProbes({ guardsDir: join(tmpdir(), "no-such-guards-dir") });
  assert.ok(results.length > 0);
  for (const r of results) assert.equal(r.status, "na");
});

test("bypassPermissions in settings.json is a fail", { skip: noFakeHomeSkip }, () => {
  const home = mkdtempSync(join(tmpdir(), "forge-adv-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = byLabel(adversarialProbes({ guardsDir }));
    assert.equal(m["adv: settings-bypass"].status, "fail");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
  assert.equal(homedir(), prev ?? homedir(), "HOME restored");
});

test("no bypass configured is ok", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-adv-clean-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const m = byLabel(adversarialProbes({ guardsDir }));
    assert.equal(m["adv: settings-bypass"].status, "ok");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});

test("live-bypass probe never throws (na on win32, ok/fail on POSIX)", () => {
  const m = byLabel(adversarialProbes({ guardsDir }));
  const r = m["adv: live-bypass"];
  assert.ok(r, "probe ran");
  if (process.platform === "win32") assert.equal(r.status, "na");
  else assert.ok(["ok", "fail"].includes(r.status), `unexpected: ${r.status}`);
});

test("doctor({adversarial:true}) runs the attack suite, not the health checks", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-adv-doctor-"));
  const { results, failed } = doctor({ targetRoot: root, adversarial: true });
  assert.ok(results.length >= 10, "adversarial suite ran");
  assert.ok(
    results.every((r) => r.label.startsWith("adv: ")),
    "every result is an adversarial probe",
  );
  assert.equal(
    failed,
    results.filter((r) => r.status === "fail").length,
    "failed counts fail probes",
  );
});

test(
  "doctor({adversarial:true}) with a bypass configured reports failed=1",
  { skip: noFakeHomeSkip },
  () => {
  const home = mkdtempSync(join(tmpdir(), "forge-adv-fail-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
  );
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const root = mkdtempSync(join(tmpdir(), "forge-adv-doctor2-"));
    const { failed } = doctor({ targetRoot: root, adversarial: true });
    // Exactly one fail probe on a clean POSIX box (settings-bypass); the
    // live-bypass probe is ok unless an ancestor carries the flag.
    assert.ok(failed >= 1, "at least the settings-bypass probe failed");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
});

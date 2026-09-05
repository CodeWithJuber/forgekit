// Doctor × the portable hook launcher: an install whose hooks still spawn `bash` directly (the
// pre-launcher exec form — `spawn bash ENOENT` on Windows) is DEGRADED and `--fix` heals it, and
// doctor reports the bash the launcher resolves.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { doctor } from "../src/doctor.js";
import { mergeSettings } from "../src/init.js";
import { toPosix } from "../src/util.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-doctor-launcher-"));
const allHooks = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((e) => e.hooks || []);

test("doctor: Forge hooks left in the pre-launcher `bash` spelling are DEGRADED (warn) — and --fix heals them", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  const base = toPosix(join(BRAND.root, "global"));
  mergeSettings({ settingsPath });
  // Rewind to what v0.32 wrote: `bash <guard> [mode]`, no launcher (manifest included).
  const s = JSON.parse(readFileSync(settingsPath, "utf8"));
  const rewind = (h) => {
    if (h?.command === "node" && h.args?.[0] === `${base}/guards/run.mjs`) {
      h.command = "bash";
      h.args = h.args.slice(1);
    }
  };
  for (const h of allHooks(s)) rewind(h);
  for (const o of s._forgeOwned.added.hooks) rewind(o);
  writeFileSync(settingsPath, JSON.stringify(s));

  const before = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "settings",
  );
  assert.equal(before.status, "warn", "wired but in a spelling that fails on Windows is not green");
  assert.match(before.note, /predate the portable launcher/);

  doctor({ targetRoot: root, settingsPath, fix: true });
  const after = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "settings",
  );
  assert.equal(after.status, "ok", after.note);
  const healed = allHooks(JSON.parse(readFileSync(settingsPath, "utf8")));
  assert.ok(healed.length > 0);
  assert.ok(
    healed.every((h) => h.command === "node" && h.args[0] === `${base}/guards/run.mjs`),
    "every hook now runs through the launcher",
  );
});

test("doctor: reports the bash the hook launcher resolves (present here → ok, via run.mjs)", () => {
  const r = doctor({ targetRoot: fixture() }).results.find((x) => x.label === "bash");
  assert.ok(r, "bash row present");
  assert.equal(r.status, "ok", r.note);
  assert.match(r.note, /run\.mjs/);
});

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BRAND } from "../src/brand.js";
import { processSession } from "../src/cortex_hook.js";
import { doctor, repairFailure } from "../src/doctor.js";
import { mergeSettings } from "../src/init.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-doctor-"));

test("doctor reports subsystem health in the standard vocabulary (P1-06)", () => {
  const root = fixture();
  const { health } = doctor({ targetRoot: root });
  const allowed = new Set(["ACTIVE", "DEGRADED", "UNAVAILABLE", "FAILED"]);
  for (const key of ["secret-redaction", "guards", "atlas", "managed-config", "pricing"]) {
    assert.ok(key in health, `health reports ${key}`);
    assert.ok(allowed.has(health[key]), `${key}=${health[key]} is a valid state`);
  }
  // node is present in this runtime, so redaction is ACTIVE (not silently missing).
  assert.equal(health["secret-redaction"], "ACTIVE");
});

test("doctor warns when a repo has more than ~6 MCP servers", () => {
  const root = fixture();
  const servers = {};
  for (let i = 0; i < 7; i++) servers[`s${i}`] = { command: "x" };
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  const mcp = doctor({ targetRoot: root }).results.find((r) => r.label === "MCP servers");
  assert.ok(mcp, "MCP check ran");
  assert.equal(mcp.status, "warn");
});

test("doctor is ok with a small MCP set", () => {
  const root = fixture();
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { context7: { command: "npx" } } }),
  );
  const mcp = doctor({ targetRoot: root }).results.find((r) => r.label === "MCP servers");
  assert.equal(mcp.status, "ok");
});

test("doctor reports 'no lessons yet' on a fresh repo, and counts once learning happens", () => {
  const fresh = fixture();
  const c0 = doctor({ targetRoot: fresh }).results.find((r) => r.label === "cortex");
  assert.ok(c0);
  assert.match(c0.note, /no lessons yet/);

  const learned = fixture();
  const s = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "edit", file: "src/a.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(learned, s(), 1);
  processSession(learned, s(), 2); // → active lesson
  const c1 = doctor({ targetRoot: learned }).results.find((r) => r.label === "cortex");
  assert.match(c1.note, /1 active/);
});

test("doctor surfaces the new tooling / guards-exec / atlas / pricing checks", () => {
  const labels = doctor({ targetRoot: fixture() }).results.map((r) => r.label);
  for (const l of ["guards exec", "jq", "atlas", "model pricing"]) {
    assert.ok(labels.includes(l), `doctor runs the '${l}' check`);
  }
});

test("doctor stays silent about gateway models when no custom gateway is configured", () => {
  const save = {
    l: process.env.LITELLM_BASE_URL,
    a: process.env.ANTHROPIC_BASE_URL,
  };
  try {
    // Direct Anthropic (default endpoint) or nothing configured → no probe, no "gateway models" row.
    process.env.LITELLM_BASE_URL = "";
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    const labels = doctor({ targetRoot: fixture() }).results.map((r) => r.label);
    assert.ok(!labels.includes("gateway models"), "no gateway check for a direct-API session");
  } finally {
    process.env.LITELLM_BASE_URL = save.l ?? "";
    process.env.ANTHROPIC_BASE_URL = save.a ?? "";
  }
});

test("doctor checks plugin manifests and hook compatibility", () => {
  const results = doctor({ targetRoot: fixture() }).results;
  const claude = results.find((r) => r.label === "Claude plugin hooks");
  const codex = results.find((r) => r.label === "Codex plugin");
  assert.ok(claude, "Claude plugin compatibility check ran");
  assert.ok(codex, "Codex plugin compatibility check ran");
  assert.equal(claude.status, "ok");
  assert.match(claude.note, /additive hook command/);
  assert.equal(codex.status, "ok");
  assert.match(codex.note, /no repo-level hook takeover/);
});

test("doctor --fix turns a missing-hooks settings warn into ok via mergeSettings", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json"); // absent → not forge-managed

  const before = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "settings",
  );
  assert.ok(before, "settings check ran");
  assert.equal(before.status, "warn");
  assert.ok(before.fix, "warn carries a fix descriptor");

  const fixed = doctor({ targetRoot: root, settingsPath, fix: true });
  const settings = fixed.results.find((r) => r.label === "settings");
  assert.equal(settings.status, "ok", "settings warn → ok after --fix");
  assert.ok(
    fixed.repairs.some((rep) => rep.id === "settings" && rep.ok),
    "a settings repair was recorded",
  );
  // mergeSettings actually wrote the marker + hooks.
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(written._forge, "forge-managed");
  assert.ok(written.hooks && Object.keys(written.hooks).length, "hooks merged in");
});

test("doctor --fix adds the ledger union-merge rule to .gitattributes", () => {
  const root = fixture();
  // A populated ledger makes the 'ledger merge' check run (empty ledgers report ok early).
  mkdirSync(join(root, ".forge", "ledger", "claims"), { recursive: true });
  const settingsPath = join(fixture(), "settings.json");

  const before = doctor({ targetRoot: root, settingsPath }).results.find(
    (r) => r.label === "ledger merge",
  );
  assert.equal(before.status, "warn");

  doctor({ targetRoot: root, settingsPath, fix: true });
  const attrs = join(root, ".gitattributes");
  assert.ok(existsSync(attrs), ".gitattributes was created");
  assert.match(readFileSync(attrs, "utf8"), /\.forge\/ledger\//);
});

test("doctor --fix is idempotent — a second run repairs nothing", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge", "ledger", "claims"), { recursive: true });
  const settingsPath = join(fixture(), "settings.json");

  const first = doctor({ targetRoot: root, settingsPath, fix: true });
  assert.ok(first.repairs.length > 0, "first --fix run does work");

  const second = doctor({ targetRoot: root, settingsPath, fix: true });
  assert.equal(second.repairs.length, 0, "second --fix run is a no-op");
});

test("doctor: a missing atlas is UNAVAILABLE, not ACTIVE; a fresh one is ACTIVE (RA-19)", async () => {
  const bare = fixture();
  const r = doctor({ targetRoot: bare });
  const atlasRow = r.results.find((x) => x.label === "atlas");
  assert.equal(atlasRow.status, "na", "not built is neither ok nor a failure");
  assert.equal(r.health.atlas, "UNAVAILABLE");
  assert.equal(r.failed, 0, "na never counts toward failed totals");

  const built = fixture();
  writeFileSync(join(built, "a.js"), "export const one = 1;\n");
  const { build } = await import("../src/atlas.js");
  build({ root: built });
  const r2 = doctor({ targetRoot: built });
  assert.equal(r2.results.find((x) => x.label === "atlas").status, "ok");
  assert.equal(r2.health.atlas, "ACTIVE");
});

test("doctor --fix records a returned {action:'error'} repair as ok:false (RA-20)", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  writeFileSync(settingsPath, "{ not: valid json"); // present but unparseable
  const r = doctor({ targetRoot: root, settingsPath, fix: true });
  const rep = r.repairs.find((x) => x.id === "settings");
  assert.ok(rep, "a settings repair was attempted");
  assert.equal(rep.ok, false, "a returned error object is not success");
  assert.match(rep.error, /not valid JSON/, "the returned reason is surfaced");
});

// ME-15: a `_forge` marker plus one unrelated hook is FALSE-GREEN — settings is only ACTIVE
// when the ACTUAL required Forge guard identities from the template are wired.
test("doctor: settings with _forge marker but WITHOUT the required forge hooks is not ACTIVE (ME-15)", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      _forge: "forge-managed",
      hooks: {
        Stop: [{ hooks: [{ command: "bash /somewhere/unrelated.sh" }] }],
      },
      permissions: { allow: ["Read"] },
    }),
  );
  const s = doctor({ targetRoot: root, settingsPath }).results.find((r) => r.label === "settings");
  assert.ok(s, "settings check ran");
  assert.equal(s.status, "warn", "marker + one unrelated hook must not read as healthy");
  assert.match(s.note, /hooks missing|not forge-managed/);
});

test("doctor: settings with the real merged forge wiring is ACTIVE (ME-15)", () => {
  const root = fixture();
  const settingsPath = join(fixture(), "settings.json");
  // mergeSettings installs the full template hook set + permissions — the genuine wiring.
  mergeSettings({ settingsPath });
  const s = doctor({ targetRoot: root, settingsPath }).results.find((r) => r.label === "settings");
  assert.equal(s.status, "ok", "a fully-wired settings file is ACTIVE");
  assert.match(s.note, /guard\(s\) \+ permissions wired/);
});

// ME-16: `~/.forge` must be a symlink/dir whose required guard assets resolve — a plain file
// or a dangling symlink is not a working install.
test("doctor: ~/.forge as a plain file is not ACTIVE (ME-16)", () => {
  const root = fixture();
  const forgeHome = join(fixture(), ".forge");
  writeFileSync(forgeHome, "not a real install");
  const r = doctor({ targetRoot: root, forgeHome }).results.find((x) => x.label === "~/.forge");
  assert.equal(r.status, "fail", "a stray file shadowing the install is a failure");
  assert.match(r.note, /not a symlink or directory/);
});

test("doctor: a dangling ~/.forge symlink is not ACTIVE (ME-16)", () => {
  const root = fixture();
  const dir = fixture();
  const forgeHome = join(dir, ".forge");
  symlinkSync(join(dir, "does-not-exist"), forgeHome); // dangling
  const r = doctor({ targetRoot: root, forgeHome }).results.find((x) => x.label === "~/.forge");
  assert.equal(r.status, "fail");
  assert.match(r.note, /dangling symlink/);
});

test("doctor: a correct ~/.forge install with resolvable guard assets is ACTIVE (ME-16)", () => {
  const root = fixture();
  const forgeHome = join(fixture(), ".forge");
  // install.sh symlinks ~/.forge -> <repo>/global; point at the real assets so they resolve.
  symlinkSync(join(BRAND.root, "global"), forgeHome);
  const r = doctor({ targetRoot: root, forgeHome }).results.find((x) => x.label === "~/.forge");
  assert.equal(r.status, "ok", "required guard assets resolve → ACTIVE");
  assert.match(r.note, /guard assets resolve/);
});

// ME-17: the redaction subsystem is ACTIVE only when a real self-test through secret-redact.mjs
// masks a fake secret; a missing redactor degrades it instead of reading green off `node`.
test("doctor: a working redactor self-test reports ACTIVE (ME-17)", () => {
  const r = doctor({ targetRoot: fixture() });
  const row = r.results.find((x) => x.label === "secret-redact");
  assert.ok(row, "redaction self-test ran");
  assert.equal(row.status, "ok");
  assert.match(row.note, /self-test passed/);
  assert.equal(r.health["secret-redaction"], "ACTIVE");
});

test("doctor: a broken redactor (guards dir missing the mjs) is DEGRADED, not ACTIVE (ME-17)", () => {
  const emptyGuards = fixture(); // no secret-redact.mjs here
  const r = doctor({ targetRoot: fixture(), guardsDir: emptyGuards });
  const row = r.results.find((x) => x.label === "secret-redact");
  assert.equal(row.status, "warn");
  assert.match(row.note, /redactor script missing/);
  assert.equal(r.health["secret-redaction"], "DEGRADED");
});

// ME-18: a repair that "succeeds" overall while a nested report row is action:"error" must be
// recorded as a failure with the reason surfaced.
test("doctor: a repair whose report has a nested action:'error' row is a failure (ME-18)", () => {
  // sync-shaped report: overall object is fine, but one emitter row errored.
  const partialSync = {
    hash: "abc",
    bytes: 100,
    report: [
      {
        tool: "shared source",
        target: "AGENTS.md",
        action: "wrote",
        note: "100 B",
      },
      {
        tool: "cursor",
        target: "-",
        action: "error",
        note: "ENOSPC: no space left on device",
      },
    ],
    warnings: [],
  };
  const reason = repairFailure(partialSync);
  assert.ok(reason, "a nested errored row makes the repair a failure");
  assert.match(reason, /sub-step\(s\) failed/);
  assert.match(reason, /cursor/);
  assert.match(reason, /ENOSPC/);

  // A fully-clean report is not a failure.
  const cleanSync = {
    report: [{ tool: "cursor", target: ".cursorrules", action: "wrote", note: "ok" }],
  };
  assert.equal(repairFailure(cleanSync), null, "a clean report is not a failure");

  // The {ok:false} (writeForgeConfig) contract is also caught.
  assert.match(repairFailure({ ok: false, reason: "corrupt config" }), /corrupt config/);
});

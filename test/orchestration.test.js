// Agent-orchestration rule pack: the source shape, on/off resolution with global vs project
// precedence, emission into every target, and the `forge orchestration` CLI. The user-level
// config is redirected per test through FORGE_HOME (each test file runs in its own process,
// after _setup's scrub), so nothing touches a real home directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadPack,
  orchestrationSection,
  resolveOrchestration,
  resolveRoutePolicy,
  ruleIds,
  setRule,
  setSetting,
} from "../src/orchestration.js";
import { readUserConfig, userConfigPath, writeForgeConfig } from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), "forge-orch-"));
/** A fresh user-level config home for one test. */
const freshHome = () => {
  process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-orch-home-"));
  return process.env.FORGE_HOME;
};
const agentsMd = (root) => readFileSync(join(root, "AGENTS.md"), "utf8");

const REQUIRED = [
  "orch.no-polling",
  "orch.parallel-cap",
  "orch.ci-heavy-checks",
  "orch.fresh-subagents",
  "orch.route-models",
  "orch.risk-review",
  "orch.isolated-env",
  "orch.lean-lead",
];

test("pack: every rule has a stable id, short text, a rationale and a default", () => {
  const pack = loadPack();
  assert.deepEqual(ruleIds(), REQUIRED);
  assert.equal(new Set(ruleIds()).size, ruleIds().length, "ids are unique");
  for (const r of pack.rules) {
    assert.match(r.id, /^orch\.[a-z-]+$/);
    assert.equal(typeof r.default, "boolean");
    assert.ok(r.text.length > 20 && r.text.length < 260, `${r.id}: short imperative text`);
    assert.ok(r.rationale.length > 20, `${r.id}: has a rationale`);
  }
  assert.equal(pack.params.parallelCap, 2, "parallel cap defaults to 2");
  assert.equal(pack.route.mode, "conservative", "routing stays conservative by default");
  assert.equal(pack.route.topTier, "explicit");
});

test("pack text is generic: no vendor model ids or tool names in a rule", () => {
  for (const r of loadPack().rules) {
    assert.doesNotMatch(r.text, /claude|codex|cursor|gemini|kimi|haiku|sonnet|opus|fable/i);
  }
});

test("defaults: every rule on, parallel cap substituted into the text", () => {
  const s = resolveOrchestration(fixture(), { global: {}, project: {} });
  assert.equal(s.enabled, true);
  assert.ok(s.rules.every((r) => r.enabled && r.source === "default"));
  const cap = s.rules.find((r) => r.id === "orch.parallel-cap");
  assert.match(cap.text, /at most 2 agents/);
  assert.doesNotMatch(cap.text, /\{parallelCap\}/);
});

test("precedence: project beats global beats default, rule by rule", () => {
  const root = fixture();
  const s = resolveOrchestration(root, {
    global: {
      orchestration: {
        rules: { "orch.no-polling": false, "orch.lean-lead": false },
        parallelCap: 5,
      },
    },
    project: { orchestration: { rules: { "orch.no-polling": true }, parallelCap: 3 } },
  });
  const by = Object.fromEntries(s.rules.map((r) => [r.id, r]));
  assert.equal(by["orch.no-polling"].enabled, true);
  assert.equal(by["orch.no-polling"].source, "project");
  assert.equal(by["orch.lean-lead"].enabled, false);
  assert.equal(by["orch.lean-lead"].source, "global");
  assert.equal(by["orch.isolated-env"].source, "default");
  assert.equal(s.parallelCap, 3);
  assert.equal(s.parallelCapSource, "project");
  assert.match(by["orch.parallel-cap"].text, /at most 3 agents/);
});

test("invalid config values are ignored, never trusted", () => {
  const s = resolveOrchestration(fixture(), {
    global: {},
    project: { orchestration: { enabled: "yes", rules: { "orch.no-polling": 0 }, parallelCap: 0 } },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.rules[0].enabled, true);
  assert.equal(s.parallelCap, 2);
});

test("minimal profile leaves the pack out unless a config turns it on", () => {
  const root = fixture();
  assert.equal(orchestrationSection(root, { global: {}, project: { profile: "minimal" } }), null);
  const on = orchestrationSection(root, {
    global: { orchestration: { enabled: true } },
    project: { profile: "minimal" },
  });
  assert.equal(on?.rules.length, REQUIRED.length);
});

test("the section is null when every rule is off; emitted rules carry their id", () => {
  const root = fixture();
  const rules = Object.fromEntries(REQUIRED.map((id) => [id, false]));
  assert.equal(
    orchestrationSection(root, { global: {}, project: { orchestration: { rules } } }),
    null,
  );
  const sec = orchestrationSection(root, { global: {}, project: {} });
  assert.equal(sec?.title, "Agent orchestration");
  for (const id of REQUIRED)
    assert.ok(
      sec?.rules.some((r) => r.endsWith(`\`[${id}]\``)),
      id,
    );
});

// --------------------------------------------------------------------------
// Emission: every target either carries the text or reads AGENTS.md.
// --------------------------------------------------------------------------

test("sync emits the pack into every target: text in AGENTS.md + Continue, pointers elsewhere", () => {
  freshHome();
  const root = fixture();
  const res = sync({ targetRoot: root });
  const agents = agentsMd(root);
  assert.match(agents, /## Agent orchestration/);
  for (const id of REQUIRED) assert.ok(agents.includes(`[${id}]`), `AGENTS.md has ${id}`);
  const cont = readFileSync(join(root, ".continue", "rules", "00-forge.md"), "utf8");
  for (const id of REQUIRED) assert.ok(cont.includes(`[${id}]`), `Continue rules have ${id}`);
  // Pointer targets read AGENTS.md, so they get exactly the same rules.
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md/m);
  const gemini = JSON.parse(readFileSync(join(root, ".gemini", "settings.json"), "utf8"));
  assert.ok(gemini.context.fileName.includes("AGENTS.md"));
  assert.match(readFileSync(join(root, ".aider.conf.yml"), "utf8"), /- AGENTS\.md/);
  for (const tool of ["Codex", "Cursor", "Copilot", "Zed", "OpenClaw", "Kimi Code"]) {
    const row = res.report.find((r) => r.tool === tool);
    assert.ok(row, `${tool} row`);
    assert.equal(row.target, "AGENTS.md", `${tool} reads AGENTS.md`);
  }
  assert.ok(Buffer.byteLength(agents) < 12 * 1024, "stays under the 12 KiB size budget");
  assert.deepEqual(res.warnings, []);
});

test("switching a rule off removes it from every text target on the next sync", () => {
  freshHome();
  const root = fixture();
  sync({ targetRoot: root });
  assert.equal(setRule(root, "orch.no-polling", false).ok, true);
  sync({ targetRoot: root });
  const cont = readFileSync(join(root, ".continue", "rules", "00-forge.md"), "utf8");
  for (const text of [agentsMd(root), cont]) {
    assert.ok(!text.includes("[orch.no-polling]"), "switched-off rule gone");
    assert.ok(text.includes("[orch.parallel-cap]"), "the others stay");
  }
  // The pack off entirely: the section disappears.
  assert.equal(setRule(root, "pack", false).ok, true);
  sync({ targetRoot: root });
  assert.doesNotMatch(agentsMd(root), /## Agent orchestration/);
  // Turning one rule back on switches the pack back on too.
  assert.equal(setRule(root, "orch.lean-lead", true).ok, true);
  sync({ targetRoot: root });
  assert.match(agentsMd(root), /\[orch\.lean-lead\]/);
});

test("global toggles apply to every repo; a repo's own setting overrides them", () => {
  const home = freshHome();
  const a = fixture();
  const b = fixture();
  const res = setRule(a, "orch.ci-heavy-checks", false, { global: true });
  assert.equal(res.ok, true);
  assert.equal(res.path, join(home, "forge.config.json"));
  assert.equal(userConfigPath(), res.path);
  assert.equal(readUserConfig().orchestration.rules["orch.ci-heavy-checks"], false);
  assert.ok(!existsSync(join(a, ".forge", "forge.config.json")), "repo config untouched");
  sync({ targetRoot: a });
  assert.ok(!agentsMd(a).includes("[orch.ci-heavy-checks]"), "global off reaches repo a");
  setRule(b, "orch.ci-heavy-checks", true);
  sync({ targetRoot: b });
  assert.ok(agentsMd(b).includes("[orch.ci-heavy-checks]"), "repo b overrides the global off");
});

test("disableSections drops the pack like any other section", () => {
  freshHome();
  const root = fixture();
  writeForgeConfig(root, (cfg) => ({ ...cfg, disableSections: ["orchestration"] }));
  sync({ targetRoot: root });
  assert.doesNotMatch(agentsMd(root), /## Agent orchestration/);
  assert.match(agentsMd(root), /## Workflow/);
});

test("parallelCap setting flows into the emitted text", () => {
  freshHome();
  const root = fixture();
  assert.equal(setSetting(root, "parallelCap", "4").ok, true);
  sync({ targetRoot: root });
  assert.match(agentsMd(root), /Run at most 4 agents in parallel/);
});

test("setRule / setSetting refuse unknown ids and bad values", () => {
  freshHome();
  const root = fixture();
  const bad = setRule(root, "orch.nope", false);
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.reason : "", /unknown rule id/);
  for (const [key, raw] of [
    ["parallelCap", "0"],
    ["parallelCap", "two"],
    ["route.mode", "yolo"],
    ["route.topTier", "always"],
    ["route.raiseConfidence", "1.5"],
    ["route.raiseConfidence", ""],
    ["route.riskFloor", "maybe"],
    ["nope", "1"],
  ])
    assert.equal(setSetting(root, key, raw).ok, false, `${key}=${raw} refused`);
  assert.ok(!existsSync(join(root, ".forge", "forge.config.json")), "nothing written");
});

test("a corrupt user-level config is reported on read and never overwritten", () => {
  const home = freshHome();
  const path = join(home, "forge.config.json");
  writeFileSync(path, "{ not json");
  assert.equal(readUserConfig().corrupt, true);
  const res = setRule(fixture(), "orch.lean-lead", false, { global: true });
  assert.equal(res.ok, false);
  assert.equal(readFileSync(path, "utf8"), "{ not json", "bytes preserved");
  // Resolution falls back to defaults instead of throwing.
  assert.equal(resolveOrchestration(fixture()).enabled, true);
});

// --------------------------------------------------------------------------
// Routing policy resolution.
// --------------------------------------------------------------------------

test("route policy: defaults, then global, then project; bad values ignored", () => {
  const root = fixture();
  const d = resolveRoutePolicy(root, { global: {}, project: {} });
  assert.equal(d.mode, "conservative");
  assert.equal(d.raiseConfidence, 0.9);
  assert.equal(d.midConfidence, 0.5);
  assert.equal(d.topTier, "explicit");
  assert.equal(d.writesCodeFloor, true);
  assert.equal(d.riskFloor, true);
  assert.deepEqual(Object.keys(d.riskCategories).sort(), [
    "auth",
    "migrations",
    "money",
    "secrets",
    "security",
  ]);
  const p = resolveRoutePolicy(root, {
    global: { route: { mode: "unattended", topTier: "never", raiseConfidence: 0.95 } },
    project: { route: { topTier: "auto", raiseConfidence: 7, midConfidence: "high" } },
  });
  assert.equal(p.mode, "unattended");
  assert.equal(p.sources.mode, "global");
  assert.equal(p.topTier, "auto");
  assert.equal(p.sources.topTier, "project");
  assert.equal(p.raiseConfidence, 0.95, "an out-of-range project value is ignored");
  assert.equal(p.midConfidence, 0.5);
});

test("route policy: risk categories are overridable, removable and extendable", () => {
  const p = resolveRoutePolicy(fixture(), {
    global: { route: { riskCategories: { money: ["ledger entry"], security: false } } },
    project: { route: { riskCategories: { compliance: ["gdpr", 42, ""] } } },
  });
  assert.deepEqual(p.riskCategories.money, ["ledger entry"]);
  assert.deepEqual(p.riskCategories.security, []);
  assert.deepEqual(p.riskCategories.compliance, ["gdpr"]);
  assert.ok(p.riskCategories.auth.includes("login"), "untouched categories keep defaults");
});

test("route policy reads the real files: project .forge/forge.config.json over the user file", () => {
  freshHome();
  const root = fixture();
  assert.equal(setSetting(root, "route.mode", "unattended", { global: true }).ok, true);
  assert.equal(resolveRoutePolicy(root).mode, "unattended");
  assert.equal(setSetting(root, "route.mode", "conservative").ok, true);
  assert.equal(resolveRoutePolicy(root).mode, "conservative");
  assert.equal(resolveRoutePolicy(fixture()).mode, "unattended", "other repos keep the global");
});

// --------------------------------------------------------------------------
// CLI.
// --------------------------------------------------------------------------

test("CLI: list, off, set --global, and errors exit non-zero", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-orch-cli-home-"));
  const root = fixture();
  mkdirSync(join(root, ".forge"));
  const env = { ...process.env, FORGE_HOME: home, FORGE_NO_HINT: "1" };
  const run = (...args) => spawnSync("node", [CLI, ...args], { cwd: root, encoding: "utf8", env });
  const off = run("orchestration", "off", "orch.lean-lead");
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /orch\.lean-lead: off \(project\)/);
  const set = run("orchestration", "set", "route.mode", "unattended", "--global");
  assert.equal(set.status, 0, set.stderr);
  const list = run("orchestration", "list", "--json");
  assert.equal(list.status, 0, list.stderr);
  const state = JSON.parse(list.stdout);
  const lean = state.rules.find((r) => r.id === "orch.lean-lead");
  assert.equal(lean.enabled, false);
  assert.equal(lean.source, "project");
  assert.equal(state.route.mode, "unattended");
  assert.equal(state.route.sources.mode, "global");
  assert.equal(state.configs.global, join(home, "forge.config.json"));
  const text = run("orchestration");
  assert.equal(text.status, 0);
  assert.match(text.stdout, /off {2}orch\.lean-lead/);
  assert.match(text.stdout, /route\.mode {13}unattended/);
  assert.equal(run("orchestration", "off", "orch.nope").status, 1);
  assert.equal(run("orchestration", "set", "route.topTier", "always").status, 1);
  assert.equal(run("orchestration", "frobnicate").status, 1);
});

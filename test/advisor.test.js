// Claude Code's advisor tool, as Forge configures it: the pairing table against the documented
// rows, alias and id parsing, config precedence, the AGENTS.md section, the `.claude/settings.json`
// emission through sync, the doctor row, the hook nudges and the `forge advisor` CLI. The
// user-level config and settings are redirected per test through FORGE_HOME / FORGE_SETTINGS_PATH
// (each test file runs in its own process, after _setup's scrub), so nothing touches a real home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptedAdvisors,
  advisorDisabledBy,
  advisorNudge,
  advisorRuleIds,
  advisorSection,
  checkPairing,
  doomLoopAdvisorHint,
  loadAdvisorPack,
  parseModel,
  rankModel,
  resetAdvisorModel,
  resolveAdvisor,
  setAdvisorModel,
  setAdvisorRule,
  suggestAdvisor,
  validateAdvisorModel,
  writeAdvisorSetting,
} from "../src/advisor.js";
import { doomLoopAdvisory } from "../src/cortex_hook.js";
import { doctor } from "../src/doctor.js";
import { readForgeConfig, readUserConfig } from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const HOOK = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), "forge-advisor-"));
/** A fresh user-level config home for one test. */
const freshHome = () => {
  process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-advisor-home-"));
  return process.env.FORGE_HOME;
};
const runCli = (args, { cwd, settingsPath, env = {} } = {}) =>
  spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_NO_HINT: "1",
      NO_COLOR: "1",
      ...(settingsPath ? { FORGE_SETTINGS_PATH: settingsPath } : {}),
      ...env,
    },
  });
const agentsMd = (root) => readFileSync(join(root, "AGENTS.md"), "utf8");
const projectSettings = (root) =>
  JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
const NO_ENV = {};

const RULES = [
  "advisor.before-approach",
  "advisor.recurring-error",
  "advisor.before-done",
  "advisor.risk",
  "advisor.evidence-wins",
  "advisor.not-for-trivia",
];

// --------------------------------------------------------------------------
// The pack and the pairing table.
// --------------------------------------------------------------------------

test("pack: every rule has a stable id, short text, a rationale and a default", () => {
  const pack = loadAdvisorPack();
  assert.deepEqual(advisorRuleIds(), RULES);
  for (const r of pack.rules) {
    assert.match(r.id, /^advisor\.[a-z-]+$/);
    assert.equal(typeof r.default, "boolean");
    assert.ok(r.text.length > 20 && r.text.length < 260, `${r.id}: short imperative text`);
    assert.ok(r.rationale.length > 20, `${r.id}: has a rationale`);
    assert.doesNotMatch(r.text, /claude|haiku|sonnet|opus|fable/i, `${r.id}: no vendor names`);
  }
  assert.match(pack.ranking.verified, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pack.ranking.rows.every((r) => Number.isInteger(r.rank) && r.label));
});

// Every row of the documented table (code.claude.com/docs/en/advisor#choose-an-advisor-model):
// main model → the advisors it accepts, with "X or later" expanded over the rows Forge knows.
const DOCS_TABLE = [
  ["claude-haiku-4-5", ["fable", "opus", "sonnet", "claude-sonnet-4-6", "claude-opus-4-6"]],
  ["claude-sonnet-4-6", ["fable", "opus", "sonnet", "claude-sonnet-4-6", "claude-opus-4-6"]],
  ["claude-opus-4-6", ["fable", "opus", "claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-4-6"]],
  ["claude-sonnet-5", ["fable", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "sonnet"]],
  ["claude-opus-4-7", ["fable", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5-5"]],
  ["claude-opus-4-8", ["fable", "claude-opus-4-7", "claude-opus-5", "claude-sonnet-5-5"]],
  ["claude-sonnet-5-5", ["fable", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5"]],
  ["claude-opus-5", ["fable", "claude-opus-5", "claude-opus-5-5", "claude-fable-5"]],
  ["claude-opus-5-5", ["fable", "claude-opus-5", "claude-opus-5-5"]],
  ["claude-fable-5", ["claude-fable-5-1", "claude-fable-5", "fable"]],
  ["claude-fable-5-1", ["claude-fable-5-1", "fable"]],
];
const DOCS_REFUSED = [
  ["claude-opus-4-6", "claude-sonnet-4-6"],
  ["claude-sonnet-5", "claude-opus-4-6"],
  ["claude-sonnet-5", "claude-sonnet-4-6"],
  ["claude-opus-4-7", "claude-sonnet-5"],
  ["claude-opus-4-8", "claude-opus-4-6"],
  ["claude-sonnet-5-5", "claude-opus-4-8"],
  ["claude-sonnet-5-5", "claude-sonnet-5"],
  ["claude-opus-5", "claude-sonnet-5-5"],
  ["claude-opus-5-5", "sonnet"],
  ["claude-fable-5", "opus"],
  ["claude-fable-5", "claude-opus-5-5"],
  ["claude-fable-5-1", "claude-fable-5"],
  ["sonnet", "haiku"],
  ["claude-haiku-4-5", "claude-haiku-4-5"],
];

test("pairing table: every documented accepted pairing is ok", () => {
  for (const [main, advisors] of DOCS_TABLE)
    for (const adv of advisors) {
      const r = checkPairing(main, adv);
      assert.equal(r.ok, true, `${main} ← ${adv}: ${r.reason}`);
    }
});

test("pairing table: every documented refusal is refused, with the reason", () => {
  for (const [main, adv] of DOCS_REFUSED) {
    const r = checkPairing(main, adv);
    assert.equal(r.ok, false, `${main} ← ${adv} must be refused`);
    assert.ok(["below", "cannot-advise"].includes(r.status), `${main} ← ${adv}: ${r.status}`);
    assert.match(r.reason, /cannot (advise|act as one)/);
  }
});

test("ranking is a total order consistent with the docs: Fable 5.1 > Fable 5 > Opus 5/5.5 > Sonnet 5.5 > Opus 4.7/4.8 > Sonnet 5 > Opus 4.6 > Sonnet 4.6 > Haiku 4.5", () => {
  const order = [
    "claude-haiku-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-sonnet-5-5",
    "claude-opus-5",
    "claude-fable-5",
    "claude-fable-5-1",
  ];
  const ranks = order.map((id) => rankModel(id).rank);
  for (let i = 1; i < ranks.length; i++)
    assert.ok(ranks[i] > ranks[i - 1], `${order[i]} above ${order[i - 1]}`);
  assert.equal(
    rankModel("claude-opus-4-8").rank,
    rankModel("claude-opus-4-7").rank,
    "4.7 and 4.8 are peers",
  );
  assert.equal(
    rankModel("claude-opus-5-5").rank,
    rankModel("claude-opus-5").rank,
    "5 and 5.5 are peers",
  );
  assert.equal(
    rankModel("claude-mythos-5-1").rank,
    rankModel("claude-fable-5-1").rank,
    "Mythos mirrors Fable",
  );
});

test("aliases resolve to the family's newest row; haiku never advises; opusplan reads as Opus", () => {
  assert.equal(rankModel("opus").label, "Opus 5.5 (opus)");
  assert.equal(rankModel("sonnet").label, "Sonnet 5.5 (sonnet)");
  assert.equal(rankModel("fable").label, "Fable 5.1 (fable)");
  assert.equal(rankModel("haiku").advises, false);
  assert.equal(checkPairing("sonnet", "opus").ok, true);
  assert.equal(checkPairing("opus", "sonnet").ok, false);
  assert.equal(
    checkPairing("fable", "opus").ok,
    false,
    "Claude Code applies no Opus advisor to a Fable main",
  );
  const op = rankModel("opusplan");
  assert.equal(op.family, "opus");
  assert.match(op.note ?? "", /executes on Sonnet/);
});

test("ids with decorations parse to the same model: namespace, [1m], Bedrock suffix, date stamp", () => {
  for (const id of [
    "claude-sonnet-5-5",
    "anthropic/claude-sonnet-5.5",
    "claude-sonnet-5-5[1m]",
    "us.anthropic.claude-sonnet-5-5-v1:0",
    "claude-sonnet-5-5-20260301",
  ]) {
    const p = parseModel(id);
    assert.equal(p.family, "sonnet", id);
    assert.equal(p.version, "5.5", id);
    assert.equal(p.alias, false, id);
  }
  assert.deepEqual(parseModel("claude-haiku-4-5-20251001"), {
    raw: "claude-haiku-4-5-20251001",
    family: "haiku",
    version: "4.5",
    alias: false,
  });
  assert.equal(parseModel("").family, null);
  assert.equal(parseModel("gpt-5").family, null);
});

test("outside the table: older models cannot pair, newer ones are unverified, unknown ones say so", () => {
  const older = checkPairing("claude-sonnet-4-5", "opus");
  assert.equal(older.ok, false);
  assert.equal(older.status, "main-unsupported");
  assert.equal(
    checkPairing("sonnet", "claude-opus-4-5").ok,
    false,
    "Opus 4.5 predates the advisor",
  );
  const newer = checkPairing("claude-sonnet-6", "opus");
  assert.equal(newer.ok, null);
  assert.equal(newer.status, "unverified");
  assert.match(newer.reason, /newer than .*pairing table/);
  assert.equal(checkPairing("gpt-5", "opus").status, "unknown-main");
  assert.equal(checkPairing("sonnet", "gpt-5").status, "unknown-advisor");
  const none = checkPairing("", "opus");
  assert.equal(none.ok, null);
  assert.equal(none.status, "no-main");
  assert.equal(none.main, null);
});

test("acceptedAdvisors lists the rows at or above the main model, newest first; suggestions follow the docs", () => {
  const a = acceptedAdvisors("claude-opus-4-8");
  assert.deepEqual(
    a.rows.map((r) => r.label),
    [
      "Fable 5.1",
      "Mythos 5.1",
      "Fable 5",
      "Mythos 5",
      "Opus 5.5",
      "Opus 5",
      "Sonnet 5.5",
      "Opus 4.8",
      "Opus 4.7",
    ],
  );
  assert.deepEqual(a.aliases, ["sonnet", "opus", "fable"]);
  assert.deepEqual(acceptedAdvisors("claude-opus-5-5").aliases, ["opus", "fable"]);
  assert.deepEqual(acceptedAdvisors("claude-fable-5-1").aliases, ["fable"]);
  assert.ok(!acceptedAdvisors().rows.some((r) => r.family === "haiku"), "haiku is never offered");
  assert.equal(suggestAdvisor("claude-haiku-4-5"), "opus");
  assert.equal(suggestAdvisor("sonnet"), "opus");
  assert.equal(suggestAdvisor("claude-opus-5-5"), "opus");
  assert.equal(suggestAdvisor("fable"), "fable");
  assert.equal(suggestAdvisor("gpt-5"), null);
});

test("validateAdvisorModel refuses haiku, pre-advisor models and garbage; accepts aliases, ids and newer versions with a note", () => {
  assert.equal(validateAdvisorModel("haiku").ok, false);
  assert.equal(validateAdvisorModel("claude-sonnet-4-5").ok, false);
  assert.equal(validateAdvisorModel("").ok, false);
  assert.equal(validateAdvisorModel("not a model").ok, false);
  assert.equal(validateAdvisorModel("gpt-5").ok, false);
  assert.deepEqual(validateAdvisorModel("opus"), { ok: true, model: "opus" });
  assert.deepEqual(validateAdvisorModel("claude-opus-5-5"), { ok: true, model: "claude-opus-5-5" });
  const newer = validateAdvisorModel("claude-opus-6");
  assert.equal(newer.ok, true);
  assert.match(newer.ok ? (newer.note ?? "") : "", /newer than/);
});

// --------------------------------------------------------------------------
// Resolution: Forge's layers over Claude Code's settings, the env kill switches.
// --------------------------------------------------------------------------

test("resolve: Forge's project config beats the global one beats Claude Code's local > project > user settings", () => {
  const root = fixture();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const userSettings = join(root, "user-settings.json");
  writeFileSync(userSettings, JSON.stringify({ advisorModel: "sonnet", model: "claude-opus-4-8" }));
  const base = { settingsPath: userSettings, env: NO_ENV };
  let s = resolveAdvisor(root, { ...base, layers: {} });
  assert.deepEqual([s.model, s.source, s.forgeConfigured], ["sonnet", "claude-user", false]);
  assert.deepEqual(s.main, { model: "claude-opus-4-8", source: "claude-user" });
  writeFileSync(
    join(root, ".claude/settings.json"),
    JSON.stringify({ advisorModel: "opus", model: "sonnet" }),
  );
  s = resolveAdvisor(root, { ...base, layers: {} });
  assert.deepEqual([s.model, s.source], ["opus", "claude-project"]);
  assert.equal(s.main.source, "claude-project");
  writeFileSync(
    join(root, ".claude/settings.local.json"),
    JSON.stringify({ advisorModel: "fable" }),
  );
  s = resolveAdvisor(root, { ...base, layers: {} });
  assert.deepEqual([s.model, s.source], ["fable", "claude-local"]);
  s = resolveAdvisor(root, {
    ...base,
    layers: { global: { advisor: { model: "claude-opus-5-5" } } },
  });
  assert.deepEqual([s.model, s.source, s.forgeConfigured], ["claude-opus-5-5", "global", true]);
  s = resolveAdvisor(root, {
    ...base,
    layers: {
      global: { advisor: { model: "claude-opus-5-5" } },
      project: { advisor: { model: "off" } },
    },
  });
  assert.deepEqual(
    [s.model, s.source, s.forgeConfigured],
    [null, "project", true],
    "off in the project wins",
  );
  assert.equal(s.pairing, null);
  // The main model: ANTHROPIC_MODEL beats every settings file; ANTHROPIC_DEFAULT_MODEL is the last resort.
  s = resolveAdvisor(root, { ...base, layers: {}, env: { ANTHROPIC_MODEL: "claude-fable-5-1" } });
  assert.deepEqual(s.main, { model: "claude-fable-5-1", source: "env" });
  const bare = fixture();
  s = resolveAdvisor(bare, {
    settingsPath: join(bare, "none.json"),
    layers: {},
    env: { ANTHROPIC_DEFAULT_MODEL: "opus" },
  });
  assert.deepEqual(s.main, { model: "opus", source: "env-default" });
});

test("resolve: the pairing verdict rides along, and invalid config values are ignored", () => {
  const root = fixture();
  const none = join(root, "none.json");
  let s = resolveAdvisor(root, {
    settingsPath: none,
    layers: { project: { advisor: { model: "sonnet" } } },
    env: { ANTHROPIC_MODEL: "claude-opus-5-5" },
  });
  assert.equal(s.pairing?.ok, false);
  assert.equal(s.pairing?.status, "below");
  s = resolveAdvisor(root, {
    settingsPath: none,
    layers: { project: { advisor: { model: 42, rules: { "advisor.risk": "no" } } } },
    env: NO_ENV,
  });
  assert.equal(s.forgeConfigured, false, "a non-string model is not a setting");
  assert.ok(
    s.rules.find((r) => r.id === "advisor.risk")?.enabled,
    "a non-boolean rule switch is ignored",
  );
  s = resolveAdvisor(root, {
    settingsPath: none,
    layers: { project: { advisor: { model: false } } },
    env: NO_ENV,
  });
  assert.deepEqual([s.model, s.forgeConfigured], [null, true], "false means off");
});

test("env kill switches: CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1, and the flag-fetch variables", () => {
  assert.equal(advisorDisabledBy(NO_ENV), null);
  assert.equal(advisorDisabledBy({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "0" }), null);
  assert.equal(
    advisorDisabledBy({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" })?.by,
    "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
  );
  assert.equal(advisorDisabledBy({ DISABLE_TELEMETRY: "1" })?.by, "DISABLE_TELEMETRY");
  assert.equal(
    advisorDisabledBy({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "yes" })?.by,
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  );
  assert.equal(advisorDisabledBy({ DISABLE_TELEMETRY: "  " }), null, "blank is unset");
  const root = fixture();
  const s = resolveAdvisor(root, {
    settingsPath: join(root, "none.json"),
    layers: { project: { advisor: { model: "opus" } } },
    env: { DISABLE_TELEMETRY: "1" },
  });
  assert.match(s.disabled?.reason ?? "", /feature-flag fetching/);
});

// --------------------------------------------------------------------------
// The AGENTS.md section and the settings emission through sync.
// --------------------------------------------------------------------------

test("section: only a Forge config layer emits it; off, no model, or every rule off → null", () => {
  const root = fixture();
  assert.equal(advisorSection(root, {}), null, "nothing configured");
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude/settings.json"), JSON.stringify({ advisorModel: "opus" }));
  assert.equal(
    advisorSection(root, {}),
    null,
    "a Claude-only pick is personal and never reaches AGENTS.md",
  );
  const sec = advisorSection(root, { global: { advisor: { model: "opus" } } });
  assert.equal(sec?.title, "Advisor");
  assert.equal(sec?.id, "advisor");
  assert.match(sec?.rules[0] ?? "", /configured: `opus`/);
  for (const id of RULES)
    assert.ok(
      sec?.rules.some((r) => r.endsWith(`\`[${id}]\``)),
      id,
    );
  assert.equal(
    advisorSection(root, {
      global: { advisor: { model: "opus" } },
      project: { advisor: { model: "off" } },
    }),
    null,
  );
  const allOff = Object.fromEntries(RULES.map((id) => [id, false]));
  assert.equal(
    advisorSection(root, { project: { advisor: { model: "opus", rules: allOff } } }),
    null,
  );
  const one = advisorSection(root, {
    project: { advisor: { model: "opus", rules: { ...allOff, "advisor.risk": true } } },
  });
  assert.equal(one?.rules.length, 2, "the lead line plus the one rule left on");
});

test("sync: a project advisor lands in .claude/settings.json and AGENTS.md; off removes it; untouched otherwise", () => {
  freshHome();
  const root = fixture();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2),
  );
  // No advisor key: the project settings file is never touched and no row is reported.
  let res = sync({ targetRoot: root });
  assert.ok(
    !res.report.some((r) => r.target === ".claude/settings.json"),
    "no row without an advisor key",
  );
  assert.deepEqual(projectSettings(root), { permissions: { allow: ["Read"] } });
  assert.doesNotMatch(agentsMd(root), /## Advisor/);
  // Set: written once, then unchanged; other keys preserved; the section appears.
  assert.equal(setAdvisorModel(root, "opus").ok, true);
  res = sync({ targetRoot: root });
  let row = res.report.find((r) => r.target === ".claude/settings.json");
  assert.deepEqual([row?.tool, row?.action], ["Claude Code", "written"]);
  assert.deepEqual(projectSettings(root), {
    permissions: { allow: ["Read"] },
    advisorModel: "opus",
  });
  assert.match(agentsMd(root), /## Advisor/);
  assert.ok(agentsMd(root).includes("[advisor.before-done]"));
  row = sync({ targetRoot: root }).report.find((r) => r.target === ".claude/settings.json");
  assert.equal(row?.action, "unchanged", "idempotent");
  // A rule switched off leaves the section on the next sync.
  assert.equal(setAdvisorRule(root, "advisor.before-done", false).ok, true);
  sync({ targetRoot: root });
  assert.ok(!agentsMd(root).includes("[advisor.before-done]"));
  assert.ok(agentsMd(root).includes("[advisor.risk]"));
  // Off: the key goes, the section goes, the other keys stay.
  assert.equal(setAdvisorModel(root, "off").ok, true);
  row = sync({ targetRoot: root }).report.find((r) => r.target === ".claude/settings.json");
  assert.equal(row?.action, "written");
  assert.match(row?.note ?? "", /removed/);
  assert.deepEqual(projectSettings(root), { permissions: { allow: ["Read"] } });
  assert.doesNotMatch(agentsMd(root), /## Advisor/);
  // Off on a repo with no settings file creates nothing.
  const bare = fixture();
  assert.equal(setAdvisorModel(bare, "off").ok, true);
  sync({ targetRoot: bare });
  assert.ok(!existsSync(join(bare, ".claude/settings.json")));
  // disableSections drops the advisor section like any other.
  assert.equal(setAdvisorModel(root, "opus").ok, true);
  const cfg = readForgeConfig(root);
  writeFileSync(
    join(root, ".forge/forge.config.json"),
    JSON.stringify({ ...cfg, disableSections: ["advisor"] }),
  );
  sync({ targetRoot: root });
  assert.doesNotMatch(agentsMd(root), /## Advisor/);
});

test("sync: a global advisor reaches AGENTS.md but never the committed project settings; a corrupt project settings file is left alone", () => {
  freshHome();
  const root = fixture();
  assert.equal(setAdvisorModel(root, "fable", { global: true }).ok, true);
  assert.equal(readUserConfig().advisor.model, "fable");
  const res = sync({ targetRoot: root });
  assert.match(agentsMd(root), /configured: `fable`/);
  assert.ok(
    !existsSync(join(root, ".claude/settings.json")),
    "global never writes the project file",
  );
  assert.ok(!res.report.some((r) => r.target === ".claude/settings.json"));
  // Corrupt project settings: refused, bytes preserved, reported.
  const other = fixture();
  mkdirSync(join(other, ".claude"), { recursive: true });
  writeFileSync(join(other, ".claude/settings.json"), "{ not json");
  setAdvisorModel(other, "opus");
  const row = sync({ targetRoot: other }).report.find((r) => r.target === ".claude/settings.json");
  assert.equal(row?.action, "skipped");
  assert.match(row?.note ?? "", /not valid JSON/);
  assert.equal(readFileSync(join(other, ".claude/settings.json"), "utf8"), "{ not json");
});

test("writeAdvisorSetting: atomic merge with a backup, refuses corrupt files, removal keeps other keys", () => {
  const root = fixture();
  const path = join(root, "nested", "settings.json");
  assert.equal(
    writeAdvisorSetting(path, null).action,
    "unchanged",
    "nothing to remove, nothing created",
  );
  assert.ok(!existsSync(path));
  assert.equal(writeAdvisorSetting(path, "opus").action, "created");
  assert.equal(writeAdvisorSetting(path, "opus").action, "unchanged");
  writeFileSync(path, JSON.stringify({ model: "sonnet", advisorModel: "opus" }));
  assert.equal(writeAdvisorSetting(path, "fable").action, "written");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    model: "sonnet",
    advisorModel: "fable",
  });
  assert.equal(writeAdvisorSetting(path, null).action, "removed");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { model: "sonnet" });
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
  writeFileSync(path, "[]");
  const r = writeAdvisorSetting(path, "opus");
  assert.equal(r.action, "error");
  assert.equal(readFileSync(path, "utf8"), "[]");
});

test("config writes: set validates first, reset removes only Forge's choice, rules switch per layer", () => {
  freshHome();
  const root = fixture();
  assert.equal(setAdvisorModel(root, "haiku").ok, false);
  assert.ok(!existsSync(join(root, ".forge/forge.config.json")), "a refused model writes nothing");
  const set = setAdvisorModel(root, "claude-opus-5-5");
  assert.equal(set.ok, true);
  assert.equal(readForgeConfig(root).advisor.model, "claude-opus-5-5");
  assert.equal(setAdvisorRule(root, "advisor.risk", false).ok, true);
  assert.equal(setAdvisorRule(root, "nope", false).ok, false);
  assert.equal(setAdvisorRule(root, "all", false, { global: true }).ok, true);
  assert.deepEqual(
    Object.values(readUserConfig().advisor.rules),
    RULES.map(() => false),
  );
  const reset = resetAdvisorModel(root);
  assert.equal(reset.ok === true && reset.had, true);
  assert.deepEqual(
    readForgeConfig(root).advisor,
    { rules: { "advisor.risk": false } },
    "rules survive a reset",
  );
  assert.equal(resetAdvisorModel(root).ok === true && resetAdvisorModel(root).had, false);
  // An empty advisor object disappears entirely.
  const clean = fixture();
  setAdvisorModel(clean, "opus");
  resetAdvisorModel(clean);
  assert.ok(!("advisor" in readForgeConfig(clean)));
});

// --------------------------------------------------------------------------
// Doctor and the hooks.
// --------------------------------------------------------------------------

test("doctor: not configured is neutral; a valid pairing is ok; a refused pairing or a kill switch warns", () => {
  freshHome();
  const root = fixture();
  const settingsPath = join(root, "user-settings.json");
  const row = () =>
    doctor({ targetRoot: root, settingsPath }).results.find((r) => r.label === "advisor");
  assert.equal(row()?.status, "na");
  assert.match(row()?.note ?? "", /not configured/);
  writeFileSync(settingsPath, JSON.stringify({ model: "sonnet", advisorModel: "opus" }));
  assert.equal(row()?.status, "ok");
  assert.match(row()?.note ?? "", /Opus 5\.5 \(opus\) advises Sonnet 5\.5 \(sonnet\)/);
  writeFileSync(settingsPath, JSON.stringify({ model: "claude-opus-5-5", advisorModel: "sonnet" }));
  assert.equal(row()?.status, "warn");
  assert.match(row()?.note ?? "", /ranks below/);
  setAdvisorModel(root, "opus");
  assert.equal(row()?.status, "ok", "the project config wins");
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
  try {
    assert.equal(row()?.status, "warn");
    assert.match(row()?.note ?? "", /CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1/);
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
  }
  setAdvisorModel(root, "off");
  assert.equal(row()?.status, "na");
  assert.match(row()?.note ?? "", /off \(project config\)/);
});

test("hook nudges: one line at a decision point only, silent otherwise and under a kill switch", () => {
  freshHome();
  const root = fixture();
  const quiet = { assumption: { shouldAsk: false }, route: { key: "sonnet" }, risk: false };
  assert.equal(advisorNudge(root, quiet, { env: NO_ENV }), "", "no advisor configured");
  setAdvisorModel(root, "opus");
  assert.equal(
    advisorNudge(root, quiet, { env: NO_ENV }),
    "",
    "a routine prompt is not a decision point",
  );
  const ask = advisorNudge(root, { ...quiet, assumption: { shouldAsk: true } }, { env: NO_ENV });
  assert.match(ask, /^- Advisor: `opus` is configured and the task is under-specified/);
  assert.match(
    advisorNudge(root, { ...quiet, route: { key: "opus" } }, { env: NO_ENV }),
    /premium tier/,
  );
  assert.match(advisorNudge(root, { ...quiet, risk: true }, { env: NO_ENV }), /risk area/);
  assert.equal(
    advisorNudge(root, { ...quiet, risk: true }, { env: { DISABLE_TELEMETRY: "1" } }),
    "",
  );
  // A pairing Claude Code would refuse is said in the same line.
  const bad = advisorNudge(
    root,
    { ...quiet, risk: true },
    { env: { ANTHROPIC_MODEL: "claude-fable-5-1" } },
  );
  assert.match(bad, /may not attach it/);
  // The doom-loop hint: the sentence rides the existing advisory, which stays pure over its events.
  assert.match(doomLoopAdvisorHint(root, { env: NO_ENV }), /Consult the advisor \(`opus`\)/);
  assert.equal(doomLoopAdvisorHint(root, { env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" } }), "");
  const fail = { type: "bash", outputSig: "sig" };
  assert.match(
    doomLoopAdvisory([fail, fail, fail], { advisorHint: "Consult the advisor (`opus`)." }),
    /don't keep patching\. Consult the advisor/,
  );
  assert.doesNotMatch(doomLoopAdvisory([fail, fail, fail]), /advisor/);
});

test("preflight hook: a risky prompt in a repo with an advisor carries the nudge; a routine one does not", () => {
  freshHome();
  const root = fixture();
  setAdvisorModel(root, "opus");
  const feed = (prompt) =>
    spawnSync("node", [HOOK, "preflight"], {
      input: JSON.stringify({ session_id: "s1", cwd: root, prompt }),
      encoding: "utf8",
      env: { ...process.env, FORGE_HOME: process.env.FORGE_HOME },
    });
  const risky = feed("add a refund endpoint for payments in src/billing.js");
  assert.equal(risky.status, 0, risky.stderr);
  const ctx = JSON.parse(risky.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Advisor: `opus` is configured/);
  // Whether a prompt is a decision point is the substrate's call; what this pins is the wiring:
  // the same prompt with the advisor off carries no nudge.
  setAdvisorModel(root, "off");
  const off = feed("add a refund endpoint for payments in src/billing.js");
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /Advisor: `opus`/);
});

// --------------------------------------------------------------------------
// The CLI.
// --------------------------------------------------------------------------

test("cli: status, set (runs sync), off, reset, rule, pairings, check and --json", () => {
  const home = freshHome();
  const root = fixture();
  const settingsPath = join(home, "user-settings.json");
  const run = (args, env) => runCli(args, { cwd: root, settingsPath, env });
  let r = run(["advisor"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /advisor: not configured/);
  assert.match(r.stdout, /advisor\.before-approach/);
  r = run(["advisor", "set", "haiku"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot act as one/);
  r = run(["advisor", "set", "opus"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /advisor = opus \(project\)/);
  assert.match(r.stdout, /\.claude\/settings\.json\s+written\s+advisorModel: opus/);
  assert.equal(projectSettings(root).advisorModel, "opus");
  assert.match(agentsMd(root), /## Advisor/);
  r = run(["advisor", "--json"]);
  const state = JSON.parse(r.stdout);
  assert.deepEqual([state.model, state.source, state.forgeConfigured], ["opus", "project", true]);
  assert.equal(state.pairing.status, "no-main");
  // A refused pairing is warned about but still saved, as Claude Code does.
  r = run(["advisor", "set", "sonnet"], { ANTHROPIC_MODEL: "claude-opus-5-5" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ranks below .* saved anyway/);
  r = run(["advisor", "set", "opus"], { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" });
  assert.match(r.stdout, /CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 disables/);
  r = run(["advisor", "rule", "off", "advisor.not-for-trivia"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readForgeConfig(root).advisor.rules["advisor.not-for-trivia"], false);
  r = run(["advisor", "rule", "sideways", "x"]);
  assert.equal(r.status, 1);
  r = run(["advisor", "off"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /advisor = off \(project\)/);
  assert.ok(!("advisorModel" in projectSettings(root)));
  assert.doesNotMatch(agentsMd(root), /## Advisor/);
  r = run(["advisor", "reset"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /choice removed \(project\)/);
  assert.ok(!("model" in (readForgeConfig(root).advisor ?? {})));
  r = run(["advisor", "pairings", "claude-sonnet-5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /main model: Sonnet 5\n/);
  assert.match(r.stdout, /suggested: opus/);
  r = run(["advisor", "pairings", "--json"]);
  const table = JSON.parse(r.stdout);
  assert.equal(
    table.pairings.find((p) => p.main === "Fable 5.1").accepted.join(),
    "Fable 5.1,Mythos 5.1",
  );
  r = run(["advisor", "check", "sonnet", "opus"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok — Opus 5\.5 \(opus\) advises Sonnet 5\.5 \(sonnet\)/);
  r = run(["advisor", "check", "opus", "sonnet"]);
  assert.equal(r.status, 1, "a refused pairing exits 1 for scripts");
  assert.match(r.stdout, /refused/);
  r = run(["advisor", "check", "claude-sonnet-6", "opus", "--json"]);
  assert.equal(r.status, 0, "unverified is not a refusal");
  assert.equal(JSON.parse(r.stdout).status, "unverified");
  r = run(["advisor", "bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown subcommand/);
  r = run(["advisor", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /forge advisor set <model\|off>/);
});

test("cli --global: writes the user-level config and the user settings file with the GLOBAL disclosure; refuses a corrupt file", () => {
  const home = freshHome();
  const root = fixture();
  const settingsPath = join(home, "claude-settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ model: "sonnet", permissions: { allow: ["Read"] } }),
  );
  let r = runCli(["advisor", "set", "fable", "--global"], { cwd: root, settingsPath });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /advisor = fable \(global\)/);
  assert.match(r.stdout, /GLOBAL — affects all repos/);
  assert.match(r.stdout, /settings: written/);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    model: "sonnet",
    permissions: { allow: ["Read"] },
    advisorModel: "fable",
  });
  assert.equal(readUserConfig().advisor.model, "fable");
  assert.ok(!existsSync(join(root, ".claude/settings.json")), "the project file is untouched");
  r = runCli(["advisor", "off", "--global"], { cwd: root, settingsPath });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /settings: removed/);
  assert.ok(!("advisorModel" in JSON.parse(readFileSync(settingsPath, "utf8"))));
  writeFileSync(settingsPath, "{ broken");
  r = runCli(["advisor", "set", "opus", "--global"], { cwd: root, settingsPath });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /settings: FAILED/);
  assert.equal(readFileSync(settingsPath, "utf8"), "{ broken");
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { read as readMetrics } from "../src/metrics.js";
import { MODELS, TIER_ORDER } from "../src/model_tiers.js";
import { setSetting } from "../src/orchestration.js";
import { setProfileModel } from "../src/providers.js";
import {
  calibrateRouting,
  describeRoute,
  emitGatewayConfig,
  meterRoute,
  routeTask,
} from "../src/route.js";
import { anthropicPage, ok, stubTransport } from "./_catalog_stub.js";

test("emitGatewayConfig writes a LiteLLM config that never pins @latest", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const path = emitGatewayConfig(root);
  assert.ok(existsSync(path));
  const yaml = readFileSync(path, "utf8");
  assert.match(yaml, /model_list/);
  assert.doesNotMatch(yaml, /@latest|:latest/);
  assert.match(yaml, /forge-simple/, "tier aliases present");
  assert.match(
    yaml,
    /model_name: "claude-haiku/,
    "passthrough for real model names so plain claude-* traffic works",
  );
});

test("emitGatewayConfig resolves each tier from the live catalog and says so — no pinned date", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const offline = readFileSync(emitGatewayConfig(root), "utf8");
  assert.doesNotMatch(offline, /Models verified/, "no hard-coded verification date");
  assert.match(offline, /# id: shipped snapshot, pricing verified/);

  const t = stubTransport({
    "api.anthropic.com": ok(
      anthropicPage([
        ["claude-opus-6", "2026-08-01T00:00:00Z", "Claude Opus 6"],
        ["claude-opus-5-5", "2026-05-01T00:00:00Z", "Claude Opus 5.5"],
        ["claude-sonnet-5-5", "2026-06-01T00:00:00Z", "Claude Sonnet 5.5"],
        ["claude-haiku-5-5", "2025-10-01T00:00:00Z", "Claude Haiku 5.5"],
      ]),
    ),
  });
  const yaml = readFileSync(
    emitGatewayConfig(root, { fetchImpl: t.fetchImpl, env: { ANTHROPIC_API_KEY: "sk-test" } }),
    "utf8",
  );
  const lines = yaml.split(/\r?\n/).map((l) => l.trim());
  const alias = lines.findIndex((l) => l.startsWith("- model_name: forge-complex"));
  assert.match(lines[alias], /Claude Opus 6/, "the catalog's display name");
  assert.equal(
    lines[alias + 1],
    "# id: newest opus in the api.anthropic.com catalog, created 2026-08-01",
  );
  assert.equal(lines[alias + 2], 'litellm_params: { model: "anthropic/claude-opus-6" }');
  assert.ok(lines.includes('- model_name: "claude-opus-6"'), "the resolved id passes through");
  assert.ok(
    lines.includes('- model_name: "claude-opus-5-5"'),
    "a client pinned to the snapshot id still passes",
  );
  assert.doesNotMatch(yaml, /@latest|:latest/);
});

test("emitGatewayConfig: a catalog string can never splice a second entry into the config", () => {
  // The generated file is fed to LiteLLM as routing config, and ids/display names come from a
  // live catalog. A name carrying a newline must not add an entry: with simple-shuffle, a second
  // `forge-complex` would send a share of that tier's prompts to the spliced model.
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const evil = "\n  - model_name: forge-complex\n    litellm_params: { model: anthropic/pwned }\n#";
  const t = stubTransport({
    "api.anthropic.com": ok(
      anthropicPage([
        [`claude-opus-9${evil}`, "2026-08-01T00:00:00Z", `Opus 9"${evil}`],
        ["claude-sonnet-5-5", "2026-06-01T00:00:00Z", "Claude Sonnet 5.5"],
        ["claude-haiku-5-5", "2025-10-01T00:00:00Z", "Claude Haiku 5.5"],
      ]),
    ),
  });
  const yaml = readFileSync(
    emitGatewayConfig(root, { fetchImpl: t.fetchImpl, env: { ANTHROPIC_API_KEY: "sk-test" } }),
    "utf8",
  );
  const lines = yaml.split(/\r?\n/);
  const entries = lines.filter((l) => /^\s*- model_name:/.test(l));
  assert.equal(
    entries.filter((l) => l.includes("forge-complex")).length,
    1,
    `one complex alias only:\n${yaml}`,
  );
  // Two layers hold: the id never passed SAFE_MODEL_ID, so the tier fell back to the snapshot
  // and the hostile text is nowhere in the file…
  assert.ok(!yaml.includes("pwned"), `the spliced text never reaches the file:\n${yaml}`);
  assert.match(
    lines[lines.findIndex((l) => l.includes("forge-complex")) + 2],
    /model: "anthropic\/claude-opus-5-5"/,
    "the complex tier falls back to the snapshot id",
  );
  // …and every emitted value is a quoted scalar, so even a value that passed the id check
  // could not end its own line.
  assert.ok(
    entries.every((l) => /^\s*- model_name: (forge-\w+\s|")/.test(l)),
    `every entry name is a plain alias or a quoted id:\n${entries.join("\n")}`,
  );
  for (const l of lines.filter((l) => l.includes("litellm_params")))
    assert.match(l, /litellm_params: \{ model: "[^"]*" \}$/, l);
});

test("routing abstains for every prompt wording without verified evidence and meters no guessed tier", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  for (const task of ["fix typo", "auth money migrations secrets", "सुरक्षा प्रणाली में सुधार करें"]) {
    const rec = routeTask(root, task, { mode: "unattended", allowTop: true });
    assert.equal(rec.status, "unrated");
    assert.equal(rec.model, null);
    assert.equal(rec.score, null);
    assert.match(describeRoute(rec), /No model recommendation/);
    meterRoute(root, task, rec);
  }
  assert.deepEqual(readMetrics(root, { stage: "route" }), []);
  assert.equal(calibrateRouting(root).status, "unrated");
});

test("an explicit model selection is returned exactly and carries no inferred quality or price", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  setProfileModel(root, "anthropic", "operator-chosen-model");
  const task = "private project phrase";
  const rec = routeTask(root, task);
  assert.equal(rec.status, "configured");
  assert.equal(rec.model.id, "operator-chosen-model");
  assert.equal(rec.provenance.path, "operator-selection");
  assert.equal(rec.availability, "configured-only");
  assert.equal(rec.score, null);
  assert.equal(rec.expectedCost, null);
  meterRoute(root, task, rec);
  const events = readMetrics(root, { stage: "route" });
  assert.equal(events[0].tier, rec.model.id);
  assert.ok(!JSON.stringify(events).includes(task));
});

test("an exact pin still respects an operator's explicit top-tier prohibition", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-route-"));
  const id = MODELS[TIER_ORDER.at(-1)].id;
  setProfileModel(root, "anthropic", id);
  assert.equal(routeTask(root, "work").model.id, id);
  assert.equal(setSetting(root, "route.topTier", "never").ok, true);
  assert.equal(routeTask(root, "work", { allowTop: true }).model, null);
});

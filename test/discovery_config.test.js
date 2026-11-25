import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chooseAdvice } from "../src/decisions.js";
import { developmentPlan } from "../src/development.js";
import { diagnose, THRASH_K } from "../src/diagnose.js";
import { advisorSettings, configureAdvisor } from "../src/discovery_config.js";
import { preflightRepo } from "../src/preflight.js";
import { routeTask } from "../src/route.js";

function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), "forge-advisor-"));
  const root = join(base, "repo");
  mkdirSync(root);
  const env = { ...process.env };
  process.env.FORGE_HOME = join(base, "state");
  delete process.env.FORGE_LLM;
  delete process.env.FORGE_EVIDENCE_WEB;
  delete process.env.FORGE_WEB_SEARCH_PROVIDER;
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(base, { recursive: true, force: true });
  });
  return root;
}

test("personal settings inherit globally, isolate repos, reset and honor explicit environment", (t) => {
  const root = workspace(t);
  const other = join(root, "../other");
  mkdirSync(other);
  assert.equal(advisorSettings(root).recommendations, false);
  assert.equal(advisorSettings(root, { FORGE_EVIDENCE_WEB: "1" }).recommendations, true);
  assert.equal(advisorSettings(root, { FORGE_EVIDENCE_WEB: "0" }).recommendations, false);
  assert.equal(advisorSettings(root).decisions, false);
  const saved = configureAdvisor(root, { decisions: true, search: "serper" }, { global: true });
  assert.equal(advisorSettings(other).decisions, true);
  configureAdvisor(root, { decisions: false, search: "off" });
  assert.equal(advisorSettings(root).decisions, false);
  assert.equal(advisorSettings(other).search, "serper");
  process.env.FORGE_LLM = "1";
  assert.equal(advisorSettings(root).decisions, true);
  process.env.FORGE_LLM = "0";
  assert.equal(advisorSettings(other).decisions, false);
  delete process.env.FORGE_LLM;
  configureAdvisor(root, null);
  assert.equal(advisorSettings(root).decisions, true);
  assert.doesNotMatch(readFileSync(saved.path, "utf8"), /API_KEY/);
  assert.throws(() => configureAdvisor(root, { apiKey: "secret" }), /Unknown/);
  writeFileSync(saved.path, '{"decisions":"yes","search":"bad"}');
  assert.equal(advisorSettings(root).decisions, false);
});

test("typed advice accepts only confident offered choices and preserves deterministic fallback", (t) => {
  const root = workspace(t);
  configureAdvisor(root, { decisions: true });
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  const options = {
    root,
    state: { repeatedFailure: true },
    choices: { reproduce: "Reproduce", inspect: "Inspect callers" },
    fallback: "reproduce",
  };
  const answer =
    (choice, confidence = 0.95) =>
    () => ({
      answers: { next: { type: "choice", choice, confidence } },
    });
  assert.equal(chooseAdvice({ ...options, call: answer("inspect") }).source, "jev");
  assert.equal(chooseAdvice({ ...options, call: answer("inspect", 0.2) }).choice, "reproduce");
  assert.equal(chooseAdvice({ ...options, call: answer("execute_remote") }).choice, "reproduce");
  assert.equal(
    chooseAdvice({
      ...options,
      call: () => {
        throw new Error("offline");
      },
    }).choice,
    "reproduce",
  );
  const forbidden = () => assert.fail("transport must not receive this state");
  assert.equal(chooseAdvice({ ...options, llm: false, call: forbidden }).source, "deterministic");
  assert.equal(
    chooseAdvice({ ...options, state: "-----BEGIN OPENSSH PRIVATE KEY-----", call: forbidden })
      .source,
    "deterministic",
  );
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(chooseAdvice({ ...options, call: forbidden }).source, "deterministic");
});

test("saved Jev setup reaches routing and preflight without enabling the text model", (t) => {
  const root = workspace(t);
  configureAdvisor(root, { decisions: true, model: "jev-test" }, { global: true });
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  const payloads = [];
  const jevCall = (payload) => {
    payloads.push(payload);
    return {
      answers: Object.fromEntries(
        Object.entries(payload.questions).map(([id, q]) => [
          id,
          q.type === "noul"
            ? { type: "noul", noul: 0.95 }
            : { type: "choice", choice: "mid", confidence: 0.9 },
        ]),
      ),
    };
  };
  const run = () => assert.fail("saved Jev preference must not enable the text LLM");
  routeTask(root, "Implement a cache with tests", { jevCall, run });
  preflightRepo(root, "Implement a cache with tests", { jevCall, run, allowBuild: false });
  assert.equal(payloads.length, 1);
  assert.ok(payloads.every((p) => p.model === "jev-test"));
  configureAdvisor(root, { decisions: false });
  routeTask(root, "Implement a cache with tests", { jevCall, run });
  assert.equal(payloads.length, 1);
});

test("planning and diagnosis send only signals; model advice cannot pass checks or cancel thrash", (t) => {
  const root = workspace(t);
  configureAdvisor(root, { decisions: true });
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  const jevCall = (payload) => {
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_CANARY/);
    return { answers: { next: { type: "choice", choice: "inspect", confidence: 0.95 } } };
  };
  const plan = developmentPlan("Fix PRIVATE_CANARY", { root, hook: true, jevCall });
  assert.ok(plan.stages.every((s) => s.status === "planned"));
  assert.ok(plan.focus);
  let result;
  for (let i = 0; i < THRASH_K; i++)
    result = diagnose(root, { errorText: "TypeError PRIVATE_CANARY", jevCall });
  assert.equal(result.advice.source, "jev");
  assert.equal(result.thrash, true);
  assert.match(result.escalate, /STOP retrying/);
});

test("CLI setup/status/reset works from a repository subdirectory and never prints keys", (t) => {
  const root = workspace(t);
  mkdirSync(join(root, ".forge"));
  mkdirSync(join(root, "nested"));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  process.env.TYPESAFE_API_KEY = "PRIVATE_API_CANARY";
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "discover", ...args, "--json"], {
      cwd: join(root, "nested"),
      env: process.env,
      encoding: "utf8",
    });
  const setup = run("setup", "--global", "--decisions", "on", "--search", "brave");
  assert.equal(setup.status, 0, setup.stderr);
  assert.doesNotMatch(setup.stdout, /PRIVATE_API_CANARY/);
  assert.equal(JSON.parse(setup.stdout).status.jevReady, true);
  const status = run("status");
  assert.equal(JSON.parse(status.stdout).decisions, true);
  assert.notEqual(run("setup", "--decisions", "yes").status, 0);
  assert.notEqual(run("find", "--global", "React tools").status, 0);
  assert.equal(run("reset", "--global").status, 0);
  assert.equal(JSON.parse(run("status").stdout).decisions, false);
});

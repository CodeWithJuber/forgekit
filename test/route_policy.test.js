// Routing policy for unattended agents: the pure policy (vote raise, writes-code floor, risk
// floor, top-tier gate), its wiring into routeTask, metering, and the `forge route` flags.
// Conservative mode must leave routing exactly as it was. No network: Jev goes through the
// injectable transport, and the key is set in-file (each test file is its own process).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.TYPESAFE_API_KEY = "test-key-not-real";

import { read as readMetrics } from "../src/metrics.js";
import { resolveRoutePolicy } from "../src/orchestration.js";
import { meterRoute, routeTask } from "../src/route.js";
import { applyRoutePolicy, POLICY_TIERS, riskMatches } from "../src/route_policy.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), "forge-route-policy-"));
const DEFAULTS = resolveRoutePolicy(fixture(), { global: {}, project: {} });
const UNATTENDED = { ...DEFAULTS, mode: "unattended" };
/** A task the deterministic rubric scores at the top cutoff (≥ 0.8). */
const TOP_TASK =
  "design the architecture of a new service\n```js\nx\n```\n1. must ensure a\n2. must ensure b\n3. must ensure c\n- must d\n- must e";
const jev = (band, confidence) => () => ({
  answers: { band: { type: "choice", choice: band, confidence } },
});
const policy = (overrides = {}) => ({ ...UNATTENDED, ...overrides });
const apply = (input) =>
  applyRoutePolicy({ detTop: false, task: "tidy the code", policy: UNATTENDED, ...input });

test("tier roles come from the shipped tier order", () => {
  assert.deepEqual(POLICY_TIERS, { cheap: "haiku", mid: "sonnet", premium: "opus", top: "fable" });
});

test("riskMatches: whole words and phrases, optional plural, case-insensitive", () => {
  const cats = DEFAULTS.riskCategories;
  assert.deepEqual(riskMatches("Fix the PAYMENTS retry", cats), [
    { category: "money", keyword: "payment" },
  ]);
  assert.deepEqual(riskMatches("rotate the API key in config", cats), [
    { category: "secrets", keyword: "api key" },
  ]);
  assert.deepEqual(riskMatches("load values from .env", cats), [
    { category: "secrets", keyword: ".env" },
  ]);
  assert.deepEqual(riskMatches("update the author field", cats), [], "auth ≠ author");
  assert.deepEqual(riskMatches("rename a variable", cats), []);
  const many = riskMatches("add a migration for the login table", cats).map((r) => r.category);
  assert.deepEqual(many.sort(), ["auth", "migrations"]);
});

test("conservative mode changes nothing — not even for a confident vote or a risky task", () => {
  const r = applyRoutePolicy({
    key: "haiku",
    detTop: false,
    vote: { band: "premium", confidence: 0.99 },
    task: "refund a payment",
    policy: DEFAULTS,
  });
  assert.equal(r.key, "haiku");
  assert.deepEqual(r.steps, []);
  assert.equal(r.mode, "conservative");
});

test("unattended vote raise: premium ≥ 0.9 → premium tier; ≥ 0.5 → at least mid", () => {
  const ro = { writesCode: false };
  assert.equal(
    apply({ key: "haiku", vote: { band: "premium", confidence: 0.92 }, ...ro }).key,
    "opus",
  );
  assert.equal(
    apply({ key: "haiku", vote: { band: "premium", confidence: 0.9 }, ...ro }).key,
    "opus",
  );
  assert.equal(
    apply({ key: "haiku", vote: { band: "premium", confidence: 0.7 }, ...ro }).key,
    "sonnet",
    "a premium vote under the premium bar still counts as a mid vote",
  );
  assert.equal(
    apply({ key: "haiku", vote: { band: "mid", confidence: 0.5 }, ...ro }).key,
    "sonnet",
  );
  assert.equal(
    apply({ key: "haiku", vote: { band: "mid", confidence: 0.49 }, ...ro }).key,
    "haiku",
  );
  assert.equal(
    apply({ key: "haiku", vote: { band: "premium", confidence: null }, ...ro }).key,
    "haiku",
    "a vote without a probability (text proposer) never raises",
  );
  const raised = apply({ key: "haiku", vote: { band: "premium", confidence: 0.95 }, ...ro });
  assert.equal(raised.steps[0].step, "vote-raise");
  assert.match(raised.steps[0].reason, /p=0\.95/);
  // Thresholds are configurable.
  const strict = apply({
    key: "haiku",
    vote: { band: "premium", confidence: 0.95 },
    policy: policy({ raiseConfidence: 0.99 }),
    ...ro,
  });
  assert.equal(strict.key, "sonnet");
});

test("unattended: a vote never lowers and never reaches the top tier", () => {
  assert.equal(apply({ key: "opus", vote: { band: "cheap", confidence: 0.99 } }).key, "opus");
  const r = apply({ key: "opus", vote: { band: "premium", confidence: 1 }, allowTop: true });
  assert.equal(r.key, "opus");
});

test("writes-code floor: code-writing tasks start at mid; read-only may stay cheap", () => {
  const w = apply({ key: "haiku" });
  assert.equal(w.key, "sonnet");
  assert.equal(w.steps[0].step, "writes-code-floor");
  assert.equal(apply({ key: "haiku", writesCode: false }).key, "haiku");
  assert.equal(apply({ key: "haiku", policy: policy({ writesCodeFloor: false }) }).key, "haiku");
  assert.equal(apply({ key: "opus" }).steps.length, 0, "a floor never lowers");
});

test("risk floor: money/auth/secrets/migrations/security never below the premium tier", () => {
  for (const task of [
    "add a refund to checkout",
    "fix the login redirect",
    "rotate the private key",
    "backfill the users table",
    "patch an xss hole",
  ]) {
    const r = apply({ key: "haiku", task, writesCode: false });
    assert.equal(r.key, "opus", task);
    assert.equal(r.steps.at(-1).step, "risk-floor");
    assert.equal(r.risk.length, 1);
  }
  assert.equal(
    apply({ key: "haiku", task: "add a refund", policy: policy({ riskFloor: false }) }).key,
    "sonnet",
  );
  const custom = policy({ riskCategories: { ...DEFAULTS.riskCategories, money: [] } });
  assert.equal(apply({ key: "haiku", task: "add a refund", policy: custom }).key, "sonnet");
  assert.equal(
    apply({
      key: "haiku",
      task: "sync the ledger entry",
      policy: policy({ riskCategories: { money: ["ledger entry"] } }),
    }).key,
    "opus",
  );
});

test("top-tier gate: explicit needs --allow-top AND the deterministic score at its cutoff", () => {
  const top = (gate, allowTop, detTop = true) =>
    apply({ key: detTop ? "fable" : "opus", detTop, allowTop, policy: policy({ topTier: gate }) });
  assert.equal(top("explicit", false).key, "opus");
  assert.equal(top("explicit", false).steps.at(-1).step, "top-tier-gate");
  assert.equal(top("explicit", true).key, "fable");
  assert.equal(top("explicit", true).topTier.allowed, true);
  assert.equal(top("never", true).key, "opus");
  assert.match(top("never", true).steps.at(-1).reason, /never/);
  assert.equal(top("auto", false).key, "fable");
  assert.equal(top("explicit", true, false).key, "opus", "the flag alone never raises to top");
  assert.equal(top("auto", true, false).key, "opus");
});

// --------------------------------------------------------------------------
// routeTask wiring.
// --------------------------------------------------------------------------

test("routeTask: conservative (the default) is byte-identical to the old router", () => {
  const root = fixture();
  for (const task of ["fix a typo", "add a refund endpoint for payments", TOP_TASK]) {
    const plain = routeTask(root, task);
    const explicit = routeTask(root, task, { policy: DEFAULTS });
    assert.deepEqual(plain, explicit, task);
    assert.equal(plain.policy, undefined, "no policy block in conservative mode");
    assert.deepEqual(plain.provenance, { path: "deterministic" });
  }
  assert.equal(
    routeTask(root, TOP_TASK).key,
    "fable",
    "conservative keeps today's top-tier behaviour",
  );
  // §5.1: a confident premium vote is still deferred, never applied.
  const voted = routeTask(root, "write a function to check if a number is prime", {
    llm: true,
    jevCall: jev("premium", 0.95),
  });
  assert.equal(voted.key, "haiku");
  assert.equal(voted.provenance.path, "llm-raise-deferred");
  assert.equal(voted.llm.escalateTo, "opus");
});

test("routeTask unattended: a confident Jev premium vote raises, with provenance", () => {
  const root = fixture();
  const r = routeTask(root, "write a function to check if a number is prime", {
    llm: true,
    jevCall: jev("premium", 0.95),
    policy: UNATTENDED,
  });
  assert.equal(r.key, "opus");
  assert.equal(r.tier, "complex");
  assert.equal(r.provenance.path, "llm-raised");
  assert.equal(r.provenance.mode, "unattended");
  assert.deepEqual(r.provenance.policy, ["vote-raise"]);
  assert.equal(r.llm.direction, "raised");
  assert.equal(r.llm.escalateTo, undefined, "the vote was applied, nothing left to escalate to");
  assert.ok(r.reasons.some((x) => x.startsWith("vote-raise: haiku → opus")));
  // A weaker premium vote reaches mid; the advisory target above it is kept.
  const mid = routeTask(root, "write a function to check if a number is prime", {
    llm: true,
    jevCall: jev("premium", 0.6),
    mode: "unattended",
    writesCode: false,
  });
  assert.equal(mid.key, "sonnet");
  assert.equal(mid.llm.escalateTo, "opus");
});

test("routeTask unattended with Jev off: deterministic, floors and gate still apply", () => {
  const root = fixture();
  const key = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const r = routeTask(root, "add a refund endpoint for payments", {
      llm: true,
      jevCall: () => {
        throw new Error("must not be called without a key");
      },
      run: () => "not json",
      policy: UNATTENDED,
    });
    assert.equal(r.llm, null);
    assert.equal(r.provenance.path, "deterministic");
    assert.equal(r.key, "opus");
    assert.deepEqual(r.provenance.policy, ["writes-code-floor", "risk-floor"]);
  } finally {
    process.env.TYPESAFE_API_KEY = key;
  }
  // FORGE_LLM is scrubbed in tests: with no explicit opt-in the proposer never runs.
  const det = routeTask(root, "list the files under src", {
    policy: UNATTENDED,
    writesCode: false,
  });
  assert.equal(det.llm, null);
  assert.equal(det.key, "haiku");
});

test("routeTask unattended: the top tier only with --allow-top and a top deterministic score", () => {
  const root = fixture();
  assert.equal(routeTask(root, TOP_TASK, { policy: UNATTENDED }).key, "opus");
  assert.equal(routeTask(root, TOP_TASK, { policy: UNATTENDED, allowTop: true }).key, "fable");
  assert.equal(
    routeTask(root, TOP_TASK, { policy: policy({ topTier: "never" }), allowTop: true }).key,
    "opus",
  );
  assert.equal(routeTask(root, "fix a typo", { policy: UNATTENDED, allowTop: true }).key, "sonnet");
});

test("meterRoute records mode and policy steps with a task hash, never the task text", () => {
  const root = fixture();
  const task = "add a refund endpoint for payments";
  meterRoute(root, task, routeTask(root, task, { policy: UNATTENDED }));
  meterRoute(root, "fix a typo", routeTask(root, "fix a typo"));
  const [unattended, conservative] = readMetrics(root, { stage: "route" });
  assert.equal(unattended.tier, "complex");
  assert.equal(unattended.mode, "unattended");
  assert.deepEqual(unattended.policy, ["writes-code-floor", "risk-floor"]);
  assert.match(unattended.ref, /^[a-f0-9]{12}$/);
  assert.equal(conservative.mode, undefined, "conservative records exactly what it always did");
  assert.ok(!JSON.stringify(unattended).includes("refund"), "no task text in metrics");
});

test("CLI: --mode unattended --json gives a generic tier key and the policy block", () => {
  const root = fixture();
  const env = {
    ...process.env,
    FORGE_HOME: mkdtempSync(join(tmpdir(), "forge-route-policy-home-")),
    FORGE_NO_HINT: "1",
  };
  const run = (...args) => spawnSync("node", [CLI, ...args], { cwd: root, encoding: "utf8", env });
  const res = run("route", "add a refund endpoint for payments", "--mode", "unattended", "--json");
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.key, "opus");
  assert.equal(out.policy.mode, "unattended");
  assert.equal(out.policy.key, "opus");
  assert.deepEqual(
    out.policy.steps.map((s) => s.step),
    ["writes-code-floor", "risk-floor"],
  );
  assert.equal(out.policy.risk[0].category, "money");
  const ro = JSON.parse(
    run("route", "list the files under src", "--mode", "unattended", "--read-only", "--json")
      .stdout,
  );
  assert.equal(ro.key, "haiku");
  assert.equal(ro.policy.writesCode, false);
  const cons = JSON.parse(run("route", "add a refund endpoint for payments", "--json").stdout);
  assert.equal(cons.policy.mode, "conservative");
  assert.deepEqual(cons.policy.steps, []);
  assert.equal(run("route", "x", "--mode", "yolo").status, 1);
});

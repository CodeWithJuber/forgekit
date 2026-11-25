import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTeam, teamPlan } from "../src/evidence_team.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const decomposition = {
  mode: "workflow",
  owner: "lead",
  merge: "Combine the diagnosis and requirements",
  streams: [
    { id: "debug", role: "debug", paths: ["a.js"], acceptance: "Return a reproduction" },
    {
      id: "requirements",
      role: "requirements",
      paths: ["docs"],
      acceptance: "Cite the original contract",
    },
  ],
};
const task = "Diagnose the Jira payment timeout and identify regression tests";
test("a task only gets the read-only workers explicitly requested by its owner", (t) => {
  const root = fixture(t);
  assert.deepEqual(teamPlan("hello", { root }).assignments, []);
  assert.deepEqual(teamPlan(task, { root }).assignments, []);
  const plan = teamPlan(task, {
    root,
    decomposition,
    evidence: { symbols: [{ file: "a.js", line: 4, name: "submit" }] },
  });
  assert.deepEqual(
    plan.assignments.map((x) => x.id),
    ["debug", "requirements"],
  );
  assert.deepEqual(plan.lead.dependsOn, ["debug", "requirements"]);
  assert.ok(
    plan.assignments.every(
      (x) => !x.dependsOn.length && x.access === "read-only" && Array.isArray(x.evidence),
    ),
  );
  assert.ok(plan.assignments[0].evidence[0].includes("a.js:4"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge", "forge.config.json"),
    JSON.stringify({ orchestration: { enabled: false } }),
  );
  assert.equal(teamPlan(task, { root, decomposition }).mode, "single");
});
test("a real launch is opt-in, requires a usable host and shares the budget", async (t) => {
  const root = fixture(t);
  const recorded = [];
  const invoke = async (args, root, input, _timeout, cwd = root) => {
    recorded.push({ args, cwd, input });
    if (args.includes("--help"))
      return "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence";
    return JSON.stringify({ result: "Validated fixture", total_cost_usd: 0.015 });
  };
  await assert.rejects(runTeam(root, task, { invoke }), /requires --run/);
  await assert.rejects(runTeam(root, task, { host: "claude", invoke }), /budget-usd/);
  assert.equal(recorded.length, 0);
  const result = await runTeam(root, task, {
    host: "claude",
    budgetUsd: 0.23,
    decomposition,
    invoke,
  });
  assert.ok(result.ok);
  assert.equal(result.workers.length, 2);
  for (const { args, cwd, input } of recorded.slice(1)) {
    assert.notEqual(cwd, root);
    assert.ok(input.includes(task));
    assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.11");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.ok(!args.includes(task));
  }
  await assert.rejects(
    runTeam(root, task, {
      host: "claude",
      budgetUsd: 0.1,
      decomposition,
      invoke: async () => "no flags",
    }),
    /lacks/,
  );
});
test("missing data in one specialist is surfaced without discarding a peer report", async (t) => {
  const root = fixture(t);
  const invoke = async (args, _root, prompt) =>
    args[0] === "--help"
      ? "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence"
      : prompt.includes("reproduction")
        ? "broken JSON"
        : JSON.stringify({ result: "source: a.js:4" });
  const r = await runTeam(root, task, { host: "claude", budgetUsd: 0.2, decomposition, invoke });
  assert.equal(r.ok, false);
  assert.equal(r.workers[1].ok, true);
  assert.equal(r.workers[0].ok, false);
  const r2 = await runTeam(root, "fix typo", {
    host: "claude",
    budgetUsd: 0.1,
    invoke: async () => assert.fail(),
  });
  assert.equal(r2.workers.length, 0);
});

test("an independent review also requires an explicit selection for all profiles", (t) => {
  const root = fixture(t);
  assert.equal(teamPlan(task, { root, profile: "engineering" }).mode, "single");
  for (const profile of ["engineering", "off", "quran"])
    assert.equal(
      teamPlan("Independent review of this one-line patch", { root, profile }).mode,
      "single",
    );
  const review = teamPlan("Independent review of this one-line patch", {
    decomposition: { mode: "review" },
    root,
    profile: "engineering",
  });
  assert.equal(review.assignments.length, 1);
  assert.equal(review.assignments[0].promptCard.id, "reviewer");
  assert.equal(review.assignments[0].access, "read-only");
});
test("scoped decomposition uses worker estimates, disjoint paths and an explicit merge owner", (t) => {
  const root = fixture(t);
  const decomposition = {
    mode: "parallel",
    owner: "lead",
    merge: "One comparison table and a focused regression check",
    streams: [
      {
        id: "parse",
        role: "adoption",
        estimatedMinutes: 45,
        paths: ["services/parser"],
        acceptance: "Provide the parser's published contract",
      },
      {
        id: "validate",
        role: "verification",
        estimatedMinutes: 35,
        paths: ["services/verify"],
        acceptance: "Return a reproducer and expected test outcome",
      },
    ],
  };
  const get = () => teamPlan(task, { root, profile: "engineering", decomposition });
  assert.equal(get().assignments.length, 2);
  assert.equal(get().lead.mergeDeliverable, decomposition.merge);
  assert.match(get().assignments[1].brief, /services\/verify/);
  decomposition.streams[1].estimatedMinutes = 15;
  assert.equal(get().assignments.length, 2);
  assert.equal(get().assignments[1].timing.milliseconds, 15 * 60000);
  decomposition.streams[1].estimatedMinutes = 40;
  decomposition.streams[1].paths = ["SERVICES/PARSER/test"];
  assert.equal(get().mode, "single");
  assert.match(get().reason, /overlap/);
});

test("explicit researcher and planner streams receive only their respective workspace references", async (t) => {
  const { portableBriefs } = await import("../src/portable_team.js");
  const plan = teamPlan("Choose a workshop slot", {
    root: fixture(t),
    maxWorkers: 2,
    decomposition: {
      mode: "parallel",
      owner: "coordinator",
      merge: "Choose a slot with sufficient seats",
      streams: [
        {
          id: "demand",
          role: "researcher",
          paths: ["responses"],
          acceptance: "Return total responses",
          estimatedMinutes: 35,
        },
        {
          id: "space",
          role: "planner",
          paths: ["rooms"],
          acceptance: "Return capacity",
          estimatedMinutes: 30,
        },
      ],
    },
    evidence: {
      hits: [{ sourceId: "restricted-manual", path: "responses/private", locator: "page 4" }],
      symbols: [
        { file: "responses/count.js", line: 1, name: "count" },
        { file: "rooms/capacity.js", line: 3, name: "capacity" },
        { file: "responses-admin/private.js", line: 9, name: "private" },
      ],
    },
  });
  assert.deepEqual(
    plan.assignments.map((a) => a.role),
    ["researcher", "planner"],
  );
  const briefs = portableBriefs(
    plan,
    "Choose a workshop slot",
    "generic",
    "unscoped mirror contents",
  );
  assert.match(briefs[0].brief, /responses\/count.js:1/);
  assert.match(briefs[1].brief, /rooms\/capacity.js:3/);
  assert.doesNotMatch(briefs[0].brief, /rooms\/|restricted-manual|responses-admin|unscoped mirror/);
  assert.doesNotMatch(
    briefs[1].brief,
    /responses\/|restricted-manual|responses-admin|unscoped mirror/,
  );
});

test("native specialists inherit the host default or propagate an exact model with separate observed model attribution", async (t) => {
  const root = fixture(t);
  const calls = [];
  const invoke = async (args) => {
    if (args.includes("--help"))
      return "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence --model";
    calls.push(args);
    return JSON.stringify({
      result: "Synthetic worker reply",
      modelUsage: { "fixture-returned": {} },
    });
  };
  const options = { host: "claude", budgetUsd: 0.2, decomposition, invoke };
  const defaults = await runTeam(root, task, options);
  assert.equal(defaults.ok, true);
  assert.equal(
    calls.some((a) => a.includes("--model")),
    false,
  );
  assert.deepEqual(defaults.workers[0].reportedModels, ["fixture-returned"]);
  calls.length = 0;
  const pinned = await runTeam(root, task, { ...options, model: "fixture-selected" });
  assert.ok(calls.every((a) => a[a.indexOf("--model") + 1] === "fixture-selected"));
  assert.equal(pinned.workers[0].requestedModel, "fixture-selected");
  assert.deepEqual(pinned.workers[0].reportedModels, ["fixture-returned"]);
});

test("named workflow respects prerequisites, slot limits and unknown costs, and reuses local measurements", async (t) => {
  const root = fixture(t);
  const spec = {
    mode: "workflow",
    owner: "lead",
    merge: "Assemble the verified result",
    streams: [
      {
        id: "peer",
        role: "planner",
        paths: ["notes"],
        acceptance: "Read the meeting plan",
        estimatedMinutes: 1,
      },
      {
        id: "source",
        role: "researcher",
        paths: ["source"],
        acceptance: "Locate contract",
        estimatedMinutes: 2,
      },
      {
        id: "check",
        role: "verification",
        paths: ["source/tests"],
        acceptance: "Compare observations",
        dependsOn: ["source"],
        estimatedMinutes: 1,
      },
      {
        id: "final",
        role: "verification",
        paths: ["source/tests"],
        acceptance: "Check the final figure",
        dependsOn: ["check"],
        estimatedMinutes: 1,
      },
    ],
  };
  const calls = [];
  const invoke = async (args, _root, input) => {
    if (args[0] === "--help")
      return "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence";
    calls.push(input);
    return JSON.stringify({ result: `report for call ${calls.length}` });
  };
  const opts = { root, decomposition: spec, maxWorkers: 1, host: "claude", budgetUsd: 0.2 };
  const before = teamPlan(task, opts);
  assert.equal(before.assignments.length, 4);
  assert.equal(before.schedule.criticalPathMs, 4 * 60000);
  const run = await runTeam(root, task, { ...opts, invoke });
  assert.deepEqual(
    run.workers.map((w) => w.status),
    Array(4).fill("completed"),
  );
  assert.ok(run.workers.every((w) => w.estimatedCostUsd === null));
  assert.match(calls[0], /Locate contract/);
  assert.match(calls[1], /report for call 1/);
  assert.match(calls[3], /report for call 2/);
  assert.doesNotMatch(calls[2], /report for call/);
  spec.streams[0].estimatedMinutes = 12;
  const after = teamPlan(task, opts);
  assert.ok(
    after.assignments.every(
      (a) =>
        a.timing.source === "previous-run" &&
        a.timing.milliseconds > 0 &&
        a.timing.reportedCostUsd === null,
    ),
  );
  assert.ok(
    teamPlan(task, { ...opts, host: "kimi" }).assignments.every(
      (a) => a.timing.source === "operator-estimate",
    ),
  );

  spec.streams[1].dependsOn = ["final"];
  await assert.rejects(
    runTeam(root, task, { ...opts, invoke: async () => assert.fail() }),
    /cycle/,
  );
  spec.streams[1].dependsOn = ["absent"];
  await assert.rejects(
    runTeam(root, task, { ...opts, invoke: async () => assert.fail() }),
    /Unknown worker dependency/,
  );
});

test("scoped workers receive only checked source excerpts, secrets are redacted before handing off", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "a.js"), "export const fixture = 123;\nDB_PASSWORD=unpublishable-value");
  writeFileSync(join(root, "unrelated.js"), "UNRELATED_PRIVATE_CONTENT");
  const plan = teamPlan(task, {
    root,
    decomposition,
    evidence: { symbols: [{ file: "unrelated.js", line: 1, name: "hidden" }] },
  });
  assert.match(plan.assignments[0].evidence.join("\n"), /fixture = 123/);
  assert.doesNotMatch(
    plan.assignments.map((a) => a.evidence).join("\n"),
    /UNRELATED_PRIVATE_CONTENT|unrelated.js|unpublishable-value/,
  );
  assert.doesNotMatch(plan.assignments[1].evidence.join("\n"), /fixture = 123/);
});

test("CLI and MCP expose the same explicit dependency contract and keep planning local", async (t) => {
  const root = fixture(t);
  const streams = [...decomposition.streams.map((w) => ({ ...w }))];
  streams[1].dependsOn = ["debug"];
  const spec = { ...decomposition, streams };
  writeFileSync(join(root, "streams.json"), JSON.stringify(spec));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const command = (...args) =>
    spawnSync(process.execPath, [cli, "team", task, ...args, "--json"], {
      cwd: root,
      encoding: "utf8",
    });
  const handoff = command("--brief", "streams.json", "--max-workers", "1", "--handoff", "generic");
  assert.equal(handoff.status, 0, handoff.stderr);
  const preview = JSON.parse(handoff.stdout);
  const { evidenceTool } = await import("../src/evidence_tools.js");
  const mcp = JSON.parse(
    await evidenceTool(root, "forge_team_plan", { task, maxWorkers: 1, decomposition: spec }),
  );
  assert.equal(preview.plan.schedule.priorityBasis, "dependency-depth");
  assert.equal(mcp.schedule.priorityBasis, preview.plan.schedule.priorityBasis);
  assert.equal(mcp.parallelCap, 1);
  assert.deepEqual(
    preview.briefs.map((w) => w.dependsOn),
    mcp.assignments.map((w) => w.dependsOn),
  );
  assert.deepEqual(
    preview.briefs.map((w) => w.id),
    ["debug", "requirements"],
  );
  const reviewer = command("--review", "--handoff", "generic");
  assert.equal(reviewer.status, 0, reviewer.stderr);
  assert.deepEqual(
    JSON.parse(reviewer.stdout).briefs.map((b) => b.id),
    ["review"],
  );
  assert.notEqual(command("--brief", "streams.json", "--review").status, 0);
});

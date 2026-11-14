import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTeam, teamPlan } from "../src/evidence_team.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-team-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const task = "Diagnose the Jira payment timeout and identify regression tests";
test("keeps simple tasks with one lead and restricts fanout to repo orchestration cap", (t) => {
  const root = fixture(t);
  assert.deepEqual(teamPlan("hello", { root }).assignments, []);
  const plan = teamPlan(task, {
    root,
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
  assert.equal(teamPlan(task, { root }).mode, "single");
});
test("a real launch is opt-in, requires a usable host and shares the budget", async (t) => {
  const root = fixture(t);
  const recorded = [];
  const invoke = async (args, cwd, input) => {
    recorded.push({ args, cwd, input });
    if (args.includes("--help"))
      return "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence";
    return JSON.stringify({ result: "Validated fixture", total_cost_usd: 0.015 });
  };
  await assert.rejects(runTeam(root, task, { invoke }), /requires --run/);
  await assert.rejects(runTeam(root, task, { host: "claude", invoke }), /budget-usd/);
  assert.equal(recorded.length, 0);
  const result = await runTeam(root, task, { host: "claude", budgetUsd: 0.23, invoke });
  assert.ok(result.ok);
  assert.equal(result.workers.length, 2);
  for (const { args, cwd, input } of recorded.slice(1)) {
    assert.equal(cwd, root);
    assert.ok(input.includes(task));
    assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.11");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.ok(!args.includes(task));
  }
  await assert.rejects(
    runTeam(root, task, { host: "claude", budgetUsd: 0.1, invoke: async () => "no flags" }),
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
  const r = await runTeam(root, task, { host: "claude", budgetUsd: 0.2, invoke });
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

test("engineering profiles wait for explicit independent work, except an independent reviewer", (t) => {
  const root = fixture(t);
  assert.equal(teamPlan(task, { root, profile: "engineering" }).mode, "single");
  const review = teamPlan("Independent review of this one-line patch", {
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
  assert.match(get().reason, /30 minutes/);
  decomposition.streams[1].estimatedMinutes = 40;
  decomposition.streams[1].paths = ["SERVICES/PARSER/test"];
  assert.equal(get().mode, "single");
  assert.match(get().reason, /overlap/);
});

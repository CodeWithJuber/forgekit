import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { portableBriefs, runPortableTeam } from "../src/portable_team.js";

test("unknown hosts receive a usable worker brief without launching a provider", () => {
  const [brief] = portableBriefs(
    { assignments: [{ id: "a", brief: "Find proof.", evidence: ["file.js:2"] }] },
    "Trace this feature",
    "my-ide",
  );
  assert.equal(brief.role, "read-only specialist");
  assert.match(brief.brief, /file\.js:2/);
});
for (const host of ["kimi", "codex"])
  test(`explicit ${host} uses isolated evidence and cleans up after worker failure`, async () => {
    const paths = [];
    const invoke = async (program, args, cwd, input) => {
      assert.equal(program, host);
      if (args.includes("--help"))
        return "--agent-file --prompt --output-format --sandbox --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check";
      paths.push(cwd);
      assert.ok(!args.includes("sample-private-brief"));
      if (host === "kimi") {
        assert.match(readFileSync(args[args.indexOf("--agent-file") + 1], "utf8"), /tools: \[\]/);
        assert.equal(readFileSync(join(cwd, "AGENTS.md"), "utf8"), "sample-private-brief");
      } else {
        assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
        assert.equal(input, "sample-private-brief");
      }
      throw new Error("synthetic failure");
    };
    const r = await runPortableTeam(
      process.cwd(),
      host,
      [{ id: "review", brief: "sample-private-brief" }],
      { invoke },
    );
    assert.equal(r.ok, false);
    assert.equal(r.workers[0].id, "review");
    assert.ok(!existsSync(paths[0]));
  });

test("evidence-only native workers block failed dependency branches and finish independent work", async () => {
  const calls = [];
  const briefs = [
    { id: "source", brief: "failed-source" },
    { id: "child", brief: "unused-child", dependsOn: ["source"] },
    { id: "grandchild", brief: "unused-grandchild", dependsOn: ["child"] },
    { id: "peer", brief: "independent" },
    { id: "consumer", brief: "reconcile", dependsOn: ["peer"] },
  ];
  const invoke = async (_p, args, _cwd, input) => {
    if (args.includes("--help"))
      return "--sandbox --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check";
    calls.push(input);
    if (input === "failed-source") throw new Error("source unavailable");
    if (input === "independent") return "accepted peer evidence";
    assert.match(input, /accepted peer evidence/);
    return "observations";
  };
  const out = await runPortableTeam(process.cwd(), "codex", briefs, { invoke, maxWorkers: 2 });
  assert.equal(out.ok, false);
  assert.deepEqual(
    out.workers.map((w) => w.status),
    ["failed", "blocked", "blocked", "completed", "completed"],
  );
  assert.deepEqual(out.workers[2].blockedBy, ["child"]);
  assert.equal(calls.length, 3);
  assert.ok(out.workers.filter((w) => w.ok).every((w) => w.estimatedCostUsd === null));
});

test("ready workers fill only available slots and successors wait for their slowest prerequisite", async () => {
  const releases = new Map(),
    running = [],
    maxWorkers = 2;
  const args = ["a", "b", "c", "d", "join"].map((id) => ({
    id,
    brief: id,
    dependsOn: id === "join" ? ["a", "b"] : [],
  }));
  const invoke = async (_p, flags, _cwd, input) => {
    if (flags.includes("--help"))
      return "--sandbox --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check";
    const id = input.split("\n")[0];
    running.push(id);
    assert.ok(running.length <= maxWorkers);
    await new Promise((done) => releases.set(id, done));
    running.splice(running.indexOf(id), 1);
    return `evidence from ${id}`;
  };
  const pending = runPortableTeam(process.cwd(), "codex", args, { invoke, maxWorkers });
  await setImmediate();
  assert.deepEqual(running, ["a", "b"]);
  releases.get("b")();
  await setImmediate();
  assert.deepEqual(running, ["a", "c"]);
  releases.get("c")();
  await setImmediate();
  assert.deepEqual(running, ["a", "d"]);
  releases.get("a")();
  await setImmediate();
  assert.deepEqual(running, ["d", "join"]);
  releases.get("d")();
  releases.get("join")();
  assert.equal((await pending).ok, true);
});

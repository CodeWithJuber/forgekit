import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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

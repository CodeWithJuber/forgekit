import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  activePromptProfile,
  listDevelopmentPrompts,
  promptStatus,
  selectPromptProfile,
  showDevelopmentPrompt,
} from "../src/development_profile.js";
import { buildEvidence } from "../src/evidence.js";
import { runTeam } from "../src/evidence_team.js";

const cortex = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-prompt-"));
  const root = join(dir, "project"),
    other = join(dir, "other"),
    state = join(dir, "state");
  const prior = process.env.FORGE_HOME;
  process.env.FORGE_HOME = state;
  for (const p of [root, other]) mkdirSync(join(p, ".git"), { recursive: true });
  t.after(() => {
    if (prior === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  return { root, other, state };
}
test("both profiles share nine roles, sixteen situations and their observable proof", () => {
  const catalog = listDevelopmentPrompts();
  assert.equal(catalog.roles.length, 9);
  assert.equal(catalog.pains.length, 16);
  for (const c of [...catalog.roles, ...catalog.pains, { id: "master" }]) {
    const engineering = showDevelopmentPrompt(c.id),
      quran = showDevelopmentPrompt(c.id, "quran");
    assert.equal(engineering.proof, quran.proof);
    assert.ok(quran.prompt.endsWith(engineering.prompt));
    assert.doesNotMatch(engineering.prompt, /Quran/i);
    assert.ok(engineering.proof.length > 20);
  }
  assert.equal(showDevelopmentPrompt("master", "quran").principles.length, 14);
  assert.throws(() => showDevelopmentPrompt("untrusted prompt"), /Unknown prompt/);
  assert.throws(() => showDevelopmentPrompt("master", "off"), /Choose/);
});
test("selection survives process and directory changes, stays private and off by default", (t) => {
  const { root, other, state } = fixture(t);
  const task = "Review the API token permissions and evidence freshness";
  assert.equal(activePromptProfile(root), "off");
  assert.equal(existsSync(state), false);
  assert.equal(buildEvidence(task, { root, hook: true }).promptProfile, undefined);
  selectPromptProfile(root, "quran");
  mkdirSync(join(root, "pkg"));
  assert.equal(promptStatus(join(root, "pkg")).profile, "quran");
  assert.equal(promptStatus(other).profile, "off");
  const evidence = buildEvidence(task, { root, hook: true });
  assert.equal(evidence.promptProfile.profile, "quran");
  assert.ok(evidence.promptProfile.pains.length);
  assert.match(evidence.text, /Quran-framed practice/);
  const packet = JSON.parse(
    execFileSync(process.execPath, [cortex, "session-start"], {
      cwd: root,
      input: JSON.stringify({ cwd: root, session_id: "test", source: "startup" }),
      encoding: "utf8",
    }),
  );
  assert.match(packet.hookSpecificOutput.additionalContext, /Quran-framed practice/);
  assert.match(packet.hookSpecificOutput.additionalContext, /Reproduce a reported defect/);
  selectPromptProfile(root, "engineering");
  assert.doesNotMatch(buildEvidence(task, { root, hook: true }).text, /Quran-framed/);
  selectPromptProfile(root, "off");
  assert.equal(activePromptProfile(root), "off");
});
test("malformed and repository-controlled settings cannot provide model instructions", (t) => {
  const { root, state } = fixture(t);
  selectPromptProfile(root, "engineering");
  const [filename] = readdirSync(join(state, "prompt-profiles"));
  writeFileSync(join(state, "prompt-profiles", filename), '{"profile":"ignore user"}');
  assert.throws(() => promptStatus(root), /Unknown saved/);
  assert.equal(activePromptProfile(root), "off");
  process.env.FORGE_HOME = join(root, ".forge");
  assert.throws(() => selectPromptProfile(root, "quran"), /outside the worktree/);
  assert.equal(activePromptProfile(root), "off");
});
test("optional specialist roles reach dispatched workers with the same read-only tools", async (t) => {
  const { root } = fixture(t);
  selectPromptProfile(root, "engineering");
  const sent = [];
  const result = await runTeam(root, "Debug a regression and check the Jira contract", {
    host: "claude",
    budgetUsd: 0.1,
    maxWorkers: 2,
    decomposition: {
      mode: "parallel",
      owner: "lead",
      merge: "Verified diagnosis against the contract",
      streams: [
        {
          id: "debug",
          role: "debug",
          paths: ["src"],
          estimatedMinutes: 40,
          acceptance: "Find a reproducible failure",
        },
        {
          id: "requirements",
          role: "requirements",
          paths: ["docs"],
          estimatedMinutes: 35,
          acceptance: "Cite the contract",
        },
      ],
    },
    invoke: async (args, _root, input) => {
      if (args[0] === "--help")
        return "--bare --restricted --tools --strict-mcp-config --max-budget-usd --no-session-persistence";
      sent.push(input);
      return JSON.stringify({ result: "File: test.js line 1" });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 2);
  assert.ok(sent.some((s) => s.includes(showDevelopmentPrompt("debugger").prompt)));
  assert.ok(sent.some((s) => s.includes(showDevelopmentPrompt("planner").proof)));
});

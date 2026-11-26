import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brainStore, remember } from "../src/brain.js";
import { appendDecision, listDecisions } from "../src/decide.js";
import { ledgerLessons } from "../src/ledger_read.js";
import { loadClaims, repoLedger, tombstone } from "../src/ledger_store.js";
import { newLesson } from "../src/lessons.js";
import { save } from "../src/lessons_store.js";
import { restoreProjectMemory } from "../src/project_memory.js";
import { autoSyncIfDrifted, sync } from "../src/sync.js";

const hookEntry = fileURLToPath(new URL("../src/cortex_hook_main.js", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const hook = (mode, root, payload = {}, env = {}) => {
  const r = spawnSync(process.execPath, [hookEntry, mode], {
    cwd: root,
    input: JSON.stringify({ cwd: root, session_id: "restart", ...payload }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "forge-restart-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".forge"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.test");
  git(repo, "config", "user.name", "Test");
  return { base, repo };
}

test("Stop leaves a committed minimal block and Continue copy byte-identical after losing config", (t) => {
  const { base, repo } = fixture(t);
  writeFileSync(join(repo, ".gitignore"), ".forge/\n");
  writeFileSync(join(repo, ".forge", "forge.config.json"), '{"profile":"minimal"}');
  sync({ targetRoot: repo, tools: ["continue", "codex"] });
  git(repo, "add", "AGENTS.md", ".continue", ".gitignore");
  git(repo, "commit", "-qm", "minimal project rules");
  const fresh = join(base, "fresh");
  git(base, "clone", "-q", repo, fresh);
  const files = ["AGENTS.md", ".continue/rules/00-forge.md"];
  const original = files.map((path) => readFileSync(join(fresh, path)));
  for (let i = 0; i < 2; i++) hook("stop", fresh);
  assert.deepEqual(
    files.map((path) => readFileSync(join(fresh, path))),
    original,
  );
  assert.equal(git(fresh, "status", "--porcelain"), "");
  mkdirSync(join(fresh, ".forge"), { recursive: true });
  writeFileSync(join(fresh, ".forge", "forge.config.json"), "{");
  assert.equal(autoSyncIfDrifted(fresh).synced, false);
  assert.deepEqual(
    files.map((path) => readFileSync(join(fresh, path))),
    original,
  );
  rmSync(join(fresh, ".forge", "forge.config.json"));
  sync({ targetRoot: fresh, tools: ["continue", "codex"] });
  assert.notDeepEqual(
    readFileSync(join(fresh, "AGENTS.md")),
    original[0],
    "explicit sync may choose the standard profile",
  );
});

test("a clean clone restores committed decisions, facts and lessons without inventing evidence", (t) => {
  const { base, repo } = fixture(t);
  writeFileSync(
    join(repo, ".forge", "forge.config.json"),
    '{"profile":"minimal","portableMemory":true}',
  );
  const text = "Release migration uses two reviewed phases — café";
  const decision = appendDecision(repo, text);
  assert.equal(decision.ok, true);
  assert.ok(remember(brainStore(repo), "Release checklist", "Verify both phases locally.").ok);
  const lesson = newLesson(
    {
      id: "lsn_migration",
      scope: "symbol",
      correctedBehavior: "Retain the old handler during migration.",
      trigger: { symbols: ["migrate"] },
    },
    20000,
  );
  assert.ok(save(repo, { ...lesson, status: "active", evidenceCount: 9 }).ok);
  writeFileSync(join(repo, ".forge", "lessons", "damaged.md"), "unfinished front matter");
  git(
    repo,
    "add",
    ".forge/forge.config.json",
    ".forge/decisions.md",
    ".forge/brain/facts",
    ".forge/lessons",
  );
  git(repo, "commit", "-qm", "review project knowledge");
  const fresh = join(base, "fresh");
  git(base, "clone", "-q", repo, fresh);
  assert.equal(existsSync(repoLedger(fresh)), false);
  const beforeStartup = JSON.parse(
    execFileSync(process.execPath, [cli, "doctor", "--json"], { cwd: fresh, encoding: "utf8" }),
  );
  assert.match(
    beforeStartup.results.find((r) => r.label === "cortex").note,
    /recover committed lessons/,
  );
  assert.match(
    beforeStartup.results.find((r) => r.label === "ledger").note,
    /committed decision journal/,
  );
  const journal = join(fresh, ".forge", "decisions.md");
  writeFileSync(
    journal,
    `${readFileSync(journal, "utf8")}- **D-9999** (2026-11-25): Uncommitted draft\n`,
  );
  hook("session-start", fresh);
  const recovered = loadClaims(repoLedger(fresh));
  assert.deepEqual(recovered.map((c) => c.kind).sort(), ["decision", "fact", "lesson"]);
  assert.ok(recovered.every((c) => !c.evidence.length && !c.provenance?.author));
  const original = loadClaims(repoLedger(repo)).find((c) => c.kind === "decision");
  assert.equal(recovered.find((c) => c.kind === "decision").id, original.id);
  assert.equal(ledgerLessons(fresh)[0].id, "lsn_migration");
  assert.equal(ledgerLessons(fresh)[0].status, "candidate");
  assert.equal(listDecisions(fresh)[0].text, text);
  const run = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "ledger", ...args, "--json"], {
        cwd: fresh,
        encoding: "utf8",
      }),
    );
  assert.ok(run("query", text).results.some((row) => row.id === original.id));
  assert.ok(
    tombstone(repoLedger(fresh), original.id, { reason: "superseded", author: "test", t: 20001 })
      .ok,
  );
  assert.deepEqual(restoreProjectMemory(fresh, { force: true }), {
    decisions: 0,
    facts: 0,
    lessons: 0,
  });
  assert.ok(loadClaims(repoLedger(fresh)).find((c) => c.id === original.id).tombstone);
  const another = join(base, "standalone");
  git(base, "clone", "-q", repo, another);
  const queried = JSON.parse(
    execFileSync(process.execPath, [cli, "ledger", "query", text, "--json"], {
      cwd: another,
      encoding: "utf8",
    }),
  );
  assert.ok(queried.results.some((r) => r.id === original.id));
  assert.equal(appendDecision(another, "A later decision").id, "D-0002");
});

test("on a cold checkout questions and a missing file skip advice, research and Atlas builds", (t) => {
  const { repo } = fixture(t);
  const sentinel = join(repo, "network recorder.cjs");
  const requests = join(repo, "requests");
  writeFileSync(
    sentinel,
    `globalThis.fetch = () => { require("node:fs").appendFileSync(${JSON.stringify(requests)}, "request\\n"); throw Error("offline"); };`,
  );
  const env = {
    FORGE_EVIDENCE_WEB: "1",
    FORGE_NO_CATALOG_FETCH: "0",
    FORGE_ENFORCE: "1",
    NODE_OPTIONS: `--import=${pathToFileURL(sentinel).href}`,
  };
  hook("session-start", repo, {}, env);
  for (const prompt of ["Which language is this?", "Why are the Redis tests failing?", "continue"])
    assert.equal(hook("preflight", repo, { prompt }, env), "");
  assert.equal(
    hook(
      "failure",
      repo,
      {
        tool_name: "Bash",
        tool_input: { command: "cat missing" },
        error: "cat: missing: No such file or directory",
        pending_query: "React lookup",
      },
      env,
    ),
    "",
  );
  hook("stop", repo, {}, env);
  assert.equal(existsSync(requests), false);
  assert.equal(existsSync(join(repo, ".forge", "atlas.json")), false);
  assert.ok(hook("preflight", repo, { prompt: "Fix the parser" }, { FORGE_ENFORCE: "1" }).trim());
});

test("doctor reports its measured warning count and ordinary commands do not print an init tip", (t) => {
  const { repo } = fixture(t);
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  const json = run("doctor", "--json");
  const report = JSON.parse(json.stdout);
  assert.ok(report.warned > 0);
  assert.equal(report.warned, report.results.filter((r) => r.status === "warn").length);
  const human = run("doctor");
  assert.doesNotMatch(human.stdout, /all clear/i);
  assert.match(human.stdout, new RegExp(`${report.warned} warnings?\\b`));
  assert.equal(json.status, report.failed ? 1 : 0);
  assert.equal(human.status, json.status);
  assert.doesNotMatch(human.stderr + json.stderr + run("catalog").stderr, /Tip: run/);
  const tty = join(repo, "tty.cjs");
  writeFileSync(tty, 'Object.defineProperty(process.stderr, "isTTY", { value: true });');
  const interactive = (...args) =>
    spawnSync(process.execPath, ["--require", tty, cli, ...args], { cwd: repo, encoding: "utf8" })
      .stderr;
  assert.match(interactive(), /Tip: run/);
  assert.doesNotMatch(interactive("catalog"), /Tip: run/);
  writeFileSync(join(repo, ".forge", "forge.config.json"), "{}");
  assert.doesNotMatch(interactive(), /Tip: run/);
});

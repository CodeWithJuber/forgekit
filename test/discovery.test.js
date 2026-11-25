import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverTools, publicQuery, rankCandidates } from "../src/discovery.js";
import { configureAdvisor } from "../src/discovery_config.js";
import { runEvidence } from "../src/evidence.js";

function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), "forge-discovery-"));
  const root = join(base, "repo");
  mkdirSync(root);
  const env = { ...process.env };
  process.env.FORGE_HOME = join(base, "state");
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(base, { recursive: true, force: true });
  });
  return root;
}
const row = (name, summary, extra = {}) => ({
  provider: "GitHub",
  title: name,
  summary,
  url: `https://github.com/example/${name}`,
  checkedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  license: "MIT",
  ...extra,
});
const rows = [
  row("react-skill", "React browser testing agent skill"),
  row("react-plugin", "React browser testing editor plugin"),
  row("react-tool", "React browser testing MCP tool"),
  row("test-hook", "React browser testing pre-commit hook"),
  row("popular-rust", "Rust compiler plugin", { stars: 999999 }),
];

test("ranks observed task fit across all artifact kinds, retaining source and setup uncertainty", (t) => {
  const root = workspace(t);
  const report = rankCandidates(
    "React browser testing",
    [
      ...rows,
      rows[0],
      row("old-react", "React browser testing skill", { updatedAt: "2019-01-01" }),
      row("unknown-react", "React browser testing plugin", { license: null, updatedAt: null }),
      row("unsafe", "React skill", { url: "javascript:alert(1)" }),
    ],
    { root },
  );
  assert.deepEqual(
    new Set(report.candidates.map((c) => c.kind)),
    new Set(["skill", "plugin", "tool", "hook"]),
  );
  assert.ok(report.best);
  assert.ok(report.candidates.every((c) => c.url.startsWith("https://")));
  assert.ok(!report.candidates.some((c) => c.title === "popular-rust"));
  assert.equal(report.candidates.filter((c) => c.title === "react-skill").length, 1);
  assert.ok(
    report.candidates
      .find((c) => c.title === "unknown-react")
      .limitations.includes("License unknown"),
  );
  assert.ok(report.candidates.every((c) => c.setup.command === null));
  assert.match(report.text, /Best observed fit/);
});

test("automatic queries use repo stack and fixed vocabulary; fresh discovery bypasses cache", async (t) => {
  const root = workspace(t);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "PRIVATE_PACKAGE",
      dependencies: { react: "19.0.0", PRIVATE_DEP: "1.0.0" },
    }),
  );
  const task = "Find skills plugins tools hooks for browser testing PRIVATE_CLIENT /private/path";
  const queries = [];
  const search = async (q) => {
    queries.push(q);
    return { checkedAt: new Date().toISOString(), results: rows, warnings: [] };
  };
  const initial = await discoverTools(task, { root, search });
  assert.equal(initial.best, null);
  assert.deepEqual(queries, []);
  configureAdvisor(root, { recommendations: true });
  const first = await discoverTools(task, { root, search });
  assert.ok(first.best);
  assert.match(queries.join(" "), /React/);
  assert.doesNotMatch(queries.join(" "), /PRIVATE|private\/path/);
  const count = queries.length;
  await discoverTools(task, { root, search });
  assert.equal(queries.length, count);
  await discoverTools(task, { root, search, fresh: true });
  assert.ok(queries.length > count);
  assert.equal(publicQuery("Correct a spelling typo", root), "");
});

test("offline and user opt-out do not search; failures remain honest and never install", async (t) => {
  const root = workspace(t);
  const noSearch = async () => assert.fail("unexpected network");
  configureAdvisor(root, { recommendations: false });
  const disabled = await discoverTools("React browser testing", { root, search: noSearch });
  assert.equal(disabled.candidates.length, 0);
  configureAdvisor(root, { recommendations: true });
  const offline = await discoverTools("Find React skills", { root, fresh: true });
  assert.equal(offline.status, "offline");
  assert.equal(offline.best, null);
  assert.deepEqual(offline.queries, []);
  const rejected = await discoverTools("Find React skills", {
    root,
    web: 'api_key="private-secret-value"',
    search: noSearch,
  });
  assert.equal(rejected.status, "invalid-query");
  assert.equal(rejected.best, null);
  const failed = await discoverTools("Find React skills", {
    root,
    fresh: true,
    search: async () => {
      throw new Error("remote failure");
    },
  });
  assert.equal(failed.best, null);
  assert.ok(failed.warnings.length);
  assert.equal(existsSync(join(root, "node_modules")), false);
});

test("retrieved commands are ignored, stale metadata is visible, and Jev can abstain", (t) => {
  const root = workspace(t);
  configureAdvisor(root, { decisions: true });
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  const result = rankCandidates(
    "React",
    [
      row("old-react-skill", "React agent skill", {
        updatedAt: "2018-01-01",
        setup: { command: "touch PWNED" },
        command: "touch PWNED",
      }),
      row("credential-url", "React skill", { url: "https://user:password@example.com/repo" }),
    ],
    {
      root,
      jevCall: () => ({ answers: { next: { type: "choice", choice: "none", confidence: 0.95 } } }),
    },
  );
  assert.equal(result.best, null);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].setup.command, null);
  assert.ok(result.candidates[0].limitations.includes("No observed update within one year"));
  assert.doesNotMatch(result.text, /touch PWNED/);
  assert.equal(existsSync(join(root, "PWNED")), false);
});

test("a library's own test setup and an unrelated product stack do not establish task fit", (t) => {
  const root = workspace(t);
  const result = rankCandidates(
    "React browser testing",
    [
      row(
        "hooks",
        "React hooks library with granular tree-shakable export and native browser testing.",
      ),
      row(
        "security-suite",
        "Offensive security testing platform with browser tools. Built on Rust and React.",
      ),
      row(
        "browser-stealer",
        "Browser data extraction tool for ethical hacking and penetration testing.",
      ),
      row("browser-test-plugin", "Vite plugin for testing React components in browser mode."),
    ],
    { root },
  );
  assert.equal(result.best.title, "browser-test-plugin");
  assert.ok(!result.candidates.some((c) => c.title === "hooks"));
  assert.ok(!result.candidates.some((c) => c.title === "browser-stealer"));
  const ui = rankCandidates("React", [row("components", "React component library")], { root });
  assert.equal(ui.best?.title, "components", "component libraries still fit UI implementation");
});

test("Jev selects only existing candidates and hook evidence includes the recommendation within budget", async (t) => {
  const root = workspace(t);
  configureAdvisor(root, { decisions: true });
  process.env.TYPESAFE_API_KEY = "test-key-not-real";
  configureAdvisor(root, { recommendations: true });
  const search = async () => ({ checkedAt: new Date().toISOString(), results: rows, warnings: [] });
  const jevCall = (payload) => {
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_CANARY/);
    return { answers: { next: { type: "choice", choice: "invented-tool", confidence: 1 } } };
  };
  const report = await runEvidence("Find React browser testing skills PRIVATE_CANARY", {
    root,
    hook: true,
    search,
    jevCall,
  });
  assert.ok(report.recommendations.best);
  assert.equal(report.recommendations.decision.source, "deterministic");
  assert.match(report.text, /Best observed fit/);
  assert.ok(report.text.length <= 2600);
});

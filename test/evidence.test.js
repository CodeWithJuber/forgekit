import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runEvidence } from "../src/evidence.js";
import { evidenceTool } from "../src/evidence_tools.js";
import { initSources, syncSources } from "../src/sources.js";

function workspace(t) {
  const base = mkdtempSync(join(tmpdir(), "forge-evidence-"));
  const root = join(base, "repo");
  mkdirSync(root);
  const old = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(base, "state");
  t.after(() => {
    if (old) process.env.FORGE_HOME = old;
    else delete process.env.FORGE_HOME;
    rmSync(base, { recursive: true, force: true });
  });
  return root;
}

test("an ordinary task retrieves private rows and discloses only known public concepts, once", async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "cases.csv"), "cause,remedy\ndeadlock,LOCAL_CANARY\n");
  const cfg = initSources(root);
  writeFileSync(
    cfg.configPath,
    JSON.stringify({ sources: [{ id: "docs", provider: "local", root }] }),
  );
  assert.equal((await syncSources(root)).ok, true);
  const queries = [];
  const search = async (q) => {
    queries.push(q);
    return {
      checkedAt: "2026-11-14",
      results: [{ provider: "test", title: "public hint", url: "https://example.com/test" }],
      warnings: [],
    };
  };
  const prompt = "Fix a PostgreSQL deadlock for private-client INTERNAL-234";
  const first = await runEvidence(prompt, { root, hook: true, search });
  assert.match(first.text, /LOCAL_CANARY/);
  assert.match(first.text, /public hint/);
  assert.equal(first.web.cached, false);
  assert.equal((await runEvidence(prompt, { root, hook: true, search })).web.cached, true);
  assert.deepEqual(queries, ["PostgreSQL deadlock"]);
  const explicit = await runEvidence(prompt, { root, web: "postgres locks", search });
  assert.equal(explicit.web.cached, false);
  assert.deepEqual(queries, ["PostgreSQL deadlock", "postgres locks"]);
});

test("an unrecognized task or disabled automatic research makes zero public requests", async (t) => {
  const root = workspace(t);
  const search = async () => assert.fail("unexpected public lookup");
  const result = await runEvidence("put the label in bold", { root, hook: true, search });
  assert.equal(result.web, null);
  const prev = process.env.FORGE_EVIDENCE_WEB;
  process.env.FORGE_EVIDENCE_WEB = "0";
  try {
    assert.equal((await runEvidence("debug Redis cache", { root, hook: true, search })).web, null);
  } finally {
    if (prev) process.env.FORGE_EVIDENCE_WEB = prev;
    else delete process.env.FORGE_EVIDENCE_WEB;
  }
});

test("MCP returns scoped results and computes actual table totals", async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, "events.csv"), "issue,amount\nCACHE-14,0.1\nCACHE-14,0.2\n");
  const { configPath } = initSources(root);
  writeFileSync(configPath, JSON.stringify({ sources: [{ id: "docs", provider: "local", root }] }));
  assert.ok((await syncSources(root)).ok);
  const read = JSON.parse(
    await evidenceTool(root, "forge_source_search", {
      query: "CACHE-14",
      sourceId: "docs",
      budget: 200,
    }),
  );
  assert.equal(read.hits[0].path, "events.csv");
  const result = JSON.parse(
    await evidenceTool(root, "forge_table_aggregate", {
      path: "events.csv",
      sourceId: "docs",
      operation: "sum",
      column: "amount",
    }),
  );
  assert.equal(result.groups[0].value, "0.3");
  await assert.rejects(
    evidenceTool(root, "forge_source_read", { sourceId: "docs", recordId: "123" }),
  );
});

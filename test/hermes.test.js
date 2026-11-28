// Hermes Agent target. What has to hold:
//   1. instructions travel via the shared AGENTS.md — Hermes loads only the first project
//      context kind it finds (.hermes.md/HERMES.md, then the AGENTS.md chain, then CLAUDE.md),
//      so no second file is written and a file that outranks AGENTS.md is reported;
//   2. no MCP file is invented: Hermes reads servers only from the profile's config.yaml, so
//      the row names the one `hermes mcp add` command instead of writing anything;
//   3. no hooks are claimed, and nothing lands outside the repository.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import hermes from "../src/emit/hermes.js";
import { emitMcp, hermesAddCommand, MCP_TARGET_FILES } from "../src/emit/mcp.js";
import { checkHarnessDrift } from "../src/harness_drift.js";
import {
  detectPrimaryTool,
  detectTools,
  KNOWN_TOOLS,
  parseTools,
  rowToolKey,
} from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-hermes-"));

test("hermes is a known, selectable tool with its own on-disk signs and alias", () => {
  assert.ok(KNOWN_TOOLS.includes("hermes"));
  assert.deepEqual(parseTools("hermes-agent,Hermes"), { tools: ["hermes"], unknown: [] });
  assert.equal(rowToolKey(hermes.tool), "hermes");
  for (const marker of [".hermes", ".hermes.md", "HERMES.md"]) {
    const root = fixture();
    if (marker === ".hermes") mkdirSync(join(root, marker));
    else writeFileSync(join(root, marker), "# mine\n");
    assert.deepEqual(detectTools(root), ["hermes"], marker);
  }
  const root = fixture();
  mkdirSync(join(root, ".hermes"));
  assert.equal(detectPrimaryTool(root), "hermes");
});

test("Hermes relies on the shared AGENTS.md and writes no file of its own", () => {
  const root = fixture();
  const res = sync({ targetRoot: root, tools: ["hermes"] });
  const row = res.report.find((r) => r.tool === "Hermes Agent");
  assert.ok(row, "sync reports a Hermes row");
  assert.equal(row.target, "AGENTS.md");
  assert.equal(row.action, "relies-on-agents");
  assert.doesNotMatch(row.note, /hook/i, "forge installs nothing into Hermes's hook system");
  // A .hermes.md would OUTRANK AGENTS.md and SOUL.md is read from HERMES_HOME only, so forge
  // writes neither — and nothing under .hermes/ either.
  for (const p of [".hermes.md", "HERMES.md", "SOUL.md", ".hermes"])
    assert.ok(!existsSync(join(root, p)), `${p} not created`);
  assert.deepEqual(
    readdirSync(root)
      .filter((f) => f !== ".forge")
      .sort(),
    ["AGENTS.md"],
  );
  assert.deepEqual(res.warnings, []);
});

test("the Hermes row names the exact `hermes mcp add` command and never claims a live server", () => {
  const row = hermes.emit({ targetRoot: fixture() });
  const expected = hermesAddCommand("forge-cortex", { command: "forge", args: ["cortex-mcp"] });
  assert.equal(expected, "hermes mcp add forge-cortex --command forge --args cortex-mcp");
  assert.ok(row.note.includes(expected), row.note);
  assert.match(row.note, /profile-level/);
  assert.match(row.note, /manual/);
});

test("hermesAddCommand quotes only what needs it and puts --args last", () => {
  assert.equal(
    hermesAddCommand("srv", { command: "node", args: ["./dist/x.js", "a b"] }),
    "hermes mcp add srv --command node --args ./dist/x.js 'a b'",
  );
  assert.equal(
    hermesAddCommand("srv", { command: "my cmd" }),
    "hermes mcp add srv --command 'my cmd'",
  );
  assert.equal(
    hermesAddCommand("docs", { url: "https://mcp.example.com/mcp" }),
    "hermes mcp add docs --url https://mcp.example.com/mcp",
  );
});

test("files that outrank AGENTS.md for Hermes are reported as shadowing it", () => {
  for (const file of [".hermes.md", "HERMES.md", "AGENTS.override.md"]) {
    const root = fixture();
    writeFileSync(join(root, file), "# mine\n");
    const row = hermes.emit({ targetRoot: root });
    assert.equal(row.action, "warn", file);
    assert.ok(row.note.includes(file), row.note);
  }
  // CLAUDE.md comes after the AGENTS.md chain, so it never hides it.
  const root = fixture();
  writeFileSync(join(root, "CLAUDE.md"), "# mine\n");
  assert.equal(hermes.emit({ targetRoot: root }).action, "relies-on-agents");
});

test("Hermes has no project MCP target: emitMcp writes nothing for it", () => {
  const root = fixture();
  const rows = emitMcp({
    targetRoot: root,
    servers: { "forge-cortex": { command: "forge", args: ["cortex-mcp"] } },
    tools: ["hermes"],
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(readdirSync(root), []);
  assert.ok(!MCP_TARGET_FILES.some((t) => t.includes("hermes")));
});

test("harness drift reports Hermes MCP as a manual profile step", () => {
  const root = fixture();
  sync({ targetRoot: root, tools: ["hermes"] });
  const report = checkHarnessDrift(root, ["hermes"]);
  const manual = report.checks.find((c) => c.host === "hermes" && c.status === "manual");
  assert.ok(manual, JSON.stringify(report.checks));
  assert.match(manual.reason, /hermes mcp add forge-cortex/);
  assert.equal(report.ok, true);
});

test("re-running sync for Hermes is a no-op, and `all` includes it", () => {
  const root = fixture();
  sync({ targetRoot: root, tools: ["hermes"] });
  const again = sync({ targetRoot: root, tools: ["hermes"] });
  assert.equal(again.report.find((r) => r.tool === "shared source").action, "unchanged");
  assert.equal(again.report.find((r) => r.tool === "Hermes Agent").action, "relies-on-agents");
  const all = sync({ targetRoot: fixture(), tools: "all" });
  assert.ok(all.report.find((r) => r.tool === "Hermes Agent"));
  const none = sync({ targetRoot: fixture(), tools: ["claude"] });
  assert.equal(
    none.report.find((r) => r.tool === "Hermes Agent"),
    undefined,
  );
});

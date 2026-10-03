// Kimi Code target. Kimi reads AGENTS.md natively (merged from the project root to the working
// directory, `${KIMI_AGENTS_MD}`), so forge writes no Kimi-specific file: the canonical rules
// reach it through the shared AGENTS.md, like Codex, Copilot and OpenClaw.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import kimi from "../src/emit/kimi.js";
import { detectTools, KNOWN_TOOLS, parseTools, rowToolKey } from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-kimi-"));

test("kimi is a known, selectable tool with its own on-disk sign and aliases", () => {
  assert.ok(KNOWN_TOOLS.includes("kimi"));
  assert.deepEqual(parseTools("kimi-cli,kimi-code"), { tools: ["kimi"], unknown: [] });
  assert.equal(rowToolKey(kimi.tool), "kimi");
  const root = fixture();
  mkdirSync(join(root, ".kimi"));
  assert.deepEqual(detectTools(root), ["kimi"]);
});

test("Kimi relies on the shared AGENTS.md — no second instruction file, no .kimi copy", () => {
  const root = fixture();
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.tool === "Kimi Code");
  assert.ok(row, "sync reports a Kimi row");
  assert.equal(row.target, "AGENTS.md");
  assert.equal(row.action, "relies-on-agents");
  assert.ok(!existsSync(join(root, ".kimi")), "nothing Kimi-specific is written");
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /## Agent orchestration/);
});

test("a tool selection without kimi emits no Kimi row", () => {
  const res = sync({ targetRoot: fixture(), tools: ["claude"] });
  assert.equal(
    res.report.find((r) => r.tool === "Kimi Code"),
    undefined,
  );
  const only = sync({ targetRoot: fixture(), tools: ["kimi"] });
  assert.ok(only.report.find((r) => r.tool === "Kimi Code"));
});

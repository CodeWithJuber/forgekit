// Pi (the pi coding agent) target. What has to hold:
//   1. instructions travel via the shared AGENTS.md — Pi loads the first of AGENTS.override.md,
//      AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD per directory, so no second file is written
//      and a root AGENTS.override.md is reported as shadowing it;
//   2. MCP lands in `.pi/mcp.json` under `mcpServers` (Pi's documented project file), and the
//      row says Pi reads it only after project trust;
//   3. it is idempotent, non-destructive and reversible like every other JSON target;
//   4. nothing else under `.pi/` is invented (no settings, extensions or system prompt files).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emitMcp, MCP_TARGET_FILES, PI_TARGET } from "../src/emit/mcp.js";
import pi from "../src/emit/pi.js";
import { addIntegration, removeIntegration } from "../src/integrations.js";
import {
  detectPrimaryTool,
  detectTools,
  KNOWN_TOOLS,
  parseTools,
  rowToolKey,
} from "../src/repo_config.js";
import { sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-pi-"));
const readTarget = (root) => JSON.parse(readFileSync(join(root, PI_TARGET), "utf8"));

test("pi is a known, selectable tool with its own on-disk sign and aliases", () => {
  assert.ok(KNOWN_TOOLS.includes("pi"));
  assert.deepEqual(parseTools("pi-agent,pi-coding-agent,Pi"), { tools: ["pi"], unknown: [] });
  assert.equal(rowToolKey(pi.tool), "pi");
  assert.equal(rowToolKey("Pi MCP"), "pi");
  assert.equal(rowToolKey("Pick"), null, "the label match is a whole word");
  const root = fixture();
  mkdirSync(join(root, ".pi"));
  assert.deepEqual(detectTools(root), ["pi"]);
  assert.equal(detectPrimaryTool(root), "pi");
});

test("Pi relies on the shared AGENTS.md — no second instruction file", () => {
  const root = fixture();
  const res = sync({ targetRoot: root, tools: ["pi"] });
  const row = res.report.find((r) => r.tool === "Pi");
  assert.ok(row, "sync reports a Pi row");
  assert.equal(row.target, "AGENTS.md");
  assert.equal(row.action, "relies-on-agents");
  assert.match(row.note, /trust/, "the project-trust step is named");
  assert.doesNotMatch(row.note, /hook/i, "forge installs no Pi extension");
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /## Agent orchestration/);
  // Only the MCP file is written under .pi/: settings, extensions and system-prompt files are
  // Pi features forge has nothing to put in.
  assert.deepEqual(readdirSync(join(root, ".pi")), ["mcp.json"]);
  assert.ok(!existsSync(join(root, "PI.md")));
});

test("a root AGENTS.override.md is reported as shadowing AGENTS.md for Pi", () => {
  const root = fixture();
  writeFileSync(join(root, "AGENTS.override.md"), "# mine\n");
  const row = pi.emit({ targetRoot: root });
  assert.equal(row.action, "warn");
  assert.match(row.note, /AGENTS\.override\.md/);
  // CLAUDE.md is lower in Pi's per-directory order, so it never shadows AGENTS.md.
  const other = fixture();
  writeFileSync(join(other, "CLAUDE.md"), "# mine\n");
  assert.equal(pi.emit({ targetRoot: other }).action, "relies-on-agents");
});

test("sync writes Pi's `.pi/mcp.json` in the mcpServers shape", () => {
  const root = fixture();
  const res = sync({ targetRoot: root, tools: ["pi"] });
  const doc = readTarget(root);
  assert.deepEqual(Object.keys(doc), ["mcpServers"]);
  assert.deepEqual(doc.mcpServers["forge-cortex"], { command: "forge", args: ["cortex-mcp"] });
  const row = res.report.find((r) => r.target === PI_TARGET);
  assert.equal(row.tool, "Pi MCP");
  assert.equal(row.action, "written");
});

test("Pi gets remote servers as url + an environment bearer header, with no transport type", () => {
  const root = fixture();
  const servers = { remote: { url: "https://mcp.example.com/mcp", tokenEnv: "EXAMPLE_TOKEN" } };
  emitMcp({ targetRoot: root, servers, tools: ["pi"] });
  assert.deepEqual(readTarget(root).mcpServers.remote, {
    url: "https://mcp.example.com/mcp",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Pi expands ${EXAMPLE_TOKEN} from the environment; it must stay a literal string
    headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
  });
});

test("re-running sync leaves the Pi artifact byte-identical", () => {
  const root = fixture();
  sync({ targetRoot: root, tools: ["pi"] });
  const first = readFileSync(join(root, PI_TARGET), "utf8");
  const second = sync({ targetRoot: root, tools: ["pi"] });
  assert.equal(readFileSync(join(root, PI_TARGET), "utf8"), first, "bytes unchanged");
  assert.equal(second.report.find((r) => r.target === PI_TARGET).action, "unchanged");
});

test("a user's own Pi MCP keys and same-name server survive emission", () => {
  const root = fixture();
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(
    join(root, PI_TARGET),
    `${JSON.stringify(
      {
        autoEnableCodemode: false,
        mcpServers: {
          "forge-cortex": { command: "my-own-forge", args: ["serve"] },
          mine: { url: "https://mine.example.com/mcp", exposure: "direct" },
        },
      },
      null,
      2,
    )}\n`,
  );
  const res = sync({ targetRoot: root, tools: ["pi"] });
  const doc = readTarget(root);
  assert.equal(doc.autoEnableCodemode, false);
  assert.deepEqual(doc.mcpServers.mine, {
    url: "https://mine.example.com/mcp",
    exposure: "direct",
  });
  assert.deepEqual(doc.mcpServers["forge-cortex"], { command: "my-own-forge", args: ["serve"] });
  const row = res.report.find((r) => r.target === PI_TARGET);
  assert.equal(row.action, "skipped");
  assert.match(row.note, /user-owned/);
});

test("Pi is an ownable MCP target: integrations add then remove round-trips", () => {
  const root = fixture();
  assert.ok(MCP_TARGET_FILES.includes(PI_TARGET), "target is in the ownership domain");
  const added = addIntegration("context7", { targetRoot: root, adopt: false });
  assert.equal(added.ok, true, added.reason);
  assert.ok(readTarget(root).mcpServers.context7, "context7 landed in .pi/mcp.json");
  const removed = removeIntegration("context7", { targetRoot: root });
  assert.equal(removed.ok, true, removed.reason);
  assert.equal(readTarget(root).mcpServers.context7, undefined, "removal reverses the add");
  assert.ok(readTarget(root).mcpServers["forge-cortex"], "the registry server stays");
});

test("a tool selection without pi writes nothing under .pi/; `all` includes it", () => {
  const root = fixture();
  const res = sync({ targetRoot: root, tools: ["claude"] });
  assert.equal(
    res.report.find((r) => rowToolKey(r.tool) === "pi"),
    undefined,
  );
  assert.ok(!existsSync(join(root, ".pi")));
  const all = sync({ targetRoot: fixture(), tools: "all" });
  assert.ok(all.report.find((r) => r.tool === "Pi"));
  assert.ok(all.report.find((r) => r.tool === "Pi MCP"));
});

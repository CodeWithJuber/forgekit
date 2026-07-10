import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMMANDS } from "../src/commands.js";
import { TOOLS } from "../src/cortex_mcp.js";
import { docsCheck, envVarsRead } from "../src/docs_check.js";

// A fixture tree whose docs are generated FROM the real registries, so it passes by
// construction — each test then breaks exactly one claim and asserts the reconciler
// catches it. `mutate` edits the file map before writing.
function fixtureRoot(mutate = (files) => files) {
  const root = mkdtempSync(join(tmpdir(), "forge-docs-"));
  const allCommands = Object.keys(COMMANDS)
    .map((c) => `| \`forge ${c}\` | ... |`)
    .join("\n");
  const allTools = TOOLS.map((t) => `- \`${t.name}\``).join("\n");
  const envDocs = "Set FORGE_FIXTURE_VAR to tune the fixture.";
  const files = {
    "package.json": JSON.stringify({ name: "fixture", version: "1.2.3" }),
    "README.md": `# fixture\n${allCommands}\n${allTools}\n${TOOLS.length} MCP tools\n${envDocs}\n`,
    "docs/GUIDE.md": `# guide\n${allCommands}\n`,
    "ARCHITECTURE.md": "# arch\n",
    "ROADMAP.md": "# roadmap\n",
    "CHANGELOG.md":
      "# Changelog\n\n## [Unreleased]\n\n- pending thing\n\n## [1.2.3] - 2026-01-01\n\n- shipped thing\n",
    "src/a.js": "const v = process.env.FORGE_FIXTURE_VAR;\n",
  };
  for (const [rel, content] of Object.entries(mutate({ ...files }))) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("docsCheck: a fully consistent tree passes clean", () => {
  const r = docsCheck({ root: fixtureRoot() });
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
});

test("docsCheck: an implemented command missing from README is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "README.md": f["README.md"].replace("| `forge config` | ... |\n", ""),
  }));
  const r = docsCheck({ root });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.check === "commands" && /forge config.*README/.test(i.detail)));
});

test("docsCheck: a documented command that does not exist is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "docs/GUIDE.md": `${f["docs/GUIDE.md"]}\nUse \`forge frobnicate\` to frob.\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some((i) => i.check === "commands" && /frobnicate.*no such command/.test(i.detail)),
  );
});

test("docsCheck: an env var src reads but no doc mentions is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "src/a.js": `${f["src/a.js"]}const w = process.env.FORGE_SECRET_KNOB;\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(r.issues.some((i) => i.check === "env-vars" && i.detail.includes("FORGE_SECRET_KNOB")));
});

test("docsCheck: a phantom env var documented but never read is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "ROADMAP.md": `${f["ROADMAP.md"]}Injects LITELLM_GATEWAY_URL so calls route through the proxy.\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some((i) => i.check === "env-vars" && /LITELLM_GATEWAY_URL.*phantom/.test(i.detail)),
  );
});

test("docsCheck: env vars read by shell guards count as read (no false phantom)", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "README.md": `${f["README.md"]}Tune FORGE_GUARD_KNOB for the guard.\n`,
    "global/guards/g.sh": 'x="${FORGE_GUARD_KNOB:-10}"\n',
  }));
  const r = docsCheck({ root });
  assert.equal(
    r.issues.filter((i) => i.detail.includes("FORGE_GUARD_KNOB")).length,
    0,
    "a guard-read var documented in README is fully consistent",
  );
  assert.ok(envVarsRead(root).has("FORGE_GUARD_KNOB"));
});

test("docsCheck: an MCP tool-count claim that disagrees with the registry is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\nExposes 3 MCP tools.\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(r.issues.some((i) => i.check === "mcp-tools" && /claims 3.*serves \d+/.test(i.detail)));
});

test("docsCheck: an undocumented MCP tool is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "README.md": f["README.md"].replace(`- \`${TOOLS[0].name}\`\n`, ""),
  }));
  const r = docsCheck({ root });
  assert.ok(r.issues.some((i) => i.check === "mcp-tools" && i.detail.includes(TOOLS[0].name)));
});

test("docsCheck: empty release sections and version mismatch are flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "CHANGELOG.md":
      "# Changelog\n\n## [Unreleased]\n\n## [9.9.9] - 2026-01-01\n\n## [1.2.3] - 2025-12-01\n\n- old\n",
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some(
      (i) => i.check === "changelog" && /\[9\.9\.9\].*package\.json is 1\.2\.3/.test(i.detail),
    ),
    "latest header must match package.json",
  );
  assert.ok(
    r.issues.some(
      (i) => i.check === "changelog" && /\[9\.9\.9\] is an empty header/.test(i.detail),
    ),
    "empty released section flagged",
  );
});

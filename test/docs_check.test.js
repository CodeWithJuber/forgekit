import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMMANDS } from "../src/commands.js";
import { docsCheck, envVarsRead } from "../src/docs_check.js";
import { TOOLS } from "../src/mcp_tools.js";
import { MODELS } from "../src/model_tiers.js";

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

// A theme that carries the actual brand color VALUES (ember #f26430 + warm-black
// #171310), not just the `%%{init` directive.
const BRAND_INIT =
  "%%{init: {'theme':'base','themeVariables':{'primaryColor':'#201a15','lineColor':'#f26430','tertiaryColor':'#171310'}}}%%";

test("docsCheck: a branded mermaid diagram with <br/> passes; diagrams is a checked dimension", () => {
  const good = `\`\`\`mermaid\n${BRAND_INIT}\nflowchart LR\n  A["a<br/>b"] --> B["c"]\n\`\`\`\n`;
  const r = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\n${good}`,
    })),
  });
  assert.deepEqual(r.issues, []);
  assert.ok(r.checked.includes("diagrams"));
});

test("docsCheck: a mermaid theme missing the brand color values is flagged", () => {
  // Has `%%{init` but not the brand.json hexes — declares a theme, renders off-brand.
  const bad = "```mermaid\n%%{init: {'theme':'base'}}%%\nflowchart LR\n  A --> B\n```\n";
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\n${bad}`,
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some((i) => i.check === "diagrams" && /missing the brand/.test(i.detail)),
    "a theme without the brand hexes is flagged",
  );
});

test("docsCheck: an unstyled mermaid diagram (no branded theme) is flagged", () => {
  const bad = "```mermaid\nflowchart LR\n  A --> B\n```\n";
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\n${bad}`,
  }));
  const r = docsCheck({ root });
  assert.ok(r.issues.some((i) => i.check === "diagrams" && /no branded.*theme/.test(i.detail)));
});

test("docsCheck: a mermaid node with a literal \\n is flagged (renders as garbage on GitHub)", () => {
  const bad = "```mermaid\n%%{init: {'theme':'base'}}%%\nflowchart LR\n  A[\"x\\ny\"] --> B\n```\n";
  const root = fixtureRoot((f) => ({
    ...f,
    "docs/GUIDE.md": `${f["docs/GUIDE.md"]}\n${bad}`,
  }));
  const r = docsCheck({ root });
  assert.ok(r.issues.some((i) => i.check === "diagrams" && /literal.*\\n/.test(i.detail)));
});

test("docsCheck: a price matching no model is flagged; a real model price passes", () => {
  const haiku = MODELS.haiku;
  const bad = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "docs/GUIDE.md": `${f["docs/GUIDE.md"]}\nRoutes to ${haiku.name} ($999/$5 per M tok).\n`,
    })),
  });
  assert.ok(
    bad.issues.some(
      (i) => i.check === "model-tiers" && /\$999\/\$5.*matches no model/.test(i.detail),
    ),
    "a stale price no model has is flagged",
  );
  const good = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "docs/GUIDE.md": `${f["docs/GUIDE.md"]}\nRoutes to ${haiku.name} ($${haiku.inCost}/$${haiku.outCost} per M tok).\n`,
    })),
  });
  assert.deepEqual(good.issues, [], "the real price reconciles clean");
});

test("docsCheck: a README benchmark number with no measured row is flagged", () => {
  const bench =
    "# Benchmarks\n\n| comp | scenario | median | p95 | runs | notes |\n|---|---|---|---|---|---|\n| atlas | build | 42 ms | 50 ms | 5 | ok |\n";
  const bad = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "reports/benchmarks.md": bench,
      "README.md": `${f["README.md"]}\nThe gate runs in **999 ms** flat.\n`,
    })),
  });
  assert.ok(
    bad.issues.some((i) => i.check === "benchmarks" && i.detail.includes("999 ms")),
    "unmeasured claim flagged",
  );
  const good = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "reports/benchmarks.md": bench,
      "README.md": `${f["README.md"]}\nThe build runs in **42 ms** flat.\n`,
    })),
  });
  assert.deepEqual(good.issues, [], "a claim backed by a measured row reconciles clean");
});

test("docsCheck: model price attributes to the NEAREST name, not first-in-registry (no comparison false positive)", () => {
  const h = MODELS.haiku;
  const s = MODELS.sonnet;
  // A comparison sentence naming two models near ONE price: the price is Sonnet's and correct.
  const r = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "docs/GUIDE.md": `${f["docs/GUIDE.md"]}\n${s.name} costs more than ${h.name}: $${s.inCost}/$${s.outCost} per M tok.\n`,
    })),
  });
  assert.deepEqual(
    r.issues.filter((i) => i.check === "model-tiers"),
    [],
    "a correct price next to two model names must not false-positive on the farther model",
  );
});

test("docsCheck: a bolded non-benchmark ms sandwich does not false-positive", () => {
  const bench =
    "# Benchmarks\n\n| c | s | median | p95 | runs | notes |\n|---|---|---|---|---|---|\n| atlas | build | 42 ms | 50 ms | 5 | ok |\n";
  // A closing ** and the next opening ** must not pair to capture the plain "250 ms" between.
  const r = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "reports/benchmarks.md": bench,
      "README.md": `${f["README.md"]}\nThe **fast path** completes within a 250 ms budget and **holds** steady.\n`,
    })),
  });
  assert.deepEqual(
    r.issues.filter((i) => i.check === "benchmarks"),
    [],
    "a number in plain prose between two bold runs is not a benchmark claim",
  );
});

test("docsCheck: a mermaid example marked docs-check-ignore is skipped", () => {
  const bad = "<!-- docs-check-ignore -->\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
  const r = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\n${bad}`,
    })),
  });
  assert.deepEqual(
    r.issues.filter((i) => i.check === "diagrams"),
    [],
    "an intentional example diagram opts out of the theme rule",
  );
});

test("docsCheck: a Markdown link to a heading anchor that doesn't exist is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\nSee [the setup](#nonexistent-section) first.\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some((i) => i.check === "links" && /#nonexistent-section/.test(i.detail)),
    "a dead same-file anchor is caught",
  );
});

test("docsCheck: a link to a real heading — including an em-dash '--' slug — resolves clean", () => {
  // "Design — the loop" → GitHub slug "design--the-loop" (the em-dash leaves two spaces → two
  // hyphens). The resolver must NOT collapse them, or valid links false-positive.
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": "# arch\n\n## Design — the loop\n\nJump to [the loop](#design--the-loop).\n",
  }));
  const r = docsCheck({ root });
  assert.deepEqual(
    r.issues.filter((i) => i.check === "links"),
    [],
    "an em-dash heading anchor is not a false positive",
  );
});

test("docsCheck: a cross-file .md#anchor that does not resolve is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "ARCHITECTURE.md": `${f["ARCHITECTURE.md"]}\nSee [the guide](docs/GUIDE.md#ghost-heading).\n`,
  }));
  const r = docsCheck({ root });
  assert.ok(
    r.issues.some(
      (i) => i.check === "links" && /ghost-heading/.test(i.detail) && /GUIDE/.test(i.detail),
    ),
    "a dead cross-file anchor resolves against the target file and is caught",
  );
});

test("docsCheck: a ROADMAP 'Now' marker behind package.json is flagged; a current one passes", () => {
  const behind = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "ROADMAP.md": "# Roadmap\n\n## Now (`master`, v1.0.0)\nold news\n",
    })),
  });
  assert.ok(
    behind.issues.some((i) => i.check === "roadmap" && /v1\.0\.0.*1\.2\.3/.test(i.detail)),
    "a roadmap two patch/minor behind the shipped version is flagged",
  );
  const current = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "ROADMAP.md": "# Roadmap\n\n## Now (`master`, v1.2.3)\nfresh\n",
    })),
  });
  assert.deepEqual(
    current.issues.filter((i) => i.check === "roadmap"),
    [],
    "a roadmap at the shipped version reconciles clean",
  );
});

// The research crosswalk fixture: rows whose forgekit column names file tokens the
// reconciler must resolve against src/ + global/guards/ + hooks/.
const crosswalkFixture = (rows) => JSON.stringify({ meta: { title: "fixture crosswalk" }, rows });

test("docsCheck: crosswalk bindings naming real src/guard files pass; crosswalk is a checked dimension", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "global/guards/g.sh": "true\n",
    "research/formal-synthesis/crosswalk.json": crosswalkFixture([
      {
        concept: "gate",
        forgekit: "src/a.js stop hook via g.sh; reviewer agent verdict",
      },
    ]),
  }));
  const r = docsCheck({ root });
  assert.deepEqual(r.issues, []);
  assert.ok(r.checked.includes("crosswalk"));
});

test("docsCheck: a crosswalk binding naming a file that exists nowhere is flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "research/formal-synthesis/crosswalk.json": crosswalkFixture([
      {
        concept: "verification",
        forgekit: "docs-guard.sh Stop hook (blocks finish)",
      },
    ]),
  }));
  const r = docsCheck({ root });
  assert.equal(r.ok, false);
  assert.ok(
    r.issues.some(
      (i) =>
        i.check === "crosswalk" && /verification.*docs-guard\.sh.*exists nowhere/.test(i.detail),
    ),
    "a stale hook name in the crosswalk is caught",
  );
});

test("docsCheck: a kit:-prefixed crosswalk clause is the kit's binding, never flagged", () => {
  const root = fixtureRoot((f) => ({
    ...f,
    "research/formal-synthesis/crosswalk.json": crosswalkFixture([
      {
        concept: "gate",
        forgekit: "src/a.js stopGate (kit: docs-guard.sh); reviewer verdict",
      },
      {
        concept: "duality",
        forgekit: "hooks = hard layer; kit: session-context.sh + intent-router.sh",
      },
    ]),
  }));
  const r = docsCheck({ root });
  assert.deepEqual(
    r.issues.filter((i) => i.check === "crosswalk"),
    [],
    "names inside a kit: clause belong to the other repo and are not our drift",
  );
});

test("docsCheck: a corrupt crosswalk.json is flagged; a missing one is a no-op", () => {
  const corrupt = docsCheck({
    root: fixtureRoot((f) => ({
      ...f,
      "research/formal-synthesis/crosswalk.json": "{not json",
    })),
  });
  assert.ok(
    corrupt.issues.some((i) => i.check === "crosswalk" && /not valid JSON/.test(i.detail)),
    "unparseable crosswalk is an error, not a silent skip",
  );
  // The base fixture has no research/ tree at all — already asserted clean above.
  const missing = docsCheck({ root: fixtureRoot() });
  assert.deepEqual(
    missing.issues.filter((i) => i.check === "crosswalk"),
    [],
  );
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

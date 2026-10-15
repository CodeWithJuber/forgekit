import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function frontmatter(md) {
  // \r?\n throughout: a Windows checkout (autocrlf) delivers `---\r\n…`, which a bare `\n`
  // anchor won't match — the parser would return null and every frontmatter assertion fail.
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    // [\w-] — the Agent Skills spec keys include hyphenated names (allowed-tools).
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

test("lean skill has valid frontmatter and the Lean Path", () => {
  const md = read("global/tools/lean/SKILL.md");
  assert.equal(frontmatter(md)?.name, "lean");
  assert.match(md, /Lean Path/);
});

test("recall skill has valid frontmatter", () => {
  assert.equal(frontmatter(read("global/tools/recall/SKILL.md"))?.name, "recall");
});

// The Agent Skills spec requires `name` to equal the skill's directory name; a hand-picked
// list let `code-modernization` ship as `name: code-modernizer`.
test("every SKILL.md name matches its directory", () => {
  let seen = 0;
  for (const base of ["global/tools", "skills"]) {
    for (const dir of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!dir.isDirectory() || !existsSync(join(root, base, dir.name, "SKILL.md"))) continue;
      const fm = frontmatter(read(`${base}/${dir.name}/SKILL.md`));
      assert.equal(fm?.name, dir.name, `${base}/${dir.name}/SKILL.md name`);
      seen += 1;
    }
  }
  assert.ok(seen > 10, `checked ${seen} skills`);
});

// A `tools:` allowlist without MCP entries hides the Playwright / chrome-devtools MCP the
// frontend-verifier is told to screenshot with, so it inherits tools minus file writes.
test("frontend-verifier can reach MCP screenshot tools and has a Bash fallback", () => {
  const md = read("global/crew/frontend-verifier.md");
  const fm = frontmatter(md);
  assert.ok(!fm?.tools || /mcp__/.test(fm.tools), "no allowlist that excludes MCP tools");
  assert.match(fm?.disallowedTools ?? "", /Write/, "still never edits files");
  assert.match(md, /npx playwright screenshot --viewport-size=390,844/);
});

test("every crew agent declares name + description", () => {
  for (const agent of ["scout.md", "verifier.md", "frontend-verifier.md"]) {
    const fm = frontmatter(read(`global/crew/${agent}`));
    assert.ok(fm?.name, `${agent} has name`);
    assert.ok(fm?.description, `${agent} has description`);
  }
});

test("verifier crew is diff/review scoped", () => {
  assert.match(read("global/crew/verifier.md").toLowerCase(), /diff|review/);
});

test("end-to-end skills (handoff / sync-docs / catchup) have valid frontmatter naming their command", () => {
  for (const [skill, cmd] of [
    ["handoff", "forge handoff"],
    ["sync-docs", "forge docs sync"],
    ["catchup", "forge decide"],
  ]) {
    const md = read(`global/tools/${skill}/SKILL.md`);
    const fm = frontmatter(md);
    assert.equal(fm?.name, skill, `${skill} frontmatter name`);
    assert.ok(fm?.description, `${skill} has description`);
    assert.ok(md.includes(cmd), `${skill} body references \`${cmd}\``);
  }
});

test("doc-sync crew agent declares frontmatter and never edits code", () => {
  const md = read("global/crew/doc-sync.md");
  const fm = frontmatter(md);
  assert.equal(fm?.name, "doc-sync");
  assert.ok(fm?.description, "doc-sync has description");
  assert.match(md, /forge docs sync/);
  assert.match(md, /never edit code/i);
});

test("installable skill packs (skills/forge-*): Agent Skills frontmatter + progressive disclosure", () => {
  // The wave-mismatch fix: forgekit's unique machinery packaged as installable SKILL.md
  // packs (Anthropic Agent Skills spec) — copy into .claude/skills/, no CLI install needed
  // to read them. Each SKILL.md stays under 500 lines; detail lives in references/.
  const packs = {
    "forge-verify": ["gate-lattice.md", "what-verify-checks.md"],
    "forge-impact": ["reading-output.md", "thresholds.md"],
    "forge-ledger": ["evidence-model.md", "subcommands.md"],
  };
  for (const [skill, refs] of Object.entries(packs)) {
    const md = read(`skills/${skill}/SKILL.md`);
    const fm = frontmatter(md);
    assert.equal(fm?.name, skill, `${skill} frontmatter name`);
    assert.ok(fm?.description?.length > 20, `${skill} has a useful description`);
    assert.equal(fm?.license, "MIT", `${skill} declares license`);
    assert.ok(fm?.["allowed-tools"], `${skill} declares allowed-tools`);
    assert.ok(md.split("\n").length < 500, `${skill}/SKILL.md under 500 lines`);
    assert.match(md, /cp -r skills\//, `${skill} documents the install one-liner`);
    assert.match(md, /forge (verify|impact|ledger)/, `${skill} invokes the forge CLI`);
    for (const ref of refs) {
      assert.ok(md.includes(`references/${ref}`), `${skill} links references/${ref}`);
      assert.doesNotMatch(read(`skills/${skill}/references/${ref}`), /^$/, `${ref} non-empty`);
    }
  }
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assemble, sync } from "../src/sync.js";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-sync-"));

test("assemble produces markdown sections from rules data", () => {
  const md = assemble({
    title: "t",
    intro: "i",
    sections: [{ title: "Workflow", rules: ["do X"] }],
  });
  assert.match(md, /## Workflow/);
  assert.match(md, /- do X/);
});

test("emitter writes each tool target", () => {
  const root = fixture();
  sync({ targetRoot: root });
  assert.ok(existsSync(join(root, "AGENTS.md")), "AGENTS.md");
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /## Workflow/);
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /^@AGENTS\.md/m);
  const gemini = JSON.parse(readFileSync(join(root, ".gemini/settings.json"), "utf8"));
  assert.ok(gemini.context.fileName.includes("AGENTS.md"), "gemini context.fileName");
  assert.match(readFileSync(join(root, ".aider.conf.yml"), "utf8"), /read:\n\s+- AGENTS\.md/);
});

test("re-running is idempotent (nothing rewritten)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const second = sync({ targetRoot: root });
  const written = second.report.filter((r) => r.action === "written");
  assert.equal(written.length, 0, `second sync wrote ${written.map((r) => r.target)}`);
});

test("adopts an existing unmanaged CLAUDE.md: prepends @AGENTS.md, preserves content, idempotent", () => {
  const root = fixture();
  writeFileSync(join(root, "CLAUDE.md"), "# my own claude file\nkeep me\n");
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.target === "CLAUDE.md");
  assert.equal(row.action, "adopted", "existing CLAUDE.md is adopted, not skipped or clobbered");
  const after = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(after, /^@AGENTS\.md/m, "shared import wired in");
  assert.match(after, /my own claude file/, "original content preserved");
  assert.match(after, /keep me/);
  // Re-running does not re-prepend or rewrite.
  const again = sync({ targetRoot: root });
  assert.equal(again.report.find((r) => r.target === "CLAUDE.md").action, "unchanged");
  assert.equal((after.match(/@AGENTS\.md/g) || []).length, 1, "import appears exactly once");
});

test("warns when a legacy .cursorrules would shadow AGENTS.md", () => {
  const root = fixture();
  writeFileSync(join(root, ".cursorrules"), "old\n");
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.tool === "Cursor");
  assert.equal(row.action, "warn");
});

test("per-repo .forge/rules.json extends the shared source", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/rules.json"),
    JSON.stringify({ sections: [{ title: "ProjectX", rules: ["ship it"] }] }),
  );
  sync({ targetRoot: root });
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /## ProjectX/);
});

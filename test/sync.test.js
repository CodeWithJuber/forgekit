import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync, assemble } from "../src/sync.js";

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
  const gemini = JSON.parse(
    readFileSync(join(root, ".gemini/settings.json"), "utf8"),
  );
  assert.ok(
    gemini.context.fileName.includes("AGENTS.md"),
    "gemini context.fileName",
  );
  assert.match(
    readFileSync(join(root, ".aider.conf.yml"), "utf8"),
    /read:\n\s+- AGENTS\.md/,
  );
});

test("re-running is idempotent (nothing rewritten)", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const second = sync({ targetRoot: root });
  const written = second.report.filter((r) => r.action === "written");
  assert.equal(
    written.length,
    0,
    `second sync wrote ${written.map((r) => r.target)}`,
  );
});

test("does not clobber an existing unmanaged CLAUDE.md", () => {
  const root = fixture();
  writeFileSync(join(root, "CLAUDE.md"), "# my own claude file\n");
  const res = sync({ targetRoot: root });
  const row = res.report.find((r) => r.target === "CLAUDE.md");
  assert.equal(row.action, "skipped");
  assert.match(
    readFileSync(join(root, "CLAUDE.md"), "utf8"),
    /my own claude file/,
  );
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

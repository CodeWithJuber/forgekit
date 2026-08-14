import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assemble, autoSyncIfDrifted, sync } from "../src/sync.js";

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

test("a hand-edited managed body (marker intact) is detected and restored", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const agents = join(root, "AGENTS.md");
  const original = readFileSync(agents, "utf8");
  // Tamper with the body but keep the forge:sync marker line untouched.
  const tampered = original.replace(/## Workflow/, "## Workflow\n- SNEAKY injected rule");
  assert.notEqual(tampered, original, "tampering changed the body");
  writeFileSync(agents, tampered);
  const second = sync({ targetRoot: root });
  const wrote = second.report.filter((r) => r.action === "written").map((r) => r.target);
  assert.ok(
    wrote.some((t) => t.includes("AGENTS.md")),
    "sync must rewrite a body-edited AGENTS.md, not trust the intact marker",
  );
  assert.equal(readFileSync(agents, "utf8"), original, "canonical body restored");
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

test("minimal profile emits only the core-safety section (P1-02)", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/forge.config.json"), JSON.stringify({ profile: "minimal" }));
  sync({ targetRoot: root });
  const md = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(md, /## Core safety/, "core-safety present");
  assert.doesNotMatch(md, /## AI interfaces & design quality/, "full pack sections dropped");
});

test("a stored legacy profile name behaves as standard — the full pack (RA-14)", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/forge.config.json"), JSON.stringify({ profile: "web-app" }));
  sync({ targetRoot: root });
  const md = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(md, /## Workflow/, "full (standard) pack emitted");
  assert.match(md, /## AI interfaces & design quality/, "no section dropped");
});

test("corrupt forge.config.json: sync fail-opens to default rules but surfaces a warning (RA-15)", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/forge.config.json"), "{ not json");
  const res = sync({ targetRoot: root });
  assert.match(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    /## Workflow/,
    "default rules still emitted (fail-open)",
  );
  assert.ok(
    res.warnings.some((w) => w.includes("not valid JSON")),
    `warnings must mention the corrupt config: ${JSON.stringify(res.warnings)}`,
  );
});

test("legacy .forge/config.json keys are migration-read into sync's config", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  // Only the LEGACY file exists — profile stored there must still reach loadRules.
  writeFileSync(join(root, ".forge/config.json"), JSON.stringify({ profile: "minimal" }));
  sync({ targetRoot: root });
  const md = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(md, /## Core safety/, "minimal profile honored from the legacy file");
});

test("config disableSections drops a named section; config.rules appends (P1-03)", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(
    join(root, ".forge/forge.config.json"),
    JSON.stringify({
      disableSections: ["ai-ux"],
      rules: [{ title: "ProjectY", rules: ["custom rule"] }],
    }),
  );
  sync({ targetRoot: root });
  const md = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.doesNotMatch(md, /## AI interfaces & design quality/, "disabled section dropped");
  assert.match(md, /## ProjectY/, "config.rules appended");
  assert.match(md, /## Workflow/, "other sections preserved");
});

test("ME-20: invalid .forge/rules.json is fail-safe — sync does not throw, falls back, bytes preserved", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  const rulesPath = join(root, ".forge/rules.json");
  const bad = '{ "sections": [ this is not json ';
  writeFileSync(rulesPath, bad);
  let res;
  assert.doesNotThrow(() => {
    res = sync({ targetRoot: root });
  }, "corrupt legacy rules.json must never abort sync");
  // Default rules still generated (fail-open).
  assert.match(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    /## Workflow/,
    "default rules emitted despite the corrupt override",
  );
  // Surfaced as a warning, not swallowed.
  assert.ok(
    res.warnings.some((w) => w.includes("rules.json") && w.includes("not valid JSON")),
    `warnings must mention the corrupt rules.json: ${JSON.stringify(res.warnings)}`,
  );
  // Never overwritten — the user's bytes are left intact to fix.
  assert.equal(readFileSync(rulesPath, "utf8"), bad, "corrupt rules.json bytes preserved");
});

test("ME-20: valid .forge/rules.json with a non-array sections field is ignored, not thrown", () => {
  const root = fixture();
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge/rules.json"), JSON.stringify({ sections: "oops" }));
  assert.doesNotThrow(() => sync({ targetRoot: root }));
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /## Workflow/);
});

test("ME-19: a failing target write yields PARTIAL status, not unconditional success", () => {
  const root = fixture();
  // Make one emit target (CLAUDE.md) un-writable by planting a DIRECTORY at its path — the
  // claude emitter's read/write then throws, sync catches it as an action:"error" row.
  mkdirSync(join(root, "CLAUDE.md"), { recursive: true });
  let res;
  assert.doesNotThrow(() => {
    res = sync({ targetRoot: root });
  }, "one failing target must not abort the whole sync");
  const errors = res.report.filter((r) => r.action === "error");
  assert.ok(errors.length >= 1, "the failed target is recorded as an error row");
  assert.equal(res.partial, true, "any error row makes the aggregate PARTIAL");
  assert.equal(res.status, "PARTIAL");
  // Other targets still succeeded — AGENTS.md was written before the failure.
  assert.ok(existsSync(join(root, "AGENTS.md")), "earlier targets are still emitted");
});

test("ME-19: an all-clean sync reports status OK / partial:false", () => {
  const root = fixture();
  const res = sync({ targetRoot: root });
  assert.equal(res.partial, false);
  assert.equal(res.status, "OK");
});

test("RA-16: a hand-edited AGENTS.md body with an INTACT marker still counts as drift", () => {
  const root = fixture();
  sync({ targetRoot: root });
  const p = join(root, "AGENTS.md");
  const lines = readFileSync(p, "utf8").split("\n");
  // Keep line 0 (the GENERATED header with the forge:sync:<hash> marker), tamper the body.
  writeFileSync(
    p,
    [lines[0], "# AGENTS.md — quietly rewritten by hand", ...lines.slice(2)].join("\n"),
  );
  const r = autoSyncIfDrifted(root);
  assert.equal(r.synced, true, "marker-only agreement must not pass as in-sync");
  const restored = readFileSync(p, "utf8");
  assert.doesNotMatch(restored, /quietly rewritten by hand/, "body restored from canonical");
  assert.equal(autoSyncIfDrifted(root).synced, false, "after repair: full bytes match again");
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { catalog, init } from "../src/init.js";

test("init emits the shared config for a fresh repo in one call", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-init-"));
  init({ targetRoot: root });
  assert.ok(existsSync(join(root, "AGENTS.md")), "AGENTS.md");
  assert.ok(existsSync(join(root, "CLAUDE.md")), "CLAUDE.md");
  assert.ok(existsSync(join(root, ".aider.conf.yml")), ".aider.conf.yml");
});

test("catalog indexes tools (with a why), crew, and guards", () => {
  const c = catalog();
  assert.ok(
    c.tools.some((t) => t.name === "lean"),
    "has lean tool",
  );
  assert.ok(
    c.tools.some((t) => t.name === "atlas"),
    "has atlas tool",
  );
  assert.ok(
    c.tools.every((t) => t.why.length > 0),
    "every tool has a one-line why",
  );
  assert.ok(c.crew.includes("scout"), "has scout crew");
  assert.ok(c.guards.includes("cost-budget"), "has cost-budget guard");
  assert.ok(!c.guards.includes("_guardlib"), "excludes the sourced lib");
});

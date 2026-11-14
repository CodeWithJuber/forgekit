import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("projects choose one integration at a time and retain unrelated choices on removal", (t) => {
  const base = mkdtempSync(join(tmpdir(), "forge-choices-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project"),
    other = join(base, "other");
  for (const p of [root, other]) {
    mkdirSync(join(p, ".git"), { recursive: true });
    mkdirSync(join(p, ".forge"));
    writeFileSync(
      join(p, ".forge", "forge.config.json"),
      JSON.stringify({ tools: ["kimi", "codex"] }),
    );
  }
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = {
    ...process.env,
    FORGE_HOME: join(base, "state"),
    FORGE_NO_HINT: "1",
    FORGE_NO_CATALOG_FETCH: "1",
  };
  const call = (p, ...args) => {
    const r = spawnSync(process.execPath, [cli, "integrations", ...args], {
      cwd: p,
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(
    JSON.parse(call(root, "list", "--json")).choices.some((x) => x.enabled),
    false,
  );
  assert.equal(existsSync(join(root, ".kimi-code", "mcp.json")), false);
  call(root, "select", "deepwiki");
  call(
    root,
    "connect",
    "operations",
    "--url",
    "https://tools.example.test/mcp",
    "--token-env",
    "OPS_READ_TOKEN",
  );
  const kimi = JSON.parse(readFileSync(join(root, ".kimi-code", "mcp.json"), "utf8"));
  assert.ok(kimi.mcpServers.deepwiki);
  assert.ok(kimi.mcpServers.operations);
  assert.match(readFileSync(join(root, ".codex", "config.toml"), "utf8"), /operations/);
  assert.equal(
    JSON.parse(call(other, "list", "--json")).choices.some((x) => x.enabled),
    false,
  );
  mkdirSync(join(root, "src"));
  call(join(root, "src"), "remove", "operations");
  assert.deepEqual(
    JSON.parse(call(root, "list", "--json"))
      .choices.filter((x) => x.enabled)
      .map((x) => x.id),
    ["deepwiki"],
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_NO_HINT: "1" },
  });
}

test("the CLI envelope preserves command JSON, help text and the actual exit status", () => {
  const brand = invoke(["--output=json-v1", "brand"]);
  assert.equal(brand.status, 0);
  const result = JSON.parse(brand.stdout);
  assert.deepEqual(result.stdout.value, JSON.parse(invoke(["brand"]).stdout));
  assert.equal(result.stdout.kind, "json");
  assert.equal(result.stdout.bytes, Buffer.byteLength(invoke(["brand"]).stdout));
  assert.equal(result.complete, true);
  const help = JSON.parse(invoke(["--output=json-v1", "verify", "--help"]).stdout);
  assert.equal(help.schemaVersion, 1);
  assert.equal(help.stdout.value, invoke(["verify", "--help"]).stdout);
  assert.equal(help.stdout.kind, "text");
  const invalid = invoke(["--output=json-v1", "no-such-forge-command"]);
  const failure = JSON.parse(invalid.stdout);
  assert.equal(failure.exitCode, invalid.status);
  assert.notEqual(invalid.status, 0);
  assert.equal(failure.stderr.value, invoke(["no-such-forge-command"]).stderr);
  assert.notEqual(invoke(["--output=v100", "brand"]).status, 0);
  assert.notEqual(invoke(["--output=json-v1", "--output=jsonl-v1", "brand"]).status, 0);
});

test("JSON Lines yields ordered bytes per stream and a final exit event", () => {
  for (const command of ["brand", "no-such-forge-command"]) {
    const raw = invoke([command]);
    const result = invoke(["--output=jsonl-v1", command]);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].event, "started");
    assert.ok(records.every((r) => r.command === command && r.schemaVersion === 1));
    assert.equal(records.at(-1).event, "exit");
    assert.equal(records.at(-1).exitCode, raw.status);
    assert.equal(result.status, raw.status);
    for (const stream of ["stdout", "stderr"]) {
      const bytes = Buffer.concat(
        records.filter((r) => r.event === stream).map((r) => Buffer.from(r.base64, "base64")),
      );
      assert.equal(bytes.toString(), raw[stream]);
    }
  }
});

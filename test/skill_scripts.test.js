import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAND } from "../src/brand.js";
import { listScripts, scriptCommand } from "../src/skill_scripts.js";

const schema = {
  type: "object",
  required: ["n"],
  properties: { n: { type: "integer" } },
  additionalProperties: false,
};
const source =
  'import {readFileSync} from "node:fs";\nconst { n } = JSON.parse(readFileSync(process.argv[2], "utf8"));\nconsole.log(JSON.stringify({n:n*n}));\n';
function fixture(t, image = `node@sha256:${"a".repeat(64)}`) {
  const root = mkdtempSync(join(tmpdir(), "forge-script-reuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "square.mjs"), source);
  const spec = {
    path: "square.mjs",
    runtime: "docker",
    image,
    inputSchema: schema,
    outputSchema: schema,
    fixtures: [
      { input: { n: 4 }, expected: { n: 16 } },
      { input: { n: -3 }, expected: { n: 9 } },
    ],
  };
  return { root, spec, command: (op, args, run) => scriptCommand(op, root, "square", args, run) };
}

test("capturing, verifying, pinning and replaying keeps the original bytes and exact typed fixtures", async (t) => {
  const { root, spec, command } = fixture(t);
  const calls = [];
  const execute = async (executionRoot, recipe, input) => {
    assert.equal(executionRoot, root);
    assert.equal(recipe.source, source);
    calls.push(input.n);
    return { n: input.n ** 2 };
  };
  const a = await command("capture-script", { input: spec }, execute);
  const b = await command("capture-script", { input: spec }, execute);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(join(root, spec.path), "utf8"), source);
  assert.equal(listScripts(root)[0].pinned, false);
  const hash = a.digest;
  await assert.rejects(command("pin-script", { hash }, execute), /Verify the exact/);
  assert.equal((await command("verify-script", { hash }, execute)).passed, 2);
  assert.deepEqual(calls, [4, -3]);
  await command("pin-script", { hash }, execute);
  assert.equal(listScripts(root)[0].pinned, true);
  writeFileSync(join(root, spec.path), `${source}// new candidate\n`);
  const c = await command("capture-script", { input: spec }, execute);
  assert.notEqual(hash, c.digest);
  const result = await command("replay-script", { input: { n: 6 } }, execute);
  assert.deepEqual(result.output, { n: 36 });
  assert.equal(result.digest, hash);
  await assert.rejects(command("replay-script", { input: { n: "6" } }, execute), /unexpected type/);
  await assert.rejects(
    command("replay-script", { input: { n: 6 } }, async () => ({ wrong: 36 })),
    /missing|unknown property/,
  );
  const fail = await command("verify-script", { hash }, async () => ({ n: 1 }));
  assert.equal(fail.status, "unverified");
  assert.match(fail.reason, /differs/);
  await assert.rejects(command("replay-script", { input: { n: 6 } }, execute), /must pass/);
});

test("invalid fixtures, extra permissions, mutable runtime and unsupported script paths fail capture", async (t) => {
  const { root, spec, command } = fixture(t);
  const broken = [
    { ...spec, fixtures: [] },
    { ...spec, network: true },
    { ...spec, fixtures: [{ input: {}, expected: { n: 2 } }] },
    { ...spec, fixtures: [{ input: { n: 1 }, expected: { n: "one" } }] },
    { ...spec, image: "node:latest" },
    { ...spec, runtime: "native" },
    { ...spec, path: join(root, spec.path) },
  ];
  if (process.platform !== "win32") {
    symlinkSync(join(root, spec.path), join(root, "alias.mjs"));
    broken.push({ ...spec, path: "alias.mjs" });
  }
  for (const candidate of broken)
    await assert.rejects(command("capture-script", { input: candidate }));
  assert.deepEqual(listScripts(root), []);
});

test("public recipe CLI captures without execution and reports unavailable isolation", (t) => {
  const { root, spec } = fixture(t);
  function cli(args, input) {
    const r = spawnSync(
      process.execPath,
      [join(BRAND.root, "src/cli.js"), "skills", ...args, "--json"],
      {
        cwd: root,
        input: input && JSON.stringify(input),
        encoding: "utf8",
        env: { ...process.env, PATH: root, FORGE_NO_HINT: "1" },
      },
    );
    return { status: r.status, value: JSON.parse(r.stdout) };
  }
  const captured = cli(["capture-script", "square", "--input", "-"], spec);
  assert.equal(captured.status, 0);
  assert.equal(captured.value.status, "candidate");
  assert.equal(cli(["scripts"]).value.scripts[0].digest, captured.value.digest);
  const failed = cli(["verify-script", "square", "--digest", captured.value.digest]);
  assert.equal(failed.status, 1);
  assert.equal(failed.value.status, "unverified");
  assert.equal(failed.value.passed, 0);
  assert.match(failed.value.reason, /trusted docker/i);
});

test("real digest-pinned Node image verifies and replays a standalone script", {
  skip:
    !process.env.HARNESS_SCRIPT_IMAGE &&
    "Preload a digest-pinned Node image and set HARNESS_SCRIPT_IMAGE",
}, async (t) => {
  const { spec, command } = fixture(t, process.env.HARNESS_SCRIPT_IMAGE);
  const { digest: hash } = await command("capture-script", { input: spec });
  const receipt = await command("verify-script", { hash });
  assert.equal(receipt.ok, true, receipt.reason);
  await command("pin-script", { hash });
  assert.deepEqual((await command("replay-script", { input: { n: 6 } })).output, { n: 36 });
});

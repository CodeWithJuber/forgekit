import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMedia, mediaPlan } from "../scripts/docs-media.mjs";

test("media refresh carries pending input changes across pushes, checks copies and converges", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "forge-docs-media-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  function put(name, bytes) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  put("src/dash.html", "dashboard v1");
  put("scripts/docs-media/hero.svg.tpl", "template v1");
  function render(group) {
    const entry = mediaPlan(root).current[group];
    for (const target of Object.keys(entry.artifacts)) put(target, entry.input);
  }
  buildMedia(root, render);
  assert.deepEqual(mediaPlan(root).stale, []);
  put("scripts/docs-media/hero.svg.tpl", "template v2");
  put("README.md", "another push lands before the original preview PR merges");
  assert.deepEqual(mediaPlan(root).stale, ["hero"]);
  const receipt = path.join(root, "docs/assets/media-receipts.json");
  const before = readFileSync(receipt, "utf8");
  assert.throws(
    () =>
      buildMedia(root, () => {
        throw new Error("browser failed");
      }),
    /browser failed/,
  );
  assert.equal(readFileSync(receipt, "utf8"), before);
  buildMedia(root, render);
  put("mintlify/images/supervised-setup.gif", "accidentally changed mirror");
  assert.deepEqual(mediaPlan(root).stale, ["demos"]);
  buildMedia(root, render);
  put("src/dash.html", "changed presentation");
  assert.ok(mediaPlan(root).stale.includes("dashboard"));
  buildMedia(root, render);
  buildMedia(root, () => assert.fail("no-op build must not render"));
});

// A demo capture runs only after a merge, in the docs job. Reworded CLI output
// must fail here, in the pull request, before it stops the generated docs.
test("the doctor demo capture selects lines the adversarial doctor prints", (t) => {
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const script = readFileSync(path.join(repo, "scripts/make-demo-gif.py"), "utf8");
  const scene = script.slice(script.indexOf('("doctor --adversarial")'));
  const patterns = [...scene.slice(0, scene.indexOf("\n\n")).matchAll(/\br"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(patterns.length >= 3, "found the capture patterns");
  const scratch = mkdtempSync(path.join(tmpdir(), "forge-doctor-capture-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    FORGE_HOME: path.join(scratch, "state"),
    FORGE_NO_HINT: "1",
    FORCE_COLOR: "0",
  };
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [path.join(repo, "src/cli.js"), "doctor", "--adversarial", ...args],
      {
        cwd: scratch,
        env,
        encoding: "utf8",
      },
    );
  // The capture shows a passing run. A bypass in this process tree is a different result.
  if (JSON.parse(run("--json").stdout).failed)
    return t.skip("a permission bypass is active in this process tree");
  const lines = run().stdout.split("\n");
  for (const pattern of patterns)
    assert.ok(
      lines.some((line) => new RegExp(pattern).test(line.trim())),
      `scripts/make-demo-gif.py expects ${pattern}`,
    );
});

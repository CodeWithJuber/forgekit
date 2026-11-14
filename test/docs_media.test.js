import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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

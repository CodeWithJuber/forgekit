import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const bashOnly = { skip: process.platform === "win32" };

// Execute the actual workflow shell blocks against local git and registry stubs.
// No publish credentials or network access are used by these tests.
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function script(name) {
  const block = step(name);
  const run = block.slice(block.indexOf("        run: |\n") + "        run: |\n".length);
  const lines = [];
  for (const line of run.split("\n")) {
    if (line.trim() && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@codewithjuber/forgekit", version: "1.12.1" }),
  );
  for (const [name, body] of Object.entries({
    npm: `printf '%s\n' "$*" >> "$RUNNER_TEMP/npm-calls"
case "$1" in
  view) exit "$VIEW_STATUS" ;;
  publish)
    printf '%s %s\n' "$GITHUB_SHA" "$GITHUB_REF" > "$RUNNER_TEMP/provenance-source"
    printf '%s\n' "$PUBLISH_ERROR"
    exit "$PUBLISH_STATUS" ;;
  *) exit 99 ;;
esac`,
    gh: 'exit "$GH_STATUS"',
    sleep: "exit 0",
  })) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: path.join(dir, "outputs"),
    TAG: "v1.12.1",
    RELEASE_SHA: "c623e217404cc8956e8a951b4197c2b7f59dea0d",
    VIEW_STATUS: "1",
    PUBLISH_STATUS: "0",
    PUBLISH_ERROR: "",
    GH_STATUS: "0",
    REQUESTED_TAG: "",
    REF_TYPE: "tag",
    REF_NAME: "v1.12.1",
    EVENT_NAME: "push",
    DEFAULT_BRANCH: "master",
  };
  return {
    dir,
    run(name, overrides = {}) {
      return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(name)], {
        cwd: dir,
        env: { ...env, ...overrides },
        encoding: "utf8",
        timeout: 10000,
      });
    },
    calls() {
      return fs.readFileSync(path.join(dir, "npm-calls"), "utf8");
    },
    git(...args) {
      return execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
    },
  };
}

test("release attempts token-free publishing and preserves provenance", bashOnly, (t) => {
  const f = fixture(t);
  assert.doesNotMatch(step("Publish to npm (with provenance)"), /^\s+if:/m);
  // A configured bearer token makes npm skip the OIDC exchange entirely, so the
  // step must not set one as an env key — OIDC trusted publishing is the only path.
  // (Mentions inside comments do not count.)
  assert.doesNotMatch(
    step("Publish to npm (with provenance)"),
    /^ {10}(NODE_AUTH_TOKEN|NPM_TOKEN):/m,
  );
  const result = f.run("Publish to npm (with provenance)");
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /publish --provenance --access public/);
  assert.equal(
    fs.readFileSync(path.join(f.dir, "provenance-source"), "utf8"),
    "c623e217404cc8956e8a951b4197c2b7f59dea0d refs/tags/v1.12.1\n",
  );
});

test("an already-published version skips publishing", bashOnly, (t) => {
  const f = fixture(t);
  const result = f.run("Publish to npm (with provenance)", { VIEW_STATUS: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already on npm/);
  assert.doesNotMatch(f.calls(), /publish/);
});

test("EOTP fails despite tee succeeding and provides actionable setup", bashOnly, (t) => {
  const f = fixture(t);
  const result = f.run("Publish to npm (with provenance)", {
    PUBLISH_STATUS: "1",
    PUBLISH_ERROR: "npm error code EOTP",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::npm requested an OTP/);
  assert.match(result.stdout, /trusted publisher/);
  assert.match(result.stdout, /delete the NPM_TOKEN repo secret/);
});

test("other npm errors retain their original failure status", bashOnly, (t) => {
  const f = fixture(t);
  const result = f.run("Publish to npm (with provenance)", {
    PUBLISH_STATUS: "17",
    PUBLISH_ERROR: "npm error code E403",
  });
  assert.equal(result.status, 17);
  assert.match(result.stdout, /npm error code E403/);
  assert.match(result.stdout, /::error::npm publish failed/);
});

test("verification checks npm even with no NPM_TOKEN", bashOnly, (t) => {
  const f = fixture(t);
  const result = f.run("Verify the release loop closed (fail loudly on a wedge)", {
    VIEW_STATUS: "0",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /view @codewithjuber\/forgekit@1.12.1 version --prefer-online/);
  assert.match(result.stdout, /Release loop verified/);
});

test("a missing registry artifact cannot produce a successful release", bashOnly, (t) => {
  const f = fixture(t);
  const result = f.run("Verify the release loop closed (fail loudly on a wedge)");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Release loop did NOT close/);
});

test("tag and recovery dispatches resolve the same annotated-tag commit", bashOnly, (t) => {
  const f = fixture(t);
  f.git("init", "-q");
  f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "package.json");
  f.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  f.git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "tag",
    "-a",
    "v1.12.1",
    "-m",
    "fixture",
  );
  const sha = f.git("rev-parse", "HEAD");
  const tagged = f.run("Resolve the release tag");
  assert.equal(tagged.status, 0, tagged.stderr);
  const expected = `tag=v1.12.1\nsha=${sha}\n`;
  assert.equal(fs.readFileSync(path.join(f.dir, "outputs"), "utf8"), expected);
  fs.writeFileSync(path.join(f.dir, "outputs"), "");
  const recovered = f.run("Resolve the release tag", {
    REQUESTED_TAG: "v1.12.1",
    REF_TYPE: "branch",
    REF_NAME: "master",
    EVENT_NAME: "workflow_dispatch",
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, "outputs"), "utf8"), expected);
});

test("recovery rejects non-default branches and nonexistent tags", bashOnly, (t) => {
  const f = fixture(t);
  for (const overrides of [
    {
      REQUESTED_TAG: "v1.12.1",
      REF_TYPE: "branch",
      REF_NAME: "feature",
      EVENT_NAME: "workflow_dispatch",
    },
    { REF_TYPE: "branch", REF_NAME: "master", EVENT_NAME: "workflow_dispatch" },
    { REF_NAME: "master" },
    { REF_NAME: "v1.12.1\nsha=injected" },
    { REF_NAME: "v9.9.9" },
  ]) {
    const result = f.run("Resolve the release tag", overrides);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "outputs")), false);
  }
});

test("quality gate and publishing checkout use the resolved immutable commit", () => {
  const gate = workflow.slice(workflow.indexOf("\n  gate:"), workflow.indexOf("\n  release:"));
  assert.match(gate, /ref: \$\{\{ needs\.resolve\.outputs\.sha \}\}/);
  assert.match(
    workflow.slice(workflow.indexOf("\n  release:")),
    /ref: \$\{\{ needs\.resolve\.outputs\.sha \}\}/,
  );
  const reusable = fs.readFileSync(
    new URL("../.github/workflows/reusable-quality-gate.yml", import.meta.url),
    "utf8",
  );
  assert.match(reusable, /ref: \$\{\{ inputs\.ref \}\}/);
});

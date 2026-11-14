import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { createHarnessVerifier } from "../src/harness_verify.js";
import { verify } from "../src/verify.js";

const image = "alpine@sha256:2d8a11041a92082ba21e364dec73559ce44f1de69b60fa68315f6d3774e59117";
function repo() {
  const root = mkdtempSync(join(tmpdir(), "forge-harness-verifier-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
test("operator-bound acceptance assertions verify exact bytes and cannot replace declared project suites", async () => {
  const root = repo();
  writeFileSync(join(root, "issue.json"), '{"status":"closed"}\n');
  const request = {
    task: "Set status to closed",
    acceptance: ["status equals closed", "document ends with newline"],
  };
  const spec = {
    mode: "assertions",
    runId: "fixture-01",
    ...request,
    assertions: [
      { criterion: 0, path: "issue.json", jsonPath: ["status"], equals: "closed" },
      { criterion: 1, path: "issue.json", textEquals: '{"status":"closed"}\n' },
    ],
  };
  const input = { runId: spec.runId, root, request };
  const verify = createHarnessVerifier(spec),
    pass = await verify(input);
  assert.equal(pass.ok, true, pass.output);
  assert.equal(pass.scope, "file-assertions");
  assert.equal((await verify({ ...input, runId: "other-run" })).ok, false);
  assert.equal((await verify({ ...input, request: { ...request, task: "unrelated" } })).ok, false);
  assert.equal(
    (
      await createHarnessVerifier({
        ...spec,
        assertions: [spec.assertions[0], spec.assertions[0]],
      })(input)
    ).ok,
    false,
  );
  writeFileSync(join(root, "issue.json"), '{"status":"open"}\n');
  assert.equal((await verify(input)).ok, false);
  writeFileSync(join(root, "issue.json"), spec.assertions[1].textEquals);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "example", scripts: { test: "node --test" } }),
  );
  const denied = await verify(input);
  assert.equal(denied.ok, false);
  assert.match(denied.output, /Project suites/);
});
test("the verifier requires authenticated same-checkout evidence, with no execution of repo code", {
  skip:
    process.platform === "win32" &&
    "The existing npm suite verifier requires a POSIX process entrypoint",
}, async () => {
  const root = repo(),
    run = createHarnessVerifier();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node --test result.test.js" } }),
  );
  writeFileSync(
    join(root, "result.test.js"),
    'require("node:test")("works",()=>require("node:assert/strict").equal(2,2))\n',
  );
  assert.equal((await run({ root })).ok, false);
  const r = verify({ targetRoot: root });
  assert.equal(r.tests.status, "PASS", r.tests.output);
  // npm prepends the checkout's .bin directory. Neither the outer receipt check
  // nor recursive code fingerprints may execute a pretend "git" from that path.
  const shimDir = join(root, ".git", "testbin"),
    marker = join(shimDir, "called");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "git"), '#!/bin/sh\ntouch "$FORGE_TEST_GIT_MARKER"\nexit 47\n', {
    mode: 0o755,
  });
  const savedPath = process.env.PATH;
  process.env.PATH = [shimDir, savedPath].join(delimiter);
  process.env.FORGE_TEST_GIT_MARKER = marker;
  let pass;
  try {
    pass = await run({ root });
  } finally {
    process.env.PATH = savedPath;
    delete process.env.FORGE_TEST_GIT_MARKER;
  }
  assert.ok(!existsSync(marker));
  assert.equal(pass.ok, true, pass.output);
  assert.equal(pass.scope, "project-suites");
  assert.match(pass.output, /exit 0/);
  const clone = mkdtempSync(join(tmpdir(), "forge-other-checkout-"));
  cpSync(root, clone, { recursive: true });
  assert.equal((await run({ root: clone })).ok, false);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "node poisonous.js" } }),
  );
  writeFileSync(join(root, "poisonous.js"), 'require("node:fs").writeFileSync("PWNED","yes")\n');
  assert.equal((await run({ root })).ok, false);
  assert.equal(existsSync(join(root, "PWNED")), false);
});
test("container checks reject mutable tags, unknown runtime names and absent runtimes", async () => {
  const root = repo();
  const cmd = { mode: "container", runtime: "docker", image, command: ["sh", "check.sh"] };
  for (const options of [
    { ...cmd, image: "alpine:latest" },
    { ...cmd, runtime: "node" },
    { ...cmd, command: [] },
  ])
    assert.equal((await createHarnessVerifier(options)({ root })).ok, false);
  const prev = process.env.PATH;
  try {
    process.env.PATH = root;
    const result = await createHarnessVerifier(cmd)({ root });
    assert.equal(result.ok, false);
    assert.match(result.output, /trusted docker/);
  } finally {
    process.env.PATH = prev;
  }
});
test("pinned OCI runtime runs a real project check in a disposable offline copy", {
  skip:
    process.env.HARNESS_REAL_CONTAINER !== "1" &&
    "Requires opt-in Docker smoke runner and preloaded digest",
}, async () => {
  const root = repo(),
    script = join(root, "check.sh");
  writeFileSync(join(root, ".env"), "private_credential=do-not-copy\n");
  writeFileSync(join(root, "config.json"), '{"value":42}\n');
  writeFileSync(
    script,
    [
      "set -eu",
      'test "$(id -u)" = 65534',
      "test ! -e .git && test ! -e .env && test ! -S /var/run/docker.sock",
      "! env | grep -E '^(GITHUB_TOKEN|HARNESS_CANARY)='",
      'test "$(ls /sys/class/net)" = lo',
      "grep 42 config.json",
      "echo temporary > config.json",
      "test ! -w /input/config.json",
      "test ! -w /etc",
      "echo isolation-passed",
    ].join("\n"),
  );
  const run = createHarnessVerifier({
    mode: "container",
    runtime: "docker",
    image,
    command: ["/bin/sh", "check.sh"],
    timeoutMs: 30000,
  });
  const pass = await run({ root });
  assert.equal(pass.ok, true, pass.output);
  assert.match(pass.output, /isolation-passed/);
  assert.match(readFileSync(join(root, "config.json"), "utf8"), /42/);
  writeFileSync(script, "echo deliberately-broken; exit 3\n");
  const fail = await run({ root });
  assert.equal(fail.ok, false);
  assert.match(fail.output, /deliberately-broken/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the remote install hook handles optional npm configuration and repairs a partial installation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-install-hook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ["package.json", "package-lock.json"]) writeFileSync(join(root, file), "{}");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == "--version" ]]; then echo 1; exit 0; fi
[[ "$*" == "ci --no-audit --no-fund" ]]
echo installed >> installs
mkdir -p node_modules/.bin node_modules/types
for tool in biome tsc; do printf '#!/bin/sh\\nexit 0\\n' > "node_modules/.bin/$tool"; chmod +x "node_modules/.bin/$tool"; done
echo 'export type Value = number;' > node_modules/types/index.d.ts
`,
  );
  chmodSync(npm, 0o755);
  const hook = fileURLToPath(new URL("../.claude/hooks/session-start.sh", import.meta.url));
  function start() {
    const r = spawnSync("bash", [hook], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        CLAUDE_CODE_REMOTE: "true",
        CLAUDE_PROJECT_DIR: root,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(root, "installs"), "utf8").trim().split("\n").length;
  }
  assert.equal(start(), 1);
  assert.equal(start(), 1);
  rmSync(join(root, "node_modules", "types", "index.d.ts"));
  assert.equal(start(), 2);
  writeFileSync(join(root, ".npmrc"), "offline=true\n");
  assert.equal(start(), 3);
  assert.equal(start(), 3);
  rmSync(join(root, ".npmrc"));
  assert.equal(start(), 4);
});

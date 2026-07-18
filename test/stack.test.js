import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectStack } from "../src/stack.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "forge-stack-"));

test("node + Next.js: language, framework, pkg manager, test command", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { next: "16", react: "19" },
      devDependencies: { vitest: "2" },
    }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const s = detectStack(root);
  assert.ok(s.languages.includes("JavaScript/TypeScript"));
  assert.ok(s.frameworks.includes("Next.js"), JSON.stringify(s.frameworks));
  assert.ok(s.frameworks.includes("React"));
  assert.ok(s.packageManagers.includes("pnpm"));
  assert.ok(s.testCommands.includes("npx vitest"));
});

test("Node signatures: scoped-prefix (Remix) matches; exact avoids preact→React", () => {
  const remix = tmp();
  writeFileSync(
    join(remix, "package.json"),
    JSON.stringify({
      dependencies: { "@remix-run/react": "2", "@remix-run/node": "2" },
    }),
  );
  assert.ok(detectStack(remix).frameworks.includes("Remix"), "scoped @remix-run/ prefix matches");

  const preact = tmp();
  writeFileSync(join(preact, "package.json"), JSON.stringify({ dependencies: { preact: "10" } }));
  const s = detectStack(preact);
  assert.ok(
    !s.frameworks.includes("React"),
    "preact must NOT be misreported as React (exact match)",
  );
});

test("python + Django: pytest + framework from requirements", () => {
  const root = tmp();
  writeFileSync(join(root, "requirements.txt"), "Django==5.0\npytest==8\n");
  const s = detectStack(root);
  assert.ok(s.languages.includes("Python"));
  assert.ok(s.frameworks.includes("Django"));
  assert.ok(s.testCommands.includes("pytest -q"));
  assert.ok(s.packageManagers.includes("pip"));
});

test("go, rust, ruby+rails, php+laravel, dotnet each detect", () => {
  const go = tmp();
  writeFileSync(join(go, "go.mod"), "module example.com/app\n\ngo 1.22\n");
  assert.deepEqual(detectStack(go).languages, ["Go"]);
  assert.ok(detectStack(go).testCommands.includes("go test ./..."));

  const rs = tmp();
  writeFileSync(join(rs, "Cargo.toml"), "[package]\nname='a'\n[dependencies]\naxum='0.7'\n");
  const rsS = detectStack(rs);
  assert.ok(rsS.languages.includes("Rust") && rsS.frameworks.includes("Axum"));

  const rb = tmp();
  writeFileSync(join(rb, "Gemfile"), "gem 'rails'\ngem 'rspec'\n");
  const rbS = detectStack(rb);
  assert.ok(rbS.languages.includes("Ruby") && rbS.frameworks.includes("Rails"));
  assert.ok(rbS.testCommands.includes("bundle exec rspec"));

  const php = tmp();
  writeFileSync(
    join(php, "composer.json"),
    JSON.stringify({ require: { "laravel/framework": "11" } }),
  );
  assert.ok(detectStack(php).frameworks.includes("Laravel"));

  const cs = tmp();
  writeFileSync(join(cs, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
  const csS = detectStack(cs);
  assert.ok(csS.languages.includes("C#") && csS.testCommands.includes("dotnet test"));
});

test("empty repo → empty but safe; corrupt manifest never throws", () => {
  const root = tmp();
  const s = detectStack(root);
  assert.deepEqual(s.languages, []);
  assert.deepEqual(s.testCommands, []);
  writeFileSync(join(root, "package.json"), "{ this is not json ");
  assert.doesNotThrow(() => detectStack(root));
});

test("testRunners: structured descriptors alongside UNCHANGED testCommands strings", () => {
  const root = tmp();
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "2" },
    }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const s = detectStack(root);
  // strings: back-compat surface, byte-identical to before
  assert.deepEqual(s.testCommands, ["npx vitest", "pnpm test"]);
  // descriptors: the DETECTED package manager, structured for a shell-free spawn
  assert.deepEqual(
    s.testRunners.find((r) => r.label === "pnpm test"),
    { bin: "pnpm", args: ["test"], label: "pnpm test" },
  );
  const npx = s.testRunners.find((r) => r.label === "npx vitest");
  assert.ok(npx && !npx.bin, "npx detections stay label-only — forge never executes npx");

  const go = tmp();
  writeFileSync(join(go, "go.mod"), "module x\n\ngo 1.22\n");
  const gs = detectStack(go);
  assert.deepEqual(gs.testCommands, ["go test ./..."]);
  assert.deepEqual(gs.testRunners, [
    { bin: "go", args: ["test", "./..."], label: "go test ./..." },
  ]);
});

test("CLI: forge stack --json emits the detected stack", () => {
  const root = tmp();
  writeFileSync(join(root, "go.mod"), "module x\n\ngo 1.22\n");
  const r = spawnSync("node", [CLI, "stack", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.languages, ["Go"]);
});

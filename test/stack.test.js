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
    JSON.stringify({ dependencies: { next: "16", react: "19" }, devDependencies: { vitest: "2" } }),
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const s = detectStack(root);
  assert.ok(s.languages.includes("JavaScript/TypeScript"));
  assert.ok(s.frameworks.includes("Next.js"), JSON.stringify(s.frameworks));
  assert.ok(s.frameworks.includes("React"));
  assert.ok(s.packageManagers.includes("pnpm"));
  assert.ok(s.testCommands.includes("npx vitest"));
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

test("CLI: forge stack --json emits the detected stack", () => {
  const root = tmp();
  writeFileSync(join(root, "go.mod"), "module x\n\ngo 1.22\n");
  const r = spawnSync("node", [CLI, "stack", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed.languages, ["Go"]);
});

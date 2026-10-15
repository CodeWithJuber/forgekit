// coupling tests — the two defect shapes from issue #206, reproduced in temp git repos:
// a member added to an allowlist that a require-all validator quantifies over (through a
// parameter, in another function), and a file read that a sibling binary writes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../src/atlas.js";
import {
  couplingHazards,
  entryPoint,
  grownSets,
  parseDiff,
  quantifiersOver,
  renderHazards,
} from "../src/coupling.js";
import { repairReason } from "../src/gate.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** A temp repo with `files` committed; returns root and a git runner. */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "forge-coupling-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "base");
  return { root, git };
}

// --- the sifruno shape: decoder allowlist + strictObject require-all validator (Go) ---

const GO_KEYS = (extra = "") => `package whm

var createAccountKeys = map[string]bool{
	"user":   true,
	"domain": true,${extra}
}
`;

const GO_STRICT = `package whm

import (
	"encoding/json"
	"fmt"
)

func decodeCreate(raw map[string]json.RawMessage) error {
	if err := strictObject(raw, createAccountKeys); err != nil {
		return err
	}
	return nil
}

func strictObject(raw map[string]json.RawMessage, allowed map[string]bool) error {
	for k := range raw {
		if !allowed[k] {
			return fmt.Errorf("unknown key %q", k)
		}
	}
	for k := range allowed {
		if _, ok := raw[k]; !ok {
			return fmt.Errorf("missing key %q", k)
		}
	}
	return nil
}
`;

test("coupling: an allowlist member added in Go flags the require-all validator behind a parameter", () => {
  const { root } = repo({ "internal/whm/keys.go": GO_KEYS(), "internal/whm/strict.go": GO_STRICT });
  put(root, "internal/whm/keys.go", GO_KEYS('\n\t"plan":   true,'));
  const { hazards } = couplingHazards(root);
  assert.equal(hazards.length, 1, JSON.stringify(hazards, null, 2));
  const [h] = hazards;
  assert.equal(h.kind, "set-quantifier");
  assert.equal(h.priority, "high");
  assert.equal(h.subject, "createAccountKeys");
  assert.deepEqual(h.added, ["plan"]);
  assert.equal(h.file, "internal/whm/keys.go");
  // the require-all loop, NOT the unknown-key loop (which iterates raw)
  assert.equal(h.coupled.length, 1);
  assert.equal(h.coupled[0].file, "internal/whm/strict.go");
  assert.match(h.coupled[0].text, /for k := range allowed/);
  assert.match(h.coupled[0].why, /require-all/);
  assert.match(h.coupled[0].why, /createAccountKeys/);
  const out = renderHazards(hazards).join("\n");
  assert.match(out, /^!! internal\/whm\/keys\.go:\d+ {2}`createAccountKeys` gained "plan"/);
  assert.match(out, /→ internal\/whm\/strict\.go:\d+ {2}require-all/);
});

test("coupling: the same edit with a validator that only rejects UNKNOWN keys is not flagged", () => {
  const lenient = GO_STRICT.replace(/\tfor k := range allowed \{[\s\S]*?\n\t\}\n/, "");
  const { root } = repo({ "internal/whm/keys.go": GO_KEYS(), "internal/whm/strict.go": lenient });
  put(root, "internal/whm/keys.go", GO_KEYS('\n\t"plan":   true,'));
  assert.deepEqual(couplingHazards(root).hazards, []);
});

test("coupling: a validator in ANOTHER package is not this package's invariant", () => {
  const { root } = repo({
    "internal/whm/keys.go": GO_KEYS(),
    "internal/other/strict.go": GO_STRICT.replace("package whm", "package other"),
  });
  put(root, "internal/whm/keys.go", GO_KEYS('\n\t"plan":   true,'));
  assert.deepEqual(couplingHazards(root).hazards, []);
});

// --- JS: direct cardinality + require-all + exhaustive switch ---

test("coupling: JS — size check, every() and a switch that misses the new member", () => {
  const base = (extra = "") => `export const KINDS = new Set([
  "fact",
  "lesson",${extra}
]);

export function check(seen) {
  if (seen.size !== KINDS.size) throw new Error("incomplete");
  return [...KINDS].every((k) => seen.has(k));
}
`;
  const label = `export function label(kind) {
  switch (kind) {
    case "fact":
      return "F";
    case "lesson":
      return "L";
    default:
      throw new Error(kind);
  }
}
`;
  const { root } = repo({ "src/kinds.js": base(), "src/label.js": label });
  put(root, "src/kinds.js", base('\n  "summary",'));
  const { hazards } = couplingHazards(root);
  assert.equal(hazards.length, 1);
  const whys = hazards[0].coupled.map((s) => `${s.file}:${s.why.split(":")[0]}`);
  assert.deepEqual(whys.sort(), [
    "src/kinds.js:cardinality",
    "src/kinds.js:require-all",
    "src/label.js:exhaustiveness",
  ]);
});

test("coupling: a fresh literal (every member new) has no prior meaning to break", () => {
  const { root } = repo({ "src/a.js": "export const x = 1;\n" });
  put(
    root,
    "src/kinds.js",
    'export const KINDS = [\n  "a",\n  "b",\n];\nexport const n = () => KINDS.length === 2;\n',
  );
  assert.deepEqual(couplingHazards(root).hazards, []);
});

// --- Python: require-all through a parameter ---

test("coupling: Python — all(k in payload for k in required) via a parameter", () => {
  const keys = (extra = "") => `REQUIRED = {\n    "user",\n    "domain",${extra}\n}\n`;
  const check = `from keys import REQUIRED


def validate(payload):
    return strict(payload, REQUIRED)


def strict(payload, required):
    return all(k in payload for k in required)
`;
  const { root } = repo({ "app/keys.py": keys(), "app/check.py": check });
  put(root, "app/keys.py", keys('\n    "plan",'));
  const { hazards } = couplingHazards(root);
  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].coupled[0].file, "app/check.py");
  assert.match(hazards[0].coupled[0].why, /require-all.*`required` \(= `REQUIRED`/);
});

// --- live readers: a store loaded once, written by a sibling binary ---

const STORE = `package store

import "os"

type Store struct{ data []byte }

func Load(path string) (*Store, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return &Store{data: b}, nil
}
`;
const DAEMON = `package main

import (
	"path/filepath"

	"example.com/x/internal/store"
)

func main() {
	s, _ := store.Load(filepath.Join("/var/lib/x", "tokens.json"))
	_ = s
}
`;
const PANELCTL = `package main

import (
	"os"
	"path/filepath"
)

func main() {
	p := filepath.Join("/var/lib/x", "tokens.json")
	_ = os.WriteFile(p, []byte("{}"), 0o600)
}
`;

test("coupling: a file-backed store loaded once, written by a sibling cmd/ binary", () => {
  const { root } = repo({
    "go.mod": "module example.com/x\n",
    "cmd/xd/main.go": DAEMON,
    "cmd/panelctl/main.go": PANELCTL,
  });
  put(root, "internal/store/store.go", STORE); // the diff ADDS the store
  const { hazards } = couplingHazards(root);
  assert.equal(hazards.length, 1, JSON.stringify(hazards, null, 2));
  const [h] = hazards;
  assert.equal(h.kind, "live-reader");
  assert.equal(h.priority, "high");
  assert.equal(h.subject, "tokens.json");
  assert.equal(h.file, "internal/store/store.go");
  assert.equal(h.coupled.length, 1);
  assert.equal(h.coupled[0].file, "cmd/panelctl/main.go");
  assert.match(h.coupled[0].why, /another binary \(cmd\/panelctl\)/);
  assert.match(h.message, /will a running process see those writes/);
});

test("coupling: the store's caller may sit on its own func line; an unrelated Load( is not a caller", () => {
  const { root } = repo({
    "go.mod": "module example.com/x\n",
    "cmd/panelctl/main.go": PANELCTL,
    // a different package's Load passing a different file — must not feed the store's keys
    "internal/cfg/cfg.go":
      'package cfg\n\nimport "os"\n\nfunc Load(p string) []byte { b, _ := os.ReadFile(p); return b }\n',
    "cmd/other/main.go":
      'package main\n\nimport "example.com/x/internal/cfg"\n\nfunc main() { cfg.Load("settings.json") }\n',
  });
  put(root, "internal/store/store.go", STORE);
  put(
    root,
    "cmd/xd/main.go",
    'package main\n\nimport "example.com/x/internal/store"\n\nfunc main() { store.Load("/var/lib/x/tokens.json") }\n',
  );
  const { hazards } = couplingHazards(root);
  assert.deepEqual(
    hazards.map((h) => [h.file, h.subject]),
    [["internal/store/store.go", "tokens.json"]],
  );
});

test("coupling: a store that already reloads on change is not flagged", () => {
  const { root } = repo({
    "go.mod": "module example.com/x\n",
    "cmd/xd/main.go": DAEMON,
    "cmd/panelctl/main.go": PANELCTL,
  });
  put(
    root,
    "internal/store/store.go",
    STORE.replace("return &Store{data: b}, nil", "_ = st.ModTime()\n\treturn &Store{data: b}, nil"),
  );
  assert.deepEqual(couplingHazards(root).hazards, []);
});

test("coupling: a writer in the reader's own package is its save path, not a live-reader risk", () => {
  const { root } = repo({ "src/a.js": "export const a = 1;\n" });
  put(
    root,
    "src/store.js",
    'import { readFileSync } from "node:fs";\nexport const load = () => readFileSync("state.json", "utf8");\n',
  );
  put(
    root,
    "src/save.js",
    'import { writeFileSync } from "node:fs";\nexport const save = (s) => writeFileSync("state.json", s);\n',
  );
  assert.deepEqual(couplingHazards(root).hazards, []);
});

test("coupling: JS reader + writer in a bin/ script → flagged; --staged reads the index", () => {
  const { root, git } = repo({
    "bin/admin.js":
      '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(".data/tokens.json", "{}");\n',
  });
  put(
    root,
    "src/server/tokens.js",
    'import { readFileSync } from "node:fs";\nconst TOKENS = JSON.parse(readFileSync(".data/tokens.json", "utf8"));\nexport const has = (t) => t in TOKENS;\n',
  );
  assert.equal(couplingHazards(root).hazards[0]?.coupled[0]?.file, "bin/admin.js");
  // nothing staged yet → nothing to report
  assert.deepEqual(couplingHazards(root, { staged: true }).hazards, []);
  git("add", "src/server/tokens.js");
  assert.equal(couplingHazards(root, { staged: true }).hazards.length, 1);
});

test("coupling: `files` narrows the change set", () => {
  const { root } = repo({ "internal/whm/keys.go": GO_KEYS(), "internal/whm/strict.go": GO_STRICT });
  put(root, "internal/whm/keys.go", GO_KEYS('\n\t"plan":   true,'));
  assert.equal(couplingHazards(root, { files: ["internal/whm/keys.go"] }).hazards.length, 1);
  assert.equal(couplingHazards(root, { files: ["internal/whm/strict.go"] }).hazards.length, 0);
});

test("coupling: fails open outside a git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-coupling-nogit-"));
  assert.deepEqual(couplingHazards(root), { changedFiles: [], hazards: [] });
});

// --- unit pieces ---

test("parseDiff keeps NEW line numbers across hunks", () => {
  const d = parseDiff(
    [
      "diff --git a/x.go b/x.go",
      "--- a/x.go",
      "+++ b/x.go",
      "@@ -3,0 +4,2 @@",
      '+\t"plan": true,',
      '+\t"tier": true,',
      "@@ -10 +12 @@",
      "-old",
      "+new",
    ].join("\n"),
  );
  assert.deepEqual(d.get("x.go"), {
    added: [
      { line: 4, text: '\t"plan": true,' },
      { line: 5, text: '\t"tier": true,' },
      { line: 12, text: "new" },
    ],
    removed: ["old"],
  });
});

test("parseDiff: inside a hunk, `--- x` is a removed `-- x`, not a file header", () => {
  const d = parseDiff(
    [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1 +1 @@",
      "--- old comment",
      "+++ new line",
      "diff --git a/y.go b/y.go",
      "--- a/y.go",
      "+++ b/y.go",
      "@@ -0,0 +1 @@",
      "+package y",
    ].join("\n"),
  );
  assert.deepEqual(d.get("q.sql"), {
    added: [{ line: 1, text: "++ new line" }],
    removed: ["-- old comment"],
  });
  assert.deepEqual(d.get("y.go")?.added, [{ line: 1, text: "package y" }]);
});

test("grownSets reads one-line literals and multi-line literals behind wrappers", () => {
  const one = ['var keys = map[string]bool{"user": true, "plan": true}'];
  assert.deepEqual(
    grownSets(
      one,
      [{ line: 1, text: one[0] }],
      ['var keys = map[string]bool{"user": true}'],
      "go",
    ).map((s) => [s.name, s.added]),
    [["keys", ["plan"]]],
  );
  const multi = ["export const ALLOWED = Object.freeze([", '  "a",', '  "b",', "]);"];
  assert.deepEqual(
    grownSets(multi, [{ line: 3, text: multi[2] }], [], "js").map((s) => [
      s.name,
      s.members,
      s.added,
    ]),
    [["ALLOWED", ["a", "b"], ["b"]]],
  );
});

test("quantifiersOver: a counted for-loop is iteration, not a cardinality invariant", () => {
  const body = [
    "for (let i = 0; i < KEYS.length; i++) log(KEYS[i]);",
    "if (KEYS.length > 3) warn();",
  ];
  assert.deepEqual(
    quantifiersOver(body, 0, "KEYS").map((q) => q.line),
    [2],
  );
});

test("entryPoint names cmd/ and bin/ binaries, main packages and scripts", () => {
  assert.equal(entryPoint("cmd/panelctl/main.go", ""), "cmd/panelctl");
  assert.equal(entryPoint("tools/cmd/gen/x.go", ""), "tools/cmd/gen");
  assert.equal(entryPoint("bin/admin.js", ""), "bin/admin.js");
  assert.equal(entryPoint("tools/x/main.go", "package main\n\nfunc main() {}\n"), "tools/x");
  assert.equal(
    entryPoint("scripts/run.py", 'if __name__ == "__main__":\n    run()\n'),
    "scripts/run.py",
  );
  assert.equal(entryPoint("internal/store/store.go", "package store\n"), null);
});

// --- surfaces: the Stop gate's checklist and `forge impact --diff` ---

const KINDS_JS = (extra = "") => `export const KINDS = [
  "fact",
  "lesson",${extra}
];
`;
const CHECK_JS = `import { KINDS } from "./kinds.js";

export function complete(seen) {
  for (const k of KINDS) {
    if (!seen.has(k)) throw new Error(\`missing \${k}\`);
  }
}
`;

test("the Stop gate lists coupled invariants AHEAD of the graph's co-change candidates", () => {
  const { root } = repo({
    "src/kinds.js": KINDS_JS(),
    "src/check.js": CHECK_JS,
    "src/app.js":
      'import { complete } from "./check.js";\nexport const run = (s) => complete(s);\n',
  });
  build({ root });
  put(root, "src/kinds.js", KINDS_JS('\n  "summary",'));
  const reason = repairReason(root, {
    codeFiles: ["src/kinds.js"],
    classes: { code: ["src/kinds.js"] },
  });
  const hazardAt = reason.indexOf("Coupled files you did not name");
  const coChangeAt = reason.indexOf("Co-change candidates");
  assert.ok(hazardAt > 0, reason);
  assert.ok(coChangeAt > hazardAt, "hazards outrank the co-change hint");
  assert.match(reason, /!! src\/kinds\.js:\d+ {2}`KINDS` gained "summary"/);
  assert.match(reason, /→ src\/check\.js:4 {2}require-all/);
  // no hazard → no step
  put(root, "src/kinds.js", KINDS_JS());
  put(root, "src/app.js", "export const run = () => 1;\n");
  const plain = repairReason(root, {
    codeFiles: ["src/app.js"],
    classes: { code: ["src/app.js"] },
  });
  assert.doesNotMatch(plain, /Coupled files you did not name/);
});

test("forge impact --diff: hazards first, then graph dependents; --json carries both", () => {
  const { root } = repo({
    "src/kinds.js": KINDS_JS(),
    "src/check.js": CHECK_JS,
    "src/app.js":
      'import { complete } from "./check.js";\nexport const run = (s) => complete(s);\n',
  });
  put(root, "src/kinds.js", KINDS_JS('\n  "summary",'));
  const run = (...args) =>
    spawnSync(process.execPath, [CLI, "impact", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORGE_NO_HINT: "1", NO_COLOR: "1" },
    });
  const text = run("--diff");
  assert.equal(text.status, 0, text.stderr);
  const hazardAt = text.stdout.indexOf("coupled files you did not name");
  const depsAt = text.stdout.indexOf("graph dependents of the changed code");
  assert.ok(hazardAt > 0 && depsAt > hazardAt, text.stdout);
  assert.match(text.stdout, /src\/check\.js \(reverse ← src\/kinds\.js\)/);
  const json = JSON.parse(run("--diff", "--json").stdout);
  assert.equal(json.base, "HEAD");
  assert.equal(json.hazards[0].subject, "KINDS");
  assert.ok(json.dependents.some((d) => d.file === "src/check.js"));
  // a target and a diff flag are two different questions
  assert.equal(run("--diff", "src/kinds.js").status, 1);
  assert.equal(run("--since").status, 1);
});

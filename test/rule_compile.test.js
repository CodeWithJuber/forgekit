import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitGate, commitGateDecision } from "../src/commit_gate.js";
import { addRule, checkRules, compileRule, loadRules, removeRule } from "../src/rule_compile.js";
import { HELDOUT } from "./fixtures/rule-corpus/heldout.mjs";
import { TUNING } from "./fixtures/rule-corpus/tuning.mjs";

/** @param {[string, string | null][]} set @param {string[]} known */
function score(set, known) {
  const wrong = [];
  for (const [sentence, want] of set) {
    const r = compileRule(sentence, { known });
    const got = r.ok
      ? `${r.rule.kind}:${r.rule.subject}${r.rule.files ? `:${r.rule.files}` : ""}`
      : null;
    if (got !== want) wrong.push(`${sentence} → ${got} (want ${want})`);
  }
  return wrong;
}

test("policy corpus: each sentence compiles to the intended check, prose stays memory", () => {
  assert.deepEqual(score(TUNING, ["lodash", "moment", "axios"]), []);
  assert.deepEqual(score(HELDOUT, ["react", "express", "jest", "zod", "request"]), []);
});

test("a vague 'use X' needs evidence that X is a package; an explicit import does not", () => {
  assert.equal(compileRule("Prefer composition over inheritance").ok, false);
  assert.equal(compileRule("Don't use lodash").ok, false, "lodash is not known here");
  assert.equal(compileRule("Don't use lodash", { known: ["lodash"] }).ok, true);
  assert.equal(compileRule("Never import lodash").ok, true, "the verb says it is a module");
  const refused = compileRule("Keep functions small");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /keep it as memory/);
});

test("checkRules: imports in JS and Python, constructs by extension, directories, lockfiles", () => {
  const rule = (/** @type {string} */ s, known = /** @type {string[]} */ ([])) => {
    const r = compileRule(s, { known });
    assert.ok(r.ok, s);
    return r.rule;
  };
  const rules = [
    rule("Never import moment"),
    rule("No console.log in src"),
    rule("Use pnpm, not npm"),
    rule("never import requests"),
  ];
  const added = new Map([
    ["src/a.js", ['import moment from "moment";', 'console.log("x");']],
    ["src/b.ts", ['const tz = require("moment/timezone");']],
    ["scripts/c.js", ['console.log("fine outside src");']],
    ["app/fetch.py", ["import requests", "from requests.adapters import HTTPAdapter"]],
    ["docs/notes.md", ["We removed moment last year."]],
    ["package-lock.json", ['{ "lockfileVersion": 3 }']],
  ]);
  const hits = checkRules(rules, added).map((h) => `${h.rule.id}@${h.file}`);
  assert.deepEqual(hits.sort(), [
    "no-file-package-lock-json@package-lock.json",
    "no-import-moment@src/a.js",
    "no-import-moment@src/b.ts",
    "no-import-requests@app/fetch.py",
    "no-text-console-log-src@src/a.js",
  ]);
});

test("rules persist, replace by id and can be removed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "forge-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(addRule(root, "Never import moment").ok, true);
  assert.equal(addRule(root, "never import moment.").ok, true, "same rule, same id");
  assert.equal(loadRules(root).length, 1);
  assert.equal(addRule(root, "Keep functions small").ok, false);
  assert.equal(removeRule(root, "no-import-moment").ok, true);
  assert.deepEqual(loadRules(root), []);
});

test("precommit refuses a commit that breaks an enforced rule, in warn mode too", (t) => {
  const v = {
    rule: /** @type {any} */ (compileRule("Never import moment")).rule,
    file: "src/a.js",
    text: "import moment",
  };
  const blocked = commitGateDecision({
    staged: ["src/a.js", "CHANGELOG.md"],
    ruleViolations: [v],
    mode: "warn",
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.findings[0].kind, "rule");
  const soft = { ...v, rule: { ...v.rule, severity: "warn" } };
  assert.equal(
    commitGateDecision({ staged: ["src/a.js", "CHANGELOG.md"], ruleViolations: [soft] }).allow,
    true,
  );

  // End to end through git: the rule lives in .forge/rules.json and the staged line breaks it.
  const root = mkdtempSync(join(tmpdir(), "forge-rules-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ ...a) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q");
  addRule(root, "Never import moment");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.js"), 'import moment from "moment";\n');
  writeFileSync(join(root, "CHANGELOG.md"), "- a\n");
  git("add", "src/a.js", "CHANGELOG.md");
  const r = commitGate(root, { env: { FORGE_COMMIT_GATE: "warn" } });
  assert.equal(r.allow, false);
  assert.ok(r.findings.some((f) => f.kind === "rule" && f.files.includes("src/a.js")));
});

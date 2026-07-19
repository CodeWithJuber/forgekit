import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const templateUrl = new URL("../global/settings.template.json", import.meta.url);
const template = JSON.parse(readFileSync(templateUrl, "utf8"));

/** Specifier inside a `Bash(<spec>)` rule, or null when the rule isn't a Bash rule. */
function bashSpec(rule) {
  const match = /^Bash\((.*)\)$/.exec(rule);
  return match ? match[1] : null;
}

const rules = [
  ...(template.permissions?.allow ?? []),
  ...(template.permissions?.ask ?? []),
  ...(template.permissions?.deny ?? []),
];

test("settings template parses and has a permissions block", () => {
  assert.ok(template.permissions, "permissions block present");
});

test("no Bash rule embeds a shell compound operator in its specifier", () => {
  // Claude Code splits compound commands on `|`, `&&`, `;` and matches each
  // subcommand independently, so an operator inside a single specifier can never
  // match a real command. This is the exact shape of the old inert
  // `Bash(curl:* | sh)` rules — keep it out for good.
  for (const rule of rules) {
    const spec = bashSpec(rule);
    if (spec === null) continue;
    assert.doesNotMatch(spec, /\||&&|;/, `malformed Bash rule (compound operator): ${rule}`);
  }
});

test("`:*` appears only at the end of a Bash specifier", () => {
  // `:*` is a trailing-wildcard shorthand ONLY at the end of a pattern; anywhere
  // else the colon is a literal character and the rule matches nothing.
  for (const rule of rules) {
    const spec = bashSpec(rule);
    if (spec === null || !spec.includes(":*")) continue;
    assert.ok(spec.endsWith(":*"), `\`:*\` not at end of specifier: ${rule}`);
  }
});

test("git stash requires confirmation (ask), never pre-allowed (RA-05)", () => {
  // `git stash show -p` dumps stashed secret-file content with NO path token in
  // the command string, so the path-token guard can never catch it — the
  // permission layer is the only defense (and stash mutates state).
  const allow = template.permissions?.allow ?? [];
  const ask = template.permissions?.ask ?? [];
  assert.ok(ask.includes("Bash(git stash:*)"), "git stash:* must be in ask");
  assert.ok(!allow.includes("Bash(git stash:*)"), "git stash:* must NOT be in allow");
});

test("the former inert curl-pipe deny rules are absent", () => {
  const deny = template.permissions?.deny ?? [];
  assert.ok(!deny.includes("Bash(curl:* | sh)"), "inert curl|sh rule must stay removed");
  assert.ok(!deny.includes("Bash(curl:* | bash)"), "inert curl|bash rule must stay removed");
});

// ---------------------------------------------------------------------------
// HI-08 — hook matchers cover current write/output-capable tools, and the two
// manifests (settings.template.json + hooks/hooks.json) stay consistent.
// ---------------------------------------------------------------------------

const pluginHooks = JSON.parse(
  readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
);

/** Matcher of the first hook group under `event` whose command mentions `guard`. */
function matcherFor(manifest, event, guard) {
  const groups = manifest.hooks?.[event] ?? [];
  for (const group of groups) {
    if ((group.hooks ?? []).some((h) => (h.command ?? "").includes(guard))) {
      return group.matcher ?? "";
    }
  }
  return null;
}

test("PreToolUse protect-paths matcher covers NotebookEdit (HI-08)", () => {
  for (const [name, manifest] of [
    ["settings.template.json", template],
    ["hooks.json", pluginHooks],
  ]) {
    const matcher = matcherFor(manifest, "PreToolUse", "protect-paths.sh");
    assert.ok(matcher, `${name}: protect-paths PreToolUse group present`);
    for (const tool of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      assert.ok(
        matcher.split("|").includes(tool),
        `${name}: protect-paths matcher must include ${tool} (got: ${matcher})`,
      );
    }
  }
});

test("PostToolUse secret-redact matcher covers WebFetch, MCP, NotebookEdit (HI-08)", () => {
  for (const [name, manifest] of [
    ["settings.template.json", template],
    ["hooks.json", pluginHooks],
  ]) {
    const matcher = matcherFor(manifest, "PostToolUse", "secret-redact.sh");
    assert.ok(matcher, `${name}: secret-redact PostToolUse group present`);
    for (const tool of ["Bash", "Read", "Grep", "WebFetch", "NotebookEdit", "mcp__.*"]) {
      assert.ok(
        matcher.split("|").includes(tool),
        `${name}: secret-redact matcher must include ${tool} (got: ${matcher})`,
      );
    }
  }
});

test("protect-paths + secret-redact matchers agree across both manifests (HI-08)", () => {
  for (const [event, guard] of [
    ["PreToolUse", "protect-paths.sh"],
    ["PostToolUse", "secret-redact.sh"],
  ]) {
    assert.equal(
      matcherFor(template, event, guard),
      matcherFor(pluginHooks, event, guard),
      `${guard} matcher must match between settings.template.json and hooks.json`,
    );
  }
});

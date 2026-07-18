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

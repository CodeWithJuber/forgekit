// forge harden — WIRE the mature security controls Anthropic/the community already
// own: enable the Claude Code sandbox (84% fewer prompts, per Anthropic) and install
// the commit-level gate rung as a pre-commit hook: gitleaks first when it's installed,
// then the built-in commit gate (`<cli> precommit` — completeness F1 + secret-scan
// fallback, src/commit_gate.js). We never auto-edit ~/.claude/settings.json (no
// clobber) — we write the sandbox block for the user to merge — and the same no-clobber
// rule protects a user-authored pre-commit hook: ours lands beside it as
// `pre-commit.<cli>` instead of overwriting it.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BRAND } from "./brand.js";
import { hasBin as have } from "./util.js";

/** Resolve the real git hooks directory. In a linked worktree or submodule `.git` is a
 *  FILE (a `gitdir:` pointer), so the naive `<root>/.git/hooks` throws ENOTDIR — ask git
 *  for the actual path instead, falling back to the classic layout when git is absent. */
function gitHooksDir(targetRoot) {
  try {
    const p = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: targetRoot,
      encoding: "utf8",
    }).trim();
    return p && (isAbsolute(p) ? p : join(targetRoot, p));
  } catch {
    return join(targetRoot, ".git", "hooks");
  }
}

// The sandbox config to merge into settings — deny the credential dirs an agent should never read.
const SANDBOX = {
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
  credentials: { deny: ["~/.aws", "~/.ssh", "GITHUB_TOKEN", "NPM_TOKEN"] },
};

// The ownership marker: a hook containing this line is OURS to rewrite; anything else
// is user-authored and never clobbered.
const MARKER = `installed by ${BRAND.cli} harden`;

/** The pre-commit script: gitleaks when present (deep scan), then the built-in commit
 *  gate. Fail-open by construction — a missing node or a moved package skips the gate
 *  instead of bricking every commit on this machine. */
export function preCommitScript() {
  const cli = join(BRAND.root, "src", "cli.js");
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER}`,
    `# commit rung of the gate lattice: gitleaks (if installed) + \`${BRAND.cli} precommit\``,
    "if command -v gitleaks >/dev/null 2>&1; then",
    "  gitleaks protect --staged --redact -v || exit 1",
    "fi",
    "command -v node >/dev/null 2>&1 || exit 0",
    `[ -f "${cli}" ] || exit 0`,
    `exec node "${cli}" precommit`,
    "",
  ].join("\n");
}

export function harden({ targetRoot = process.cwd() } = {}) {
  const report = {};

  // Pre-commit gate (WIRE) — only in a git repo. gitleaks is now optional: when absent
  // the hook still runs the built-in secret scan + completeness classifier.
  if (!existsSync(join(targetRoot, ".git"))) {
    report.gitleaks = "not a git repo — skipped";
    report.precommit = "not a git repo — skipped";
  } else {
    report.gitleaks = have("gitleaks")
      ? "installed — the pre-commit hook runs it first"
      : "not installed — hook falls back to the built-in secret scan (`brew install gitleaks` for deeper coverage)";
    const hooks = gitHooksDir(targetRoot);
    mkdirSync(hooks, { recursive: true });
    const hookPath = join(hooks, "pre-commit");
    let existing = null;
    try {
      existing = readFileSync(hookPath, "utf8");
    } catch {}
    // No-clobber: a user-authored hook (no marker) is never overwritten — write ours
    // beside it for the user to merge or exec.
    const target =
      existing !== null && !existing.includes(MARKER)
        ? join(hooks, `pre-commit.${BRAND.cli}`)
        : hookPath;
    writeFileSync(target, preCommitScript());
    try {
      chmodSync(target, 0o755);
    } catch {
      /* best effort */
    }
    report.precommit =
      target === hookPath
        ? `installed pre-commit (gitleaks-if-present + \`${BRAND.cli} precommit\`)`
        : `existing pre-commit kept — wrote pre-commit.${BRAND.cli} beside it (merge or exec it from your hook)`;
  }

  // Sandbox settings (WIRE — Anthropic owns the sandbox; we write the block to merge).
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "sandbox.json"), JSON.stringify(SANDBOX, null, 2));
  report.sandbox = "written to .forge/sandbox.json";
  return report;
}

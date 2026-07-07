// forge harden — WIRE the mature security controls Anthropic/the community already
// own: enable the Claude Code sandbox (84% fewer prompts, per Anthropic) and install
// a Gitleaks pre-commit hook. We never auto-edit ~/.claude/settings.json (no clobber)
// — we write the sandbox block for the user to merge, and only touch the repo's own hooks.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasBin as have } from "./util.js";

// The sandbox config to merge into settings — deny the credential dirs an agent should never read.
const SANDBOX = {
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
  credentials: { deny: ["~/.aws", "~/.ssh", "GITHUB_TOKEN", "NPM_TOKEN"] },
};

export function harden({ targetRoot = process.cwd() } = {}) {
  const report = {};

  // Gitleaks pre-commit (WIRE) — only in a git repo, only if gitleaks is installed.
  if (!existsSync(join(targetRoot, ".git"))) {
    report.gitleaks = "not a git repo — skipped";
  } else if (!have("gitleaks")) {
    report.gitleaks = "gitleaks not installed — `brew install gitleaks` then re-run";
  } else {
    const hooks = join(targetRoot, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "pre-commit"),
      "#!/usr/bin/env bash\n# installed by forge harden\nexec gitleaks protect --staged --redact -v\n",
    );
    try {
      chmodSync(join(hooks, "pre-commit"), 0o755);
    } catch {
      /* best effort */
    }
    report.gitleaks = "installed pre-commit";
  }

  // Sandbox settings (WIRE — Anthropic owns the sandbox; we write the block to merge).
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "sandbox.json"), JSON.stringify(SANDBOX, null, 2));
  report.sandbox = "written to .forge/sandbox.json";
  return report;
}

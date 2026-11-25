// forge harden — WIRE the mature security controls Anthropic/the community already
// own: enable the Claude Code sandbox (84% fewer prompts, per Anthropic) and install
// the commit-level gate rung as a pre-commit hook: gitleaks first when it's installed,
// then the built-in commit gate (`<cli> precommit` — completeness F1 + secret-scan
// fallback, src/commit_gate.js). We never auto-edit ~/.claude/settings.json (no
// clobber) — we write the sandbox block for the user to merge — and the same no-clobber
// rule protects a user-authored pre-commit hook: ours lands beside it as
// `pre-commit.<cli>` instead of overwriting it.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BRAND } from "./brand.js";
import { containsPath, physicalPath, readBounded } from "./private_paths.js";
import { contentHash, hasBin as have } from "./util.js";

// Git honors core.hooksPath (including a global setting) and may share hooks between
// worktrees. Installing a fallback for one project must stay inside its own checkout.
function localHooksDir(root, fromInit) {
  if (!lstatSync(join(root, ".git"), { throwIfNoEntry: false })) return null;
  let directory;
  try {
    const raw = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "rev-parse", "--git-path", "hooks"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trimEnd();
    if (!raw) return null;
    directory = resolve(root, raw);
  } catch {
    // Preserve harden's support for a newly initialized .git directory.
    if (fromInit || !lstatSync(join(root, ".git")).isDirectory()) return null;
    directory = join(root, ".git", "hooks");
  }
  const configured = spawnSync("git", ["config", "--show-scope", "--get", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (configured.status === 0 && !/^(?:local|worktree)\s/.test(configured.stdout))
    throw new Error("Git obtains its active hook directory from shared configuration");
  if (directory === root || !containsPath(root, directory) || physicalPath(directory) !== directory)
    throw new Error("Git uses a shared or linked hook directory outside this checkout");
  return directory;
}

// The settings block to merge — the sandbox plus deny rules for the credential stores an
// agent should never read. The deny list is `permissions.deny` with real `Read(<glob>)`
// rules: the earlier `credentials.deny` key was invented here and Claude Code reads no such
// key, so the "denied" paths were never denied (review B8).
const SANDBOX = {
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
  permissions: {
    deny: [
      "Read(~/.aws/**)",
      "Read(~/.ssh/**)",
      "Read(~/.config/gcloud/**)",
      "Read(~/.netrc)",
      "Read(~/.npmrc)",
      "Read(~/.git-credentials)",
    ],
  },
};

const MARKER = `installed by ${BRAND.cli} harden`;
const INIT_MARKER = "# Managed by forge init for hosts without edit callbacks";
const CHECKSUM = "# ForgeKit hook body sha256 ";
// A personal hook may call its sibling unconditionally. Keep that path callable
// after deselection, including when the Forge CLI is no longer installed.
const inactiveBody = `#!/usr/bin/env bash\n# ${MARKER}\n${INIT_MARKER}\nexit 0\n`;
const inactiveSibling = inactiveBody + CHECKSUM + contentHash(inactiveBody) + "\n";
const cliPath = join(BRAND.root, "src", "cli.js");
const quotedCli = `'${cliPath.replaceAll("'", "'\\''")}'`;

function hookBody(requireVerified, fromInit, cliArgument) {
  const missing = requireVerified ? 1 : 0;
  return [
    "#!/usr/bin/env bash",
    `# ${MARKER}`,
    ...(fromInit ? [INIT_MARKER] : []),
    `# commit rung of the gate lattice: gitleaks (if installed) + \`${BRAND.cli} precommit\``,
    "if command -v gitleaks >/dev/null 2>&1; then",
    "  gitleaks protect --staged --redact -v || exit 1",
    "fi",
    `command -v node >/dev/null 2>&1 || exit ${missing}`,
    `[ -f ${cliArgument} ] || exit ${missing}`,
    ...(fromInit && requireVerified
      ? ['if [ "$FORGE_GATE" = advisory ]; then', `  exec node ${cliArgument} precommit`, "fi"]
      : []),
    `exec node ${cliArgument} precommit${requireVerified ? " --require-verified" : ""}`,
    "",
  ].join("\n");
}

/** The checksum identifies local edits even when the package has moved since installation. */
export function preCommitScript({ requireVerified = false, fromInit = false } = {}) {
  const body = hookBody(requireVerified, fromInit, quotedCli);
  return `${body + CHECKSUM + contentHash(body)}\n`;
}

function hookState(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { exists: false, owned: false, strict: false, fromInit: false };
  if (entry.isFile() && entry.nlink === 1 && !entry.isSymbolicLink()) {
    try {
      const current = readBounded(path, 16 * 1024).bytes.toString("utf8");
      const at = current.lastIndexOf(CHECKSUM);
      const body = at < 0 ? current : current.slice(0, at);
      const intact =
        at >= 0 &&
        body.startsWith(`#!/usr/bin/env bash\n# ${MARKER}\n`) &&
        current.slice(at) === `${CHECKSUM + contentHash(body)}\n`;
      // The published wrapper predated checksums and used double-quoted argv.
      // Match its complete template, preserving edits to either old or new hooks.
      const old =
        at < 0 &&
        ([quotedCli, `"${cliPath}"`].some((cli) => body === hookBody(false, false, cli)) ||
          body === hookBody(true, false, quotedCli));
      if (intact || old)
        return {
          exists: true,
          owned: true,
          strict: body.endsWith(" precommit --require-verified\n"),
          fromInit: body.split("\n").includes(INIT_MARKER),
          current,
          executable: process.platform === "win32" || Boolean(entry.mode & 0o111),
        };
    } catch {}
  }
  return { exists: true, owned: false, strict: false, fromInit: false };
}

function publishHook(target, state, script) {
  const temp = join(dirname(target), `.forge-hook-${randomUUID()}`);
  try {
    writeFileSync(temp, script, { flag: "wx", mode: 0o755 });
    if (state.owned) {
      if (hookState(target).current !== state.current)
        throw new Error("The Git hook changed during setup");
      renameSync(temp, target);
    } else {
      linkSync(temp, target);
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Retire only intact hooks marked as installed by init. Explicit harden and
 * personal hooks have independent owners. */
export function retireInitCommitHook(targetRoot) {
  try {
    const hooks = localHooksDir(realpathSync.native(targetRoot), true);
    if (!hooks) return null;
    const primary = join(hooks, "pre-commit");
    const sibling = join(hooks, `pre-commit.${BRAND.cli}`);
    const changes = [];
    const first = hookState(primary);
    if (first.fromInit) {
      if (hookState(primary).current !== first.current)
        throw new Error("The Git hook changed during setup");
      rmSync(primary);
      changes.push("removed the init-managed pre-commit hook");
    }
    const side = hookState(sibling);
    if (side.fromInit && side.current !== inactiveSibling) {
      publishHook(sibling, side, inactiveSibling);
      changes.push("disabled the init-managed sibling");
    }
    return changes.length ? { state: "retired", active: false, message: changes.join(", ") } : null;
  } catch (error) {
    return { state: "manual", active: false, message: error.message };
  }
}

/** Install just the Git check. A user-owned hook may opt into a sibling via
 * `git hook run` or by invoking it explicitly. No global Git or host settings are needed. */
export function installCommitHook({
  targetRoot,
  requireVerified = false,
  fromInit = false,
  existingOnly = false,
}) {
  const command = `${BRAND.cli} precommit${requireVerified ? " --require-verified" : ""}`;
  const manual = `Run ${command} from your existing pre-commit hook or require ${BRAND.cli} verify --json in CI.`;
  try {
    const root = realpathSync.native(targetRoot);
    const hooks = localHooksDir(root, fromInit);
    if (!hooks && existingOnly) return null;
    if (!hooks)
      return {
        state: "unavailable",
        active: false,
        message: `not a git repo — initialize Git and rerun setup, or require ${BRAND.cli} verify --json in CI`,
      };
    const primary = join(hooks, "pre-commit");
    const previous = hookState(primary);
    const sidecar = previous.exists && !previous.owned;
    const target = sidecar ? join(hooks, `pre-commit.${BRAND.cli}`) : primary;
    const state = sidecar ? hookState(target) : previous;
    if (existingOnly && (!state.fromInit || state.current === inactiveSibling)) return null;
    mkdirSync(hooks, { recursive: true });
    if (realpathSync.native(hooks) !== hooks)
      throw new Error("The Git hook directory changed during setup");
    if (state.exists && !state.owned)
      return {
        state: "manual",
        active: false,
        message: `Both the existing pre-commit and its ForgeKit sibling are user-managed. ${manual}`,
      };
    const strict = requireVerified || (state.strict && (!fromInit || !state.fromInit));
    const script = preCommitScript({
      requireVerified: strict,
      fromInit: fromInit && (!state.owned || state.fromInit),
    });
    if (state.current !== script || !state.executable) {
      publishHook(target, state, script);
    }
    const installed = `${BRAND.cli} precommit${strict ? " --require-verified" : ""}`;
    return sidecar
      ? {
          state: "manual",
          active: false,
          path: target,
          message: `existing pre-commit kept — wrote pre-commit.${BRAND.cli} beside it. Invoke ${target} from your hook to activate ${installed}.`,
        }
      : {
          state: "installed",
          active: true,
          path: target,
          message: `installed pre-commit (gitleaks-if-present + ${installed})`,
        };
  } catch (error) {
    return { state: "manual", active: false, message: `${error.message}. ${manual}` };
  }
}

export function harden({ targetRoot = process.cwd(), requireVerified = false } = {}) {
  const hook = installCommitHook({ targetRoot, requireVerified });
  const report = {
    precommit: hook.message,
    gitleaks:
      hook.state === "unavailable"
        ? "not a git repo — skipped"
        : have("gitleaks")
          ? "installed — the pre-commit hook runs it first"
          : "not installed — the hook uses the built-in secret scan",
    sandbox: "",
  };

  // Sandbox settings (WIRE — Anthropic owns the sandbox; we write the block to merge).
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "sandbox.json"), JSON.stringify(SANDBOX, null, 2));
  report.sandbox =
    "written to .forge/sandbox.json (sandbox + permissions.deny — merge it into ~/.claude/settings.json)";
  return report;
}

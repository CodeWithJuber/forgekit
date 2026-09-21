#!/usr/bin/env node
// PreToolUse guard — block reads/edits of secret/credential files and obviously destructive
// Bash. The whole rule set lives in Node (the secret-redact.sh → secret-redact.mjs pattern),
// for three reasons the shell version could not give:
//   1. ONE parser. The shell guard read its payload with jq, else a regex that stopped at the
//      first escaped quote — `echo "x"; cat .env` arrived as `echo \`, so every rule after it
//      silently missed (2 review-found bypasses, reproduced here as tests).
//   2. NO pipeline hazards. `printf … | grep -q` under `pipefail` fails when grep exits early
//      and printf takes SIGPIPE, so on a LARGE command the deny did not fire.
//   3. FAIL CLOSED. Exit 1 is a non-blocking hook error in Claude Code; `set -e` turned every
//      internal hiccup into a silent pass. Here any error denies with a reason (exit 2).
//
// SCOPE: pattern matching, not a sandbox. Regex cannot parse shell, so interpreter-driven
// access (`python -c 'open(".env")…'`, `node -e …`) is DELIBERATELY out of scope. This layer
// sits behind the permission system and secret-redact.sh: best-effort hardening, never a
// boundary.

// ── File rules. Paths are normalized to forward slashes (Claude Code sends native Windows
// paths) and matched case-insensitively (NTFS is; a `.ENV` is still a secret on POSIX).
const FILE_RULES = [
  { re: /\.env($|\.)/i, what: "env file" },
  {
    re: /\.pem($|\.)|(^|\/)id_rsa($|\.)|(^|\/)id_ed25519($|\.)|\.key($|\.)/i,
    what: "credential/key file",
  },
  { re: /\/secrets\/|\/\.ssh\//i, what: "path under secrets/ or .ssh/" },
  {
    re: /(^|\/)(\.aws\/credentials|\.netrc|_netrc|\.npmrc|\.git-credentials)$/i,
    what: "credential store",
  },
];

// ── Command rules. A command word starts at the line start, after a separator, or after
// whitespace (so `sudo rm`, `env rm` and `/bin/rm` are all caught).
const B = "(^|[^A-Za-z0-9_.-])([^\\s;&|]*/)?";
const SEG = "([^;&|]*\\s)?"; // further args inside the SAME command segment
const TARGET = "[\"']?(/|~|\\$HOME|\\$\\{HOME\\})"; // an absolute/home path operand
const RECUR = "(-[A-Za-z]*[rR][A-Za-z]*|--recursive)";
// Git readers that can print file or history content (RA-05, HI-07), behind an optional
// `env `/`command `/`VAR=val ` prefix, an absolute path, and git's own global options.
const gitpfx = "([A-Za-z0-9_]+=\\S+\\s+|(env|command)\\s+)*(\\S*/)?git\\s+";
const gitopt =
  "(-C\\s+\\S+\\s+|--no-pager\\s+|-c\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+)*";
const gitsub = "(show|log|diff|stash|cat-file|archive|grep|blame|show-index|bundle)(\\s|$)";
const READER = `(^|[;&|])\\s*((cat|less|more|head|tail|nl|xxd|od|strings|base64|rg|grep|ag)\\s|${gitpfx}${gitopt}${gitsub})`;
// \b anchors the extensions so `.key` matches a real key file but NOT `Object.keys`, and
// `.env` matches `.env`/`.env.prod` but NOT `.environment`.
const SECRET_TOKEN =
  "(\\.env(\\.[A-Za-z0-9_-]+)?\\b|id_rsa\\b|id_ed25519\\b|\\.pem\\b|\\.key\\b|/secrets/|/\\.ssh/|\\.netrc\\b|_netrc\\b|\\.npmrc\\b|\\.git-credentials\\b|\\.aws/credentials\\b)";
// A protected path as a redirection target, or as an argument to a mutating command. Each
// alternative embeds the token, so a bare `echo hi > out.txt` is never blocked.
const WRITE = [
  `>>?\\s*["']?[^\\s<>|;&]*${SECRET_TOKEN}`,
  `(^|[;&|])\\s*(${gitpfx})?(tee(\\s+-a)?|cp|mv|install)\\s+[^;&|]*${SECRET_TOKEN}`,
  `(^|[;&|])\\s*sed\\s+[^;&|]*-i[^;&|]*${SECRET_TOKEN}`,
  `(^|[;&|])\\s*dd\\s+([^;&|]*\\s)?of=\\S*${SECRET_TOKEN}`,
].join("|");

/** @type {{all: RegExp[], reason: string}[]} — first match wins; protected paths first, so
 *  `dd if=x of=.env` reads as a secret write rather than as a generic `dd of=`. */
const COMMAND_RULES = [
  {
    // Close the Bash secret-READ bypass (P0-04): the Read tool denies .env/keys, but a shell
    // `cat .env` / `git show HEAD:.env` sidesteps that. A reader command AND a protected
    // path token — so prose in a quoted arg (a commit message naming ".env") is not a hit.
    all: [new RegExp(READER), new RegExp(SECRET_TOKEN)],
    reason: "reading a protected secret path via Bash is blocked. Read it yourself if intended.",
  },
  {
    // Close the Bash secret-WRITE bypass (HI-06).
    all: [new RegExp(WRITE)],
    reason: "writing to a protected secret path via Bash is blocked. Edit it yourself if intended.",
  },
  {
    // Recursive delete of an absolute/home path, flags in any order or grouping.
    all: [
      new RegExp(
        `${B}rm\\s+${SEG}${RECUR}(\\s[^;&|]*)?\\s${TARGET}|${B}rm\\s+${SEG}${TARGET}[^;&|]*\\s${RECUR}(\\s|$)|${B}rm\\s+${SEG}--no-preserve-root`,
      ),
    ],
    reason: "destructive rm (recursive delete of an absolute/home path) detected.",
  },
  {
    // `--force-with-lease` / `--force-if-includes` are the SAFE variants and stay allowed.
    all: [
      new RegExp(
        `git\\s${SEG}push\\s${SEG}(--force([\\s=]|$)|-[A-Za-z0-9]*f[A-Za-z0-9]*(\\s|$)|\\+\\S+(\\s|$))`,
      ),
    ],
    reason: "force-push blocked (--force-with-lease is allowed). Ask the user first.",
  },
  {
    all: [new RegExp(`git\\s${SEG}reset\\s${SEG}--hard(\\s|$)`)],
    reason: "`git reset --hard` discards uncommitted work. Ask the user first.",
  },
  {
    all: [new RegExp(`git\\s${SEG}clean\\s${SEG}(-[A-Za-z0-9]*f[A-Za-z0-9]*|--force)(\\s|$)`)],
    reason: "`git clean -f` deletes untracked files for good. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}find\\s[^;&|]*\\s(-delete|-exec\\s+(\\S*/)?rm)(\\s|$)`)],
    reason: "`find … -delete` / `-exec rm` detected. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}chmod\\s+${SEG}(-[A-Za-z]*R[A-Za-z]*|--recursive)(\\s|$)`)],
    reason: "recursive chmod detected. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}dd\\s+${SEG}of=`)],
    reason: "`dd … of=` overwrites its target. Ask the user first.",
  },
  {
    // Case-insensitive for the SQL keywords; the bare `TRUNCATE <table>` form stays
    // uppercase-only so the coreutils `truncate` command is not a false positive.
    all: [/\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|TRUNCATE\s+[A-Za-z0-9_"]/i],
    reason: "destructive SQL detected. Confirm with the user.",
  },
  {
    // Pipe-to-shell (curl … | sh). Boundary-aware so `… | shellcheck` is not caught.
    all: [/\|\s*(sh|bash|zsh)(\s|$)/],
    reason: "piping content to a shell is blocked.",
  },
];

/**
 * PURE decision over one tool call — the testable core.
 * @param {{toolName?: string, filePath?: string, command?: string}} call
 * @returns {{block: boolean, reason?: string}}
 */
export function protectPathsDecision({ toolName = "", filePath = "", command = "" } = {}) {
  const path = String(filePath).replaceAll("\\", "/");
  if (path) {
    // A plugin install carries no `permissions.deny` block, so for Read this guard is the
    // only thing between the agent and `.env`.
    const verb = /^(Read|Grep|Glob|NotebookRead)$/.test(String(toolName)) ? "read" : "modify";
    for (const { re, what } of FILE_RULES) {
      if (re.test(path))
        return {
          block: true,
          reason: `refusing to ${verb} ${what} (${filePath}). Handle it yourself if intended.`,
        };
    }
  }
  const cmd = String(command);
  if (cmd) {
    for (const rule of COMMAND_RULES) {
      if (rule.all.every((re) => re.test(cmd))) return { block: true, reason: rule.reason };
    }
  }
  return { block: false };
}

/** @param {string} reason */
function deny(reason) {
  // Structured decision for current Claude Code; exit-2 + stderr is the version-agnostic
  // fallback that older versions (and `forge doctor`) rely on.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stderr.write(`BLOCKED by protect-paths guard: ${reason}\n`);
  process.exit(2);
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    deny("cannot parse the hook payload — blocking to fail closed");
    return;
  }
  const inp = data.tool_input ?? {};
  const d = protectPathsDecision({
    toolName: data.tool_name,
    filePath: inp.file_path ?? inp.notebook_path ?? inp.path ?? "",
    command: inp.command ?? "",
  });
  if (d.block) deny(String(d.reason));
}

// Run only as the hook entrypoint; importing it (tests) must evaluate no payload.
if (process.argv[1] && /protect-paths\.mjs$/i.test(process.argv[1])) {
  main().catch((err) => deny(`internal error (${err?.message ?? err}) — blocking to fail closed`));
}

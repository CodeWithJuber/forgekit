// forge precommit — the commit-level rung of the gate lattice (turn ⊂ commit ⊂ PR).
// The Stop hook gates the TURN and CI's docs check gates the PR; this module runs the
// same F1 classifier at the commit boundary so a commit that ships code without its
// doc/state artifact is caught while the fix is still one `git add` away. Same math as
// the paper's Theorem D: each rung is an independent cⱼ layer over the identical
// structural signal, so P(silent miss) falls multiplicatively, not by hope.
//
// Two detectors, both reused — never reimplemented:
//  (i) COMPLETENESS — classifyPath (gate.js), the same registry-derived total function
//      the Stop gate and the atlas share: code staged with no docs-class artifact in
//      the same commit is a finding.
//  (ii) SECRETS — hasSecret (secrets.js) over the staged ADDED lines only (context
//      lines predate the commit), as the built-in fallback when gitleaks is absent.
//
// Modes via FORGE_COMMIT_GATE: "warn" (default — print findings, allow), "block"
// (completeness findings refuse the commit), "0"/"off" (kill switch). A secret finding
// blocks in BOTH warn and block modes — evidence-proportional (mizan): a missing doc is
// repairable in the next commit, a credential in history is not; the kill switch and
// `git commit --no-verify` remain the explicit overrides. Fail-open like stopGate:
// any internal error resolves to allow — the gate must never brick a commit.

import { execFileSync } from "node:child_process";
import { BRAND } from "./brand.js";
import { CLASSES, classifyPath } from "./gate.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { IGNORE_DIRS } from "./util.js";

// A BLOCKING detector needs redaction-grade precision, not store-refusal breadth:
// hasSecret's ASSIGNED branch deliberately refuses ANY key-assigned value (cheap and
// conservative for a store), which would flag ordinary code like
// `token = process.env.TOKEN` — a false block that costs the gate its credibility.
// So detection is confirmed by the same module's NARROWER redaction rules (format
// grammars, PEM, entropy tokens, opaque assigned literals — never a code expression):
// one source of truth (secrets.js), calibrated to the verb (mizan).
const lineBlockSecret = (text) => hasSecret(text) && redactSecrets(text) !== text;

// Exact bytes, no trim — same discipline as gate.js's gitRaw.
function gitRaw(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

// Vendor/build trees force-staged past .gitignore are never pinned on the committer —
// but .forge/ stays IN scope: the ledger/decisions are deliberately git-committable
// and a staged .forge/decisions.md must keep its docs credit.
const vendorPrefixed = (p) => {
  const top = String(p).split("/")[0];
  return top !== ".forge" && IGNORE_DIRS.has(top);
};

/**
 * Staged paths, NUL-separated (`-z`, per the stop gate's parsing discipline): git's
 * C-quoting of unicode/space paths never reaches us, so `Änderungen.md` keeps its
 * docs classification instead of degrading to `other`.
 * @param {string} root
 * @returns {string[]}
 */
export function stagedFiles(root) {
  return gitRaw(root, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean)
    .filter((p) => !vendorPrefixed(p));
}

/**
 * Staged ADDED lines per file (`--unified=0` — context/removed lines predate this
 * commit and must not trigger the secret scan). Header paths are informational only
 * (git may C-quote exotic names there); detection never depends on path fidelity.
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
export function stagedAddedLines(root) {
  const raw = gitRaw(root, ["diff", "--cached", "--unified=0", "--no-color"]);
  const byFile = new Map();
  let file = null;
  // A `+++ ` line is the file header ONLY between `diff --git` and the first `@@`; once
  // inside a hunk, a `+`-prefixed line is content — including added content that itself
  // begins with `++ ` (which renders as `+++ ` in the diff and would otherwise be
  // misread as a header, dropping that line and mis-attributing the ones after it).
  let inHunk = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !file || !line.startsWith("+")) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(line.slice(1));
  }
  return byFile;
}

/**
 * Resolve the gate mode from FORGE_COMMIT_GATE's raw value. Total: any unrecognized
 * value degrades to the default ("warn"), never to a crash or a silent block.
 * @param {string} [v]
 * @returns {"warn"|"block"|"off"}
 */
export function gateMode(v = process.env.FORGE_COMMIT_GATE) {
  if (v === "0" || v === "off") return "off";
  if (v === "block") return "block";
  return "warn";
}

/**
 * PURE decision table over already-gathered facts — the testable core, no git.
 * @param {{staged?: string[], secretFiles?: string[], mode?: "warn"|"block"|"off"}} [opts]
 * @returns {{allow: boolean, row: string, findings: {kind: string, severity: string, detail: string, files: string[]}[], classes?: Record<string, string[]>}}
 */
export function commitGateDecision({ staged = [], secretFiles = [], mode = "warn" } = {}) {
  if (mode === "off") return { allow: true, row: "kill-switch", findings: [] };
  const classes = Object.fromEntries(CLASSES.map((c) => [c, []]));
  for (const f of staged) classes[classifyPath(f)].push(f);
  const findings = [];
  if (secretFiles.length) {
    findings.push({
      kind: "secret",
      severity: "block", // blocks in every mode — see header (mizan)
      detail: `staged added lines look like a credential in: ${secretFiles.join(", ")}`,
      files: secretFiles,
    });
  }
  if (classes.code.length && !classes.docs.length) {
    findings.push({
      kind: "completeness",
      severity: mode === "block" ? "block" : "warn",
      detail: `code staged with no doc/state artifact in the same commit: ${classes.code
        .slice(0, 10)
        .join(", ")}${classes.code.length > 10 ? ` (+${classes.code.length - 10} more)` : ""}`,
      files: classes.code,
    });
  }
  const allow = !findings.some((f) => f.severity === "block");
  return {
    allow,
    row: allow ? (findings.length ? "warned" : "clean") : "blocked",
    findings,
    classes,
  };
}

/**
 * The impure orchestrator the CLI (and the harden-installed pre-commit hook) calls.
 * Every step guarded; ANY internal error resolves to allow (fail-open, like stopGate).
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 */
export function commitGate(root, { env = process.env } = {}) {
  try {
    const mode = gateMode(env.FORGE_COMMIT_GATE);
    if (mode === "off")
      return {
        allow: true,
        mode,
        row: "kill-switch",
        findings: [],
        staged: [],
      };
    if (gitRaw(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true")
      return { allow: true, mode, row: "not-a-repo", findings: [], staged: [] };
    const staged = stagedFiles(root);
    if (!staged.length)
      return {
        allow: true,
        mode,
        row: "nothing-staged",
        findings: [],
        staged: [],
      };
    const secretFiles = [];
    for (const [file, lines] of stagedAddedLines(root)) {
      if (lineBlockSecret(lines.join("\n"))) secretFiles.push(file);
    }
    return {
      ...commitGateDecision({ staged, secretFiles, mode }),
      mode,
      staged,
    };
  } catch {
    return {
      allow: true,
      mode: "warn",
      row: "internal-error",
      findings: [],
      staged: [],
    };
  }
}

/**
 * Human-readable report — the reason IS the repair procedure, same contract as the
 * Stop gate's checklist.
 * @param {ReturnType<typeof commitGate>} r
 */
export function renderCommitGate(r) {
  const lines = [];
  if (r.row === "kill-switch") return "  commit gate off (FORGE_COMMIT_GATE=0)";
  if (r.row === "not-a-repo") return "  not a git repo — nothing to gate";
  if (r.row === "nothing-staged") return "  nothing staged — nothing to gate";
  if (r.row === "internal-error") return "  commit gate error — failing open (commit proceeds)";
  if (!r.findings.length) return `  ✓ staged changes pass (${r.staged.length} file(s), ${r.mode})`;
  for (const f of r.findings) {
    lines.push(`  ${f.severity === "block" ? "✗" : "!"} [${f.kind}] ${f.detail}`);
    if (f.kind === "completeness") {
      lines.push(
        `      fix: \`${BRAND.cli} docs sync\` then stage the updated doc — or \`${BRAND.cli} handoff\`/\`${BRAND.cli} decide\` and stage the artifact.`,
      );
    }
    if (f.kind === "secret") {
      lines.push(
        "      fix: remove the credential from the staged lines (use an env var), then re-stage.",
      );
    }
  }
  lines.push(
    r.allow
      ? `  → allowed (${r.mode} mode). FORGE_COMMIT_GATE=block makes completeness findings refuse the commit.`
      : "  → commit refused. Kill switch: FORGE_COMMIT_GATE=0 (or `git commit --no-verify`).",
  );
  return lines.join("\n");
}

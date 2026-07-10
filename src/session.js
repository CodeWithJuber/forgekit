// forge session — per-session git anchoring. Nothing recorded WHERE the repo stood when
// a session began, so "what changed this session" was unanswerable and every diff ran
// against live HEAD. SessionStart records the anchor once (resume keeps it); the
// completion gate diffs against it; the rehydration block tells a fresh session what
// recently happened instead of letting it assume.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { sessionPath } from "./cortex_hook.js";

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Raw NUL-separated porcelain — the ONLY quote-proof status format (paths with
// spaces/unicode/quotes arrive verbatim, no C-quoting to undo).
function statusPathsZ(root) {
  try {
    const raw = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tokens = raw.split("\0").filter(Boolean);
    const paths = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.length < 4 || t[2] !== " ") continue; // defensive: not an "XY path" entry
      paths.push(t.slice(3));
      if (/[RC]/.test(t[0])) paths.push(tokens[++i] ?? ""); // rename/copy: next token is the source path
    }
    return paths.filter(Boolean);
  } catch {
    return [];
  }
}

/** Record HEAD as this session's baseline — once. An existing file wins (a --resume
 *  re-fires SessionStart and must NOT move the anchor mid-session). Also snapshots the
 *  files ALREADY dirty at session start (even on an unborn HEAD), so the completion
 *  gate never attributes pre-existing dirt to this session. */
export function recordBaseline(root, sid) {
  const head = git(root, ["rev-parse", "HEAD"]);
  const dirtyPath = sessionPath(root, sid, "dirty");
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) === "true" && !existsSync(dirtyPath)) {
      mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
      writeFileSync(dirtyPath, `${statusPathsZ(root).join("\n")}\n`);
    }
  } catch {}
  if (!head) return { recorded: false, head: null }; // unborn HEAD → dirty snapshot only
  const p = sessionPath(root, sid, "base");
  try {
    if (existsSync(p)) return { recorded: false, head: readFileSync(p, "utf8").trim() };
    mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
    writeFileSync(p, `${head}\n`);
    return { recorded: true, head };
  } catch {
    return { recorded: false, head };
  }
}

/** The set of paths that were already dirty when the session started (empty when the
 *  snapshot is missing — degraded mode, gate errs toward its other guards). */
export function readDirtySnapshot(root, sid) {
  try {
    const p = sessionPath(root, sid, "dirty");
    if (!existsSync(p)) return null;
    return new Set(readFileSync(p, "utf8").split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

/** The session's anchor: baseline sha + the file's mtime (= when the session started —
 *  the completion gate compares state.md's mtime against it). Null when never recorded. */
export function readBaseline(root, sid) {
  const p = sessionPath(root, sid, "base");
  try {
    if (!existsSync(p)) return null;
    return { head: readFileSync(p, "utf8").trim(), t: statSync(p).mtimeMs };
  } catch {
    return null;
  }
}

/** Age out stale per-session artifacts (logs, baselines, markers) in one sweep. */
export function pruneSessions(root, { maxAgeDays = 7, now = Date.now() } = {}) {
  const dir = join(root, ".forge", "sessions");
  let removed = 0;
  try {
    for (const f of readdirSync(dir)) {
      try {
        if (now - statSync(join(dir, f)).mtimeMs > maxAgeDays * 86_400_000) {
          unlinkSync(join(dir, f));
          removed += 1;
        }
      } catch {}
    }
  } catch {}
  return { removed };
}

/** SessionStart injection: recent commits + uncommitted changes — the repo's actual
 *  recent history, so a fresh session orients on evidence instead of assumptions.
 *  Empty string outside a git repo (low-nag). */
export function rehydrationBlock(root, { commits = 10, statusCap = 20 } = {}) {
  const log = git(root, ["log", "--oneline", `-${commits}`])
    .split("\n")
    .filter(Boolean);
  if (!log.length) return "";
  const lines = [
    `## Where this repo stands (${BRAND.brand})`,
    "Recent commits:",
    ...log.map((l) => `- ${l}`),
  ];
  const status = git(root, ["status", "--short"]).split("\n").filter(Boolean);
  if (status.length) {
    lines.push(
      "Uncommitted changes at session start:",
      ...status.slice(0, statusCap).map((s) => `- ${s}`),
    );
    if (status.length > statusCap) lines.push(`- (+${status.length - statusCap} more)`);
  }
  lines.push("");
  return lines.join("\n");
}

// forge session — per-session git anchoring. Nothing recorded WHERE the repo stood when
// a session began, so "what changed this session" was unanswerable and every diff ran
// against live HEAD. SessionStart records the anchor once (resume keeps it); the
// completion gate diffs against it; the rehydration block tells a fresh session what
// recently happened instead of letting it assume. The session TRAIL (below) narrows that
// diff to the files this session itself touched, so a checkout shared by several agents
// does not pin one agent's edits on another.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BRAND } from "./brand.js";
import { isE2eRun, sessionPath } from "./cortex_hook.js";
import { redactSecrets } from "./secrets.js";
import { git, IGNORE_DIRS } from "./util.js";
import { computeCodeState, evidenceMac } from "./verify.js";

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

/** A content fingerprint (sha256 hex of the bytes) of a working-tree file, or null when
 *  it can't be read (missing/deleted/binary-unreadable). The session baseline stores this
 *  per pre-dirty path so the gate can tell an untouched pre-existing edit (fingerprint
 *  still matches → keep hiding it) from one the agent edited FURTHER this session
 *  (fingerprint moved → it's a real session change, HI-03). */
export function fingerprintFile(root, rel) {
  try {
    return createHash("sha256")
      .update(readFileSync(join(root, rel)))
      .digest("hex");
  } catch {
    return null;
  }
}

/** Record HEAD as this session's baseline — once. An existing file wins (a --resume
 *  re-fires SessionStart and must NOT move the anchor mid-session). Also snapshots the
 *  files ALREADY dirty at session start (even on an unborn HEAD), so the completion
 *  gate never attributes pre-existing dirt to this session. Each pre-dirty path is stored
 *  WITH a content fingerprint (`<sha256>\t<path>`) so a further edit to an already-dirty
 *  file is still seen as a session change (HI-03). */
export function recordBaseline(root, sid) {
  const head = git(root, ["rev-parse", "HEAD"]);
  const dirtyPath = sessionPath(root, sid, "dirty");
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) === "true" && !existsSync(dirtyPath)) {
      mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
      const lines = statusPathsZ(root).map((p) => `${fingerprintFile(root, p) ?? ""}\t${p}`);
      writeFileSync(dirtyPath, `${lines.join("\n")}\n`);
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

/** A Map<path, fingerprint|null> of the files already dirty when the session started.
 *  `null` fingerprint = unknown (an OLD snapshot that stored paths only, or a file
 *  unreadable at snapshot time) → the gate must NOT silently hide it (degrades to
 *  "potentially changed"). `.has(path)` keeps working for callers that only need
 *  membership. Null when the snapshot is missing (degraded mode). */
export function readDirtySnapshot(root, sid) {
  try {
    const p = sessionPath(root, sid, "dirty");
    if (!existsSync(p)) return null;
    const map = new Map();
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      // New format `<sha256>\t<path>`: split on the FIRST tab (a path may contain tabs).
      if (tab > 0 && /^[0-9a-f]{64}$/.test(line.slice(0, tab)))
        map.set(line.slice(tab + 1), line.slice(0, tab));
      else if (tab === 0)
        map.set(line.slice(1), null); // empty fingerprint written → unknown
      else map.set(line, null); // legacy path-only line → unknown fingerprint
    }
    return map;
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

// ── What THIS session changed ──────────────────────────────────────────────────────────

// Raw bytes (no trim): `git log -z` output is split on NUL below.
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

// Files committed DURING the session: commits in base..HEAD whose committer time is at
// or after session start. A branch switch or `git pull` moves HEAD onto commits made
// long before the session — a plain baseline diff would attribute all of them to the
// agent (review-found false block). Merge commits list no files (correct: the merged
// work predates the session); the 2s slack absorbs clock granularity.
function committedSince(root, baseHead, sinceMs) {
  if (!baseHead || !git(root, ["rev-parse", "--verify", `${baseHead}^{commit}`])) return [];
  const since = new Date(Math.max(0, (sinceMs ?? 0) - 2000)).toISOString();
  const raw = gitRaw(root, [
    "log",
    "--name-only",
    "-z",
    "--pretty=format:",
    `--since=${since}`,
    `${baseHead}..HEAD`,
  ]);
  return raw
    .split("\0")
    .flatMap((chunk) => chunk.split("\n"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Vendor/build trees that are somehow not gitignored must never be pinned on the agent.
const IGNORED_PREFIX = (p) => IGNORE_DIRS.has(String(p).split("/")[0]);

/**
 * Everything the TREE says changed since the session started: files from session-time
 * commits ∪ the working tree minus whatever was already dirty at session start.
 * Pre-existing dirt, pulled-in commits, and vendor trees stay out — near-zero false
 * blocks is the completion gate's credibility. Degraded mode (no baseline/snapshot): the
 * full worktree. Another agent's concurrent edits are still in here; `readTrail` +
 * `attributeChanged` take them out.
 * @param {string} root
 * @param {string|null} [baseHead]
 * @param {{sinceMs?: number, preDirty?: Map<string, string|null>}} [opts]
 * @returns {string[]}
 */
export function changedSet(root, baseHead, { sinceMs, preDirty } = {}) {
  const out = new Set(committedSince(root, baseHead, sinceMs));
  for (const p of statusPathsZ(root)) {
    // A path that was already dirty at session start is hidden ONLY while its content is
    // unchanged since then: its baseline fingerprint must be known AND still match. An
    // unknown baseline (legacy snapshot) or a moved fingerprint means the agent edited a
    // pre-dirty file THIS session — let it flow through the normal classification (HI-03).
    if (preDirty?.has(p)) {
      const baseFp = preDirty.get(p);
      if (baseFp != null && fingerprintFile(root, p) === baseFp) continue;
    }
    out.add(p);
  }
  return [...out].filter((p) => !IGNORED_PREFIX(p)).sort();
}

// ── The session trail ──────────────────────────────────────────────────────────────────
// changedSet reads the TREE, so in a checkout several agents share, a file another agent
// edits mid-session lands in this session's set and the gate blames the wrong agent. The
// trail is this session's own record of what IT touched, appended by the PostToolUse
// capture hook: Edit/Write/MultiEdit/NotebookEdit paths, the file paths a Bash command
// names (`sed -i f`, `cat > f`, `git mv a b`), and passing e2e runs bound to the code state
// they ran against. Unlike the event log (cleared at every Stop), it lasts the session and
// ages out with the other session files. It counts as AUTHORITATIVE only when SessionStart
// opened it (a MAC'd start record: capture was live from the first tool call) and at least
// one tool call landed in it. Otherwise every reader falls back to the tree-wide view.

const TRAIL = "trail";
const TRAIL_PATHS_CAP = 64; // path tokens kept per Bash command

/** Open this session's trail with a signed start record — once (a resume keeps it).
 *  @param {string} root @param {string} sid @returns {boolean} true when it was opened now */
export function openTrail(root, sid) {
  try {
    const p = sessionPath(root, sid, TRAIL);
    if (existsSync(p)) return false;
    mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
    const start = { k: "start", t: Date.now(), mac: evidenceMac(["trail", sid]) };
    writeFileSync(p, `${JSON.stringify(start)}\n`);
    return true;
  } catch {
    return false;
  }
}

// A shell token that names a file: path characters only (no `$`, globs, `=`, `:` — so no
// URLs, env assignments, or `key=value` flags) and either a directory part or an extension.
const PATH_TOKEN = /^[\w./@+-]+$/;

/**
 * The file paths a shell command names, as written (relative or absolute). Heredoc bodies
 * are skipped (they are file CONTENT, not arguments); a `--flag=value` contributes its
 * value. Over-inclusive on purpose: a path the session only read is attributed to it too,
 * which errs toward today's behaviour (blame), never toward a missed change.
 * @param {string} command
 * @returns {string[]}
 */
export function commandPaths(command) {
  const lines = [];
  let heredoc = null;
  for (const line of String(command ?? "").split("\n")) {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    lines.push(line);
    const m = line.match(/<<-?\s*(['"]?)([\w.-]+)\1/);
    if (m) heredoc = m[2];
  }
  const out = new Set();
  for (const raw of lines.join("\n").split(/[\s;&|()<>]+/)) {
    let t = raw.replace(/^['"]+|['"]+$/g, "");
    if (t.startsWith("-") && t.includes("=")) t = t.slice(t.indexOf("=") + 1);
    // A trailing `/` is a directory (or a sed expression): never a changed FILE.
    if (!t || t.startsWith("-") || t.endsWith("/") || !PATH_TOKEN.test(t)) continue;
    if (!t.includes("/") && !/\.[A-Za-z0-9]+$/.test(t)) continue;
    out.add(t);
    if (out.size >= TRAIL_PATHS_CAP) break;
  }
  return [...out];
}

/**
 * PURE: the trail entry one PostToolUse payload contributes, or null. An edit tool logs
 * its target; a Bash call logs the paths it names and — when it is an unmasked e2e run that
 * SUCCEEDED — an `e2e` flag. Success: an explicit exit code of 0, or (Claude Code, which
 * reports no exit code) the PostToolUse event itself, which fires only for a tool call that
 * succeeded. A backgrounded or interrupted run has no verdict yet and never counts.
 * @param {any} hook
 * @param {string} cwd  resolves relative paths
 * @returns {{k: "edit", p: string} | {k: "bash", p: string[], e2e?: boolean} | null}
 */
export function trailEntry(hook, cwd) {
  const tool = hook?.tool_name;
  const inp = hook?.tool_input ?? {};
  const abs = (p) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p));
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const p = inp.file_path ?? inp.notebook_path;
    return typeof p === "string" && p ? { k: "edit", p: abs(p) } : null;
  }
  if (tool !== "Bash") return null;
  const command = String(inp.command ?? "");
  const entry = /** @type {{k: "bash", p: string[], e2e?: boolean}} */ ({
    k: "bash",
    p: commandPaths(command)
      .filter((t) => redactSecrets(t) === t)
      .map(abs),
  });
  const passed =
    typeof hook.exitCode === "number"
      ? hook.exitCode === 0
      : hook.hook_event_name === "PostToolUse";
  if (
    passed &&
    inp.run_in_background !== true &&
    hook.tool_response?.interrupted !== true &&
    isE2eRun(command)
  )
    entry.e2e = true;
  return entry;
}

/**
 * Append what this PostToolUse payload says the session touched. Only a trail SessionStart
 * opened is written to (a session that started before the upgrade keeps the tree-wide
 * view instead of a trail with a hole at the front). A passing e2e run is stored with the
 * code state it ran against, MAC'd, so the gate can tell a stale or hand-written one.
 * @param {string} root @param {string} sid @param {any} hook
 */
export function recordTrail(root, sid, hook) {
  try {
    const p = sessionPath(root, sid, TRAIL);
    if (!existsSync(p)) return null;
    const entry = trailEntry(hook, hook?.cwd || root);
    if (!entry) return null;
    const { e2e, ...line } = /** @type {any} */ (entry);
    let text = `${JSON.stringify(line)}\n`;
    if (e2e) {
      const code = computeCodeState(root).dirtyHash;
      if (code)
        text += `${JSON.stringify({
          k: "e2e",
          cmd: redactSecrets(String(hook.tool_input?.command ?? "")).slice(0, 200),
          code,
          mac: evidenceMac(["e2e", sid, code]),
        })}\n`;
    }
    appendFileSync(p, text);
    return entry;
  } catch {
    return null;
  }
}

/**
 * This session's trail: the absolute paths it touched, its e2e runs, and whether the trail
 * is authoritative (see the section header). Null when there is no trail.
 * @param {string} root @param {string} sid
 * @returns {{paths: Set<string>, e2e: {cmd?: string, code: string, mac?: string|null}[], authoritative: boolean} | null}
 */
export function readTrail(root, sid) {
  let text;
  try {
    text = readFileSync(sessionPath(root, sid, TRAIL), "utf8");
  } catch {
    return null;
  }
  const paths = new Set();
  const e2e = [];
  let start = null;
  let activity = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // one torn line must not lose the trail
    }
    if (e?.k === "start" && !start) start = e;
    else if (e?.k === "edit" && typeof e.p === "string") {
      paths.add(e.p);
      activity += 1;
    } else if (e?.k === "bash" && Array.isArray(e.p)) {
      for (const x of e.p) if (typeof x === "string") paths.add(x);
      activity += 1;
    } else if (e?.k === "e2e" && typeof e.code === "string") e2e.push(e);
  }
  // B7: a start record the agent wrote itself carries no valid MAC — such a trail cannot
  // narrow the gate (no key anywhere → unsigned, like every other evidence file).
  const mac = evidenceMac(["trail", sid]);
  const signed = !!start && (mac == null || start.mac === mac);
  return { paths, e2e, authoritative: signed && activity > 0 };
}

// One spelling per file on both sides: symlinked checkouts (/tmp → /private/tmp) and a
// deleted file (resolve its directory instead) must still compare equal.
function canonicalPath(p) {
  try {
    return realpathSync(p);
  } catch {}
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {}
  return resolve(p);
}

/**
 * The subset of `changed` (repo-relative, as changedSet returns it) this session touched
 * according to its trail paths (absolute). Everything else moved under another agent.
 * @param {string} root @param {string[]} changed @param {Iterable<string>} touched
 * @returns {string[]}
 */
export function attributeChanged(root, changed, touched) {
  const top = git(root, ["rev-parse", "--show-toplevel"]) || root;
  const mine = new Set([...touched].map(canonicalPath));
  return changed.filter((p) => mine.has(canonicalPath(join(top, p))));
}

/** The session id a CLI/MCP call runs under: FORGE_SESSION_ID, else the id Claude Code
 *  exports to its tool processes (CLAUDE_CODE_SESSION_ID), else null. `env` is for tests.
 *  @param {Record<string, string|undefined>} [env] */
export function currentSessionId(env) {
  const e = env ?? {
    FORGE_SESSION_ID: process.env.FORGE_SESSION_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
  };
  return e.FORGE_SESSION_ID || e.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * What THIS session changed, for the pre-action checks (goal drift, minimality) that used
 * to read the whole working diff, other agents' work and pre-session dirt included. Null
 * when the session is not anchored (no SessionStart baseline): callers keep the whole-diff
 * view. `attributed` says whether the trail narrowed it to this session's own files.
 * @param {string} root @param {string|null|undefined} sid
 * @returns {{base: string|null, changed: string[], attributed: boolean} | null}
 */
export function sessionChanges(root, sid) {
  if (!sid) return null;
  const base = readBaseline(root, sid);
  const preDirty = readDirtySnapshot(root, sid);
  if (!base && !preDirty) return null;
  const all = changedSet(root, base?.head, {
    sinceMs: base?.t,
    preDirty: preDirty ?? undefined,
  });
  const trail = readTrail(root, sid);
  const attributed = !!trail?.authoritative;
  return {
    base: base?.head ?? null,
    changed: attributed && trail ? attributeChanged(root, all, trail.paths) : all,
    attributed,
  };
}

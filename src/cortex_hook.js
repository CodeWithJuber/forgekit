// forge cortex hooks — the AMBIENT layer. Turns raw Claude Code hook events (edits, bash
// runs, user prompts) into the correction episodes the orchestrator consumes, with zero
// commands from the developer. Signal detection is PURE (over a normalized event log) so
// it's unit-testable; the shell hooks just append events and call processSession on Stop.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { recordContradiction, recordMistake } from "./cortex.js";
import { privateMemoryDir } from "./private_memory.js";
import { readBounded } from "./private_paths.js";
import { redactSecrets } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { contentHash, git } from "./util.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

// Checkout markers include the git baseline, completion gate and last declared intent.
// Private event captures have a separate per-checkout location.
export const sessionPath = (root, sid, ext = "jsonl") =>
  join(root, ".forge", "sessions", `${String(sid).replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`);

export const sessionEventsDir = (root) =>
  privateWorkspaceFile(root, "cortex-session-events-v2").replace(/\.json$/, "");
export const sessionFile = (root, sid) =>
  join(sessionEventsDir(root), `${contentHash(String(sid))}.jsonl`);
const promptFile = (root, sid) =>
  join(privateMemoryDir(root, "prompts"), basename(sessionPath(root, sid)));

/** Every string leaf of an event, secret-redacted; structure and non-strings untouched. */
const redactEvent = (v) =>
  typeof v === "string"
    ? redactSecrets(v)
    : Array.isArray(v)
      ? v.map(redactEvent)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactEvent(x)]))
        : v;

/** Append one normalized event to a session's log (called by capture hooks). Prompts and
 *  shell commands are the user's raw text — a pasted `GITHUB_TOKEN=…` or an
 *  `Authorization: Bearer …` curl used to land verbatim on disk — so every string is
 *  redacted BEFORE it is written (the signals read verbs like `npm test`/`git revert`,
 *  which redaction never touches). */
export function appendSessionEvent(root, sid, event) {
  if (!event) return;
  const path = sessionFile(root, sid);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let stored = redactEvent(event);
  if (event.type === "bash" && event.command !== stored.command) stored.correctionEligible = false;
  if (event.type === "prompt") {
    stored = { type: "prompt" };
    if (process.env.FORGE_DEJA === "1") {
      const privatePath = promptFile(root, sid);
      mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
      stored.ref = randomUUID();
      appendFileSync(
        privatePath,
        `${JSON.stringify({ ref: stored.ref, text: redactSecrets(event.text ?? "") })}\n`,
        { mode: 0o600 },
      );
    }
  }
  appendFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

export function readSession(root, sid) {
  return readLines(sessionFile(root, sid));
}

function readLines(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line)); // a single corrupt line must not lose the whole session log
    } catch {}
  }
  return out;
}

export function summaryEvents(root, sid, events) {
  const prompts = new Map(readLines(promptFile(root, sid)).map((p) => [p.ref, p.text]));
  return events.map((e) => (e.type === "prompt" ? { ...e, text: prompts.get(e.ref) } : e));
}

export function clearSession(root, sid) {
  const path = sessionFile(root, sid);
  if (existsSync(path)) rmSync(path);
  try {
    rmSync(promptFile(root, sid), { force: true });
  } catch {
    /* A private-state misconfiguration must not break Stop. */
  }
}

const MASKED_RE = /\|\|\s*(true|:)\b|;\s*(true|exit\s+0)\b/;
// An end-to-end suite run (`npm run e2e`, `pnpm test:e2e`, `npx playwright test`, `cypress
// run`), same position rule as TEST_RE, env assignments allowed in front. The completion
// gate takes a passing one as test evidence, and all it sees is the WHOLE command's exit
// status. So the run counts only when that status IS the suite's: the e2e invocation is the
// last thing the command runs, followed by nothing but its own arguments and redirections.
// `npm run e2e; echo "exit=$?"`, `npm run e2e || echo failed`, `npm run e2e > log; cat log`
// and `npm run e2e &` all exit 0 on a failing suite; `npm run e2e | tail` hands the status
// to `tail`; `x || npm run e2e` may never run it; `--list`/`--help` run no test at all.
const E2E_RE =
  /(^|[\n;&|]\s*)(\w+=\S*\s+)*((npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn)\s+)?((npm|pnpm|yarn|bun)\s+(run\s+)?(test:)?e2e\b|playwright\s+test\b|cypress\s+run\b)/g;
const PIPED_RE = /(^|[^|])\|(?!\|)/;
// `>f`, `2>&1`, `&>f`, `>>f`, `<f`: redirections leave the exit status alone.
const REDIRECT_RE = /(?:\d*|&)>>?\s*(?:&\s*(?:\d+|-)|[^\s;&|<>()`]+)|\d*<\s*[^\s;&|<>()`]+/g;
// Quoted arguments (`--grep "a|b"`) are data. A double-quoted string holding `$` or a
// backtick could run a substitution, so it is left in and judged like the rest.
const QUOTED_RE = /'[^']*'|"(?:[^"\\$`]|\\.)*"/g;
const NO_RUN_FLAG_RE = /(^|\s)(--list|--help|-h|--version|-V|--pass-with-no-tests)(?=[\s=]|$)/;

/** Is this shell command a real end-to-end test run whose exit status is the command's own?
 *  (The completion gate accepts a passing one as test evidence.) @param {string} command */
export const isE2eRun = (command) => {
  const c = String(command ?? "")
    .trim()
    .replace(QUOTED_RE, '""');
  if (MASKED_RE.test(c) || PIPED_RE.test(c) || c.includes("||")) return false;
  const last = [...c.matchAll(E2E_RE)].pop();
  if (!last) return false;
  const tail = c.slice((last.index ?? 0) + last[0].length).replace(REDIRECT_RE, " ");
  return !/[;&|\n()`]/.test(tail) && !NO_RUN_FLAG_RE.test(tail);
};
// A cheap signature of a failing run's output. Line numbers, hex addresses, timings, and
// temp paths are normalized out so "the same failure" hashes the same across runs even as
// surrounding noise shifts — this is what lets us catch a same-error doom loop.
//
// It hashes the WHOLE normalized output (head + tail for very long runs), not the first 800
// characters: a test runner prints a long, identical passing header before the failure, so a
// head-only signature made three DIFFERENT failures one loop (review C10). Numbers are still
// collapsed, which is what keeps a re-run of the same failure stable across timings and
// counts — the documented cost is that two failures differing only in digits share a
// signature.
const SIG_HEAD = 8000;
const SIG_TAIL = 56000;

function outputSignature(text) {
  const raw = String(text);
  const bounded =
    raw.length > SIG_HEAD + SIG_TAIL
      ? `${raw.slice(0, SIG_HEAD)}\n…\n${raw.slice(-SIG_TAIL)}`
      : raw;
  const norm = bounded
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "0xADDR")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "T")
    .replace(/:\d+:\d+/g, ":L:C")
    .replace(/\b\d+\b/g, "N")
    .replace(/\/tmp\/\S+/g, "/tmp/X")
    .replace(/\s+/g, " ")
    .trim();
  return norm ? contentHash(norm).slice(0, 12) : "";
}

/** Normalize a raw hook payload into a compact event, or null if it carries no signal. */
export function classifyEvent(hook) {
  const eventId =
    typeof hook.tool_use_id === "string" && hook.tool_use_id
      ? { eventId: contentHash(hook.tool_use_id) }
      : {};
  const tool = hook.tool_name;
  const inp = hook.tool_input ?? {};
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    if (typeof inp.file_path !== "string" || !inp.file_path) return null;
    let file = inp.file_path;
    let versions;
    if (hook.cwd) {
      const target = resolve(hook.cwd, file);
      file = relative(sourceWorkspaceRoot(hook.cwd), target);
      if (!file || isAbsolute(file) || file === ".." || file.startsWith(`..${sep}`)) return null;
      file = file.split(sep).join("/");
      // Capture only Git blob identities. If bounded or no-follow reading fails,
      // a later reversal cannot be attributed to this version of the file.
      try {
        const { bytes } = readBounded(target, 1024 * 1024);
        versions = ["sha1", "sha256"].map((algorithm) =>
          createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
        );
      } catch {}
    }
    return { type: "edit", file, ...(versions ? { versions } : {}), ...eventId };
  }
  if (tool === "Bash") {
    if (inp.run_in_background === true || hook.tool_response?.interrupted === true) return null;
    const exitCode =
      hook.exitCode ??
      hook.exit_code ??
      hook.tool_response?.exitCode ??
      hook.tool_response?.exit_code;
    const failed = typeof exitCode === "number" && exitCode !== 0;
    // BOTH streams: jest, mocha and tsc print their failures on stderr, so a stdout-only
    // signature never saw them and those loops were invisible (review C10).
    const res = hook.tool_response;
    const out = [typeof res === "string" ? res : "", res?.stdout, res?.stderr, hook.output]
      .filter((x) => typeof x === "string" && x)
      .join("\n");
    return {
      type: "bash",
      ...eventId,
      ...(exitCode === 0 && hook.cwd ? verifiedRevert(hook.cwd, inp.command, out) : {}),
      command: inp.command ?? "",
      exitCode,
      // Only carry a signature for FAILED runs — that's all the doom-loop check needs.
      ...(failed && out ? { outputSig: outputSignature(out) } : {}),
    };
  }
  if (hook.hook_event_name === "UserPromptSubmit" || typeof hook.prompt === "string") {
    return { type: "prompt", text: hook.prompt ?? "" };
  }
  return null;
}

// Attribute a reversal only when Git reported a newly-created commit and the
// current object confirms it names a reverted commit. File names come from that tree.
function verifiedRevert(root, command, output) {
  if (!/^git\s+revert(?:\s|$)/.test(command) || /[;&|`$\n]/.test(command)) return {};
  const reported = /^\[[^\]\n]+ ([0-9a-f]{7,64})\]/im.exec(output)?.[1];
  if (!reported) return {};
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head.startsWith(reported)) return {};
  const reversed = /^This reverts commit ([0-9a-f]{40,64})[. ,]/im.exec(
    git(root, ["show", "-s", "--format=%B", head]),
  )?.[1];
  if (!reversed) return {};
  function changedBlobs(commit) {
    const fields = git(root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--no-renames",
      "--no-abbrev",
      "-r",
      "-z",
      "--raw",
      commit,
    ]).split("\0");
    const paths = new Map();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const fieldsForFile = /^:[0-7]{6} [0-7]{6} ([0-9a-f]+) ([0-9a-f]+) [ADM]$/.exec(fields[i]);
      if (fieldsForFile)
        paths.set(fields[i + 1], { before: fieldsForFile[1], after: fieldsForFile[2] });
    }
    return paths;
  }
  const original = changedBlobs(reversed);
  const reversedVersions = Object.fromEntries(
    [...changedBlobs(head)]
      .filter(([file, change]) => {
        const prior = original.get(file);
        return prior && prior.before === change.after && prior.after === change.before;
      })
      .map(([file, change]) => [file, change.before]),
  );
  return Object.keys(reversedVersions).length ? { reversedVersions, revertCommit: head } : {};
}

/** Pair an observed command failure with the same command's success. Each receipt
 * identifies the underlying recovery. A replay and a different passing command
 * cannot independently confirm the first recovery. */
export function detectEpisodes(events, { nowDay = 0, sessionId = "" } = {}) {
  const failures = new Map();
  const seen = new Set();
  const episodes = [];
  const digest = (parts) => contentHash(JSON.stringify(parts));
  for (const event of events) {
    if (event.eventId) {
      const receipt = JSON.stringify([event.eventId, event.type, event.file]);
      if (seen.has(receipt)) continue;
      seen.add(receipt);
    }
    if (event.type === "edit" && event.file) {
      for (const failure of failures.values()) {
        const previous = failure.edits.get(event.file);
        failure.edits.set(event.file, {
          count: (previous?.count ?? 0) + 1,
          versions: event.versions,
        });
      }
      continue;
    }
    if (
      event.type !== "bash" ||
      event.correctionEligible === false ||
      !Number.isInteger(event.exitCode) ||
      !event.command
    )
      continue;
    const check = digest([event.command]);
    if (event.exitCode !== 0) {
      failures.set(check, { id: event.eventId ?? null, edits: new Map() });
      continue;
    }
    if (event.revertCommit && event.reversedVersions) {
      episodes.push({
        kind: "contradiction",
        context: {
          files: Object.keys(event.reversedVersions),
          symbols: [],
          reversedVersions: event.reversedVersions,
        },
        episodeId: `rev_${event.revertCommit}`,
        nowDay,
      });
    }
    const failure = failures.get(check);
    if (!failure) continue;
    failures.delete(check);
    // Without host action IDs, a session can attest to one recovery of this command per file.
    // Without even a session identity, a repeated anonymous trace cannot promote itself.
    const identity = failure.id && event.eventId ? [failure.id, event.eventId] : [sessionId, check];
    for (const [file, edits] of failure.edits) {
      episodes.push({
        kind: "mistake",
        context: {
          files: [file],
          symbols: [],
          check,
          ...(edits.versions ? { versions: edits.versions } : {}),
        },
        signals: edits.count > 1 ? [{ signal: "S1" }, { signal: "S2" }] : [{ signal: "S1" }],
        episodeId: `ep_${digest([identity, file])}`,
        nowDay,
      });
    }
  }
  return episodes;
}

/**
 * Doom-loop breaker (self-correction #5). The shell guard catches the SAME action repeated;
 * this catches the subtler loop the paper names — different edits that keep producing the SAME
 * test failure. When one failure signature recurs ≥ `threshold` times, the agent is stuck: halt
 * and escalate with a diagnosis rather than burning more attempts. Pure + advisory.
 * @returns {{loop:boolean, signature?:string, count?:number, files?:string[]}}
 */
export function detectDoomLoop(events, { threshold = 3 } = {}) {
  const counts = new Map(); // outputSig -> occurrences
  const filesAround = new Map(); // outputSig -> Set(files edited between failures)
  let editsSinceFail = [];
  for (const e of events) {
    if (e.type === "edit" && e.file) {
      editsSinceFail.push(e.file);
    } else if (e.type === "bash" && e.outputSig) {
      counts.set(e.outputSig, (counts.get(e.outputSig) ?? 0) + 1);
      const set = filesAround.get(e.outputSig) ?? new Set();
      for (const f of editsSinceFail) set.add(f);
      filesAround.set(e.outputSig, set);
      editsSinceFail = [];
    }
  }
  let worst = null;
  for (const [sig, count] of counts) {
    if (count >= threshold && (!worst || count > worst.count)) {
      worst = { signature: sig, count, files: [...(filesAround.get(sig) ?? [])] };
    }
  }
  return worst ? { loop: true, ...worst } : { loop: false };
}

/** The advisory string for a detected doom loop (empty when there's no loop). */
export function doomLoopAdvisory(events, opts = {}) {
  const r = detectDoomLoop(events, opts);
  if (!r.loop) return "";
  // A configured advisor (Claude Code's advisor tool) is exactly for this moment; the caller
  // passes the hint so this stays pure over the events.
  const hint =
    typeof opts.advisorHint === "string" && opts.advisorHint ? ` ${opts.advisorHint}` : "";
  const where = r.files.length ? ` around ${r.files.slice(0, 5).join(", ")}` : "";
  // Only claim edits were made when some were: with nothing edited between the runs, the
  // honest advice is "re-running is not a fix", not "different edits aren't fixing it".
  const what = r.files.length
    ? "Different edits aren't fixing it."
    : "Nothing was edited between the runs — re-running without changing anything cannot fix it.";
  return `Forge Cortex — doom loop: the SAME test failure has recurred ${r.count}× this session${where}. ${what} Stop, find the root cause (re-read the failing assertion and the code it exercises), or ask a human — don't keep patching.${hint}`;
}

/** Drive the orchestrator from a session's events (called by the Stop hook). */
export function processSession(root, events, nowDay = 0, { sessionId = "" } = {}) {
  return detectEpisodes(events, { nowDay, sessionId }).map((ep) =>
    ep.kind === "contradiction"
      ? recordContradiction(root, ep)
      : recordMistake(root, { ...ep, signals: ep.signals ?? [] }),
  );
}

// forge cortex hooks — the AMBIENT layer. Turns raw Claude Code hook events (edits, bash
// runs, user prompts) into the correction episodes the orchestrator consumes, with zero
// commands from the developer. Signal detection is PURE (over a normalized event log) so
// it's unit-testable; the shell hooks just append events and call processSession on Stop.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordContradiction, recordMistake } from "./cortex.js";

const sessionFile = (root, sid) =>
  join(root, ".forge", "sessions", `${String(sid).replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);

/** Append one normalized event to a session's log (called by capture hooks). */
export function appendSessionEvent(root, sid, event) {
  if (!event) return;
  const path = sessionFile(root, sid);
  mkdirSync(join(root, ".forge", "sessions"), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

export function readSession(root, sid) {
  const path = sessionFile(root, sid);
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

export function clearSession(root, sid) {
  const path = sessionFile(root, sid);
  if (existsSync(path)) rmSync(path);
}

const REVERT_RE = /\bgit\s+(revert|reset\s+--hard|checkout\s+--|restore)\b/;
const TEST_RE = /\b(npm\s+(run\s+)?test|node\s+--test|jest|vitest|pytest|go\s+test|cargo\s+test)\b/;
// Negation must be corrective, not incidental ("no problem"); require a corrective verb.
const NEG_RE = /\b(undo|revert|that'?s\s+wrong|not\s+what|you\s+broke|regression|wrong\s+again)\b/i;

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);

// A cheap, dependency-free signature of a failing test's output. Line numbers, hex addresses,
// timings, and temp paths are normalized out so "the same failure" hashes the same across runs
// even as surrounding noise shifts — this is what lets us catch a same-error doom loop.
function outputSignature(text) {
  const norm = String(text)
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "0xADDR")
    .replace(/\b\d+(\.\d+)?(ms|s)\b/g, "T")
    .replace(/:\d+:\d+/g, ":L:C")
    .replace(/\b\d+\b/g, "N")
    .replace(/\/tmp\/\S+/g, "/tmp/X")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return norm ? h.toString(36) : "";
}

/** Normalize a raw hook payload into a compact event, or null if it carries no signal. */
export function classifyEvent(hook) {
  const tool = hook.tool_name;
  const inp = hook.tool_input ?? {};
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return { type: "edit", file: inp.file_path ?? "" };
  }
  if (tool === "Bash") {
    const exitCode = hook.exitCode;
    const failed = typeof exitCode === "number" && exitCode !== 0;
    const out = hook.tool_response?.stdout ?? hook.tool_response ?? hook.output ?? "";
    return {
      type: "bash",
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

/**
 * Scan a session's normalized events and emit correction episodes. Signals are grouped
 * PER FILE so the cross-family gate works (a lone thrash never fires; test-fail-then-pass
 * on a file that was also edited does). Reverts become contradiction episodes.
 * @returns {{kind:string, context:object, signals?:{signal:string}[], episodeId:string, nowDay:number}[]}
 */
export function detectEpisodes(events, { nowDay = 0 } = {}) {
  const sig = new Map(); // file -> Set(signal)
  const editCount = new Map();
  const recentEdits = [];
  const contradictions = [];
  let sawTestFail = false;
  let failFiles = new Set();
  const add = (file, s) => {
    if (!file) return;
    if (!sig.has(file)) sig.set(file, new Set());
    sig.get(file).add(s);
  };

  for (const e of events) {
    if (e.type === "edit" && e.file) {
      const n = (editCount.get(e.file) ?? 0) + 1;
      editCount.set(e.file, n);
      if (n >= 2) add(e.file, "S2"); // edited again this session = self-correction
      if (n >= 3) add(e.file, "S3"); // thrash
      recentEdits.push(e.file);
      if (sawTestFail) failFiles.add(e.file);
    } else if (e.type === "bash") {
      if (TEST_RE.test(e.command)) {
        if (typeof e.exitCode === "number" && e.exitCode !== 0) sawTestFail = true;
        else if (e.exitCode === 0 && sawTestFail) {
          for (const f of failFiles) add(f, "S1"); // fail → edit → pass, same files
          sawTestFail = false;
          failFiles = new Set();
        }
      }
      if (REVERT_RE.test(e.command)) contradictions.push({ files: recentEdits.slice(-3) });
    } else if (e.type === "prompt" && NEG_RE.test(e.text)) {
      const f = recentEdits.at(-1);
      if (f) add(f, "S5"); // weak; never fires alone (gate), needs a co-occurring signal
    }
  }

  let seq = 0;
  const episodes = [];
  for (const [file, signals] of sig) {
    episodes.push({
      kind: "mistake",
      context: { files: [file], symbols: [] },
      signals: [...signals].map((s) => ({ signal: s })),
      episodeId: `ep_m${seq++}_${slug(file)}`,
      nowDay,
    });
  }
  for (const c of contradictions) {
    episodes.push({
      kind: "contradiction",
      context: { files: c.files, symbols: [] },
      episodeId: `ep_c${seq++}`,
      nowDay,
    });
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
  const where = r.files.length ? ` around ${r.files.slice(0, 5).join(", ")}` : "";
  return `Forge Cortex — doom loop: the SAME test failure has recurred ${r.count}× this session${where}. Different edits aren't fixing it. Stop, find the root cause (re-read the failing assertion and the code it exercises), or ask a human — don't keep patching.`;
}

/** Drive the orchestrator from a session's events (called by the Stop hook). */
export function processSession(root, events, nowDay = 0) {
  return detectEpisodes(events, { nowDay }).map((ep) =>
    ep.kind === "contradiction"
      ? recordContradiction(root, ep)
      : recordMistake(root, { ...ep, signals: ep.signals ?? [] }),
  );
}

// forge cortex hooks — the AMBIENT layer. Turns raw Claude Code hook events (edits, bash
// runs, user prompts) into the correction episodes the orchestrator consumes, with zero
// commands from the developer. Signal detection is PURE (over a normalized event log) so
// it's unit-testable; the shell hooks just append events and call processSession on Stop.
import { recordContradiction, recordMistake } from "./cortex.js";

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

/** Normalize a raw hook payload into a compact event, or null if it carries no signal. */
export function classifyEvent(hook) {
  const tool = hook.tool_name;
  const inp = hook.tool_input ?? {};
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return { type: "edit", file: inp.file_path ?? "" };
  }
  if (tool === "Bash") {
    return {
      type: "bash",
      command: inp.command ?? "",
      exitCode: hook.exitCode,
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

/** Drive the orchestrator from a session's events (called by the Stop hook). */
export function processSession(root, events, nowDay = 0) {
  return detectEpisodes(events, { nowDay }).map((ep) =>
    ep.kind === "contradiction"
      ? recordContradiction(root, ep)
      : recordMistake(root, { ...ep, signals: ep.signals ?? [] }),
  );
}

// forge hosts — the same guards in every agent that has a hook system.
//
// A skill or an MCP tool runs only when the model chooses to call it. A hook runs whatever the
// model chooses. Until now forge's hooks reached Claude Code alone, and only on a machine where
// forge was installed at user level (the plugin, or `forge init` writing ~/.claude/settings.json).
// A teammate, a CI job, a cloud agent, or any other agent got text in AGENTS.md and an MCP
// server it was free to ignore.
//
// Every major agent now has lifecycle hooks, and they are the same idea in different dialects:
// JSON on stdin, a verdict on stdout / stderr / the exit code. So one entry point serves them
// all — `forge hooks run <host> <event>`:
//
//   host payload ──normalize──▶ canonical payload (the Claude Code shape every guard reads)
//        ──▶ the guard chain from hooks/hooks.json (the ONE list of what runs when)
//        ──merge──▶ one verdict (deny > ask > allow, context concatenated)
//        ──render──▶ that host's dialect
//
// Everything host-specific is DATA: HOSTS (events, tool names, what each event can express),
// FIELDS (where a value lives in a payload) and DIALECTS (how a verdict is spelled). Adding an
// agent is a table row, never a new code path. The guards themselves do not change.
//
// Fail-safe by construction: a missing payload, an unknown host or event, a guard that cannot
// run — none of them blocks a tool call. Only a guard's own verdict blocks. Kill switch:
// FORGE_HOOKS=0.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GUARD_POLICY } from "../global/guards/run.mjs";
import { BRAND } from "./brand.js";
import { failureQuery, hookEvidence, queueQuery, takeQuery } from "./hook_evidence.js";
import { readForgeConfig, recordedTools } from "./repo_config.js";
import { readJsonSafe, userStateDir } from "./util.js";

/** The events forge has guards for — Claude Code's names, the shape every guard reads.
 *  @typedef {"SessionStart"|"UserPromptSubmit"|"PreToolUse"|"PostToolUse"|"PostToolUseFailure"|"Stop"} CanonEvent */
/** One native event of a host: which canonical event it is, and what a hook may say there.
 *  `tool` + `lift`: the event carries no tool name, it IS one tool, its input lifted from
 *  top-level fields. `skipTools`: canonical tools another event of this host already covers.
 *  `ask` / `context` / `block`: the verdicts this event can express; anything else degrades
 *  (ask → deny) or is dropped. `emptyJson`: an empty reply must still be a JSON object.
 *  @typedef {{as: CanonEvent, tool?: string, lift?: string[], skipTools?: string[],
 *    ask?: boolean, context?: boolean, block?: boolean, emptyJson?: boolean}} HostEvent */
/** @typedef {{label: string, tool: string, file: string|null, layout: "groups"|"flat"|"copilot",
 *    dialect: keyof typeof DIALECTS, events: Record<string, HostEvent>,
 *    tools: Record<string, string>, timeoutMs?: boolean, named?: boolean, matchAll?: string,
 *    windows?: string, detect?: string[], via?: string, plugin?: boolean, trust: string}} Host */

/** @type {Record<string, HostEvent>} */
const CLAUDE_EVENTS = {
  SessionStart: { as: "SessionStart", context: true },
  UserPromptSubmit: { as: "UserPromptSubmit", context: true, block: true },
  PreToolUse: { as: "PreToolUse", ask: true, context: true },
  PostToolUse: { as: "PostToolUse", context: true, block: true },
  Stop: { as: "Stop", block: true },
};

/**
 * Every agent forge can run its guards in. Checked against each vendor's hook reference on
 * 2026-11-13; `docs/INTEGRATIONS.md` says how each claim is backed.
 * @type {Record<string, Host>}
 */
export const HOSTS = {
  claude: {
    label: "Claude Code",
    tool: "claude",
    file: ".claude/settings.json",
    layout: "groups",
    dialect: "claude",
    events: { ...CLAUDE_EVENTS, PostToolUseFailure: { as: "PostToolUseFailure", context: true } },
    tools: {},
    trust: "runs once the folder is trusted; also read by Cursor, Copilot CLI and Devin",
  },
  codex: {
    label: "Codex",
    tool: "codex",
    file: ".codex/hooks.json",
    layout: "groups",
    dialect: "claude",
    events: {
      ...CLAUDE_EVENTS,
      // Codex has no "ask" on PreToolUse, and a Stop hook that exits 0 must print JSON.
      PreToolUse: { as: "PreToolUse", context: true },
      Stop: { as: "Stop", block: true, emptyJson: true },
    },
    tools: { apply_patch: "Edit" },
    windows: "commandWindows",
    trust: "the project must be trusted and each hook reviewed once with /hooks",
  },
  gemini: {
    label: "Gemini CLI",
    tool: "gemini",
    file: ".gemini/settings.json",
    layout: "groups",
    dialect: "gemini",
    events: {
      SessionStart: { as: "SessionStart", context: true },
      BeforeAgent: { as: "UserPromptSubmit", context: true, block: true },
      BeforeTool: { as: "PreToolUse" },
      AfterTool: { as: "PostToolUse", context: true, block: true },
      AfterAgent: { as: "Stop", block: true },
    },
    tools: {
      run_shell_command: "Bash",
      write_file: "Write",
      replace: "Edit",
      read_file: "Read",
      read_many_files: "Read",
      search_file_content: "Grep",
      grep_search: "Grep",
      glob: "Glob",
      web_fetch: "WebFetch",
    },
    timeoutMs: true,
    named: true,
    matchAll: "*",
    trust: "Gemini CLI warns the first time it sees a project hook",
  },
  cursor: {
    label: "Cursor",
    tool: "cursor",
    file: ".cursor/hooks.json",
    layout: "flat",
    dialect: "cursor",
    events: {
      sessionStart: { as: "SessionStart", context: true },
      beforeSubmitPrompt: { as: "UserPromptSubmit", block: true },
      // A shell command fires both events; this one can pause for a human, so it owns Bash.
      beforeShellExecution: { as: "PreToolUse", tool: "Bash", lift: ["command"], ask: true },
      preToolUse: { as: "PreToolUse", skipTools: ["Bash"] },
      postToolUse: { as: "PostToolUse", context: true },
      postToolUseFailure: { as: "PostToolUseFailure", context: true },
      stop: { as: "Stop", block: true },
    },
    tools: { Shell: "Bash", Write: "Write", Read: "Read", Grep: "Grep", Task: "Task" },
    detect: ["CURSOR_VERSION"],
    trust: "project hooks also run in Cursor cloud agents (user-level hooks do not)",
  },
  copilot: {
    label: "GitHub Copilot",
    tool: "vscode",
    file: `.github/hooks/${BRAND.cli}.json`,
    layout: "copilot",
    dialect: "copilot",
    events: {
      sessionStart: { as: "SessionStart", context: true },
      userPromptSubmitted: { as: "UserPromptSubmit" },
      preToolUse: { as: "PreToolUse", ask: true },
      postToolUse: { as: "PostToolUse", context: true },
      postToolUseFailure: { as: "PostToolUseFailure", context: true },
      agentStop: { as: "Stop", block: true },
    },
    tools: {
      bash: "Bash",
      powershell: "Bash",
      view: "Read",
      create: "Write",
      edit: "Edit",
      str_replace_editor: "Edit",
      apply_patch: "Edit",
      grep: "Grep",
      rg: "Grep",
      glob: "Glob",
      web_fetch: "WebFetch",
      task: "Task",
    },
    trust: "the cloud agent reads this file from the default branch only",
  },
  kimi: {
    label: "Kimi Code",
    tool: "kimi",
    file: null,
    plugin: true,
    layout: "groups",
    dialect: "kimi",
    events: {
      SessionStart: { as: "SessionStart" },
      UserPromptSubmit: { as: "UserPromptSubmit", context: true, block: true },
      PreToolUse: { as: "PreToolUse" },
      PostToolUse: { as: "PostToolUse" },
      PostToolUseFailure: { as: "PostToolUseFailure" },
      Stop: { as: "Stop", block: true },
    },
    tools: {},
    trust: "install the per-user ForgeKit plugin with /plugins install, then /reload",
  },
  // Devin (the CLI and the desktop app that was Windsurf) reads Claude Code's settings file,
  // so it has no file of its own: the claude channel serves it, with Devin's own limits.
  devin: {
    label: "Devin",
    tool: "windsurf",
    file: null,
    via: "claude",
    layout: "groups",
    dialect: "claude",
    events: {
      ...CLAUDE_EVENTS,
      PreToolUse: { as: "PreToolUse", context: true },
    },
    tools: { exec: "Bash" },
    detect: ["DEVIN_PROJECT_DIR"],
    trust: "reads .claude/settings.json unless Restricted Mode is on",
  },
};

/** Any host's native tool name → the canonical one. Built from HOSTS, so a row there is all a
 *  new agent needs; `test/hosts.test.js` holds that no two hosts disagree about a name. */
export const TOOL_NAMES = Object.freeze(
  Object.assign({}, ...Object.values(HOSTS).map((h) => h.tools)),
);

/** Where a value lives in a hook payload, most specific spelling first. A path is
 *  dot-separated; the first non-empty one wins. */
export const FIELDS = Object.freeze({
  session_id: ["session_id", "sessionId", "conversation_id", "trajectory_id"],
  cwd: ["cwd", "workspace_roots.0"],
  prompt: ["prompt", "user_prompt", "initialPrompt", "initial_prompt"],
  tool_name: ["tool_name", "toolName"],
  tool_use_id: ["tool_use_id", "toolCallId", "tool_call_id"],
  tool_input: ["tool_input", "toolArgs", "tool_args"],
  tool_response: ["tool_response", "tool_output", "toolResult", "tool_result", "output"],
  transcript_path: ["transcript_path", "transcriptPath"],
  source: ["source"],
  permission_mode: ["permission_mode"],
});

/** The same, inside a tool's input: every host's spelling of the five fields the guards read. */
export const INPUT_FIELDS = Object.freeze({
  command: ["command", "command_line", "cmd", "script"],
  file_path: ["file_path", "path", "filePath", "target_file", "absolute_path", "filename"],
  content: ["content", "contents", "file_text", "new_content"],
  old_string: ["old_string", "old_str", "oldString"],
  new_string: ["new_string", "new_str", "newString"],
});

/** How a session began, in the three words the guard manifest matches on. A host's own word
 *  for the same thing maps here; anything else (a compaction) passes through and matches no
 *  guard, exactly as in Claude Code. */
export const SOURCES = Object.freeze({ new: "startup", fork: "resume" });

/** Environment variables an agent sets to its project root — a payload with no `cwd` falls
 *  back to the first one present. */
export const PROJECT_DIR_ENV = [
  "CLAUDE_PROJECT_DIR",
  "CURSOR_PROJECT_DIR",
  "GEMINI_PROJECT_DIR",
  "DEVIN_PROJECT_DIR",
];

/** Files one patch may touch before the rest go unchecked (each file runs the guard chain). */
export const MAX_PATCH_FILES = 8;
/** One guard may take this long before it is abandoned (fail-open, or a block if fail-closed). */
export const GUARD_TIMEOUT_MS = 25000;

/** @param {any} obj @param {readonly string[]} paths */
function pick(obj, paths) {
  for (const path of paths) {
    let v = obj;
    for (const key of path.split(".")) v = v !== null && typeof v === "object" ? v[key] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// ── patches ────────────────────────────────────────────────────────────────────────────────

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/;

/**
 * The files an `apply_patch` envelope touches, as the edits the guards understand. Codex and
 * Copilot send a whole patch as one tool call; a guard that reads `file_path` would see
 * nothing. Add → the new content; Update → one {old_string, new_string} per hunk (context
 * lines sit on both sides, so the old text is exactly what is on disk); Delete → empty content.
 * @param {string} text
 * @returns {{file_path: string, kind: "add"|"update"|"delete", content?: string,
 *   edits?: {old_string: string, new_string: string}[]}[]}
 */
export function parsePatch(text) {
  /** @type {ReturnType<typeof parsePatch>} */
  const files = [];
  /** @type {ReturnType<typeof parsePatch>[number]|null} */
  let file = null;
  /** @type {{old: string[], next: string[]}|null} */
  let hunk = null;
  const closeHunk = () => {
    if (file?.kind === "update" && hunk && (hunk.old.length || hunk.next.length))
      file.edits?.push({ old_string: hunk.old.join("\n"), new_string: hunk.next.join("\n") });
    hunk = null;
  };
  for (const line of String(text).split(/\r?\n/)) {
    const head = PATCH_FILE.exec(line);
    if (head) {
      closeHunk();
      const kind = /** @type {"add"|"update"|"delete"} */ (head[1].toLowerCase());
      file = { file_path: head[2], kind };
      if (kind === "update") file.edits = [];
      else file.content = "";
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("*** ")) {
      // `*** Move to:`, `*** End of File`, `*** End Patch` — none of them is content.
      if (line.startsWith("*** End Patch")) {
        closeHunk();
        file = null;
      }
      continue;
    }
    if (file.kind === "add") {
      if (line.startsWith("+")) file.content += `${file.content ? "\n" : ""}${line.slice(1)}`;
      continue;
    }
    if (file.kind !== "update") continue;
    if (line.startsWith("@@")) {
      closeHunk();
      continue;
    }
    hunk ??= { old: [], next: [] };
    if (line.startsWith("-")) hunk.old.push(line.slice(1));
    else if (line.startsWith("+")) hunk.next.push(line.slice(1));
    else {
      const context = line.startsWith(" ") ? line.slice(1) : line;
      hunk.old.push(context);
      hunk.next.push(context);
    }
  }
  closeHunk();
  return files;
}

// ── normalize: a host's payload → what the guards read ─────────────────────────────────────

/** Canonical name for a native tool: the alias table, MCP spellings folded to `mcp__…`. */
export function canonicalTool(name) {
  const raw = String(name ?? "");
  if (Object.hasOwn(TOOL_NAMES, raw)) return TOOL_NAMES[raw];
  const mcp = /^(?:MCP:|mcp_(?!_))(.+)$/.exec(raw);
  return mcp ? `mcp__${mcp[1]}` : raw;
}

/** A tool input as an object, whatever it arrived as (Copilot sends JSON text).
 *  @param {unknown} input @returns {Record<string, any>} */
function inputObject(input) {
  if (input !== null && typeof input === "object") return { .../** @type {object} */ (input) };
  if (typeof input !== "string" || !input) return {};
  try {
    const parsed = JSON.parse(input);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {}
  return { command: input };
}

/**
 * Translate one hook payload. Returns the canonical event and one payload per thing to check:
 * usually one, several when a patch touches several files, none when the event is not ours.
 * Pure: `env` is injectable.
 * @param {string} hostId @param {string} nativeEvent @param {any} payload
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{event: CanonEvent, def: HostEvent, payloads: Record<string, any>[], unchecked: number}|null}
 */
export function normalize(hostId, nativeEvent, payload, env = process.env) {
  const def = HOSTS[hostId]?.events[nativeEvent];
  if (!def) return null;
  const data = payload !== null && typeof payload === "object" ? payload : {};
  const cwd = String(
    pick(data, FIELDS.cwd) ?? PROJECT_DIR_ENV.map((k) => env[k]).find(Boolean) ?? process.cwd(),
  );
  /** @type {Record<string, any>} */
  const base = {
    hook_event_name: def.as,
    session_id: String(pick(data, FIELDS.session_id) ?? "default"),
    cwd,
  };
  for (const key of /** @type {const} */ (["transcript_path", "permission_mode", "tool_use_id"])) {
    const v = pick(data, FIELDS[key]);
    if (v !== undefined) base[key] = v;
  }
  if (def.as === "SessionStart") {
    const source = String(pick(data, FIELDS.source) ?? "startup");
    base.source = SOURCES[source] ?? source;
  }
  if (def.as === "UserPromptSubmit") {
    const prompt = pick(data, FIELDS.prompt);
    // Kimi sends multimodal prompt parts; only textual parts are valid search terms.
    base.prompt =
      hostId === "kimi" && Array.isArray(prompt)
        ? prompt
            .filter((p) => p?.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join(" ")
        : String(prompt ?? "");
  }
  // A host that counts stop-hook rounds (Cursor) says the same thing as `stop_hook_active`.
  if (def.as === "Stop")
    base.stop_hook_active = Boolean(data.stop_hook_active) || Number(data.loop_count) > 0;
  if (def.as !== "PreToolUse" && def.as !== "PostToolUse" && def.as !== "PostToolUseFailure")
    return { event: def.as, def, payloads: [base], unchecked: 0 };

  const input = def.tool
    ? Object.fromEntries((def.lift ?? []).map((k) => [k, data[k]]))
    : inputObject(pick(data, FIELDS.tool_input));
  for (const [field, aliases] of Object.entries(INPUT_FIELDS)) {
    const v = pick(input, aliases);
    if (v !== undefined && input[field] === undefined) input[field] = v;
  }
  let tool = def.tool ?? canonicalTool(pick(data, FIELDS.tool_name));
  // Hosts name their file tools differently; the input says which canonical one it is.
  if (tool === "Write" || tool === "Edit")
    tool = Array.isArray(input.edits)
      ? "MultiEdit"
      : input.old_string !== undefined
        ? "Edit"
        : input.content !== undefined
          ? "Write"
          : tool;
  if (def.skipTools?.includes(tool)) return { event: def.as, def, payloads: [], unchecked: 0 };
  const response = pick(data, FIELDS.tool_response);
  const code = data.exitCode ?? data.exit_code;
  const call = {
    ...base,
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(def.as === "PostToolUseFailure"
      ? {
          error: String(data.error?.message ?? data.error ?? data.error_message ?? "Tool failed"),
          is_interrupt: data.is_interrupt === true,
          failure_type: data.failure_type,
        }
      : {}),
    tool_name: tool,
    tool_input: input,
    ...(def.as === "PostToolUse" && response !== undefined ? { tool_response: response } : {}),
  };

  // A failed patch has no successful per-file edits to review or capture. Preserve the
  // original error response for recovery instead of expanding it into synthetic edits.
  if (def.as === "PostToolUseFailure" || (def.as === "PostToolUse" && failureQuery(call)))
    return { event: def.as, def, payloads: [call], unchecked: 0 };

  // A patch names its files inside the text: one edit per file, so path and manifest guards see them.
  const patchText = [input.command, input.patch, input.input].find(
    (v) => typeof v === "string" && /^\*\*\* (?:Add|Update|Delete) File: /m.test(v),
  );
  if (!patchText) return { event: def.as, def, payloads: [call], unchecked: 0 };
  const files = parsePatch(patchText);
  const edits = files.slice(0, MAX_PATCH_FILES).map((f) => ({
    ...base,
    tool_name: f.kind === "update" ? "MultiEdit" : "Write",
    tool_input: {
      file_path: isAbsolute(f.file_path) ? f.file_path : join(cwd, f.file_path),
      ...(f.kind === "update" ? { edits: f.edits } : { content: f.content }),
    },
  }));
  // A shell command that carries a patch is still a shell command; a patch tool is only its files.
  const payloads = tool === "Bash" ? [call, ...edits] : edits;
  return { event: def.as, def, payloads, unchecked: Math.max(0, files.length - MAX_PATCH_FILES) };
}

// ── the guard chain: hooks/hooks.json is the one list of what runs when ────────────────────

/** @typedef {{args: string[], guard: string, failClosed: boolean}} GuardStep */

/** The placeholder the plugin manifest uses for the package root (spelled in two parts so no
 *  linter reads it as a JS template). */
const PLUGIN_ROOT_TOKEN = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");

/** @returns {Record<string, {matcher?: string, hooks: {command?: string, args?: string[]}[]}[]>} */
export function loadManifest(path = join(BRAND.root, "hooks", "hooks.json")) {
  return readJsonSafe(path)?.hooks ?? {};
}

/**
 * The guards a canonical payload runs through, in manifest order. A group's matcher is tested
 * against the tool name (tool events) or the session source (SessionStart), anchored — the
 * same rule the host applies natively.
 * @param {Record<string, any>} payload
 * @param {ReturnType<typeof loadManifest>} [manifest]
 * @returns {GuardStep[]}
 */
export function guardChain(payload, manifest = loadManifest()) {
  const event = String(payload.hook_event_name);
  const subject = event === "SessionStart" ? payload.source : (payload.tool_name ?? "");
  /** @type {GuardStep[]} */
  const steps = [];
  for (const group of manifest[event] ?? []) {
    const m = group.matcher;
    if (m && m !== "*") {
      let hit = false;
      try {
        hit = new RegExp(`^(?:${m})$`).test(String(subject ?? ""));
      } catch {}
      if (!hit) continue;
    }
    for (const hook of group.hooks ?? []) {
      if (!Array.isArray(hook.args)) continue;
      const args = hook.args.map((a) => String(a).replaceAll(PLUGIN_ROOT_TOKEN, BRAND.root));
      const guard = (args.find((a) => /\.sh$/.test(a)) ?? "").split(/[\\/]/).pop() ?? "";
      steps.push({ args, guard, failClosed: Boolean(GUARD_POLICY[guard]?.failClosed) });
    }
  }
  return steps;
}

/** @typedef {{guard: string, stdout: string, stderr: string, status: number|null, failClosed: boolean}} GuardRun */

/**
 * Run the chain: every guard gets the canonical payload on stdin, all at once (the way a host
 * runs matching hooks). A guard that cannot start or runs out of time has status null.
 * @param {GuardStep[]} steps @param {Record<string, any>} payload
 * @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number, spawnImpl?: typeof spawn}} [opts]
 * @returns {Promise<GuardRun[]>}
 */
export function runGuards(steps, payload, opts = {}) {
  const { env = process.env, timeoutMs = GUARD_TIMEOUT_MS, spawnImpl = spawn } = opts;
  const body = JSON.stringify(payload);
  const cwd = existsSync(String(payload.cwd)) ? String(payload.cwd) : process.cwd();
  return Promise.all(
    steps.map(
      (step) =>
        /** @type {Promise<GuardRun>} */ (
          new Promise((resolve) => {
            /** @type {GuardRun} */
            const run = {
              guard: step.guard,
              stdout: "",
              stderr: "",
              status: null,
              failClosed: step.failClosed,
            };
            let child;
            try {
              child = spawnImpl(process.execPath, step.args, { cwd, env, windowsHide: true });
            } catch {
              return resolve(run);
            }
            const timer = setTimeout(() => child.kill(), timeoutMs);
            child.stdout?.on("data", (d) => {
              run.stdout += d;
            });
            child.stderr?.on("data", (d) => {
              run.stderr += d;
            });
            child.on("error", () => {
              clearTimeout(timer);
              resolve(run);
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              run.status = code;
              resolve(run);
            });
            child.stdin?.on("error", () => {});
            child.stdin?.end(body);
          })
        ),
    ),
  );
}

// ── merge: many guards, one verdict ────────────────────────────────────────────────────────

/** @typedef {{decision: "deny"|"ask"|"allow", reason: string, context: string, block: string}} Verdict */

const RANK = { allow: 0, ask: 1, deny: 2 };
const join2 = (/** @type {string} */ a, /** @type {string} */ b, sep = "\n") =>
  a && b ? `${a}${sep}${b}` : a || b;

/**
 * What one guard said, read from the Claude Code hook protocol it speaks: exit 2 blocks with
 * stderr as the reason; exit 0 may carry a JSON decision or context; plain stdout is context on
 * the two events where hosts inject it. Any other exit is the guard failing, which blocks only
 * for a fail-closed guard.
 * @param {CanonEvent} event @param {GuardRun} run @returns {Verdict}
 */
export function interpret(event, run) {
  /** @type {Verdict} */
  const v = { decision: "allow", reason: "", context: "", block: "" };
  const gate = event === "PreToolUse";
  const stop = (/** @type {string} */ why) => {
    if (gate) {
      v.decision = "deny";
      v.reason = join2(v.reason, why);
    } else v.block = join2(v.block, why);
  };
  if (run.status === 2) {
    stop(run.stderr.trim() || `blocked by ${run.guard}`);
    return v;
  }
  if (run.status !== 0) {
    if (run.failClosed && gate)
      stop(
        `${run.guard} could not reach a verdict — a security guard that cannot run blocks the action`,
      );
    return v;
  }
  const text = run.stdout.trim();
  if (!text) return v;
  let json = null;
  if (text.startsWith("{")) {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  if (json === null || typeof json !== "object") {
    if (event === "SessionStart" || event === "UserPromptSubmit") v.context = text;
    return v;
  }
  const out = json.hookSpecificOutput ?? {};
  if (typeof out.additionalContext === "string") v.context = out.additionalContext;
  if (out.permissionDecision === "deny") stop(String(out.permissionDecisionReason ?? ""));
  else if (out.permissionDecision === "ask" && gate) {
    v.decision = "ask";
    v.reason = String(out.permissionDecisionReason ?? "");
  }
  if (json.decision === "block") stop(String(json.reason ?? ""));
  if (json.continue === false) stop(String(json.stopReason ?? json.reason ?? ""));
  return v;
}

/** Deny beats ask beats allow; reasons of the winning level, contexts and blocks concatenated.
 *  @param {Verdict[]} verdicts @returns {Verdict} */
export function merge(verdicts) {
  /** @type {Verdict} */
  const out = { decision: "allow", reason: "", context: "", block: "" };
  for (const v of verdicts) {
    if (RANK[v.decision] > RANK[out.decision]) {
      out.decision = v.decision;
      out.reason = v.reason;
    } else if (v.decision === out.decision && v.decision !== "allow")
      out.reason = join2(out.reason, v.reason);
    out.context = join2(out.context, v.context, "\n\n");
    out.block = join2(out.block, v.block);
  }
  return out;
}

// ── render: one verdict → a host's dialect ─────────────────────────────────────────────────

/** @typedef {{stdout: string, stderr: string, exit: number}} Reply */
/** @param {unknown} o @returns {Reply} */
const json = (o) => ({ stdout: JSON.stringify(o), stderr: "", exit: 0 });

/** Added when a guard wanted a human to confirm and the agent has no way to ask one. */
export const NO_CONFIRM =
  " This agent cannot pause for a confirmation here, so the action is blocked; if it is what you intend, allow it explicitly (the message above says how) or run it yourself.";

/**
 * How each family of agents spells a verdict. `e.native` is the host's own event name (a
 * context reply must echo it), `e.as` the canonical one. Exit 2 with the reason on stderr is
 * the one block every agent here honours, so it is the default `deny`.
 */
export const DIALECTS = {
  claude: {
    deny: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
    ask: (e, reason, context) =>
      json({
        hookSpecificOutput: {
          hookEventName: e.native,
          permissionDecision: "ask",
          permissionDecisionReason: reason,
          ...(context ? { additionalContext: context } : {}),
        },
      }),
    context: (e, context) =>
      json({ hookSpecificOutput: { hookEventName: e.native, additionalContext: context } }),
    block: (_e, reason) => json({ decision: "block", reason }),
  },
  gemini: {
    deny: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
    ask: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
    context: (e, context) =>
      json({ hookSpecificOutput: { hookEventName: e.native, additionalContext: context } }),
    block: (_e, reason) => json({ decision: "deny", reason }),
  },
  cursor: {
    deny: (_e, reason) => json({ permission: "deny", user_message: reason, agent_message: reason }),
    ask: (_e, reason) => json({ permission: "ask", user_message: reason, agent_message: reason }),
    context: (_e, context) => json({ additional_context: context }),
    block: (e, reason) =>
      e.as === "Stop"
        ? json({ followup_message: reason })
        : json({ continue: false, user_message: reason }),
  },
  kimi: {
    deny: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
    ask: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
    context: (_e, context) => json({ message: context }),
    block: (_e, reason) => ({ stdout: "", stderr: reason, exit: 2 }),
  },
  copilot: {
    deny: (_e, reason) => json({ permissionDecision: "deny", permissionDecisionReason: reason }),
    ask: (_e, reason) => json({ permissionDecision: "ask", permissionDecisionReason: reason }),
    context: (e, context) =>
      e.as === "PostToolUseFailure"
        ? { stdout: context, stderr: "", exit: 2 }
        : json({ additionalContext: context }),
    block: (_e, reason) => json({ decision: "block", reason }),
  },
};

/**
 * Spell a verdict for a host. What the event cannot express degrades the safe way: an "ask"
 * the agent cannot honour becomes a block (never a silent allow), context an event cannot
 * carry is dropped.
 * @param {string} hostId @param {string} nativeEvent @param {Verdict} verdict @returns {Reply}
 */
export function render(hostId, nativeEvent, verdict) {
  const host = HOSTS[hostId];
  const def = host?.events[nativeEvent];
  /** @type {Reply} */
  const nothing = { stdout: def?.emptyJson ? "{}" : "", stderr: "", exit: 0 };
  if (!host || !def) return nothing;
  const say = DIALECTS[host.dialect];
  const e = { native: nativeEvent, as: def.as };
  const context = def.context ? verdict.context : "";
  if (def.as === "PreToolUse") {
    if (verdict.decision === "deny") return say.deny(e, verdict.reason);
    if (verdict.decision === "ask")
      return def.ask
        ? say.ask(e, verdict.reason, context)
        : say.deny(e, `${verdict.reason}${NO_CONFIRM}`);
    return context ? say.context(e, context) : nothing;
  }
  if (verdict.block && def.block) return say.block(e, verdict.block);
  return context ? say.context(e, context) : nothing;
}

// ── one event, delivered twice ─────────────────────────────────────────────────────────────

/** Two deliveries this close together are the same event arriving by two config files. */
export const CLAIM_WINDOW_MS = 1500;
/** How long the second delivery waits for the first one's verdict before checking for itself. */
export const CLAIM_WAIT_MS = 20000;
const CLAIM_KEEP_MS = 60000;

/** What makes two deliveries the same event: who, what kind, and what it is about. */
export function eventKey(payloads) {
  const h = createHash("sha256");
  for (const p of payloads)
    h.update(
      JSON.stringify([
        p.hook_event_name,
        p.cwd,
        p.session_id,
        p.error ?? "",
        p.tool_use_id ?? "",
        p.exitCode ?? "",
        p.tool_response ?? "",
        p.tool_name ?? "",
        p.tool_input?.command ?? "",
        p.tool_input?.file_path ?? "",
        p.prompt ?? "",
        p.source ?? "",
      ]),
    );
  return h.digest("hex").slice(0, 32);
}

/**
 * Some agents read more than one hook file (Copilot CLI reads its own and Claude Code's), so
 * one event can arrive twice. The first delivery claims it (an exclusive create — no race) and
 * publishes its verdict; the second replays that verdict in its own dialect, so the guards run
 * once and a denial is never turned into a silent pass. A claim older than the window is a
 * NEW event that merely looks the same (a retry), and is checked afresh.
 * @param {{dir?: string, key: string, nowMs?: number, waitMs?: number, sleep?: (ms: number) => Promise<void>}} o
 * @returns {Promise<{owner: true, publish: (v: Verdict) => void} | {owner: false, verdict: Verdict|null}>}
 */
export async function claimEvent({
  dir = join(userStateDir(), "hook-claims"),
  key,
  nowMs = Date.now(),
  waitMs = CLAIM_WAIT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const path = join(dir, `${key}.json`);
  const publish = (/** @type {Verdict} */ verdict) => {
    try {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: nowMs, verdict }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {}
  };
  const take = () => {
    try {
      // A verdict can quote a guard's reason; keep it to this user, like the rest of the state dir.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ at: nowMs }));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  try {
    // Housekeeping, bounded: a claim is useless a minute later.
    for (const name of readdirSync(dir).slice(0, 200)) {
      const p = join(dir, name);
      if (nowMs - statSync(p).mtimeMs > CLAIM_KEEP_MS) unlinkSync(p);
    }
  } catch {}
  if (take()) return { owner: true, publish };
  const read = () => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const first = read();
  if (!first || nowMs - Number(first.at) > CLAIM_WINDOW_MS) {
    // Not a twin: a stale claim, or an unreadable one. Take it over and check for real.
    try {
      unlinkSync(path);
    } catch {}
    return take() ? { owner: true, publish } : { owner: false, verdict: null };
  }
  for (let waited = 0; waited <= waitMs; waited += 40) {
    const seen = read();
    if (seen?.verdict) return { owner: false, verdict: seen.verdict };
    await sleep(40);
  }
  return { owner: false, verdict: null };
}

// ── who is really calling, and is someone else already on it ───────────────────────────────

/** The agent whose environment this is, when it says so (`detect` in HOSTS). An agent that
 *  reads Claude Code's settings file runs the claude channel, but is not Claude Code. */
export function detectHost(env = process.env) {
  for (const [id, host] of Object.entries(HOSTS))
    if (host.detect?.some((name) => env[name])) return id;
  return null;
}

/** Does this text hold a command forge wrote? Ownership is the command itself — no marker to
 *  forget, and a hook a person wrote is never mistaken for ours. */
export const HOOK_COMMAND = new RegExp(`\\b${BRAND.cli} hooks run [a-z]+ [A-Za-z]+`);
export const isForgeHookCommand = (text) => typeof text === "string" && HOOK_COMMAND.test(text);

/** Has `forge hooks on` wired this host's own file in this project? */
export function projectWired(root, hostId) {
  const file = HOSTS[hostId]?.file;
  if (!file) return false;
  try {
    return HOOK_COMMAND.test(readFileSync(join(root, file), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Is forge already wired into Claude Code at USER level on this machine — the plugin enabled,
 * or `forge init` having merged the guards into ~/.claude/settings.json? Then every guard
 * already runs for every project, and the project-level entry stands down instead of running
 * each one twice.
 * @param {{home?: string}} [o]
 */
export function userLevelWired({ home = homedir() } = {}) {
  const settings = readJsonSafe(join(home, ".claude", "settings.json"));
  if (!settings || typeof settings !== "object") return false;
  if (settings._forge === "forge-managed") return true;
  const plugins = settings.enabledPlugins;
  if (plugins && typeof plugins === "object")
    for (const [id, on] of Object.entries(plugins))
      if (on === true && id.split("@")[0] === BRAND.pkg) return true;
  return JSON.stringify(settings.hooks ?? {}).includes("/global/guards/run.mjs");
}

// ── the entry point ────────────────────────────────────────────────────────────────────────

/** True when the user turned every project-level hook off (`FORGE_HOOKS=0`, `false`, `off`, `no`). */
export const hooksDisabled = (env = process.env) =>
  /^(0|false|off|no)$/i.test(String(env.FORGE_HOOKS ?? "").trim());

/** Explicit hook hosts take precedence over the repository's selected tools. */
export function kimiPluginEnabled(cfg) {
  if (cfg.corrupt || cfg.hooks?.project === false) return false;
  const hosts = Array.isArray(cfg.hooks?.hosts) ? cfg.hooks.hosts : recordedTools(cfg);
  return hosts === null || hosts.includes("kimi");
}

/**
 * `forge hooks run <host> <event>` — one hook call, start to finish. Never throws; every path
 * that is not a guard's own verdict returns an empty, successful reply.
 * @param {{host: string, event: string, input: string, env?: NodeJS.ProcessEnv, home?: string,
 *   manifest?: ReturnType<typeof loadManifest>, run?: typeof runGuards,
 *   claim?: typeof claimEvent | null}} o
 * @returns {Promise<Reply>}
 */
export async function runHook({
  host,
  event,
  input,
  env = process.env,
  home = homedir(),
  manifest,
  run = runGuards,
  claim = claimEvent,
}) {
  /** @type {Reply} */
  const silent = { stdout: "", stderr: "", exit: 0 };
  try {
    if (hooksDisabled(env) || !HOSTS[host]?.events[event]) return silent;
    let payload = {};
    try {
      payload = JSON.parse(input || "{}");
    } catch {
      return silent;
    }
    // An agent that reads Claude Code's file is served by its own channel when it has one,
    // and by its own rules (tool names, what it can express) when it does not.
    let as = host;
    if (host === "kimi") {
      // Kimi launches plugin hooks in its managed copy. Only the payload identifies
      // the actual workspace. Respect a project's explicit hook opt-out.
      const cwd = pick(payload, FIELDS.cwd);
      if (typeof cwd !== "string" || !isAbsolute(cwd)) return silent;
      const { sourceWorkspaceRoot } = await import("./sources.js");
      const cfg = readForgeConfig(sourceWorkspaceRoot(cwd));
      if (!kimiPluginEnabled(cfg)) return silent;
    }
    if (host === "claude") {
      const actual = detectHost(env);
      const cwd = String(pick(payload, FIELDS.cwd) ?? process.cwd());
      if (actual && HOSTS[actual].file && projectWired(cwd, actual)) return silent;
      if (actual && HOSTS[actual].via === "claude") as = actual;
      if (!actual && userLevelWired({ home })) return silent;
    }
    const empty = render(as, event, { decision: "allow", reason: "", context: "", block: "" });
    const norm = normalize(as, event, payload, env);
    if (!norm?.payloads.length) return empty;

    const first = norm.payloads[0];
    const defer = as === "cursor" || as === "copilot";
    const sid = pick(payload, FIELDS.session_id);
    if (defer && norm.event === "UserPromptSubmit") first.defer_evidence = true;
    if (defer && (norm.event === "Stop" || norm.event === "SessionStart"))
      queueQuery(as, first.cwd, sid, "");

    const evidenceEvent = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].includes(
      norm.event,
    );
    // Hosts with different output capabilities must each deliver their own advice. Duplicate
    // plugin + project deliveries in ONE host can share the original execution.
    const key = (evidenceEvent ? `${as}-` : "") + eventKey(norm.payloads);
    const ticket = claim ? await claim({ key }) : null;
    if (ticket && "verdict" in ticket && ticket.verdict) return render(as, event, ticket.verdict);

    const afterTool = norm.event === "PostToolUse" || norm.event === "PostToolUseFailure";
    const pending = defer && afterTool ? takeQuery(as, first.cwd, sid) : "";
    if (pending && norm.event === "PostToolUseFailure") first.pending_query = pending;
    const chains = norm.payloads.map((p) => ({ payload: p, steps: guardChain(p, manifest) }));
    const runs = await Promise.all(chains.map((c) => run(c.steps, c.payload, { env })));
    const verdict = merge(runs.flat().map((r) => interpret(norm.event, r)));
    if (defer && norm.event === "UserPromptSubmit")
      queueQuery(as, first.cwd, sid, verdict.block ? "" : first.prompt);
    if (norm.event === "PostToolUse") {
      // Other hosts deliver failures inside the ordinary result, e.g. a nonzero Codex Bash exit.
      const guidance = await hookEvidence(
        first.cwd,
        [failureQuery(first), pending].filter(Boolean).join("\n"),
      );
      verdict.context = join2(verdict.context, guidance, "\n\n");
    }
    if (norm.unchecked && norm.event === "PreToolUse")
      verdict.context = join2(
        verdict.context,
        `${BRAND.brand}: ${norm.unchecked} more file(s) in this patch were not checked (the first ${MAX_PATCH_FILES} were).`,
        "\n\n",
      );
    // Only the first delivery injects source text. A duplicate replays the decision without
    // saving private excerpts in the event-claim store or injecting them twice.
    if (ticket && "publish" in ticket)
      ticket.publish(evidenceEvent ? { ...verdict, context: "" } : verdict);
    return render(as, event, verdict);
  } catch {
    return silent;
  }
}

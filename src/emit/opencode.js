// OpenCode has no shell-hook file. It loads JavaScript plugins from `.opencode/plugins/`, so
// this emitter writes that plugin: the repository-carried carrier for the same guard chain
// every other host runs through `forge hooks run`. The file is fully generated and owned by
// its `forge:sync:<hash>` marker; a file without the marker is never overwritten.
//
// A pre-tool check that cannot run denies the operation. A verdict is a JSON
// object on stdout: `{decision, reason}` before a tool, `{context}` after a prompt or tool,
// `{block}` at the end of a turn.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { projectForgeLauncher } from "../forge_launcher.js";
import {
  hashContent,
  isManaged,
  markerString,
  readIfExists,
  writeAtomicIfChanged,
} from "./_shared.js";

export const OPENCODE_PLUGIN = ".opencode/plugins/forgekit.js";

/**
 * The generated plugin body (everything after the marker line). Kept as data so tests can
 * assert on the exact contract without importing the generated file as a module.
 */
export const OPENCODE_PLUGIN_BODY = `// ForgeKit's OpenCode adapter. OpenCode loads this file automatically; it forwards the
// session lifecycle to \`forge hooks run opencode <event>\` and turns the verdict into what
// OpenCode understands. Pre-tool checks require a working CLI.
import { spawnSync } from "node:child_process";

const LOCAL_ENTRY = "";
const CLI = process.env.FORGE_CLI || (LOCAL_ENTRY ? process.execPath : "forge");
const TIMEOUT_MS = 30000;
const CONTEXT_LIMIT = 4;
const contexts = new Map();
const started = new Set();

function promptText(parts) {
  if (!Array.isArray(parts)) return "";
  const out = [];
  for (const part of parts)
    if (part && part.type === "text" && typeof part.text === "string") out.push(part.text);
  return out.join("\\n");
}

function call(ctx, event, input) {
  const payload = {
    session_id: input.sessionID,
    cwd: ctx.directory || process.cwd(),
    hook_event_name: event,
  };
  if (event === "SessionStart") payload.source = input.source || "startup";
  if (event === "UserPromptSubmit") payload.prompt = input.prompt || "";
  if (event === "PreToolUse" || event === "PostToolUse") {
    payload.tool_name = input.tool || "";
    payload.tool_input = input.args && typeof input.args === "object" ? input.args : {};
    payload.tool_use_id = input.callID || "";
  }
  if (event === "PostToolUse") payload.tool_response = input.response;
  const unavailable = event === "PreToolUse" ? {decision:"deny", reason:"ForgeKit could not check this tool call. Verify FORGE_CLI and the guard installation."}
    : event === "PostToolUse" ? {updatedToolOutput:"[Output withheld: ForgeKit could not check the result.]"} : null;
  let result;
  try {
    result = spawnSync(CLI, [...(LOCAL_ENTRY && !process.env.FORGE_CLI ? [LOCAL_ENTRY] : []), "hooks", "run", "opencode", event], {
      cwd: payload.cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: process.env,
      windowsHide: true,
    });
  } catch {
    return unavailable;
  }
  if (!result || result.error || result.status !== 0) return unavailable;
  const text = (result.stdout || "").trim();
  if (!text) return event === "PreToolUse" ? unavailable : null;
  try {
    const reply = JSON.parse(text);
    if (event === "PreToolUse" && !["allow", "ask", "deny"].includes(reply?.decision)) return unavailable;
    return reply;
  } catch {
    return unavailable;
  }
}

function remember(sessionID, context) {
  if (!context) return;
  const key = sessionID || "default";
  const list = contexts.get(key) || [];
  list.push(String(context));
  contexts.set(key, list.slice(-CONTEXT_LIMIT));
}

function start(ctx, sessionID) {
  const key = sessionID || "default";
  if (started.has(key)) return;
  started.add(key);
  const reply = call(ctx, "SessionStart", { sessionID: key, source: "startup" });
  if (reply) remember(key, reply.context);
}

export const ForgeKit = async (ctx) => {
  const directory = (ctx && ctx.directory) || process.cwd();
  const run = (event, input) => call({ directory }, event, input);

  return {
    event: async ({ event }) => {
      const type = event && typeof event.type === "string" ? event.type : "";
      const props = (event && event.properties) || {};
      if (type === "session.created") {
        start({ directory }, props.info && props.info.id);
      } else if (type === "session.idle") {
        const reply = run("Stop", { sessionID: props.sessionID });
        if (reply) remember(props.sessionID, reply.block);
      } else if (type === "session.deleted") {
        const id = (props.info && props.info.id) || props.sessionID || "default";
        contexts.delete(id);
        started.delete(id);
      }
    },
    "chat.message": async (input, output) => {
      start({ directory }, input.sessionID);
      const reply = run("UserPromptSubmit", {
        sessionID: input.sessionID,
        prompt: promptText(output && output.parts),
      });
      if (reply && reply.block) throw new Error(reply.block);
      if (reply) remember(input.sessionID, reply.context);
    },
    "tool.execute.before": async (input, output) => {
      const reply = run("PreToolUse", {
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
        args: output && output.args,
      });
      if (reply && (reply.decision === "deny" || reply.decision === "ask"))
        throw new Error(reply.reason || "ForgeKit blocked this tool call");
      if (reply) remember(input.sessionID, reply.context);
    },
    "tool.execute.after": async (input, output) => {
      const reply = run("PostToolUse", {
        sessionID: input.sessionID,
        tool: input.tool,
        callID: input.callID,
        args: input.args,
        response: output && output.output,
      });
      if (output && reply && typeof reply.updatedToolOutput === "string") output.output = reply.updatedToolOutput;
      if (reply) remember(input.sessionID, reply.context);
    },
    // Best-effort prompt context. OpenCode 1.18.x invokes this hook but does not deliver the
    // entries appended to output.system to the model, so the durable rules still travel through
    // AGENTS.md and the tool guard still blocks. Kept because a host that honours the hook gets
    // the evidence for free, and removing it later is one line.
    "experimental.chat.system.transform": async (input, output) => {
      const key = (input && input.sessionID) || "default";
      const list = contexts.get(key);
      if (!list || !list.length) return;
      if (output && Array.isArray(output.system)) output.system.push(...list);
      contexts.delete(key);
    },
  };
};
`;

/** The exact bytes of the managed plugin file. */
export function opencodePlugin({ entrypoint = "" } = {}) {
  const body = OPENCODE_PLUGIN_BODY.replace(
    'const LOCAL_ENTRY = "";',
    `const LOCAL_ENTRY = ${JSON.stringify(entrypoint)};`,
  );
  const header = `// GENERATED by \`forge sync\` — edit source/rules.json, not this file. ${markerString(hashContent(body))}`;
  return { header, body, content: `${header}\n${body}\n` };
}

/**
 * What the plugin file should hold. Pure. `error` means a person owns the file (no forge
 * marker) and forge must leave every byte alone.
 * @param {string|null} text
 * @returns {{next: string, error?: string}}
 */
export function planPlugin(text, { entrypoint = "" } = {}) {
  const { content } = opencodePlugin({ entrypoint });
  if (text === null) return { next: content };
  if (!isManaged(text)) return { next: text, error: "not a forge-managed file — left as it is" };
  return { next: content };
}

/**
 * Write or remove the generated plugin. Ownership is the marker, so a hand-written
 * `.opencode/plugins/forgekit.js` is reported and preserved.
 * @param {string} root
 * @param {{enable?: boolean}} [o]
 * @returns {{action: string, note: string}}
 */
export function applyPlugin(root, { enable = true } = {}) {
  const path = join(root, OPENCODE_PLUGIN);
  const text = readIfExists(path);
  if (!enable) {
    if (text === null) return { action: "unchanged", note: "no plugin" };
    if (!isManaged(text))
      return { action: "skipped", note: "not a forge-managed file — left as it is" };
    unlinkSync(path);
    return { action: "removed", note: "plugin off" };
  }
  if (text !== null && !isManaged(text))
    return { action: "skipped", note: "not a forge-managed file — left as it is" };
  const { content } = opencodePlugin({ entrypoint: projectForgeLauncher(root).args[0] });
  return { action: writeAtomicIfChanged(path, content), note: "5 events → forge hooks run" };
}

/** OpenCode reads the shared AGENTS.md natively; the plugin is written by `forge hooks on`. */
export default {
  tool: "OpenCode",
  emit(_ctx) {
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: "native; `forge hooks on` writes .opencode/plugins/forgekit.js",
    };
  },
};

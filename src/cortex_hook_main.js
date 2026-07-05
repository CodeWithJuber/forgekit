#!/usr/bin/env node
// forge cortex hook entrypoint — invoked by the shell hooks with the hook JSON on stdin.
// FAIL-SAFE BY CONSTRUCTION: any error is swallowed and the process exits 0, so Cortex can
// never block or break a tool call or a session. It is advisory memory, nothing more.
//
//   modes:  capture         (PostToolUse Edit|Write|Bash) — log a signal event
//           prompt          (UserPromptSubmit)            — log a user-utterance event
//           stop            (Stop)                        — distill the session into lessons
//           session-start   (SessionStart)               — inject learned lessons as context
import { startupBlock } from "./cortex.js";
import {
  appendSessionEvent,
  classifyEvent,
  clearSession,
  processSession,
  readSession,
} from "./cortex_hook.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const mode = process.argv[2];
  let hook = {};
  try {
    hook = JSON.parse((await readStdin()) || "{}");
  } catch {
    return; // no/garbled payload → nothing to do
  }
  const root = hook.cwd || process.cwd();
  const sid = hook.session_id || "default";
  const today = Math.floor(Date.now() / 86400000);

  if (mode === "capture" || mode === "prompt") {
    appendSessionEvent(root, sid, classifyEvent(hook));
  } else if (mode === "stop") {
    const events = readSession(root, sid);
    if (events.length) {
      processSession(root, events, today);
      clearSession(root, sid);
    }
  } else if (mode === "session-start") {
    const block = startupBlock(root, today);
    if (block) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: block,
          },
        }),
      );
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

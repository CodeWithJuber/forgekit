#!/usr/bin/env node
// forge cortex hook entrypoint — invoked by the shell hooks with the hook JSON on stdin.
// FAIL-SAFE BY CONSTRUCTION: any error is swallowed and the process exits 0, so Cortex can
// never block or break a tool call or a session. It is advisory memory, nothing more.
//
//   modes:  capture         (PostToolUse Edit|Write|Bash) — log a signal event
//           prompt          (UserPromptSubmit)            — log a user-utterance event
//           preflight       (UserPromptSubmit)            — inject the substrate pre-action advisory
//           pre-edit        (PreToolUse Edit|Write)       — advise on lessons/risk before an edit
//           stop            (Stop)                        — distill the session into lessons
//           session-start   (SessionStart)               — inject learned lessons as context
import { applyDistillation, lessonsForContext, startupBlock } from "./cortex.js";
import {
  appendSessionEvent,
  classifyEvent,
  clearSession,
  processSession,
  readSession,
} from "./cortex_hook.js";
import { load } from "./lessons_store.js";
import { substrateCheck, substrateContext } from "./substrate.js";

// Opt-in: distill newly-created lessons into real prose via a cheap model call. Off by
// default (deterministic template is used); fail-safe (any error → keep the template).
async function enrichCreated(root, results) {
  if (process.env.ENABLE_CORTEX_DISTILL !== "1") return;
  const created = results.filter((r) => r?.action === "created" && r.id);
  if (!created.length) return;
  const { distill } = await import("./cortex_distill.js");
  for (const r of created) {
    const lesson = load(root).find((l) => l.id === r.id);
    if (!lesson) continue;
    const better = distill({
      context: lesson.trigger,
      signals: lesson.provenance?.signals ?? [],
    });
    if (better) applyDistillation(root, r.id, better);
  }
}

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
      const results = processSession(root, events, today);
      clearSession(root, sid);
      await enrichCreated(root, results);
    }
  } else if (mode === "session-start") {
    const block = startupBlock(root, today);
    if (block) emit("SessionStart", block);
  } else if (mode === "pre-edit") {
    const advice = await preEditAdvisory(root, hook.tool_input?.file_path, today);
    if (advice) emit("PreToolUse", advice);
  } else if (mode === "preflight") {
    // Ambient cognitive substrate: assumption gate + (when an atlas is already cached)
    // model routing, blast-radius, memory, and minimality — surfaced before the agent acts.
    // allowBuild:false keeps it cheap and never writes .forge/ from a hook; advisory only.
    if (typeof hook.prompt === "string" && hook.prompt.trim()) {
      const advisory = substrateContext(substrateCheck(root, hook.prompt, { allowBuild: false }));
      if (advisory) emit("UserPromptSubmit", advisory);
    }
  }
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext },
    }),
  );
}

// Advisory before an edit: surface matching lessons (cheap), and — only if none matched —
// a one-line high-risk note from the predictor. Advisory only, never blocks. Low-nag by
// design: nothing is emitted unless there's a real lesson or genuinely high risk.
async function preEditAdvisory(root, file, today) {
  if (!file) return "";
  const { block, selected } = lessonsForContext(
    root,
    { files: [file], symbols: [], keywords: [file] },
    { nowDay: today, budget: 3 },
  );
  if (selected.length) return block; // learned lessons for this file win
  const { featuresForEdit } = await import("./cortex_features.js");
  const { riskFor } = await import("./predictor.js");
  const { band } = riskFor(featuresForEdit(root, { file }, { nowDay: today }), {
    mode: "heuristic",
  });
  return band === "high"
    ? `Forge Cortex — ${file} looks high-risk (churn / prior mistakes here). Re-read and check impact before editing.`
    : "";
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

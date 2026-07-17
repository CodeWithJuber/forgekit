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
//           stop-gate       (Stop, synchronous)           — completion gate: block once if code moved but no doc/state did
//           session-start   (SessionStart)               — inject learned lessons as context
import { applyDistillation, lessonsForContext, startupBlock } from "./cortex.js";
import {
  appendSessionEvent,
  classifyEvent,
  clearSession,
  doomLoopAdvisory,
  processSession,
  readSession,
} from "./cortex_hook.js";
import { load } from "./lessons_store.js";
import { enforceDecision, substrateCheck, substrateContext } from "./substrate.js";
import { epochDay } from "./util.js";

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
    if (!better) continue;
    applyDistillation(root, r.id, better);
    // A7 auto-routing: a distilled lesson whose prose reads like a settled decision or
    // a durable repo fact ALSO lands in that home (decisions.md / ledger) — confidently
    // (≥0.5) routed knowledge reaches the shelf the next session actually reads.
    // Fail-open like everything in this file: routing must never break the distill loop.
    try {
      const { routeFact, storeFact } = await import("./knowledge_router.js");
      const text = `${better.correctedBehavior} — ${better.whatWentWrong}`;
      const route = routeFact(text);
      if ((route.home === "decision" || route.home === "ledger-fact") && route.confidence >= 0.5)
        storeFact(root, text, { route });
    } catch {}
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
  const today = epochDay();

  if (mode === "capture" || mode === "prompt") {
    appendSessionEvent(root, sid, classifyEvent(hook));
  } else if (mode === "stop") {
    const events = readSession(root, sid);
    if (events.length) {
      const results = processSession(root, events, today);
      // Anti-repetition: a first-try success mints no mistake episode, so its trace
      // would vanish at clearSession. Mint one `summary` claim of the solved task FIRST
      // (before the log is cleared) — `forge deja` then finds it next time. Fail-safe;
      // kill switch FORGE_DEJA=0.
      if (process.env.FORGE_DEJA !== "0") {
        try {
          const { recordSessionSummary } = await import("./deja.js");
          recordSessionSummary(root, sid, events, today);
        } catch {}
      }
      clearSession(root, sid);
      await enrichCreated(root, results);
    }
    // Auto-sync: anything this session taught the memory (lessons, facts) reaches
    // every AGENTS.md-reading tool NOW — drift used to be detected by doctor but
    // repaired by nobody. Only touches an already-Forge-managed AGENTS.md;
    // kill switch FORGE_AUTOSYNC=0. Fail-safe like everything else here.
    try {
      const { autoSyncIfDrifted } = await import("./sync.js");
      autoSyncIfDrifted(root);
    } catch {}
  } else if (mode === "stop-gate") {
    // The completion gate — the ONLY Stop-path mode that may block, so it runs through
    // its own SYNCHRONOUS guard shim (cortex.sh stop is detached and can never answer).
    // stopGate is fail-open by construction; a block's reason IS the repair checklist.
    try {
      const { stopGate } = await import("./gate.js");
      const r = stopGate(root, sid, hook);
      try {
        const { record } = await import("./metrics.js");
        record(root, {
          stage: "gate",
          outcome: r.allow ? "stop-pass" : "stop-block",
        });
      } catch {}
      if (!r.allow) process.stdout.write(JSON.stringify({ decision: "block", reason: r.reason }));
    } catch {}
  } else if (mode === "session-start") {
    // Prune BEFORE anchoring: pruning after would delete the very baseline a >7-day
    // resume just preserved (the anchor then re-records fresh, which is the right
    // semantics for a week-old session anyway). Then record WHERE the repo stands so
    // the completion gate can diff this session's changes against it.
    try {
      const { pruneSessions, recordBaseline } = await import("./session.js");
      pruneSessions(root);
      recordBaseline(root, sid);
    } catch {}
    // Then everything a fresh session forgets: learned lessons, the persistent goal,
    // the handoff snapshot, and the repo's recent history.
    const { goalBlock } = await import("./goal.js");
    const { stateBlock } = await import("./handoff.js");
    const { rehydrationBlock } = await import("./session.js");
    const block = [
      startupBlock(root, today),
      goalBlock(root),
      stateBlock(root),
      rehydrationBlock(root),
    ]
      .filter(Boolean)
      .join("\n");
    if (block) emit("SessionStart", block);
  } else if (mode === "pre-edit") {
    // A doom loop (the same failure recurring) is the loudest thing to say — it means "stop",
    // so it takes precedence over lesson/risk advice.
    const loop = doomLoopAdvisory(readSession(root, sid));
    const advice = loop || (await preEditAdvisory(root, hook.tool_input?.file_path, today));
    const docs = await staleDocsAdvisory(root, hook.tool_input?.file_path);
    const currency = await currencyAdvisory(root, hook.tool_input?.file_path);
    const combined = [advice, docs, currency].filter(Boolean).join("\n\n");
    if (combined) emit("PreToolUse", combined);
  } else if (mode === "preflight") {
    // Ambient cognitive substrate: assumption gate + (when an atlas is already cached)
    // model routing, blast-radius, memory, and minimality — surfaced before the agent acts.
    // allowBuild:false keeps it cheap and never writes .forge/ from a hook; advisory only.
    if (typeof hook.prompt === "string" && hook.prompt.trim()) {
      const result = substrateCheck(root, hook.prompt, { allowBuild: false });
      // Best-effort metrics recording — fills the cost dashboard pipeline without
      // blocking the hook. A failing write is silently swallowed.
      try {
        const { record } = await import("./metrics.js");
        // substrateCheck() has no `gate` key — the halt signal is the assumption gate
        // (same source substrate.js recordGate uses: preflight.assumption.shouldAsk).
        // Reading the missing field recorded every prompt as "pass", so the cost
        // dashboard's halt-rate was permanently zero.
        record(root, {
          stage: "gate",
          outcome: result.assumption?.shouldAsk ? "halt" : "pass",
        });
        if (result.route?.key) {
          record(root, { stage: "route", tier: result.route.tier });
        }
      } catch {}
      const gate = enforceDecision(result);
      if (gate.block) {
        process.stdout.write(JSON.stringify({ decision: "block", reason: gate.reason }));
        return;
      }
      // Session evidence trail (fail-safe): the per-prompt goal-drift score feeds the
      // completion gate's CUSUM, and assumptions-proceeded-under are RECORDED — the
      // handoff surfaces them later, so a guess can never silently become a fact.
      try {
        const { getGoal } = await import("./goal.js");
        const goal = getGoal(root);
        if (goal) {
          const { goalDrift } = await import("./anchor.js");
          const d = goalDrift(root, goal, {
            changed: result.goalAnchor?.changed,
          });
          appendSessionEvent(root, sid, { type: "drift", score: d.driftScore });
        }
        const a = result.assumption;
        if (!a.shouldAsk && ((a.missing?.length ?? 0) > 0 || (a.questions?.length ?? 0) > 0))
          appendSessionEvent(root, sid, {
            type: "assumption",
            missing: (a.missing ?? []).map((m) => m.key),
            questions: (a.questions ?? []).slice(0, 3),
          });
      } catch {}
      const advisory = substrateContext(result);
      // Intent protocol card (exemplar k-NN, once per run of the same intent) rides the
      // SAME emit — one hook process must write one JSON object.
      let card = "";
      try {
        const { intentCard } = await import("./intent.js");
        card = intentCard(root, sid, hook.prompt);
      } catch {}
      // Anti-repetition advisory: one line when a prior solved task closely matches this
      // prompt (cache-only ledger read, never a fetch). Kill switch FORGE_DEJA=0.
      let deja = "";
      try {
        const { dejaAdvisory } = await import("./deja.js");
        deja = dejaAdvisory(root, hook.prompt, today);
      } catch {}
      const combined = [advisory, card, deja].filter(Boolean).join("\n\n");
      if (combined) emit("UserPromptSubmit", combined);
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

// Docs that reference the file about to change (atlas doc edges, CACHED graph only —
// a hook never builds). The end-to-end nudge: a code edit carries its docs with it.
async function staleDocsAdvisory(root, file) {
  if (!file || file.endsWith(".md")) return "";
  try {
    const { load, impact } = await import("./atlas.js");
    const atlas = load(root);
    if (!atlas) return "";
    // root + separator, not a bare prefix: '/home/u/repo' must not strip '/home/u/repository'.
    const rel =
      file.startsWith(`${root}/`) || file.startsWith(`${root}\\`)
        ? file.slice(root.length + 1)
        : file;
    const docs = impact(atlas, rel, { maxHops: 2 }).impactedFiles.filter((f) => f.endsWith(".md"));
    if (!docs.length) return "";
    return `Forge impact — docs that reference ${rel}: ${docs.slice(0, 5).join(", ")}. If this change alters behavior, update them in the same pass (\`forge impact ${rel}\` for the full list).`;
  } catch {
    return "";
  }
}

// Dependency-currency advisory before an edit: if the file imports a dep the last `forge
// radar` scan put in "hold" (deprecated / critical advisory), say so. CACHE-ONLY — a hook
// never fetches. Kill switch FORGE_RADAR=0. Fail-safe like everything else here.
async function currencyAdvisory(root, file) {
  if (!file) return "";
  try {
    const { radarAdvisory } = await import("./radar.js");
    return radarAdvisory(root, file);
  } catch {
    return "";
  }
}

main()
  .catch((err) => {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge cortex: ${err?.message ?? err}\n`);
  })
  .finally(() => process.exit(0));

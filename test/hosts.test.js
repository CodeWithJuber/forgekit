// forge hosts — one hook entry point for every agent: payload in, guards, verdict out in the
// agent's own dialect. Hermetic: guard results, the environment and the clock are injected;
// the two end-to-end tests run the real guards on payloads that need no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import {
  applyHooks,
  BOOTSTRAP_TIMEOUT_S,
  emitProjectHooks,
  HOOK_HOSTS,
  HOOK_TIMEOUT_S,
  hookCommand,
  hooksStatus,
  packageSpec,
  planHooks,
  selectedHosts,
} from "../src/emit/hooks.js";
import {
  CLAIM_WINDOW_MS,
  canonicalTool,
  claimEvent,
  DIALECTS,
  detectHost,
  eventKey,
  guardChain,
  HOSTS,
  hooksDisabled,
  INPUT_FIELDS,
  interpret,
  isForgeHookCommand,
  loadManifest,
  MAX_PATCH_FILES,
  merge,
  NO_CONFIRM,
  normalize,
  parsePatch,
  projectWired,
  render,
  runHook,
  TOOL_NAMES,
  userLevelWired,
} from "../src/hosts.js";

const CANON = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const CLI = BRAND.cli;
const tmp = (name = "hosts-") => mkdtempSync(join(tmpdir(), name));
const allow = { decision: "allow", reason: "", context: "", block: "" };
/** A guard run as the launcher reports it. */
const ran = (o = {}) => ({
  guard: "g.sh",
  stdout: "",
  stderr: "",
  status: 0,
  failClosed: false,
  ...o,
});
/** One canonical payload out of a host payload. */
const one = (host, event, payload, env = {}) => {
  const n = normalize(host, event, payload, env);
  assert.equal(n?.payloads.length, 1, `${host} ${event}: exactly one payload`);
  return n.payloads[0];
};

// ── the tables ─────────────────────────────────────────────────────────────────────────────

test("HOSTS: every event maps to a canonical one, every dialect and tool name is real", () => {
  for (const [id, host] of Object.entries(HOSTS)) {
    assert.ok(host.label && host.tool && host.trust, `${id}: labelled`);
    assert.ok(DIALECTS[host.dialect], `${id}: dialect ${host.dialect}`);
    // Each host covers the whole lifecycle, so no guard is silently missing somewhere.
    assert.deepEqual(
      [...new Set(Object.values(host.events).map((e) => e.as))].sort(),
      [
        ...CANON,
        ...(["claude", "cursor", "copilot", "kimi"].includes(id) ? ["PostToolUseFailure"] : []),
      ].sort(),
      id,
    );
    for (const [name, e] of Object.entries(host.events)) {
      // Only a gate can ask; only a non-gate can block-with-feedback.
      if (e.ask) assert.equal(e.as, "PreToolUse", `${id}.${name}: ask only before a tool`);
      if (e.block)
        assert.notEqual(e.as, "PreToolUse", `${id}.${name}: a gate denies, it does not "block"`);
    }
    // A host with no file of its own is served through one that has.
    if (!host.file && !host.plugin)
      assert.ok(HOSTS[host.via]?.file, `${id}: served via a host with a file`);
  }
  for (const d of Object.values(DIALECTS))
    for (const verb of ["deny", "ask", "context", "block"])
      assert.equal(typeof d[verb], "function");
});

test("TOOL_NAMES: no two hosts mean different things by the same tool name", () => {
  /** @type {Record<string, string>} */
  const seen = {};
  for (const [id, host] of Object.entries(HOSTS))
    for (const [native, canon] of Object.entries(host.tools)) {
      if (seen[native]) assert.equal(canon, seen[native], `${id}: ${native}`);
      seen[native] = canon;
    }
  assert.deepEqual(TOOL_NAMES, seen);
  assert.equal(canonicalTool("run_shell_command"), "Bash");
  assert.equal(canonicalTool("Bash"), "Bash", "a canonical name is left alone");
  // Every agent's MCP spelling folds to the one the guard manifest matches (`mcp__.*`).
  assert.equal(canonicalTool("MCP:search"), "mcp__search");
  assert.equal(canonicalTool("mcp_github_create_issue"), "mcp__github_create_issue");
  assert.equal(canonicalTool("mcp__github__create_issue"), "mcp__github__create_issue");
  assert.equal(canonicalTool(undefined), "");
});

// ── normalize ──────────────────────────────────────────────────────────────────────────────

test("normalize: a shell command reads the same from every agent", () => {
  const want = { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "s", cwd: "/r" };
  const cases = [
    [
      "claude",
      "PreToolUse",
      { session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: "npm i x" } },
    ],
    [
      "codex",
      "PreToolUse",
      { session_id: "s", cwd: "/r", tool_name: "Bash", tool_input: { command: "npm i x" } },
    ],
    [
      "gemini",
      "BeforeTool",
      {
        session_id: "s",
        cwd: "/r",
        tool_name: "run_shell_command",
        tool_input: { command: "npm i x" },
      },
    ],
    [
      "cursor",
      "beforeShellExecution",
      { conversation_id: "s", workspace_roots: ["/r"], command: "npm i x" },
    ],
    // Copilot sends the arguments as JSON text.
    [
      "copilot",
      "preToolUse",
      { sessionId: "s", cwd: "/r", toolName: "bash", toolArgs: '{"command":"npm i x"}' },
    ],
    [
      "devin",
      "PreToolUse",
      { session_id: "s", cwd: "/r", tool_name: "exec", tool_input: { command: "npm i x" } },
    ],
  ];
  for (const [host, event, payload] of cases) {
    const p = one(host, event, payload);
    for (const [k, v] of Object.entries(want)) assert.equal(p[k], v, `${host}: ${k}`);
    assert.equal(p.tool_input.command, "npm i x", host);
  }
});

test("normalize: file tools become Write / Edit / MultiEdit with the fields the guards read", () => {
  const base = { session_id: "s", cwd: "/r" };
  const w = one("gemini", "BeforeTool", {
    ...base,
    tool_name: "write_file",
    tool_input: { file_path: "/r/a.txt", content: "x" },
  });
  assert.deepEqual(
    [w.tool_name, w.tool_input.file_path, w.tool_input.content],
    ["Write", "/r/a.txt", "x"],
  );
  const e = one("gemini", "BeforeTool", {
    ...base,
    tool_name: "replace",
    tool_input: { file_path: "/r/a.txt", old_string: "a", new_string: "b" },
  });
  assert.equal(e.tool_name, "Edit");
  // Copilot's own field names are aliased, and the input says whether it is a write or an edit.
  const c = one("copilot", "preToolUse", {
    ...base,
    toolName: "create",
    toolArgs: { path: "/r/b.txt", file_text: "hello" },
  });
  assert.deepEqual(
    [c.tool_name, c.tool_input.file_path, c.tool_input.content],
    ["Write", "/r/b.txt", "hello"],
  );
  const s = one("copilot", "preToolUse", {
    ...base,
    toolName: "str_replace_editor",
    toolArgs: { path: "/r/b.txt", old_str: "a", new_str: "b" },
  });
  assert.deepEqual(
    [s.tool_name, s.tool_input.old_string, s.tool_input.new_string],
    ["Edit", "a", "b"],
  );
  // Cursor calls every file change "Write"; an old string makes it an edit.
  const cur = one("cursor", "preToolUse", {
    conversation_id: "s",
    workspace_roots: ["/r"],
    tool_name: "Write",
    tool_input: { path: "/r/c.txt", old_string: "a", new_string: "b" },
  });
  assert.equal(cur.tool_name, "Edit");
  const multi = one("claude", "PreToolUse", {
    ...base,
    tool_name: "Edit",
    tool_input: { file_path: "/r/a", edits: [{ old_string: "a", new_string: "b" }] },
  });
  assert.equal(multi.tool_name, "MultiEdit");
  // The original spelling is kept beside the canonical one — nothing a host sent is lost.
  assert.equal(c.tool_input.path, "/r/b.txt");
  for (const aliases of Object.values(INPUT_FIELDS)) assert.ok(aliases.length >= 3);
});

test("normalize: lifecycle events — session source, prompt, stop state, session and folder", () => {
  // Copilot says "new" where the guard manifest matches "startup".
  assert.equal(
    one("copilot", "sessionStart", { sessionId: "s", cwd: "/r", source: "new" }).source,
    "startup",
  );
  assert.equal(one("codex", "SessionStart", { source: "fork" }).source, "resume");
  assert.equal(one("claude", "SessionStart", { source: "compact" }).source, "compact");
  assert.equal(one("cursor", "sessionStart", {}).source, "startup", "no source is a fresh start");
  assert.equal(one("gemini", "BeforeAgent", { prompt: "add csv export" }).prompt, "add csv export");
  assert.equal(
    one("copilot", "sessionStart", { initialPrompt: "x" }).hook_event_name,
    "SessionStart",
  );
  // Cursor counts stop-hook rounds; the guards read that as "already continued once".
  assert.equal(one("cursor", "stop", { loop_count: 0 }).stop_hook_active, false);
  assert.equal(one("cursor", "stop", { loop_count: 2 }).stop_hook_active, true);
  assert.equal(one("gemini", "AfterAgent", { stop_hook_active: true }).stop_hook_active, true);
  // No folder in the payload: the agent's own project-dir variable, then the process.
  assert.equal(
    one("gemini", "SessionStart", {}, { GEMINI_PROJECT_DIR: "/from/env" }).cwd,
    "/from/env",
  );
  assert.equal(one("claude", "Stop", {}).session_id, "default");
  assert.equal(
    one("claude", "PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: { ok: 1 } })
      .tool_response.ok,
    1,
  );
});

test("normalize: what is not ours yields nothing — never an error", () => {
  assert.equal(normalize("claude", "Notification", {}), null);
  assert.equal(normalize("nobody", "PreToolUse", {}), null);
  // Cursor fires two events for a shell command; preToolUse leaves Bash to the other one.
  const dup = normalize("cursor", "preToolUse", {
    tool_name: "Shell",
    tool_input: { command: "ls" },
  });
  assert.deepEqual(dup.payloads, []);
  // A payload that is not an object is an empty one.
  assert.equal(one("claude", "PreToolUse", "garbage").tool_name, "");
  assert.equal(
    one("copilot", "preToolUse", { toolName: "bash", toolArgs: "ls -la" }).tool_input.command,
    "ls -la",
  );
});

// ── patches ────────────────────────────────────────────────────────────────────────────────

const PATCH = [
  "*** Begin Patch",
  "*** Add File: src/new.js",
  "+export const a = 1;",
  "+export const b = 2;",
  "*** Update File: package.json",
  "@@",
  // A context line is one space, then the line as it is in the file (here indented by two).
  '   "dependencies": {',
  '-    "express": "^4.19.0"',
  '+    "express": "^4.19.0",',
  '+    "zod": "3.23.8"',
  "   }",
  "@@ second hunk",
  '-  "private": true',
  '+  "private": false',
  "*** Update File: old/name.js",
  "*** Move to: new/name.js",
  "@@",
  "-x",
  "+y",
  "*** Delete File: tmp/junk.txt",
  "*** End Patch",
].join("\n");

test("parsePatch: one entry per file, hunks as the old and new text around them", () => {
  const files = parsePatch(PATCH);
  assert.deepEqual(
    files.map((f) => [f.kind, f.file_path]),
    [
      ["add", "src/new.js"],
      ["update", "package.json"],
      ["update", "old/name.js"],
      ["delete", "tmp/junk.txt"],
    ],
  );
  assert.equal(files[0].content, "export const a = 1;\nexport const b = 2;");
  assert.deepEqual(files[1].edits, [
    {
      old_string: '  "dependencies": {\n    "express": "^4.19.0"\n  }',
      new_string: '  "dependencies": {\n    "express": "^4.19.0",\n    "zod": "3.23.8"\n  }',
    },
    { old_string: '  "private": true', new_string: '  "private": false' },
  ]);
  assert.deepEqual(files[2].edits, [{ old_string: "x", new_string: "y" }]);
  assert.equal(files[3].content, "");
  assert.deepEqual(parsePatch("not a patch"), []);
});

test("normalize: a patch is checked file by file, so path and manifest guards see each one", () => {
  const n = normalize("codex", "PreToolUse", {
    session_id: "s",
    cwd: "/r",
    tool_name: "apply_patch",
    tool_input: { command: PATCH },
  });
  assert.deepEqual(
    n.payloads.map((p) => [p.tool_name, p.tool_input.file_path]),
    [
      ["Write", join("/r", "src/new.js")],
      ["MultiEdit", join("/r", "package.json")],
      ["MultiEdit", join("/r", "old/name.js")],
      ["Write", join("/r", "tmp/junk.txt")],
    ],
  );
  assert.equal(n.unchecked, 0);
  // A shell command that carries a patch is still a shell command, plus its files.
  const viaShell = normalize("codex", "PreToolUse", {
    cwd: "/r",
    tool_name: "Bash",
    tool_input: { command: `apply_patch <<'EOF'\n${PATCH}\nEOF` },
  });
  assert.deepEqual(
    viaShell.payloads.map((p) => p.tool_name),
    ["Bash", "Write", "MultiEdit", "MultiEdit", "Write"],
  );
  // Past the cap the rest is reported, not silently skipped.
  const many = Array.from(
    { length: MAX_PATCH_FILES + 3 },
    (_, i) => `*** Add File: f${i}.txt\n+x`,
  ).join("\n");
  const capped = normalize("codex", "PreToolUse", {
    cwd: "/r",
    tool_name: "apply_patch",
    tool_input: { command: many },
  });
  assert.equal(capped.payloads.length, MAX_PATCH_FILES);
  assert.equal(capped.unchecked, 3);
});

// ── the guard chain ────────────────────────────────────────────────────────────────────────

test("guardChain: hooks/hooks.json is the single list — matchers decide, the root is filled in", () => {
  const guards = (payload) => guardChain(payload).map((s) => s.guard);
  const pre = (tool_name) => guards({ hook_event_name: "PreToolUse", tool_name });
  assert.ok(pre("Bash").includes("dep-gate.sh"));
  assert.ok(pre("Bash").includes("protect-paths.sh"));
  assert.ok(pre("Write").includes("dep-gate.sh"), "manifest edits reach dep-gate");
  assert.deepEqual(pre("Read"), ["protect-paths.sh"]);
  assert.deepEqual(
    pre("SomeUnknownTool"),
    ["protect-paths.sh"],
    "supervised mode gates unknown tools too",
  );
  assert.equal(guards({ hook_event_name: "SessionStart", source: "startup" }).length, 2);
  assert.deepEqual(guards({ hook_event_name: "SessionStart", source: "compact" }), []);
  assert.ok(guards({ hook_event_name: "Stop" }).includes("completion-gate.sh"));
  // A security guard that cannot run must block; an advisory one must not.
  const steps = guardChain({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.equal(steps.find((s) => s.guard === "protect-paths.sh").failClosed, true);
  assert.equal(steps.find((s) => s.guard === "dep-gate.sh").failClosed, false);
  for (const s of steps)
    for (const a of s.args) assert.ok(!a.includes("${"), `unfilled placeholder: ${a}`);
  // Every guard the manifest names can be reached from some canonical payload.
  const manifest = loadManifest();
  assert.deepEqual(Object.keys(manifest).sort(), [...CANON, "PostToolUseFailure"].sort());
  // A broken matcher in a manifest skips that group instead of throwing.
  assert.deepEqual(
    guardChain(
      { hook_event_name: "PreToolUse", tool_name: "Bash" },
      { PreToolUse: [{ matcher: "(", hooks: [] }] },
    ),
    [],
  );
});

// ── one guard's answer, then all of them ───────────────────────────────────────────────────

test("interpret: the hook protocol the guards speak — exit 2, a JSON decision, or context", () => {
  const out = (o) => JSON.stringify(o);
  assert.deepEqual(interpret("PreToolUse", ran({ status: 2, stderr: "BLOCKED: no\n" })), {
    ...allow,
    decision: "deny",
    reason: "BLOCKED: no",
  });
  // After the fact there is nothing to deny: the same exit is feedback.
  assert.deepEqual(interpret("Stop", ran({ status: 2, stderr: "tests did not run" })), {
    ...allow,
    block: "tests did not run",
  });
  const ask = ran({
    stdout: out({
      hookSpecificOutput: {
        permissionDecision: "ask",
        permissionDecisionReason: "new package",
        additionalContext: "note",
      },
    }),
  });
  assert.deepEqual(interpret("PreToolUse", ask), {
    ...allow,
    decision: "ask",
    reason: "new package",
    context: "note",
  });
  const deny = ran({
    stdout: out({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" },
    }),
  });
  assert.equal(interpret("PreToolUse", deny).decision, "deny");
  assert.deepEqual(
    interpret("Stop", ran({ stdout: out({ decision: "block", reason: "keep going" }) })),
    { ...allow, block: "keep going" },
  );
  assert.equal(
    interpret("PostToolUse", ran({ stdout: out({ continue: false, stopReason: "halt" }) })).block,
    "halt",
  );
  // Plain text is context only where a host injects it.
  assert.equal(
    interpret("SessionStart", ran({ stdout: "## Lessons\n- x\n" })).context,
    "## Lessons\n- x",
  );
  assert.equal(interpret("PreToolUse", ran({ stdout: "chatter" })).context, "");
  // A guard that crashed says nothing — unless it is one that must reach a verdict.
  assert.deepEqual(interpret("PreToolUse", ran({ status: 1, stderr: "boom" })), allow);
  assert.deepEqual(interpret("PreToolUse", ran({ status: null })), allow);
  const closed = interpret(
    "PreToolUse",
    ran({ status: null, failClosed: true, guard: "protect-paths.sh" }),
  );
  assert.equal(closed.decision, "deny");
  assert.match(closed.reason, /protect-paths\.sh could not reach a verdict/);
  assert.deepEqual(interpret("PreToolUse", ran({ stdout: "{not json" })), allow);
});

test("merge: deny beats ask beats allow; context from every guard survives", () => {
  const v = (o) => ({ ...allow, ...o });
  assert.deepEqual(merge([]), allow);
  const m = merge([
    v({ context: "a" }),
    v({ decision: "ask", reason: "confirm" }),
    v({ decision: "deny", reason: "blocked" }),
    v({ context: "b" }),
  ]);
  assert.deepEqual(m, { decision: "deny", reason: "blocked", context: "a\n\nb", block: "" });
  assert.equal(
    merge([v({ decision: "deny", reason: "one" }), v({ decision: "deny", reason: "two" })]).reason,
    "one\ntwo",
  );
  assert.equal(merge([v({ decision: "ask", reason: "q" }), v({})]).decision, "ask");
  assert.equal(merge([v({ block: "x" }), v({ block: "y" })]).block, "x\ny");
});

// ── render ─────────────────────────────────────────────────────────────────────────────────

test("render: a denial is spelled the way each agent blocks a tool", () => {
  const deny = { ...allow, decision: "deny", reason: "not on the registry" };
  for (const [host, event] of [
    ["claude", "PreToolUse"],
    ["codex", "PreToolUse"],
    ["gemini", "BeforeTool"],
    ["devin", "PreToolUse"],
  ])
    assert.deepEqual(
      render(host, event, deny),
      { stdout: "", stderr: "not on the registry", exit: 2 },
      host,
    );
  const cursor = render("cursor", "beforeShellExecution", deny);
  assert.equal(cursor.exit, 0);
  assert.deepEqual(JSON.parse(cursor.stdout), {
    permission: "deny",
    user_message: deny.reason,
    agent_message: deny.reason,
  });
  assert.deepEqual(JSON.parse(render("copilot", "preToolUse", deny).stdout), {
    permissionDecision: "deny",
    permissionDecisionReason: deny.reason,
  });
});

test("render: an ask the agent cannot honour becomes a block — never a silent pass", () => {
  const ask = { ...allow, decision: "ask", reason: "ten days old" };
  const claude = JSON.parse(render("claude", "PreToolUse", ask).stdout).hookSpecificOutput;
  assert.deepEqual(claude, {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: "ten days old",
  });
  assert.equal(JSON.parse(render("cursor", "beforeShellExecution", ask).stdout).permission, "ask");
  assert.equal(JSON.parse(render("copilot", "preToolUse", ask).stdout).permissionDecision, "ask");
  // Codex, Gemini, Devin and Cursor's generic tool event have no confirm step.
  for (const [host, event] of [
    ["codex", "PreToolUse"],
    ["gemini", "BeforeTool"],
    ["devin", "PreToolUse"],
  ]) {
    const r = render(host, event, ask);
    assert.equal(r.exit, 2, host);
    assert.equal(r.stderr, `ten days old${NO_CONFIRM}`, host);
  }
  const cursorTool = JSON.parse(render("cursor", "preToolUse", ask).stdout);
  assert.equal(cursorTool.permission, "deny");
  assert.ok(cursorTool.agent_message.endsWith(NO_CONFIRM));
});

test("render: context and continue-working, per dialect; what an event cannot carry is dropped", () => {
  const ctx = { ...allow, context: "## Lessons" };
  const hso = (r) => JSON.parse(r.stdout).hookSpecificOutput;
  assert.deepEqual(hso(render("claude", "SessionStart", ctx)), {
    hookEventName: "SessionStart",
    additionalContext: "## Lessons",
  });
  // The reply echoes the HOST's event name, not the canonical one.
  assert.deepEqual(hso(render("gemini", "BeforeAgent", ctx)), {
    hookEventName: "BeforeAgent",
    additionalContext: "## Lessons",
  });
  assert.deepEqual(JSON.parse(render("cursor", "sessionStart", ctx).stdout), {
    additional_context: "## Lessons",
  });
  assert.deepEqual(JSON.parse(render("copilot", "sessionStart", ctx).stdout), {
    additionalContext: "## Lessons",
  });
  // No context channel on these events: nothing is printed, nothing fails.
  for (const [host, event] of [
    ["gemini", "BeforeTool"],
    ["cursor", "beforeSubmitPrompt"],
    ["copilot", "userPromptSubmitted"],
    ["cursor", "preToolUse"],
  ])
    assert.deepEqual(
      render(host, event, ctx),
      { stdout: "", stderr: "", exit: 0 },
      `${host} ${event}`,
    );

  const block = { ...allow, block: "run the tests first" };
  assert.deepEqual(JSON.parse(render("claude", "Stop", block).stdout), {
    decision: "block",
    reason: "run the tests first",
  });
  assert.deepEqual(JSON.parse(render("gemini", "AfterAgent", block).stdout), {
    decision: "deny",
    reason: "run the tests first",
  });
  assert.deepEqual(JSON.parse(render("cursor", "stop", block).stdout), {
    followup_message: "run the tests first",
  });
  assert.deepEqual(JSON.parse(render("cursor", "beforeSubmitPrompt", block).stdout), {
    continue: false,
    user_message: "run the tests first",
  });
  assert.deepEqual(JSON.parse(render("copilot", "agentStop", block).stdout), {
    decision: "block",
    reason: "run the tests first",
  });
  assert.equal(
    render("copilot", "userPromptSubmitted", block).stdout,
    "",
    "Copilot ignores this event's output",
  );

  // Nothing to say: empty — except where the agent requires a JSON object.
  assert.equal(render("claude", "Stop", allow).stdout, "");
  assert.equal(render("codex", "Stop", allow).stdout, "{}");
  assert.deepEqual(render("nobody", "PreToolUse", { ...allow, decision: "deny", reason: "x" }), {
    stdout: "",
    stderr: "",
    exit: 0,
  });
});

// ── an event delivered twice ───────────────────────────────────────────────────────────────

test("claimEvent: the first delivery owns the event, the second replays its verdict", async () => {
  const dir = tmp("claims-");
  const sleep = async () => {};
  const first = await claimEvent({ dir, key: "k1", nowMs: 1000, sleep });
  assert.equal(first.owner, true);
  first.publish({ ...allow, decision: "deny", reason: "blocked" });
  const twin = await claimEvent({ dir, key: "k1", nowMs: 1000 + 200, sleep });
  assert.deepEqual(twin, {
    owner: false,
    verdict: { ...allow, decision: "deny", reason: "blocked" },
  });
  // The same event later is a retry, not a twin: it is checked afresh.
  const retry = await claimEvent({ dir, key: "k1", nowMs: 1000 + CLAIM_WINDOW_MS + 1, sleep });
  assert.equal(retry.owner, true);
  // A twin whose owner never publishes stops waiting and checks for itself.
  const slow = await claimEvent({ dir, key: "k2", nowMs: 5000, sleep });
  assert.equal(slow.owner, true);
  const orphan = await claimEvent({ dir, key: "k2", nowMs: 5010, waitMs: 80, sleep });
  assert.deepEqual(orphan, { owner: false, verdict: null });
  // An unusable directory degrades to "check for yourself", never to an error.
  const file = join(dir, "a-file");
  writeFileSync(file, "x");
  const broken = await claimEvent({ dir: join(file, "sub"), key: "k3", sleep });
  assert.deepEqual(broken, { owner: false, verdict: null });
});

test("eventKey: the same event by two routes has one key; a different one does not", () => {
  const a = one("copilot", "preToolUse", {
    sessionId: "s",
    cwd: "/r",
    toolName: "bash",
    toolArgs: '{"command":"npm i x"}',
  });
  const b = one("claude", "PreToolUse", {
    session_id: "s",
    cwd: "/r",
    tool_name: "Bash",
    tool_input: { command: "npm i x" },
  });
  assert.equal(eventKey([a]), eventKey([b]));
  const c = one("claude", "PreToolUse", {
    session_id: "s",
    cwd: "/r",
    tool_name: "Bash",
    tool_input: { command: "npm i y" },
  });
  assert.notEqual(eventKey([b]), eventKey([c]));
  const other = one("claude", "PreToolUse", {
    session_id: "t",
    cwd: "/r",
    tool_name: "Bash",
    tool_input: { command: "npm i x" },
  });
  assert.notEqual(eventKey([b]), eventKey([other]), "another session is another event");
});

// ── runHook ────────────────────────────────────────────────────────────────────────────────

/** `runHook` with canned guard results; records what the guards were handed. */
const hook = (o, results = [ran()], seen = []) =>
  runHook({
    env: {},
    home: tmp("home-"),
    claim: null,
    run: async (steps, payload) => {
      seen.push({ payload, guards: steps.map((s) => s.guard) });
      return results;
    },
    ...o,
    input: typeof o.input === "string" ? o.input : JSON.stringify(o.input ?? {}),
  });
const bash = (command, extra = {}) => ({
  session_id: "s",
  cwd: "/r",
  tool_name: "Bash",
  tool_input: { command },
  ...extra,
});

test("Kimi user plugin honors the worktree host selection for prompts and status", async (t) => {
  const root = tmp();
  const home = tmp();
  const configDir = join(root, ".forge");
  const nested = join(root, "packages");
  const plugins = join(home, ".kimi-code", "plugins");
  mkdirSync(configDir);
  mkdirSync(nested);
  writeFileSync(join(root, ".git"), "gitdir: ../main/.git/worktrees/client\n");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "installed.json"),
    JSON.stringify({ plugins: [{ id: BRAND.pkg, enabled: true }] }),
  );
  const kimiHome = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
  t.after(() => {
    if (kimiHome !== undefined) process.env.KIMI_CODE_HOME = kimiHome;
  });
  for (const [config, enabled] of [
    [{}, true],
    [{ tools: ["codex"] }, false],
    [{ tools: [] }, false],
    [{ tools: "all" }, true],
    [{ tools: "kimi-code,codex" }, true],
    [{ tools: ["kimi"], hooks: { hosts: ["codex"] } }, false],
    [{ tools: ["codex"], hooks: { hosts: ["kimi"] } }, true],
    [{ tools: ["kimi"], hooks: { project: false } }, false],
  ]) {
    writeFileSync(join(configDir, "forge.config.json"), JSON.stringify(config));
    const seen = [];
    await hook(
      {
        host: "kimi",
        event: "UserPromptSubmit",
        input: { cwd: nested, prompt: [{ type: "text", text: "Find the test." }] },
      },
      [],
      seen,
    );
    assert.equal(seen.length > 0, enabled, JSON.stringify(config));
    const row = hooksStatus(root, { config, home }).hosts.find((h) => h.host === "kimi");
    assert.equal(row.state, enabled ? "enabled in Kimi" : "off");
  }
});

test("runHook: a guard's denial reaches each agent in its own words", async () => {
  const deny = [ran({ status: 2, stderr: "BLOCKED by dep-gate: not on the registry" })];
  const codex = await hook({ host: "codex", event: "PreToolUse", input: bash("npm i x") }, deny);
  assert.deepEqual(codex, {
    stdout: "",
    stderr: "BLOCKED by dep-gate: not on the registry",
    exit: 2,
  });
  const copilot = await hook(
    {
      host: "copilot",
      event: "preToolUse",
      input: { sessionId: "s", toolName: "bash", toolArgs: '{"command":"npm i x"}' },
    },
    deny,
  );
  assert.equal(JSON.parse(copilot.stdout).permissionDecision, "deny");
  const cursor = await hook(
    { host: "cursor", event: "beforeShellExecution", input: { command: "npm i x" } },
    deny,
  );
  assert.equal(JSON.parse(cursor.stdout).permission, "deny");
  // The guards were handed the canonical payload, whatever the agent sent.
  const seen = [];
  await hook(
    {
      host: "gemini",
      event: "BeforeTool",
      input: {
        session_id: "s",
        tool_name: "run_shell_command",
        tool_input: { command: "npm i x" },
      },
    },
    [ran()],
    seen,
  );
  assert.equal(seen[0].payload.tool_name, "Bash");
  assert.equal(seen[0].payload.hook_event_name, "PreToolUse");
  assert.ok(seen[0].guards.includes("dep-gate.sh"));
});

test("runHook: nothing that is not a verdict can fail a tool call", async () => {
  const silent = { stdout: "", stderr: "", exit: 0 };
  const deny = [ran({ status: 2, stderr: "no" })];
  assert.deepEqual(
    await hook({ host: "codex", event: "PreToolUse", input: "{not json" }, deny),
    silent,
  );
  assert.deepEqual(
    await hook({ host: "nobody", event: "PreToolUse", input: bash("x") }, deny),
    silent,
  );
  assert.deepEqual(
    await hook({ host: "codex", event: "Notification", input: bash("x") }, deny),
    silent,
  );
  assert.deepEqual(
    await hook(
      { host: "codex", event: "PreToolUse", input: bash("x"), env: { FORGE_HOOKS: "0" } },
      deny,
    ),
    silent,
  );
  const throwing = await runHook({
    host: "codex",
    event: "PreToolUse",
    input: JSON.stringify(bash("x")),
    env: {},
    claim: null,
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(throwing, silent);
  assert.equal(hooksDisabled({ FORGE_HOOKS: "off" }), true);
  assert.equal(hooksDisabled({ FORGE_HOOKS: "1" }), false);
  assert.equal(hooksDisabled({}), false);
});

test("runHook: Claude's file stands down when the agent has its own channel or a user-level install", async () => {
  const deny = [ran({ status: 2, stderr: "no" })];
  const silent = { stdout: "", stderr: "", exit: 0 };
  // Inside Cursor, with Cursor's own file wired in this project: that channel answers.
  const repo = tmp("repo-");
  mkdirSync(join(repo, ".cursor"));
  writeFileSync(join(repo, ".cursor", "hooks.json"), planHooks(null, "cursor").next);
  assert.equal(projectWired(repo, "cursor"), true);
  const inCursor = await hook(
    {
      host: "claude",
      event: "PreToolUse",
      input: bash("npm i x", { cwd: repo }),
      env: { CURSOR_VERSION: "3.1" },
    },
    deny,
  );
  assert.deepEqual(inCursor, silent);
  // Inside Cursor WITHOUT its own file, Claude's file is the only channel, so it answers.
  const bare = await hook(
    {
      host: "claude",
      event: "PreToolUse",
      input: bash("npm i x", { cwd: tmp("repo-") }),
      env: { CURSOR_VERSION: "3.1" },
    },
    deny,
  );
  assert.equal(bare.exit, 2);
  // forge already wired at user level: every guard already runs; do not run each twice.
  const home = tmp("home-");
  mkdirSync(join(home, ".claude"));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ _forge: "forge-managed" }),
  );
  assert.equal(userLevelWired({ home }), true);
  assert.deepEqual(
    await hook({ host: "claude", event: "PreToolUse", input: bash("npm i x"), home }, deny),
    silent,
  );
  // …also when it is the plugin, or hooks merged by an older install.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { [`${BRAND.pkg}@market`]: true } }),
  );
  assert.equal(userLevelWired({ home }), true);
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "other@market": true } }),
  );
  assert.equal(userLevelWired({ home }), false);
  assert.equal(userLevelWired({ home: tmp("empty-") }), false);
  // Another host's own channel never stands down for a Claude install.
  assert.equal(
    (
      await hook(
        { host: "codex", event: "PreToolUse", input: bash("npm i x"), home: tmp("home-") },
        deny,
      )
    ).exit,
    2,
  );
});

test("runHook: Devin reads Claude's file but plays by its own rules", async () => {
  assert.equal(detectHost({ DEVIN_PROJECT_DIR: "/r" }), "devin");
  assert.equal(detectHost({ CURSOR_VERSION: "3" }), "cursor");
  assert.equal(detectHost({}), null);
  const seen = [];
  const ask = [
    ran({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "new package" },
      }),
    }),
  ];
  const r = await hook(
    {
      host: "claude",
      event: "PreToolUse",
      input: { session_id: "s", tool_name: "exec", tool_input: { command: "npm i x" } },
      env: { DEVIN_PROJECT_DIR: "/r" },
    },
    ask,
    seen,
  );
  assert.equal(seen[0].payload.tool_name, "Bash", "Devin's `exec` is a shell command");
  assert.equal(seen[0].payload.cwd, "/r", "the folder comes from Devin's own variable");
  assert.deepEqual(r, { stdout: "", stderr: `new package${NO_CONFIRM}`, exit: 2 });
});

test("runHook: an event delivered by two files runs the guards once and denies twice", async () => {
  const dir = tmp("claims-");
  let runs = 0;
  const run = async () => {
    runs++;
    return [ran({ status: 2, stderr: "BLOCKED: invented name" })];
  };
  const claim = (o) => claimEvent({ ...o, dir, sleep: async () => {} });
  const common = { env: {}, home: tmp("home-"), run, claim };
  const native = await runHook({
    ...common,
    host: "copilot",
    event: "preToolUse",
    input: JSON.stringify({
      sessionId: "s",
      cwd: "/r",
      toolName: "bash",
      toolArgs: '{"command":"npm i x"}',
    }),
  });
  const viaClaude = await runHook({
    ...common,
    host: "claude",
    event: "PreToolUse",
    input: JSON.stringify(bash("npm i x")),
  });
  assert.equal(runs, 1, "the guards ran once");
  assert.equal(JSON.parse(native.stdout).permissionDecision, "deny");
  assert.deepEqual(
    viaClaude,
    { stdout: "", stderr: "BLOCKED: invented name", exit: 2 },
    "replayed in its own dialect",
  );
});

test("runHook: a patch past the cap says what was not checked", async () => {
  const many = Array.from(
    { length: MAX_PATCH_FILES + 2 },
    (_, i) => `*** Add File: f${i}.txt\n+x`,
  ).join("\n");
  const r = await hook({
    host: "codex",
    event: "PreToolUse",
    input: { session_id: "s", cwd: "/r", tool_name: "apply_patch", tool_input: { command: many } },
  });
  assert.match(
    JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    /2 more file\(s\) in this patch were not checked/,
  );
});

test("runHook, end to end: the real guards block a secret read from every agent", async () => {
  const repo = tmp("repo-");
  const env = { ...process.env, FORGE_DEPGATE: "0" };
  const read = (host, event, input) =>
    runHook({ host, event, input: JSON.stringify(input), env, home: tmp("home-"), claim: null });
  const gemini = await read("gemini", "BeforeTool", {
    session_id: "e2e",
    cwd: repo,
    tool_name: "read_file",
    tool_input: { file_path: join(repo, ".env") },
  });
  assert.equal(gemini.exit, 2);
  assert.match(gemini.stderr, /protect-paths/);
  const copilot = await read("copilot", "preToolUse", {
    sessionId: "e2e",
    cwd: repo,
    toolName: "view",
    toolArgs: JSON.stringify({ path: join(repo, ".env") }),
  });
  assert.match(JSON.parse(copilot.stdout).permissionDecisionReason, /protect-paths/);
  const patch = `*** Begin Patch\n*** Add File: .env\n+SECRET=1\n*** End Patch`;
  const codex = await read("codex", "PreToolUse", {
    session_id: "e2e",
    cwd: repo,
    tool_name: "apply_patch",
    tool_input: { command: patch },
  });
  assert.equal(codex.exit, 2, "a patch is read for the files it touches");
  const fine = await read("codex", "PreToolUse", {
    session_id: "e2e",
    cwd: repo,
    tool_name: "Read",
    tool_input: { file_path: join(repo, "README.md") },
  });
  assert.deepEqual(fine, { stdout: "", stderr: "", exit: 0 });
});

// ── the files each agent reads ─────────────────────────────────────────────────────────────

test("hookCommand: never fails a machine without the CLI; a bootstrap pins this exact version", () => {
  const cmd = hookCommand("codex", "PreToolUse");
  assert.equal(
    cmd,
    `command -v ${CLI} >/dev/null 2>&1 || exit 0; ${CLI} hooks run codex PreToolUse`,
  );
  assert.ok(isForgeHookCommand(cmd));
  assert.ok(isForgeHookCommand(hookCommand("copilot", "preToolUse", { shell: "powershell" })));
  assert.equal(isForgeHookCommand("./scripts/my-own-hook.sh"), false);
  assert.equal(isForgeHookCommand(undefined), false);
  // The registry name comes from package.json — the brand name belongs to someone else on npm.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  assert.equal(packageSpec(), `${pkg.name}@${pkg.version}`);
  const boot = hookCommand("claude", "SessionStart", { bootstrap: true });
  assert.ok(boot.includes(`npm install -g --silent ${pkg.name}@${pkg.version}`));
  assert.ok(
    boot.endsWith(`|| exit 0; ${CLI} hooks run claude SessionStart`),
    "still stands down if the install failed",
  );
  // Only a session start installs; a tool call never waits on npm.
  assert.equal(
    hookCommand("claude", "PreToolUse", { bootstrap: true }),
    hookCommand("claude", "PreToolUse"),
  );
  // The command a shell runs really does stand down when the CLI is absent.
  const absent = spawnSync("sh", ["-c", hookCommand("codex", "PreToolUse")], {
    input: "{}",
    env: { PATH: "/nonexistent" },
    encoding: "utf8",
  });
  if (absent.error === undefined)
    assert.deepEqual([absent.status, absent.stdout, absent.stderr], [0, "", ""]);
});

test("planHooks: each agent's file, in its own shape", () => {
  const doc = (host, o) => JSON.parse(planHooks(null, host, o).next);
  const claude = doc("claude");
  assert.deepEqual(Object.keys(claude.hooks), [...CANON, "PostToolUseFailure"]);
  assert.deepEqual(claude.hooks.PreToolUse, [
    {
      hooks: [
        {
          type: "command",
          command: hookCommand("claude", "PreToolUse"),
          timeout: HOOK_TIMEOUT_S.PreToolUse,
        },
      ],
    },
  ]);
  const codex = doc("codex").hooks.Stop[0].hooks[0];
  assert.ok(
    codex.commandWindows.startsWith("if (Get-Command"),
    "Codex takes a Windows command of its own",
  );
  const gemini = doc("gemini");
  assert.deepEqual(Object.keys(gemini.hooks), [
    "SessionStart",
    "BeforeAgent",
    "BeforeTool",
    "AfterTool",
    "AfterAgent",
  ]);
  assert.equal(gemini.hooks.BeforeTool[0].matcher, "*");
  assert.equal(
    gemini.hooks.BeforeTool[0].hooks[0].timeout,
    HOOK_TIMEOUT_S.PreToolUse * 1000,
    "Gemini counts milliseconds",
  );
  assert.equal(gemini.hooks.BeforeTool[0].hooks[0].name, `${CLI}-BeforeTool`);
  const cursor = doc("cursor");
  assert.deepEqual(Object.keys(cursor), ["version", "hooks"]);
  assert.deepEqual(cursor.hooks.beforeShellExecution, [
    { command: hookCommand("cursor", "beforeShellExecution"), timeout: 30 },
  ]);
  const copilot = doc("copilot");
  assert.equal(copilot.version, 1);
  assert.deepEqual(Object.keys(copilot.hooks.preToolUse[0]), [
    "type",
    "bash",
    "powershell",
    "cwd",
    "timeoutSec",
  ]);
  // A bootstrap gives the session start time to install.
  assert.equal(
    doc("claude", { bootstrap: true }).hooks.SessionStart[0].hooks[0].timeout,
    BOOTSTRAP_TIMEOUT_S,
  );
  assert.equal(
    doc("claude", { bootstrap: true }).hooks.PreToolUse[0].hooks[0].timeout,
    HOOK_TIMEOUT_S.PreToolUse,
  );
  assert.deepEqual(HOOK_HOSTS, ["claude", "codex", "gemini", "cursor", "copilot", "kimi"]);
});

test("planHooks: only forge's own entries are ever touched; turning off leaves no trace", () => {
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/audit.sh" }] };
  const before = JSON.stringify(
    {
      model: "x",
      hooks: { PreToolUse: [mine], Notification: [mine] },
      permissions: { allow: ["Bash(ls)"] },
    },
    null,
    2,
  );
  const on = planHooks(before, "claude").next;
  const parsed = JSON.parse(on);
  assert.deepEqual(parsed.hooks.PreToolUse[0], mine, "the person's hook stays first");
  assert.equal(parsed.hooks.PreToolUse.length, 2);
  assert.deepEqual(parsed.hooks.Notification, [mine]);
  assert.deepEqual([parsed.model, parsed.permissions], ["x", { allow: ["Bash(ls)"] }]);
  // Idempotent: a second run changes nothing (so `forge sync` reports "unchanged").
  assert.equal(planHooks(on, "claude").next, on);
  // Off: byte for byte what the person had.
  assert.equal(planHooks(on, "claude", { enable: false }).next, `${before}\n`);
  // A file forge created is removed entirely when turned off; a version number is not content.
  for (const host of HOOK_HOSTS.filter((id) => HOSTS[id].file)) {
    const created = planHooks(null, host).next;
    assert.equal(planHooks(created, host, { enable: false }).next, null, host);
  }
  // Changing an option rewrites forge's entry instead of adding a second one.
  const boot = JSON.parse(planHooks(on, "claude", { bootstrap: true }).next);
  assert.equal(boot.hooks.SessionStart.length, 1);
  // Gemini's settings hold other things under the same file; they are kept.
  const gem = JSON.parse(
    planHooks(
      JSON.stringify({ context: { fileName: ["AGENTS.md"] }, mcpServers: { a: {} } }),
      "gemini",
    ).next,
  );
  assert.deepEqual(gem.context, { fileName: ["AGENTS.md"] });
  assert.ok(gem.mcpServers.a && gem.hooks.BeforeTool);
  // A file that is not JSON is left exactly as it is, and says so.
  assert.deepEqual(planHooks("{ not json", "claude"), {
    next: "{ not json",
    error: "not valid JSON — left as it is",
  });
  assert.equal(planHooks("[1,2]", "cursor").error, "not a JSON object — left as it is");
});

test("applyHooks / hooksStatus / emitProjectHooks: on, current, stale, off", () => {
  const root = tmp("repo-");
  const home = tmp("home-");
  const state = (config) =>
    Object.fromEntries(hooksStatus(root, { config, home }).hosts.map((h) => [h.host, h.state]));
  assert.deepEqual(new Set(Object.values(state({}))), new Set(["off"]));
  // `forge sync` writes nothing until a repository turns hooks on.
  assert.deepEqual(emitProjectHooks({ targetRoot: root, config: {} }), []);
  assert.deepEqual(
    emitProjectHooks({ targetRoot: root, config: { hooks: { project: false } } }),
    [],
  );
  const on = { hooks: { project: true } };
  const rows = emitProjectHooks({ targetRoot: root, config: on });
  assert.deepEqual(
    rows.map((r) => [r.tool, r.target, r.action]),
    HOOK_HOSTS.map((id) => [
      HOSTS[id].label,
      HOSTS[id].file ?? "Kimi /plugins",
      HOSTS[id].file ? "written" : "manual",
    ]),
  );
  for (const id of HOOK_HOSTS.filter((id) => HOSTS[id].file))
    assert.ok(existsSync(join(root, HOSTS[id].file)), id);
  assert.deepEqual(state(on), {
    claude: "on",
    codex: "on",
    gemini: "on",
    cursor: "on",
    copilot: "on",
    kimi: "off",
    devin: "via claude",
  });
  assert.deepEqual(
    emitProjectHooks({ targetRoot: root, config: on }).map((r) => r.action),
    [...Array(5).fill("unchanged"), "manual"],
  );
  // The files hold yesterday's commands (here: no bootstrap, config now asks for one) → stale.
  const boot = { hooks: { project: true, bootstrap: true } };
  assert.equal(state(boot).claude, "stale");
  emitProjectHooks({ targetRoot: root, config: boot });
  assert.equal(state(boot).claude, "on");
  // The repository's tool selection and an explicit host list both narrow what is written.
  assert.deepEqual(
    selectedHosts({}, (tool) => tool === "claude" || tool === "codex"),
    ["claude", "codex"],
  );
  assert.deepEqual(
    selectedHosts({ hooks: { hosts: ["copilot"] } }, () => false),
    ["copilot"],
  );
  // Off: gone.
  for (const id of HOOK_HOSTS)
    assert.equal(
      applyHooks(root, id, { enable: false }).action,
      HOSTS[id].plugin ? "manual" : "removed",
      id,
    );
  assert.deepEqual(new Set(Object.values(state({}))), new Set(["off"]));
  assert.equal(applyHooks(root, "devin"), null, "Devin has no file of its own");
  // A file that is not JSON is reported, not overwritten.
  mkdirSync(join(root, ".cursor"), { recursive: true });
  writeFileSync(join(root, ".cursor", "hooks.json"), "{ nope");
  assert.equal(applyHooks(root, "cursor").action, "skipped");
  assert.equal(readFileSync(join(root, ".cursor", "hooks.json"), "utf8"), "{ nope");
});

test("forge hooks: on writes every file, status reads them back, off removes them; run answers an agent", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const root = tmp("repo-");
  const run = (args, input) =>
    spawnSync(process.execPath, [cli, "hooks", ...args], {
      cwd: root,
      encoding: "utf8",
      input,
      env: { ...process.env, FORGE_DEPGATE: "0" },
    });
  const on = JSON.parse(run(["on", "--json"]).stdout);
  assert.deepEqual([on.enabled, on.rows.length], [true, 6]);
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, ".forge", "forge.config.json"), "utf8")).hooks,
    { project: true },
  );
  const status = JSON.parse(run(["status", "--json"]).stdout);
  assert.equal(status.enabled, true);
  assert.ok(
    status.hosts.every(
      (h) =>
        h.state === "on" || h.state === "via claude" || (h.host === "kimi" && h.state === "off"),
    ),
  );
  // What an agent gets: a verdict on stdout/stderr and nothing else — no tip line, no banner.
  const blocked = run(
    ["run", "codex", "PreToolUse"],
    JSON.stringify({
      session_id: "cli",
      cwd: root,
      tool_name: "Read",
      tool_input: { file_path: join(root, ".env") },
    }),
  );
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stdout, "");
  assert.match(blocked.stderr, /^BLOCKED by protect-paths guard/);
  assert.equal(
    blocked.stderr.trim().split("\n").length,
    1,
    "stderr is the reason and only the reason",
  );
  const quiet = run(["run", "codex", "PreToolUse"], "{}");
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, "", ""]);
  const off = JSON.parse(run(["off", "--json"]).stdout);
  assert.ok(
    off.rows.every(
      (r) => r.action === "removed" || (r.tool === "Kimi Code" && r.action === "manual"),
    ),
  );
  for (const id of HOOK_HOSTS.filter((id) => HOSTS[id].file))
    assert.equal(existsSync(join(root, HOSTS[id].file)), false, id);
  const bad = run(["on", "--hosts", "emacs"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown host\(s\): emacs/);
});

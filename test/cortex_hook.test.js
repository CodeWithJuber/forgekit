import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendSessionEvent,
  classifyEvent,
  detectDoomLoop,
  detectEpisodes,
  doomLoopAdvisory,
  isE2eRun,
  processSession,
  readSession,
  sessionPath,
} from "../src/cortex_hook.js";
import { load } from "../src/lessons_store.js";
import { fakeGithubPat } from "./_fixtures.js";

// Default is now ledger-only; these cases exercise the legacy FILE store (the
// FORGE_LEDGER_ONLY=0 escape hatch). Pin it here so they test that path directly.
process.env.FORGE_LEDGER_ONLY = "0";

const fixture = () => mkdtempSync(join(tmpdir(), "forge-hook-"));

test("classifyEvent normalizes edits, bash, and prompts", () => {
  assert.deepEqual(classifyEvent({ tool_name: "Edit", tool_input: { file_path: "a.ts" } }), {
    type: "edit",
    file: "a.ts",
  });
  assert.deepEqual(
    classifyEvent({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      exitCode: 1,
    }),
    {
      type: "bash",
      command: "npm test",
      exitCode: 1,
    },
  );
  assert.equal(
    classifyEvent({ hook_event_name: "UserPromptSubmit", prompt: "undo that" }).type,
    "prompt",
  );
  assert.equal(classifyEvent({ tool_name: "Read", tool_input: {} }), null);
});

test("test-fail → edit → pass on a repeatedly-edited file fires a mistake episode", () => {
  const events = [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  const eps = detectEpisodes(events, { nowDay: 1 });
  const m = eps.find((e) => e.kind === "mistake");
  const signals = m.signals.map((s) => s.signal).sort();
  assert.deepEqual(signals, ["S1", "S2"], "test-recovery + self-edit → two families");
});

test("a lone edit or a single 'no' produces no firing lesson (false-positive guards)", () => {
  const root = fixture();
  processSession(root, [{ type: "edit", file: "src/x.ts" }], 1); // one edit, nothing else
  assert.equal(load(root).length, 0, "one edit is not a mistake");

  const root2 = fixture();
  processSession(
    root2,
    [
      { type: "edit", file: "src/y.ts" },
      { type: "prompt", text: "no problem, thanks" },
    ],
    1,
  );
  assert.equal(load(root2).length, 0, "'no problem' is not a correction");
});

test("git revert emits a contradiction episode against recently-edited files", () => {
  const events = [
    { type: "edit", file: "src/auth.ts" },
    { type: "bash", command: "git revert HEAD", exitCode: 0 },
  ];
  const eps = detectEpisodes(events, { nowDay: 1 });
  const c = eps.find((e) => e.kind === "contradiction");
  assert.ok(c, "revert detected");
  assert.deepEqual(c.context.files, ["src/auth.ts"]);
});

test("end-to-end (strong pattern): recurring mistake → candidate then active in 2 sessions", () => {
  const root = fixture();
  // 3 edits (S2+S3) + test fail→pass (S1) → p≈0.71, clears the distill bar on its own
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "edit", file: "src/tax.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  assert.equal(load(root)[0].status, "candidate", "first strong occurrence → candidate");
  processSession(root, session(), 2);
  assert.equal(load(root)[0].status, "active", "recurrence → active");
});

test("end-to-end (weak pattern): a 0.4–0.7 episode is ignored once, earns a lesson on recurrence", () => {
  const root = fixture();
  // 2 edits (S2) + test fail→pass (S1) → p≈0.59, below the distill bar
  const session = () => [
    { type: "bash", command: "npm test", exitCode: 1 },
    { type: "edit", file: "src/util.ts" },
    { type: "edit", file: "src/util.ts" },
    { type: "bash", command: "npm test", exitCode: 0 },
  ];
  processSession(root, session(), 1);
  assert.equal(load(root).length, 0, "one weak occurrence is not yet a lesson");
  processSession(root, session(), 2);
  assert.equal(
    load(root)[0]?.status,
    "candidate",
    "recurrence promotes the weak episode to a candidate",
  );
});

test("classifyEvent attaches an output signature only to a FAILED bash run", () => {
  const failed = classifyEvent({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    exitCode: 1,
    tool_response: "AssertionError: expected 3 to equal 4\n  at test.js:12:5",
  });
  assert.ok(failed.outputSig, "failed run carries a signature");
  const passed = classifyEvent({
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    exitCode: 0,
    tool_response: "all good",
  });
  assert.equal(passed.outputSig, undefined, "a passing run carries none");
});

test("detectDoomLoop fires when the SAME failure signature recurs past the threshold", () => {
  // same normalized failure three times, with different edits in between
  const fail = (n) => ({
    type: "bash",
    command: "npm test",
    exitCode: 1,
    outputSig: "sameSig",
    _n: n,
  });
  const events = [
    { type: "edit", file: "a.js" },
    fail(1),
    { type: "edit", file: "a.js" },
    fail(2),
    { type: "edit", file: "b.js" },
    fail(3),
  ];
  const r = detectDoomLoop(events, { threshold: 3 });
  assert.equal(r.loop, true);
  assert.equal(r.count, 3);
  assert.ok(r.files.includes("a.js"));
  assert.match(doomLoopAdvisory(events, { threshold: 3 }), /doom loop/i);
});

test("detectDoomLoop stays quiet when failures differ or are below threshold", () => {
  const events = [
    { type: "bash", command: "npm test", exitCode: 1, outputSig: "sigA" },
    { type: "bash", command: "npm test", exitCode: 1, outputSig: "sigB" },
    { type: "bash", command: "npm test", exitCode: 1, outputSig: "sigA" },
  ];
  assert.equal(detectDoomLoop(events, { threshold: 3 }).loop, false, "no single signature hit 3×");
  assert.equal(doomLoopAdvisory(events), "");
});

test("outputSignature normalizes line numbers/timings so the same error matches across runs", () => {
  const e1 = classifyEvent({
    tool_name: "Bash",
    tool_input: { command: "pytest" },
    exitCode: 1,
    tool_response: "FAILED test_x.py:41 in 0.3s — assert 1 == 2",
  });
  const e2 = classifyEvent({
    tool_name: "Bash",
    tool_input: { command: "pytest" },
    exitCode: 1,
    tool_response: "FAILED test_x.py:57 in 1.1s — assert 1 == 2",
  });
  assert.equal(e1.outputSig, e2.outputSig, "line/timing noise is normalized out");
});

// B5: prompts and shell commands were appended to .forge/sessions/<sid>.jsonl verbatim, so a
// pasted `GITHUB_TOKEN=ghp_…` or an `Authorization: Bearer …` curl sat on disk in the repo.
test("session log never stores a raw secret from a prompt or a command (B5)", () => {
  const root = fixture();
  const tok = fakeGithubPat();
  const log = (hook) => appendSessionEvent(root, "s-b5", classifyEvent(hook));
  log({ hook_event_name: "UserPromptSubmit", prompt: `deploy with GITHUB_TOKEN=${tok} please` });
  log({
    tool_name: "Bash",
    tool_input: { command: `curl -H 'Authorization: Bearer ${tok}' https://api.github.com` },
  });
  log({ tool_name: "Bash", tool_input: { command: "git revert HEAD" }, exitCode: 0 });
  const raw = readFileSync(sessionPath(root, "s-b5"), "utf8");
  assert.equal(raw.includes(tok), false, "the token never reaches disk");
  assert.match(raw, /GITHUB_TOKEN=\[REDACTED\] please/, "the prompt stays readable");
  // Redaction must not blind the signal detectors (verbs are never secrets).
  const events = readSession(root, "s-b5");
  assert.equal(events.length, 3);
  assert.equal(events[2].command, "git revert HEAD");
});

test("classifyEvent (C10): the signature covers stderr and the WHOLE output, not the first 800 chars", () => {
  const bash = (response) =>
    classifyEvent({
      tool_name: "Bash",
      tool_input: { command: "npx jest" },
      exitCode: 1,
      tool_response: response,
    });
  // (a) a stderr-only failure (jest, mocha, tsc) used to carry no signature at all.
  const e = bash({ stdout: "", stderr: "FAIL src/a.test.js\n  expected 3 received 4" });
  assert.ok(e.outputSig, "a stderr-only failure is still a failure");
  assert.equal(detectDoomLoop([e, e, e]).loop, true);
  // (b) three DIFFERENT failures behind the same long passing header are not one loop.
  const header = `> app@1.0.0 test\n> node --test\n${"▶ suite\n  ✔ passes (1.2ms)\n".repeat(40)}`;
  const f1 = bash({ stdout: `${header}✖ auth: expected 3 got 4` });
  const f2 = bash({ stdout: `${header}✖ billing: TypeError x is undefined` });
  const f3 = bash({ stdout: `${header}✖ cache: timeout waiting for the queue` });
  assert.equal(new Set([f1.outputSig, f2.outputSig, f3.outputSig]).size, 3, "distinct failures");
  assert.equal(
    detectDoomLoop([f1, { type: "edit", file: "a" }, f2, { type: "edit", file: "b" }, f3]).loop,
    false,
  );
  // …while the same failure, header and all, still is one.
  assert.equal(detectDoomLoop([f1, { type: "edit", file: "a" }, f1, f1]).loop, true);
});

test("doomLoopAdvisory (C10): with no edits between runs it does not claim edits were made", () => {
  const same = {
    type: "bash",
    command: "npm test",
    exitCode: 1,
    outputSig: "aaaaaaaaaaaa",
  };
  const noEdits = doomLoopAdvisory([same, same, same]);
  assert.match(noEdits, /doom loop/i);
  assert.doesNotMatch(noEdits, /Different edits aren't fixing it/);
  assert.match(noEdits, /without chang/i, noEdits);
  const withEdits = doomLoopAdvisory([same, { type: "edit", file: "a.js" }, same, same]);
  assert.match(withEdits, /Different edits aren't fixing it/);
});

test("isE2eRun: real, unmasked end-to-end suite runs only", () => {
  for (const c of [
    "npm run e2e",
    "npm run test:e2e",
    "pnpm e2e",
    "yarn e2e:mobile",
    "npx playwright test e2e/home.spec.ts",
    "pnpm exec playwright test",
    "npx cypress run",
    "cd /repo && E2E_BASE_URL=http://localhost:3100 npm run e2e",
  ])
    assert.equal(isE2eRun(c), true, c);
  for (const c of [
    "npm test",
    'echo "run npm run e2e later"',
    "npm run e2e || true",
    "npm run e2e; exit 0",
    "npm run e2e 2>&1 | tail -20",
    "playwright install chromium",
  ])
    assert.equal(isE2eRun(c), false, c);
});

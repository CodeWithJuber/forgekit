import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pendingCorrections } from "../src/cortex.js";
import {
  appendSessionEvent,
  classifyEvent,
  clearSession,
  detectDoomLoop,
  detectEpisodes,
  doomLoopAdvisory,
  isE2eRun,
  processSession,
  readSession,
  sessionFile,
  sessionPath,
  summaryEvents,
} from "../src/cortex_hook.js";
import { mergedLessons as load } from "../src/ledger_read.js";
import { fakeGithubPat } from "./_fixtures.js";

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

test("an aliased checkout accepts either host spelling of a target, including a new nested file", () => {
  const outer = realpathSync.native(fixture());
  const project = join(outer, "project"),
    alias = join(outer, "directory-alias");
  mkdirSync(project);
  symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  execFileSync("git", ["init", "-q"], { cwd: project });
  mkdirSync(join(project, "pkg"));
  writeFileSync(join(project, "pkg", "a"), "exact bytes");
  const edit = (cwd, file_path) =>
    classifyEvent({ cwd, tool_name: "Edit", tool_input: { file_path } });
  const regular = edit(project, join(project, "pkg", "a"));
  assert.equal(regular.file, "pkg/a");
  assert.ok(regular.versions.length);
  for (const cwd of [project, alias, join(project, "pkg"), join(alias, "pkg")]) {
    assert.deepEqual(edit(cwd, join(alias, "pkg", "a")), regular);
    assert.deepEqual(edit(cwd, join(project, "pkg", "a")), regular);
  }
  assert.deepEqual(edit(join(alias, "pkg"), "new/missing.js"), {
    type: "edit",
    file: "pkg/new/missing.js",
  });
  symlinkSync(outer, join(project, "external"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(
    project,
    join(project, "nested-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const outside of [
    join(outer, "other"),
    join(alias, "external", "other"),
    join(alias, "nested-link", "pkg", "a"),
  ]) {
    assert.equal(edit(alias, outside), null);
  }
  assert.deepEqual(
    detectEpisodes([null, ...recovery(), null]).map((e) => e.kind),
    ["mistake"],
  );
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

test("only a successful revert with a matching reported Git object can contradict, on its real files", () => {
  const root = fixture();
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.org");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(root, ".gitattributes"), "real.js text eol=crlf\n");
  writeFileSync(join(root, "real.js"), "one\r\n");
  git("add", ".gitattributes", "real.js");
  git("commit", "-qm", "one");
  writeFileSync(join(root, "real.js"), "two\r\n");
  const performed = classifyEvent({
    tool_name: "Edit",
    cwd: root,
    tool_input: { file_path: "real.js" },
  });
  assert.equal(readFileSync(join(root, "real.js"), "utf8"), "two\r\n");
  git("commit", "-qam", "two");
  assert.equal(git("show", "HEAD:real.js"), "two\n");
  assert.ok(performed.versions.includes(git("rev-parse", "HEAD:real.js").trim()));
  const actual = [
    { type: "bash", command: "check observed", exitCode: 1 },
    performed,
    performed,
    { type: "bash", command: "check observed", exitCode: 0 },
  ];
  for (const sessionId of ["one", "two"]) {
    processSession(root, actual, 1, { sessionId });
    processSession(
      root,
      actual.map((e) =>
        e.file ? { ...e, versions: [] } : { ...e, command: "an unrelated check" },
      ),
      1,
      { sessionId },
    );
  }
  const run = {
    tool_name: "Bash",
    cwd: root,
    tool_input: { command: "git revert --no-edit HEAD" },
    exitCode: 0,
    tool_response: git("revert", "--no-edit", "HEAD"),
  };
  const events = [{ type: "edit", file: "irrelevant.js" }, classifyEvent(run)];
  assert.deepEqual(detectEpisodes(events)[0]?.context.files, ["real.js"]);
  const [result] = processSession(root, events, 2, { sessionId: "revert" });
  assert.equal(
    result.results.length,
    1,
    "only the lesson whose observed file version was undone is contradicted",
  );
  assert.equal(load(root, 2).filter((l) => l.status === "quarantined").length, 1);
  assert.equal(load(root, 2).filter((l) => l.status === "active").length, 1);
  for (const changed of [
    { exitCode: 1 },
    { tool_response: "" },
    { tool_response: "[main 0000000] Revert demo" },
  ]) {
    assert.equal(detectEpisodes([classifyEvent({ ...run, ...changed })]).length, 0);
  }
});

test("only Git-authorized text conversions contribute a normalized blob", () => {
  const root = fixture();
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "core.autocrlf", "true");
  const binary = Buffer.from([0x80, 0xff, 0x0d, 0x0a]);
  const file = join(root, "data.file");
  const normalized = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: root,
    input: Buffer.from([0x80, 0xff, 0x0a]),
  })
    .toString()
    .trim();
  const raw = execFileSync("git", ["hash-object", "--stdin"], { cwd: root, input: binary })
    .toString()
    .trim();
  writeFileSync(file, binary);
  const capture = () =>
    classifyEvent({ tool_name: "Edit", cwd: root, tool_input: { file_path: "data.file" } })
      .versions;
  for (const attrs of [
    "data.file -text",
    "data.file text ident",
    "data.file text filter=custom",
    "data.file text working-tree-encoding=UTF-16",
  ]) {
    writeFileSync(join(root, ".gitattributes"), `${attrs}\n`);
    const versions = capture();
    assert.ok(versions.includes(raw));
    assert.equal(versions.includes(normalized), false, attrs);
  }
  writeFileSync(join(root, ".gitattributes"), "");
  assert.ok(capture().includes(normalized), "built-in core.autocrlf preserves every other byte");
  git("config", "core.autocrlf", "false");
  assert.equal(
    capture().includes(normalized),
    false,
    "literal CRLF and LF are distinct when conversion is disabled",
  );
  writeFileSync(join(root, ".gitattributes"), "data.file text eol=lf\n");
  git("config", "core.safecrlf", "true");
  assert.equal(capture().includes(normalized), false, "Git would refuse this round trip");
});

const recovery = (command = "npm test") => [
  { type: "bash", command, exitCode: 1 },
  { type: "edit", file: "src/tax.ts" },
  { type: "edit", file: "src/tax.ts" },
  { type: "bash", command, exitCode: 0 },
];

test("same-command recovery proposes privately; only independent sessions or tool receipts promote", () => {
  const root = fixture(),
    session = recovery("make check");
  processSession(root, session, 1, { sessionId: "one" });
  assert.equal(pendingCorrections(root)[0].status, "candidate");
  assert.deepEqual(load(root), []);
  assert.equal(processSession(root, session, 2, { sessionId: "one" })[0].action, "duplicate");
  assert.deepEqual(load(root), []);
  assert.equal(processSession(root, session, 2, { sessionId: "two" })[0].status, "active");
  const ids = session.map((event, i) => ({ ...event, eventId: `native_${i}` }));
  assert.equal(processSession(root, ids, 2, { sessionId: "two" })[0].action, "confirmed");
  assert.equal(processSession(root, ids, 3, { sessionId: "different" })[0].action, "duplicate");
  assert.equal(load(root)[0].evidenceCount, 2);
});

test("attempts to join unrelated outcomes, repeated delivery of an edit, or prompt wording abstain", () => {
  const root = fixture(),
    events = recovery();
  const differentCommand = events.map((e, i) => (i === 3 ? { ...e, command: "pytest" } : e));
  assert.deepEqual(detectEpisodes(differentCommand), []);
  const namedEdits = events.map((e) =>
    e.type === "edit" ? { ...e, eventId: "same-native-edit" } : e,
  );
  assert.equal(processSession(root, namedEdits)[0].action, "abstained");
  const confused = [
    events[0],
    events[1],
    { type: "prompt", text: "undo and revert that" },
    events[3],
  ];
  assert.equal(processSession(root, confused)[0].action, "abstained");
  processSession(root, recovery("make lint"), 1, { sessionId: "A" });
  processSession(root, recovery("make unit"), 1, { sessionId: "B" });
  assert.equal(pendingCorrections(root).length, 2);
  assert.deepEqual(load(root), []);
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
  const raw = readFileSync(sessionFile(root, "s-b5"), "utf8");
  assert.equal(existsSync(sessionPath(root, "s-b5")), false);
  assert.equal(raw.includes(tok), false, "the token never reaches disk");
  assert.doesNotMatch(raw, /deploy with|GITHUB_TOKEN|please/, "prompt text stays off disk");
  // Redaction must not blind the signal detectors (verbs are never secrets).
  const events = readSession(root, "s-b5");
  assert.equal(events.length, 3);
  assert.equal(events[1].correctionEligible, false);
  assert.deepEqual(events[0], { type: "prompt" });
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
    // Redirections keep the suite's exit status; quoted arguments are data.
    "npm run e2e > e2e.log 2>&1",
    "npm run e2e &> e2e.log",
    'npx playwright test --grep "checkout|pay; now"',
    // A server backgrounded BEFORE the run: the run itself is still the last command.
    "npx next start -p 3100 & sleep 5 && npm run e2e",
  ])
    assert.equal(isE2eRun(c), true, c);
  for (const c of [
    "npm test",
    'echo "run npm run e2e later"',
    "npm run e2e || true",
    "npm run e2e; exit 0",
    "npm run e2e 2>&1 | tail -20",
    "playwright install chromium",
    // Review: each of these exits 0 whatever the suite did (the gate sees only that status).
    'npm run e2e; echo "exit=$?"',
    "npm run e2e || echo failed",
    "npm run e2e > out.log 2>&1; cat out.log",
    "cd web && npx playwright test; cd ..",
    "npm run e2e &",
    "npm run e2e & sleep 1",
    "npm run e2e && echo done",
    "npm run e2e\necho done",
    "(npm run e2e)",
    // The run may never have happened.
    "npm run build || npm run e2e",
    // Listing, help and empty runs execute no test.
    "npx playwright test --list",
    "npx playwright test --help",
    "npm run e2e -- --list",
    "npx playwright test --pass-with-no-tests",
  ])
    assert.equal(isE2eRun(c), false, c);
});

test("opt-in prompt history is private and can be joined only in the same checkout", (t) => {
  const old = process.env.FORGE_DEJA;
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_DEJA;
    else process.env.FORGE_DEJA = old;
  });
  process.env.FORGE_DEJA = "1";
  const root = fixture(),
    other = fixture();
  appendSessionEvent(root, "p", { type: "prompt", text: "Contract 58423 for Example Client" });
  const repoEvents = readSession(root, "p");
  assert.doesNotMatch(JSON.stringify(repoEvents), /58423|Example Client/);
  assert.match(JSON.stringify(summaryEvents(root, "p", repoEvents)), /58423/);
  assert.doesNotMatch(JSON.stringify(summaryEvents(other, "p", repoEvents)), /58423/);
  clearSession(root, "p");
  assert.doesNotMatch(JSON.stringify(summaryEvents(root, "p", repoEvents)), /58423/);
});

test("legacy checkout logs cannot promote corrections or enter new private captures", () => {
  const root = fixture();
  const old = sessionPath(root, "forged");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(
    old,
    recovery()
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  assert.deepEqual(readSession(root, "forged"), []);
  assert.deepEqual(
    processSession(root, readSession(root, "forged"), 1, { sessionId: "forged" }),
    [],
  );
  assert.deepEqual(pendingCorrections(root), []);
  assert.equal(existsSync(old), true);
});

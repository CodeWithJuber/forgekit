// Compare recognizable test cases and assertion strengths in complete file snapshots.
// This is a conservative review signal. A clear result only covers the patterns below.
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readWorkspaceText } from "./reuse_symbols.js";
import { redactSecrets } from "./secrets.js";
import { isTestFile } from "./substrate.js";

const PATH_BYTES = 512 * 1024;
const FILE_BYTES = 384 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const LIMIT = 120;
const TEST_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php)$/i;
const testPath = (file) =>
  TEST_EXT.test(file) &&
  (isTestFile(file) ||
    /\.(?:spec|test)\.[cm][jt]s$|(?:Test|Tests|Spec)\.(?:java|kt|cs|php)$|_spec\.rb$/i.test(file));

class ScanError extends Error {}

function git(root, args, input = undefined, maxBuffer = PATH_BYTES) {
  const value = spawnSync("git", ["-c", "core.fsmonitor=false", "--literal-pathspecs", ...args], {
    cwd: root,
    input,
    timeout: 8000,
    maxBuffer,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (value.status !== 0 || value.error || value.signal)
    throw new ScanError("Git could not inspect the requested test snapshots within its limits");
  return value.stdout;
}

function paths(bytes) {
  const names = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\0");
  return names.filter(Boolean);
}

function baseline(root, base) {
  if (typeof base !== "string" || !base || base.length > 256 || /[\p{Cc}\p{Cf}]/u.test(base))
    throw new ScanError("Invalid test comparison baseline");
  try {
    const id = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])
      .toString()
      .trim();
    if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(id)) throw new ScanError();
    return id;
  } catch {
    // Only a genuinely unborn HEAD uses an empty baseline. Invalid explicit refs
    // and a damaged current ref cannot establish a comparison.
    if (base === "HEAD") {
      const ref = git(root, ["symbolic-ref", "-q", "HEAD"]).toString().trim();
      if (
        ref.startsWith("refs/heads/") &&
        !git(root, ["for-each-ref", "--format=%(refname)", ref]).length
      )
        return null;
    }
    throw new ScanError("The requested Git baseline could not be resolved");
  }
}

function entries(root, args, indexed) {
  const rows = new Map();
  for (const raw of paths(git(root, args))) {
    const tab = raw.indexOf("\t");
    const path = raw.slice(tab + 1);
    const fields = raw.slice(0, tab).split(" ");
    if (tab < 0 || !/^100(?:644|755)$/.test(fields[0]) || (indexed && fields[2] !== "0")) {
      throw new ScanError("A test has an unresolved merge or unsupported Git file mode");
    }
    rows.set(path, fields[indexed ? 1 : 2]);
  }
  return rows;
}

function blobs(root, ids) {
  const contents = new Map();
  if (!ids.size) return contents;
  // One process bounds both the total bytes and startup overhead on Windows.
  const raw = git(root, ["cat-file", "--batch"], `${[...ids].join("\n")}\n`, TOTAL_BYTES);
  let offset = 0;
  for (const id of ids) {
    const end = raw.indexOf(10, offset);
    const [hash, type, size] = raw.toString("ascii", offset, end).split(" ");
    const length = Number(size);
    if (
      end < 0 ||
      hash !== id ||
      type !== "blob" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > FILE_BYTES ||
      raw[end + 1 + length] !== 10
    ) {
      throw new ScanError(
        "An original or staged test exceeded the scan limit or could not be read",
      );
    }
    contents.set(id, raw.toString("utf8", end + 1, end + 1 + length));
    offset = end + 2 + length;
  }
  return contents;
}

function readWorking(root, file) {
  try {
    lstatSync(join(root, file));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw new ScanError("A changed test could not be inspected");
  }
  const text = readWorkspaceText(root, file, FILE_BYTES);
  if (text === null) throw new ScanError("A working test is inaccessible, oversized or symlinked");
  return text;
}

const CASE_JS =
  /^(?:await\s+)?(?:test|it|specify|xit|xtest)(?:\.(?:skip|todo|only|concurrent|serial|failing))*\s*\(\s*(['"`])(.+?)\1/;
const CASE_FUNC =
  /^(?:(?:async\s+)?def\s+(test_\w+)|func\s+(Test\w+)|(?:public\s+)?function\s+(test\w+))\s*\(/;
const MARKED_FUNC =
  /^(?:(?:public|private|protected|static|async|final|override|virtual|fun|fn|void|Task)\s+)+(\w+)\s*\(/;
const SKIP =
  /^(?:(?:x(?:it|test|describe)|(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|todo|only))\s*\(|(?:return\s+)?(?:t\.skip|t\.Skipf?|(?:pytest\.)?skip|self\.skipTest|pytest\.xfail|pending)\s*\(|@(?:pytest\.mark\.(?:skip(?:if)?|xfail)|unittest\.skip\w*|Disabled|Ignore)\b|#\[ignore\b|\[(?:Ignore\b|Fact\(Skip\s*=))/i;
const ASSERT =
  /^(?:await\s+)?(?:return\s+)?(?:assert(?:\b|[A-Z])|self\.assert|expect\s*\(|(?:require|assert)\.\w+\(t,|(?:debug_)?assert(?:_eq|_ne)?!\s*\(|t\.(?:Errorf?|Fatalf?)\s*\()/;
const TAUTOLOGY =
  /^(?:(?:assert(?:\.ok|_true)?|self\.assertTrue|assertTrue)\s*\(\s*(?:true|True|1)\s*[,)]|assert\s+(?:True|true|1)(?:\s*(?:#|$|,))|expect\(\s*(?:true|1)\s*\)\.toBeTruthy\(\)|assert(?:\.(?:deepStrictEqual|strictEqual|equal)|_eq!)\(\s*([\w$.]+)\s*,\s*\1\s*[,)]|expect\(\s*([\w$.]+)\s*\)\.to(?:Be|Equal)\(\s*\2\s*\))/;
const WEAK =
  /\.to(?:BeDefined|BeTruthy|BeFalsy|BeNull|BeUndefined)\s*\(|^(?:assert(?:\.ok)?\(\s*[\w$.]+\s*[,)]|(?:self\.assert(?:IsNotNone|True)|assertNotNull|assertTrue)\s*\(|assert\s+[\w.]+(?:\s+is not None)?\s*$)/;
function bodyLine(line) {
  return line
    .trim()
    .replace(
      /^(?:(?:async\s+)?def|func|fn|function|(?:public|private|protected|static|final|async|override|virtual|void|fun|Task)(?:\s+(?:public|private|protected|static|final|async|override|virtual|void|fun|Task))*)\s+[\w$]+(?=\s*\()/,
      "function",
    );
}

function inspect(file, text) {
  if (text.includes("\0")) throw new ScanError("A binary test cannot be inspected");
  const cases = [];
  const skips = [];
  const start = (name, line) => {
    const item = { file, name, line, strong: 0, weak: 0, trivial: 0, body: "", assertions: 0 };
    cases.push(item);
    return item;
  };
  let active = start("", 1);
  let decorated = false;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const s = raw.trim();
    if (!s || s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) continue;
    if (s.length > 24000) throw new ScanError("A test line exceeds the scan limit");
    const js = CASE_JS.exec(s);
    const named = CASE_FUNC.exec(s);
    const annotated = decorated && MARKED_FUNC.exec(s);
    const name = js?.[2] ?? named?.slice(1).find(Boolean) ?? annotated?.[1];
    if (name) {
      active = start(name, i + 1);
      decorated = false;
    }
    if (/^(@Test\b|#\[test\]|\[(?:Fact|Theory|Test)\b)/.test(s)) decorated = true;
    if (
      SKIP.test(s) ||
      (/^(?:it|test)\s*\(/.test(s) && /\b(?:skip|todo)\s*:\s*(?!false\b)[^\s,}]/.test(s)) ||
      /^(?:skip|todo)\s*:\s*(?!false\b)[^\s,}]/.test(s)
    ) {
      skips.push({ file, line: i + 1, signature: s.replace(/\s+/g, " ").slice(0, 500) });
    }
    // Match an assertion only at a statement boundary. An example embedded in a
    // quoted fixture string, comment, or snapshot should not count as a check.
    const stmt = js ? s.slice(js[0].length).replace(/^.*?=>\s*\{?\s*/, "") : s;
    active.body += `${name && !js ? bodyLine(s) : stmt}\n`;
    if (!ASSERT.test(stmt)) continue;
    active.assertions++;
    if (TAUTOLOGY.test(stmt)) active.trivial++;
    else if (WEAK.test(stmt)) active.weak++;
    else active.strong++;
  }
  return { cases: cases.filter((c) => c.name || c.assertions), skips };
}

const count = (c) => c.strong + c.weak + c.trivial;
function compare(before, after, report) {
  const oldSkips = new Map();
  for (const file of before.files.keys()) {
    if (
      !after.files.has(file) &&
      !before.cases.some((c) => c.file === file) &&
      ![...after.files.values()].includes(before.files.get(file))
    ) {
      report(
        { file, line: 1 },
        "An entire test file was removed without a byte-identical replacement; inspect its replacement coverage",
      );
    }
  }
  for (const x of before.skips) oldSkips.set(x.signature, 1 + (oldSkips.get(x.signature) ?? 0));
  for (const x of after.skips) {
    const n = oldSkips.get(x.signature) ?? 0;
    if (n) oldSkips.set(x.signature, n - 1);
    else report(x, "A skip, expected failure or exclusive-test marker was added or changed");
  }
  // Pair same names within the file first, then across files for moved cases.
  const next = new Set(after.cases);
  const old = new Set(before.cases);
  const equalShape = (a, b) =>
    a.strong === b.strong && a.weak === b.weak && a.trivial === b.trivial;
  for (const pass of [
    (a, b) => a.file === b.file && a.name === b.name,
    (a, b) => a.name && a.name === b.name && equalShape(a, b),
    (a, b) => a.name && a.name === b.name,
    (a, b) => a.name && b.name && a.body === b.body,
  ]) {
    for (const a of old) {
      const b = Array.from(next).find((b) => pass(a, b));
      if (!b) continue;
      next.delete(b);
      old.delete(a);
      if (b.trivial > a.trivial)
        report(b, "An assertion became unconditionally true or compares a value with itself");
      if (b.strong < a.strong && b.weak > a.weak)
        report(
          b,
          "A stronger assertion appears to have been replaced by a presence or truthiness check",
        );
      else if (count(b) < count(a))
        report(b, "A test now has fewer recognizable assertions; inspect its coverage");
    }
  }
  for (const a of old) {
    report(
      a,
      a.name
        ? "A test case was removed or renamed; check that its behavior remains covered"
        : "Assertions outside named cases were removed; inspect their replacement",
    );
  }
  for (const b of next)
    if (b.trivial)
      report(
        b,
        "A new test contains an assertion that is always true or compares a value with itself",
      );
}

function indexCases(items) {
  const out = { cases: [], skips: [], files: items };
  for (const [file, text] of items) {
    const result = inspect(file, text);
    out.cases.push(...result.cases);
    out.skips.push(...result.skips);
    if (out.cases.length > 2000 || out.skips.length > 2000)
      throw new ScanError("Too many changed test cases to compare within the scan limit");
  }
  return out;
}

/** Compare the requested baseline to both the proposed index and current worktree.
 * @param {string} root @param {string} base */
export function assessTestIntegrity(root, base = "HEAD") {
  const findings = [];
  try {
    root = realpathSync(root);
    const commit = baseline(root, base);
    const staged = paths(
      git(root, [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "--relative",
        "-z",
        ...(commit ? [commit] : []),
        "--",
        ".",
      ]),
    );
    const unstaged = paths(
      git(root, ["ls-files", "--modified", "--others", "--exclude-standard", "-z", "--", "."]),
    );
    const tests = [...new Set([...staged, ...unstaged].filter(testPath))];
    if (tests.length > LIMIT)
      throw new ScanError("Too many changed test files to compare within the scan limit");
    if (tests.some((f) => /[\p{Cc}\p{Cf}]/u.test(f)))
      throw new ScanError("A test filename contains control characters");
    if (!tests.length)
      return {
        status: "clear",
        reason: "No changed test files were identified",
        findings,
        scannedFiles: 0,
        baseline: commit,
      };
    const originals = commit
      ? entries(root, ["ls-tree", "-z", commit, "--", ...tests], false)
      : new Map();
    const stagedFiles = entries(root, ["ls-files", "--stage", "-z", "--", ...tests], true);
    const data = blobs(root, new Set([...originals.values(), ...stagedFiles.values()]));
    const decode = (items) => new Map([...items].map(([file, id]) => [file, data.get(id)]));
    const old = indexCases(decode(originals));
    const working = new Map();
    let bytes = 0;
    for (const file of tests) {
      const text = readWorking(root, file);
      if (text === null) continue;
      bytes += Buffer.byteLength(text);
      if (bytes > TOTAL_BYTES) throw new ScanError("Working tests exceed the total scan limit");
      working.set(file, text);
    }
    const reported = new Set();
    const record = (snapshot) => (item, reason) => {
      const key = JSON.stringify([item.file, item.line, reason]);
      if (reported.has(key)) return;
      reported.add(key);
      if (findings.length < 30)
        findings.push({ file: redactSecrets(item.file), line: item.line, reason, snapshot });
    };
    compare(old, indexCases(working), record("worktree"));
    if (staged.some(testPath)) compare(old, indexCases(decode(stagedFiles)), record("index"));
    return {
      status: findings.length ? "suspect" : "clear",
      reason: findings.length
        ? "Changed test coverage requires independent review"
        : "No recognized test weakening found in the compared snapshots",
      findings,
      findingCount: reported.size,
      scannedFiles: tests.length,
      baseline: commit,
    };
  } catch (err) {
    const reason =
      err instanceof ScanError && err.message
        ? err.message
        : "The test comparison could not be completed";
    return { status: "unavailable", reason, findings };
  }
}

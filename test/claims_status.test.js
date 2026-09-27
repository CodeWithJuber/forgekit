// The claim/status registry (docs/status/claims.json) and its generator/checker
// (scripts/claims-status.mjs): validation rules, table rendering, --check drift detection on a
// throwaway checkout, and the repository's own registry staying valid and in sync.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  BEGIN,
  cell,
  checkCopies,
  compareVersions,
  END,
  README_PATH,
  REGISTRY_PATH,
  releaseProblems,
  renderTable,
  run,
  STATUSES,
  spliceReadme,
  stampRelease,
  validateRegistry,
} from "../scripts/claims-status.mjs";

const SHA = "d2abfa69fb77531199ffc67c5c076b524af69040";

/** A minimal valid claim; override any field. */
const claim = (over = {}) => ({
  id: "example-claim",
  claim: "The example does what it says.",
  component: "example component",
  version: "1.0.0",
  source_commit: SHA,
  assessed_release: "1.4.3",
  status: "measured",
  evidence: ["evidence/result.md"],
  notes: "",
  ...over,
});

/** Run the CLI against `root`, capturing its output instead of printing it. */
function cli(argv, root, pairs) {
  const out = [];
  const err = [];
  const code = run(argv, {
    root,
    pairs,
    log: (s) => out.push(s),
    error: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A throwaway checkout with a registry, a README carrying the markers, and one docs copy. */
function fixture(claims = [claim()]) {
  const root = mkdtempSync(join(tmpdir(), "forge-claims-"));
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write("evidence/result.md", "# result\n");
  write(REGISTRY_PATH, `${JSON.stringify({ as_of: "2026-09-26", claims }, null, 2)}\n`);
  write(README_PATH, `# Claim status\n\n${BEGIN}\n${END}\n`);
  write("research/paper.html", "<p>canonical</p>\n");
  write("docs/paper.html", "<p>canonical</p>\n");
  const pairs = [["docs/paper.html", "research/paper.html"]];
  return { root, write, pairs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a valid registry has no problems", () => {
  assert.deepEqual(validateRegistry({ claims: [claim()] }), []);
  for (const status of STATUSES) {
    assert.deepEqual(validateRegistry({ claims: [claim({ status })] }), [], status);
  }
});

test("validation rejects a missing field, an unknown status and a duplicate id", () => {
  const { notes: _drop, ...noNotes } = claim();
  const problems = validateRegistry({
    claims: [noNotes, claim({ id: "b", status: "proven" }), claim({ id: "b" })],
  });
  assert.ok(
    problems.some((p) => /missing required field "notes"/.test(p)),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => /status "proven" is not one of/.test(p)),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((p) => /duplicate id "b"/.test(p)),
    problems.join("\n"),
  );
});

test("validation rejects bad commits, empty evidence, malformed ids and empty registries", () => {
  const problems = validateRegistry({
    claims: [
      claim({ id: "x", source_commit: "HEAD" }),
      claim({ id: "y", evidence: [] }),
      claim({ id: "Bad Id" }),
      claim({ id: "z", claim: "  " }),
    ],
  });
  assert.ok(problems.some((p) => /source_commit must be 7-40/.test(p)));
  assert.ok(problems.some((p) => /evidence must be a non-empty array/.test(p)));
  assert.ok(problems.some((p) => /id must match/.test(p)));
  assert.ok(problems.some((p) => /"claim" must be a non-empty string/.test(p)));
  assert.deepEqual(validateRegistry({ claims: [] }), ["registry.claims must be a non-empty array"]);
  assert.deepEqual(validateRegistry([]), ["registry must be a JSON object with a `claims` array"]);
});

test("with a root, a missing evidence path is a problem and a URL is not checked", () => {
  const f = fixture();
  try {
    const reg = {
      claims: [
        claim({ evidence: ["evidence/result.md#section", "https://example.org/paper"] }),
        claim({ id: "gone", evidence: ["evidence/missing.md"] }),
      ],
    };
    const problems = validateRegistry(reg, { root: f.root });
    assert.deepEqual(problems, ["claims[1] (gone): evidence path not found: evidence/missing.md"]);
  } finally {
    f.cleanup();
  }
});

test("the rendered table escapes pipes, links evidence and counts statuses", () => {
  const out = renderTable({
    as_of: "2026-09-26",
    claims: [
      claim({ claim: "a | b", evidence: ["evidence/result.md", "https://example.org/x/"] }),
      claim({ id: "second", status: "refuted" }),
    ],
  });
  assert.match(out, /^2 claims — implemented 0 · measured 1 · .*refuted 1\./);
  assert.match(out, /Assessed against commit `d2abfa69fb77` \(as of 2026-09-26\)/);
  assert.match(out, /a \\\| b/);
  assert.match(out, /\[`evidence\/result\.md`\]\(\.\.\/\.\.\/evidence\/result\.md\)/);
  assert.match(out, /\[example\.org\/x\]\(https:\/\/example\.org\/x\/\)/);
  assert.throws(() => spliceReadme("no markers here", out), /must contain the markers/);
});

test("--check passes when current, and fails on a stale table without rewriting it", () => {
  const f = fixture();
  try {
    assert.equal(cli(["--check"], f.root, f.pairs).code, 1, "a fresh README has no table yet");
    const first = cli([], f.root, f.pairs);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /rewrote the generated table/);
    assert.equal(cli(["--check"], f.root, f.pairs).code, 0);

    // Change a status in the registry: the table on disk is now stale.
    const reg = JSON.parse(readFileSync(join(f.root, REGISTRY_PATH), "utf8"));
    reg.claims[0].status = "refuted";
    f.write(REGISTRY_PATH, JSON.stringify(reg));
    const before = readFileSync(join(f.root, README_PATH), "utf8");
    const stale = cli(["--check"], f.root, f.pairs);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /is stale/);
    assert.equal(readFileSync(join(f.root, README_PATH), "utf8"), before, "--check never writes");

    assert.equal(cli([], f.root, f.pairs).code, 0);
    assert.equal(cli(["--check"], f.root, f.pairs).code, 0);
  } finally {
    f.cleanup();
  }
});

test("--check fails on an invalid registry and on a drifted docs copy; --sync-copies repairs it", () => {
  const f = fixture();
  try {
    assert.equal(cli([], f.root, f.pairs).code, 0);
    f.write("docs/paper.html", "<p>edited in the wrong place</p>\n");
    assert.deepEqual(
      checkCopies(f.root, f.pairs).map((r) => r.reason),
      ["sha256 differs"],
    );
    const drift = cli(["--check"], f.root, f.pairs);
    assert.equal(drift.code, 1);
    assert.match(drift.err, /copy drift: docs\/paper\.html vs research\/paper\.html/);

    const synced = cli(["--sync-copies"], f.root, f.pairs);
    assert.equal(synced.code, 0, synced.err);
    assert.equal(readFileSync(join(f.root, "docs/paper.html"), "utf8"), "<p>canonical</p>\n");
    assert.equal(cli(["--check"], f.root, f.pairs).code, 0);

    f.write(REGISTRY_PATH, JSON.stringify({ claims: [claim({ status: "vibes" })] }));
    const invalid = cli(["--check"], f.root, f.pairs);
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /status "vibes"/);
    assert.equal(cli(["--nope"], f.root, f.pairs).code, 2);
  } finally {
    f.cleanup();
  }
});

test("--check reads a CRLF checkout (Windows core.autocrlf) as current", () => {
  const f = fixture();
  try {
    assert.equal(cli([], f.root, f.pairs).code, 0);
    const lf = readFileSync(join(f.root, README_PATH), "utf8");
    f.write(README_PATH, lf.replace(/\n/g, "\r\n"));
    const r = cli(["--check"], f.root, f.pairs);
    assert.equal(r.code, 0, r.err);
  } finally {
    f.cleanup();
  }
});

test("the repository's own registry is valid, its table current, and its docs copies identical", () => {
  const r = cli(["--check"]);
  assert.equal(r.code, 0, r.err);
});

test("table cells escape backslashes before pipes (a trailing backslash cannot undo an escape)", () => {
  assert.equal(cell("a|b"), "a\\|b");
  assert.equal(cell("a\\|b"), "a\\\\\\|b");
  assert.equal(cell("ends with \\"), "ends with \\\\");
  assert.equal(cell("two\nlines"), "two lines");
});

// Review 2026-09-27, suggestion 5: the registry is a release artifact.
test("assessed_release is a release or 'unreleased'; counterexamples are well-formed links", () => {
  const ok = { claims: [claim({ assessed_release: "unreleased" })] };
  assert.deepEqual(validateRegistry(ok), []);
  const problems = validateRegistry({
    claims: [
      claim({ id: "a", assessed_release: "master after 1.4.3 (unreleased)" }),
      claim({
        id: "b",
        counterexamples: [{ review: "2026-09-27", id: "N01", resolution: "maybe" }],
      }),
      claim({ id: "c", counterexamples: "N01" }),
    ],
  });
  assert.ok(problems.some((p) => /\(a\): assessed_release must be a release version/.test(p)));
  assert.ok(problems.some((p) => /\(b\): counterexamples must be/.test(p)));
  assert.ok(problems.some((p) => /\(c\): counterexamples must be/.test(p)));
  const linked = claim({
    counterexamples: [{ review: "2026-09-27", id: "N01", resolution: "fixed" }],
  });
  assert.deepEqual(validateRegistry({ claims: [linked] }), []);
  assert.match(renderTable({ claims: [linked] }), /Review counterexamples: 2026-09-27 N01 fixed\./);
  assert.match(renderTable({ claims: [linked] }), /\| 1\.4\.3 · `d2abfa69` \|/);
});

test("with release tags, a stale 'unreleased' and a release that lacks the commit are problems", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-claims-git-"));
  try {
    const g = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    g("init");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("commit", "--allow-empty", "-m", "one");
    const one = g("rev-parse", "HEAD");
    const base = { claims: [claim({ source_commit: one, assessed_release: "unreleased" })] };
    assert.equal(releaseProblems(root, base), null, "no tags: the check cannot run");
    g("tag", "v1.0.0");
    g("commit", "--allow-empty", "-m", "two");
    const two = g("rev-parse", "HEAD");
    const problems = releaseProblems(root, {
      claims: [
        claim({ id: "stale", source_commit: one, assessed_release: "unreleased" }),
        claim({ id: "fresh", source_commit: two, assessed_release: "unreleased" }),
        claim({ id: "shipped", source_commit: one, assessed_release: "1.0.0" }),
        claim({ id: "too-early", source_commit: two, assessed_release: "1.0.0" }),
        claim({ id: "no-tag", source_commit: one, assessed_release: "9.9.9" }),
      ],
    });
    assert.deepEqual(
      problems.map((p) => p.split(":")[0]),
      ["stale", "too-early", "no-tag"],
    );
    assert.match(problems[0], /shipped in v1\.0\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout with only older release tags leaves newer releases unchecked, not failing", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-claims-partial-"));
  try {
    const g = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    g("init");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("commit", "--allow-empty", "-m", "one");
    const one = g("rev-parse", "HEAD");
    g("tag", "v1.0.0");
    // the code is 1.2.0, but this clone never fetched v1.1.0 or v1.2.0
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.0" }));
    const unchecked = [];
    const problems = releaseProblems(
      root,
      {
        claims: [
          claim({ id: "fetched", source_commit: one, assessed_release: "1.0.0" }),
          claim({ id: "not-fetched", source_commit: one, assessed_release: "1.2.0" }),
          claim({ id: "future", source_commit: one, assessed_release: "1.3.0" }),
          claim({ id: "never-tagged", source_commit: one, assessed_release: "0.9.0" }),
        ],
      },
      { unchecked },
    );
    assert.deepEqual(
      problems.map((p) => p.split(":")[0]),
      ["future", "never-tagged"],
      "a release newer than the code, or older than a tag present, is still a problem",
    );
    assert.deepEqual(unchecked, ["not-fetched (1.2.0)"]);
    assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
    assert.equal(compareVersions("1.7.3", "1.7.3"), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stampRelease rewrites only unreleased assessments, keeping the file's layout", () => {
  const text =
    '{\n  "a": { "assessed_release": "unreleased" },\n  "b": { "assessed_release": "1.2.3" }\n}\n';
  assert.equal(
    stampRelease(text, "1.3.0"),
    '{\n  "a": { "assessed_release": "1.3.0" },\n  "b": { "assessed_release": "1.2.3" }\n}\n',
  );
});

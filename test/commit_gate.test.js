import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commitGate,
  commitGateDecision,
  gateMode,
  renderCommitGate,
  stagedAddedLines,
  stagedBinaryFiles,
  stagedFiles,
} from "../src/commit_gate.js";
import { fakeGithubPat } from "./_fixtures.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-precommit-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "forge@test.invalid");
  git("config", "user.name", "forge-test");
  writeFileSync(join(root, "a.js"), "export const one = 1;\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git };
}

// A clean env for every gate call: the host shell (or CI) may export
// FORGE_COMMIT_GATE and the tests must not inherit it.
const env = (extra = {}) => {
  const e = { ...process.env, ...extra };
  if (!("FORGE_COMMIT_GATE" in extra)) delete e.FORGE_COMMIT_GATE;
  return e;
};

const cli = (root, extraEnv = {}) =>
  spawnSync("node", [CLI, "precommit"], {
    cwd: root,
    encoding: "utf8",
    env: env(extraEnv),
  });

test("warn (default): staged code without docs is a finding but the commit is allowed", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 2;\n");
  git("add", "a.js");
  const r = commitGate(root, { env: env() });
  assert.equal(r.mode, "warn");
  assert.equal(r.allow, true);
  assert.equal(r.row, "warned");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "completeness");
  assert.match(r.findings[0].detail, /a\.js/);
  assert.match(renderCommitGate(r), /docs sync/, "the finding carries the repair procedure");
  const run = cli(root);
  assert.equal(run.status, 0, "warn mode never refuses the commit");
  assert.match(run.stdout, /completeness/);
});

test("code + doc staged together passes clean", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 3;\n");
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented the change\n");
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true);
  assert.equal(r.row, "clean");
  assert.equal(r.findings.length, 0);
});

test("FORGE_COMMIT_GATE=block refuses staged code without docs (exit 1 via CLI)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 4;\n");
  git("add", "a.js");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(r.allow, false);
  assert.equal(r.row, "blocked");
  const run = cli(root, { FORGE_COMMIT_GATE: "block" });
  assert.equal(run.status, 1, "block mode refuses via exit code");
  assert.match(run.stdout, /commit refused/);
});

test("a staged secret blocks even in warn mode (gitleaks fallback)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "config.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "config.js");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, false, "warn mode still refuses a credential");
  const secret = r.findings.find((f) => f.kind === "secret");
  assert.ok(secret, "a secret finding is reported");
  assert.match(secret.detail, /config\.js/);
  const run = cli(root);
  assert.equal(run.status, 1);
});

test("removed lines never trigger the secret scan (added lines only)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "cfg.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "cfg.js");
  git("-c", "commit.gpgsign=false", "commit", "-qm", "leak (historical)");
  writeFileSync(join(root, "cfg.js"), "export const token = process.env.TOKEN;\n");
  writeFileSync(join(root, "README.md"), "# app\n\ntoken now comes from the env\n");
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true, "deleting the secret must not be refused as adding one");
  assert.equal(r.findings.length, 0);
});

test("kill switch FORGE_COMMIT_GATE=0 disables everything — even the secret scan", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "config.js"), `export const token = "${fakeGithubPat()}";\n`);
  git("add", "config.js");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "0" }) });
  assert.equal(r.allow, true);
  assert.equal(r.row, "kill-switch");
  assert.equal(cli(root, { FORGE_COMMIT_GATE: "0" }).status, 0);
});

test("nothing staged, non-repo, and unreadable roots all fail open", () => {
  const { root } = gitFixture();
  const clean = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(clean.allow, true);
  assert.equal(clean.row, "nothing-staged");
  const bare = mkdtempSync(join(tmpdir(), "forge-precommit-"));
  const notRepo = commitGate(bare, {
    env: env({ FORGE_COMMIT_GATE: "block" }),
  });
  assert.equal(notRepo.allow, true);
  assert.equal(notRepo.row, "not-a-repo");
  const gone = commitGate(join(bare, "does-not-exist"), {
    env: env({ FORGE_COMMIT_GATE: "block" }),
  });
  assert.equal(gone.allow, true, "an unusable root can never brick a commit");
});

test("test-only and docs-only commits pass (same class semantics as the Stop gate)", () => {
  const { root, git } = gitFixture();
  writeFileSync(
    join(root, "a.test.js"),
    "import { test } from 'node:test';\ntest('x', () => {});\n",
  );
  git("add", "a.test.js");
  assert.equal(commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) }).allow, true);
  writeFileSync(join(root, "NOTES.md"), "# notes\n");
  git("add", "NOTES.md");
  assert.equal(commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) }).allow, true);
});

test("unicode/space doc paths keep their doc credit (-z parsing)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 5;\n");
  writeFileSync(join(root, "Änderungen notes.md"), "# änderungen\n\ndokumentiert\n");
  git("add", "-A");
  const staged = stagedFiles(root);
  assert.ok(staged.includes("Änderungen notes.md"), "the exact unicode path survives -z");
  const r = commitGate(root, { env: env({ FORGE_COMMIT_GATE: "block" }) });
  assert.equal(r.allow, true, "the unicode-named doc satisfies the gate");
});

test("stagedAddedLines maps added lines to their file, unified=0", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "a.js"), "export const one = 1;\nexport const two = 2;\n");
  git("add", "a.js");
  const byFile = stagedAddedLines(root);
  assert.deepEqual(byFile.get("a.js"), ["export const two = 2;"]);
});

test("gateMode is total: unrecognized values degrade to warn, never crash or block", () => {
  assert.equal(gateMode(undefined), "warn");
  assert.equal(gateMode("banana"), "warn");
  assert.equal(gateMode("block"), "block");
  assert.equal(gateMode("0"), "off");
  assert.equal(gateMode("off"), "off");
});

test("pure decision table: vendor-free classes, block only on the stated rows", () => {
  const warn = commitGateDecision({ staged: ["src/x.js"], mode: "warn" });
  assert.equal(warn.allow, true);
  assert.equal(warn.findings[0].kind, "completeness");
  const block = commitGateDecision({ staged: ["src/x.js"], mode: "block" });
  assert.equal(block.allow, false);
  const withDocs = commitGateDecision({
    staged: ["src/x.js", "docs/x.md"],
    mode: "block",
  });
  assert.equal(withDocs.allow, true);
  const secret = commitGateDecision({
    staged: ["src/x.js", "docs/x.md"],
    secretFiles: ["src/x.js"],
    mode: "warn",
  });
  assert.equal(secret.allow, false, "a secret blocks regardless of docs credit and mode");
  const off = commitGateDecision({
    staged: ["src/x.js"],
    secretFiles: ["src/x.js"],
    mode: "off",
  });
  assert.equal(off.allow, true);
});

// ── B3: the secret scan must fail CLOSED. It used to read `git diff --cached` with
// execFileSync's default 1 MiB buffer (overflow → "" → "nothing to scan") and through the
// repo's own diff rendering (a `-diff` attribute or a textconv driver hid added lines).
const leak = () => `export const t = "${fakeGithubPat()}";\n`;

test("a staged secret still blocks when another staged file makes the diff > 1 MiB (B3)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "cfg.js"), leak());
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n");
  let big = "";
  for (let i = 0; i < 40000; i++) big += `row ${i} lorem ipsum dolor sit amet\n`;
  writeFileSync(join(root, "data.txt"), big); // ~1.5 MB of added lines
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, false, "the leak must not hide behind a big file");
  assert.ok(r.findings.some((f) => f.kind === "secret" && f.files.includes("cfg.js")));
  assert.equal(cli(root).status, 1);
});

test("a repo's .gitattributes / textconv cannot hide staged secret lines (B3)", () => {
  for (const [attrs, cfg] of [
    ["*.js -diff\n", null],
    ["*.js binary\n", null],
    ["*.js diff=hide\n", ["diff.hide.textconv", "sed d"]],
  ]) {
    const { root, git } = gitFixture();
    writeFileSync(join(root, ".gitattributes"), attrs);
    if (cfg) git("config", ...cfg);
    writeFileSync(join(root, "cfg.js"), leak());
    writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n");
    git("add", "-A");
    const r = commitGate(root, { env: env() });
    assert.equal(r.allow, false, `hidden by ${attrs.trim()}`);
    assert.ok(r.findings.some((f) => f.kind === "secret" && f.files.includes("cfg.js")));
  }
});

test("a staged file git cannot diff is refused as unscanned, never passed (B3 fail-closed)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "cfg.js"), leak());
  writeFileSync(join(root, "README.md"), "# app\n\ndocumented\n");
  git("add", "-A");
  // Corrupt the object store under the staged blob: every diff of it now errors. The
  // worktree copy goes too — with it in place and its stat matching the index, git can
  // answer `diff --cached` from the file and never touch the missing object (it does on
  // the Linux/macOS runners: status 0, empty stderr, a full diff), which would make this
  // test pass for the wrong reason on one platform and fail on another.
  const sha = String(git("ls-files", "-s", "cfg.js")).split(/\s+/)[1];
  rmSync(join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2)), { force: true });
  rmSync(join(root, "cfg.js"), { force: true });
  const r = commitGate(root, { env: env() });
  // Diagnostics in the message: which git behaviour this platform actually shows, so a
  // failure here says WHY (git's status/stderr for the corrupted blob) instead of "false".
  const probe = spawnSync(
    "git",
    ["diff", "--cached", "--unified=0", "--no-color", "--text", "--no-ext-diff", "--no-textconv"],
    { cwd: root, encoding: "utf8" },
  );
  const why = `git status=${probe.status} stderr=${JSON.stringify(String(probe.stderr).slice(0, 200))} stdoutLen=${String(probe.stdout).length} findings=${JSON.stringify(r.findings)}`;
  assert.equal(r.allow, false, `an unreadable diff is not a clean diff — ${why}`);
  const f = r.findings.find((x) => x.kind === "secret-scan");
  assert.ok(f, `reported as an unscanned file — ${why}`);
  assert.deepEqual(f.files, ["cfg.js"], "only the unreadable file is unscanned");
  assert.match(renderCommitGate(r), /could not read the staged lines of: cfg\.js/);
  assert.equal(cli(root).status, 1);
  const pure = commitGateDecision({ staged: ["x.md"], unscanned: ["x.md"], mode: "warn" });
  assert.equal(pure.allow, false, "the pure table refuses unscanned files in every mode");
});

// ── B4 at the gate: the real left-pad@1.3.0 package-lock line was refused as a secret.
test("a lockfile integrity line passes the commit gate (B4)", () => {
  const { root, git } = gitFixture();
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        packages: {
          "node_modules/left-pad": {
            version: "1.3.0",
            resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            integrity:
              "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  git("add", "-A");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true, renderCommitGate(r));
  assert.equal(r.findings.filter((f) => f.kind.startsWith("secret")).length, 0);
});

// ── Binary files: the staged scan reads every file with `--text`, and the entropy leg
// flagged the XMP packet id that every PDF/JPEG/PNG with XMP metadata carries, so ordinary
// binary commits were refused. Binary files now get the format grammars only.
const XMP_ID = "W5M0MpCehiHzreSzNTczkc9d";
/** A small PDF-shaped binary: an XMP packet plus a compressed stream holding NUL bytes. */
const binaryPdf = (extra = "") => {
  const xmp = `<?xpacket begin="﻿" id="${XMP_ID}"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>\n<?xpacket end="w"?>`;
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< /Type /Metadata /Subtype /XML >>\nstream\n${xmp}\nendstream\nendobj\n2 0 obj\n<< /Length 8 /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    Buffer.from([0x78, 0x9c, 0x00, 0x01, 0xff, 0x00, 0x10, 0x0a]),
    Buffer.from(`${extra}\nendstream\nendobj\n%%EOF\n`, "latin1"),
  ]);
};

test("a staged XMP-bearing binary PDF is allowed (git reports it binary)", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "report.pdf"), binaryPdf());
  git("add", "report.pdf");
  assert.ok(stagedBinaryFiles(root).has("report.pdf"), "git's numstat marks the PDF binary");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true, renderCommitGate(r));
  assert.equal(r.findings.filter((f) => f.kind.startsWith("secret")).length, 0);
  assert.equal(cli(root).status, 0);
});

test("a binary file holding a credential format is still refused", () => {
  const { root, git } = gitFixture();
  writeFileSync(join(root, "leak.pdf"), binaryPdf(`/Token (${fakeGithubPat()})`));
  git("add", "leak.pdf");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, false, "format grammars still apply to binary content");
  assert.ok(r.findings.some((f) => f.kind === "secret" && f.files.includes("leak.pdf")));
  assert.equal(cli(root).status, 1);
});

test("binary scope: the entropy leg is skipped for binaries, kept for text files", () => {
  const unknown = ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");
  // A random-looking run inside binary bytes is not refused (it is what compression looks
  // like); the same run in a text file is.
  const bin = gitFixture();
  writeFileSync(join(bin.root, "blob.pdf"), binaryPdf(unknown));
  bin.git("add", "blob.pdf");
  assert.equal(commitGate(bin.root, { env: env() }).allow, true);
  const txt = gitFixture();
  writeFileSync(join(txt.root, "cfg.txt"), `key ${unknown}\n`);
  txt.git("add", "cfg.txt");
  assert.equal(commitGate(txt.root, { env: env() }).allow, false);
});

test("a `binary` attribute on a text file does not switch the entropy leg off", () => {
  const unknown = ["Zq7Rt2", "Xk9Lp4", "Vm1Nc8", "Yb5Ws3", "Hd6Fg0"].join("");
  const { root, git } = gitFixture();
  writeFileSync(join(root, ".gitattributes"), "*.txt binary\n");
  writeFileSync(join(root, "cfg.txt"), `key ${unknown}\n`);
  git("add", "-A");
  assert.ok(stagedBinaryFiles(root).has("cfg.txt"), "git reports it binary by attribute");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, false, "no NUL byte, so it is scanned as text");
  assert.ok(r.findings.some((f) => f.kind === "secret" && f.files.includes("cfg.txt")));
});

test("an XMP packet in a text sidecar passes too (public constant)", () => {
  const { root, git } = gitFixture();
  writeFileSync(
    join(root, "photo.xmp"),
    `<?xpacket begin="" id="${XMP_ID}"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"/>\n<?xpacket end="w"?>\n`,
  );
  git("add", "photo.xmp");
  const r = commitGate(root, { env: env() });
  assert.equal(r.allow, true, renderCommitGate(r));
});

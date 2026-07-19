// CLI-level init contract (RA-04, RA-11, RA-13, RA-17, RA-18): exit codes, stderr
// routing, and the install.sh wording that the docs/help print. The settings target is
// injected via FORGE_SETTINGS_PATH (test-only plumbing read by the init block) so no
// test ever touches the real ~/.claude/settings.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const runCli = (args, { cwd, settingsPath } = {}) =>
  spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_NO_HINT: "1",
      ...(settingsPath ? { FORGE_SETTINGS_PATH: settingsPath } : {}),
    },
  });

test("init --settings-only against a corrupt settings file exits 1 with the reason on stderr", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-cli-corrupt-"));
  const settingsPath = join(tmp, "settings.json");
  const garbage = "{ not json ";
  writeFileSync(settingsPath, garbage);
  const r = runCli(["init", "--settings-only"], { cwd: tmp, settingsPath });
  assert.equal(r.status, 1, "a refused merge must FAIL, not exit 0 (RA-04)");
  assert.match(r.stderr, /settings: FAILED/, "failure goes to stderr");
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(readFileSync(settingsPath, "utf8"), garbage, "file untouched");
});

test("init --settings-only announces the GLOBAL merge (informed consent) and exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-cli-consent-"));
  const settingsPath = join(tmp, "settings.json");
  const first = runCli(["init", "--settings-only"], { cwd: tmp, settingsPath });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /GLOBAL — affects all repos/, "consent line on merge");
  assert.match(first.stdout, /--no-settings/, "names the opt-out");
  assert.match(first.stdout, /--remove-settings/, "names the reversal");
  // RA-11: the notice prints on unchanged runs too, not only the first merge.
  const second = runCli(["init", "--settings-only"], {
    cwd: tmp,
    settingsPath,
  });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /GLOBAL — affects all repos/, "consent line on unchanged run");
  assert.match(second.stdout, /already up to date/);
});

test("init --remove-settings reverses a merge (exit 0) and fails loudly on a corrupt file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-cli-remove-"));
  const settingsPath = join(tmp, "settings.json");
  assert.equal(runCli(["init", "--settings-only"], { cwd: tmp, settingsPath }).status, 0);
  const removed = runCli(["init", "--remove-settings"], {
    cwd: tmp,
    settingsPath,
  });
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, /settings: removed .*_forge/, "reports what was removed");
  assert.match(removed.stdout, /backup:/, "reports the backup");
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.ok(!after._forge && !after.hooks, "forge entries gone");
  // Corrupt file → refuse with exit 1 on stderr.
  const garbage = "{ nope ";
  writeFileSync(settingsPath, garbage);
  const bad = runCli(["init", "--remove-settings"], { cwd: tmp, settingsPath });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /NOT modified/);
  assert.equal(readFileSync(settingsPath, "utf8"), garbage, "corrupt file untouched");
});

test("full init with an invalid profile exits 1 BEFORE any side effect (RA-13)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-cli-badprofile-"));
  const settingsPath = join(tmp, "home-settings.json");
  const r = runCli(["init", "--profile", "bogus"], { cwd: tmp, settingsPath });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown profile: bogus/);
  assert.ok(!existsSync(join(tmp, "AGENTS.md")), "no AGENTS.md emitted");
  assert.ok(!existsSync(join(tmp, ".forge")), "no .forge/ created");
  assert.ok(!existsSync(join(tmp, ".gitattributes")), "no .gitattributes appended");
  assert.ok(!existsSync(settingsPath), "settings never touched");
});

// ---------------------------------------------------------------------------
// install.sh — static checks (RA-04, RA-17, RA-18): syntax + truthful wording.
// ---------------------------------------------------------------------------

test("install.sh parses (bash -n) and its header tells the truth about the settings merge", () => {
  const syntax = spawnSync("bash", ["-n", INSTALL_SH], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);
  const sh = readFileSync(INSTALL_SH, "utf8");
  assert.ok(!sh.includes("never edits settings.json"), "the RA-18 lie is gone");
  assert.match(sh, /GLOBAL — affects all repos/, "header/consent names the global scope");
  assert.match(sh, /--no-settings/, "documents the skip flag");
  assert.match(sh, /--remove-settings/, "documents the reversal path");
});

test("install.sh propagates a failed settings merge as an INCOMPLETE install, and uninstall cleans settings", () => {
  const sh = readFileSync(INSTALL_SH, "utf8");
  assert.match(sh, /SETTINGS_FAILED=1/, "captures the merge exit status");
  assert.match(sh, /WARNING: settings merge FAILED/, "loud stderr warning");
  assert.match(sh, /Install INCOMPLETE — settings\.json was not updated/, "no false Done.");
  assert.match(sh, /init --remove-settings/, "uninstall attempts the settings reversal");
  // The failure path must not be swallowed by a `|| say` on the merge pipeline (RA-04).
  assert.ok(
    !/init --settings-only 2>&1 \| sed[^\n]*\\\n\s*\|\| say/.test(sh),
    "merge exit status is no longer discarded by an || fallback on the pipeline",
  );
});

test("install.sh (HI-10): link() backs up foreign symlinks and uninstall stops when settings cleanup fails", () => {
  const syntax = spawnSync("bash", ["-n", INSTALL_SH], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);
  const sh = readFileSync(INSTALL_SH, "utf8");
  // link(): an existing symlink NOT pointing into the repo is backed up before replacement.
  assert.match(sh, /backed up existing symlink/, "a foreign user symlink is backed up, not lost");
  assert.match(sh, /readlink "\$dest"/, "link() inspects the existing symlink target");
  // uninstall: a failed settings cleanup stops instead of removing assets the hooks point at.
  assert.match(
    sh,
    /Uninstall INCOMPLETE — settings still reference Forge hooks/,
    "uninstall refuses to strip assets while settings still reference them",
  );
  // The INCOMPLETE branch exits non-zero and precedes asset removal.
  const incompleteIdx = sh.indexOf("Uninstall INCOMPLETE");
  const unlinkIdx = sh.indexOf("unlink_ours", incompleteIdx);
  assert.ok(incompleteIdx > 0 && unlinkIdx > incompleteIdx, "the stop precedes asset removal");
  assert.match(sh.slice(incompleteIdx, unlinkIdx), /exit 1/, "the incomplete path exits non-zero");
});

#!/usr/bin/env node
/**
 * Zero-dependency version bump for forgekit (node stdlib only).
 *
 * Usage:
 *   node scripts/bump.mjs <patch|minor|major|auto>   # bump every version field + CHANGELOG
 *   node scripts/bump.mjs check                      # assert all version fields agree (CI guard)
 *   node scripts/bump.mjs <kind> --dry-run           # compute + print, write nothing
 *
 * "auto" heuristic (deliberately simple):
 *   1. Conventional commits since the last v* tag:
 *        BREAKING CHANGE / "type!:" -> major, feat -> minor, anything else -> patch.
 *   2. If git yields no commits, fall back to the CHANGELOG [Unreleased] body:
 *        "BREAKING" -> major, a "### Added" section -> minor, any other content -> patch.
 *   3. Nothing found anywhere -> error (nothing to release).
 *
 * Files touched (all version fields in the repo):
 *   package.json, package-lock.json (root "version" + packages[""].version),
 *   .claude-plugin/plugin.json, .codex-plugin/plugin.json,
 *   CITATION.cff (version + date-released), landing/index.html (display string),
 *   CHANGELOG.md ([Unreleased] rotated under "## [X.Y.Z] - <date>" + compare links).
 *
 * Prints ONLY the new version on stdout (diagnostics go to stderr) so callers can
 * capture it: NEW="$(node scripts/bump.mjs auto)".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure version math
// ---------------------------------------------------------------------------

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`unsupported version format: ${JSON.stringify(v)} (want X.Y.Z)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function computeNext(current, kind) {
  const { major, minor, patch } = parseVersion(current);
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown bump kind: ${JSON.stringify(kind)} (want patch|minor|major)`);
  }
}

/**
 * Conventional-commit heuristic. `commits` is [{ subject, body }].
 * BREAKING -> major, feat -> minor, anything else -> patch, no commits -> null.
 */
export function inferKindFromCommits(commits) {
  if (!commits || commits.length === 0) return null;
  let kind = "patch";
  for (const { subject = "", body = "" } of commits) {
    if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /BREAKING[ -]CHANGE/.test(`${subject}\n${body}`)) {
      return "major";
    }
    if (/^feat(\([^)]*\))?:/.test(subject)) kind = "minor";
  }
  return kind;
}

/**
 * CHANGELOG fallback heuristic on the [Unreleased] body.
 * "BREAKING" -> major, "### Added" section -> minor, other content -> patch, empty -> null.
 */
export function inferKindFromChangelog(unreleasedBody) {
  const body = (unreleasedBody || "").trim();
  if (!body) return null;
  if (/\bBREAKING\b/.test(body)) return "major";
  if (/^### Added\b/m.test(body)) return "minor";
  return "patch";
}

// ---------------------------------------------------------------------------
// CHANGELOG rotation (pure)
// ---------------------------------------------------------------------------

/** Returns the text between "## [Unreleased]" and the next "## [" heading (or EOF/link refs). */
export function extractUnreleased(changelog) {
  const start = changelog.search(/^## \[Unreleased\][^\n]*\n/m);
  if (start === -1) return null;
  const afterHeading = changelog.indexOf("\n", start) + 1;
  const rest = changelog.slice(afterHeading);
  const next = rest.search(/^(## \[|\[Unreleased\]:)/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Moves the [Unreleased] body under "## [newVersion] - date", leaves a fresh empty
 * [Unreleased], and rewrites the keep-a-changelog compare links at the bottom.
 */
export function rotateChangelog(changelog, newVersion, prevVersion, date) {
  if (new RegExp(`^## \\[${newVersion.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md already has a [${newVersion}] section`);
  }
  const body = extractUnreleased(changelog);
  if (body === null) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  const start = changelog.search(/^## \[Unreleased\][^\n]*\n/m);
  const afterHeading = changelog.indexOf("\n", start) + 1;
  const head = changelog.slice(0, afterHeading);
  const tail = changelog.slice(afterHeading + body.length);
  const released = `\n## [${newVersion}] - ${date}\n\n${body.trim()}\n\n`;
  let out = head + released + tail;

  // Rewrite the compare links: [Unreleased] -> vNEW...HEAD, insert [NEW] -> vPREV...vNEW.
  const refRe = /^\[Unreleased\]:\s*(\S+?)\/compare\/\S+\s*$/m;
  const refMatch = refRe.exec(out);
  if (refMatch) {
    const base = refMatch[1];
    out = out.replace(
      refRe,
      `[Unreleased]: ${base}/compare/v${newVersion}...HEAD\n` +
        `[${newVersion}]: ${base}/compare/v${prevVersion}...v${newVersion}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// File mutation
// ---------------------------------------------------------------------------

export const JSON_VERSION_FILES = [
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Replaces the first `"version": "<old>"` in raw JSON text (keeps formatting/escapes). */
export function setJsonVersionText(text, oldVersion, newVersion) {
  const needle = `"version": "${oldVersion}"`;
  const idx = text.indexOf(needle);
  if (idx === -1) throw new Error(`no "version": "${oldVersion}" field found`);
  const out = `${text.slice(0, idx)}"version": "${newVersion}"${text.slice(idx + needle.length)}`;
  JSON.parse(out); // sanity: still valid JSON
  return out;
}

/** Collects every tracked version field, as { file: version }. Missing files are skipped. */
export function collectVersions(root) {
  const found = {};
  for (const rel of JSON_VERSION_FILES) {
    const text = readIfExists(path.join(root, rel));
    if (text !== null) found[rel] = JSON.parse(text).version;
  }
  const lockText = readIfExists(path.join(root, "package-lock.json"));
  if (lockText !== null) {
    const lock = JSON.parse(lockText);
    found["package-lock.json (root)"] = lock.version;
    if (lock.packages?.[""]) found['package-lock.json (packages."")'] = lock.packages[""].version;
  }
  const cff = readIfExists(path.join(root, "CITATION.cff"));
  if (cff !== null) {
    const m = /^version:\s*(\S+)\s*$/m.exec(cff);
    if (m) found["CITATION.cff"] = m[1];
  }
  return found;
}

/**
 * Writes `newVersion` (and `date`) into every version field. Returns the list of
 * files changed. Files absent from `root` are skipped so fixtures can be partial.
 */
export function applyBump(root, currentVersion, newVersion, date) {
  const changed = [];
  const write = (rel, text) => {
    fs.writeFileSync(path.join(root, rel), text);
    changed.push(rel);
  };

  for (const rel of JSON_VERSION_FILES) {
    const text = readIfExists(path.join(root, rel));
    if (text !== null) write(rel, setJsonVersionText(text, currentVersion, newVersion));
  }

  const lockRel = "package-lock.json";
  const lockText = readIfExists(path.join(root, lockRel));
  if (lockText !== null) {
    const lock = JSON.parse(lockText);
    lock.version = newVersion;
    if (lock.packages?.[""]) lock.packages[""].version = newVersion;
    write(lockRel, `${JSON.stringify(lock, null, 2)}\n`);
  }

  const cffRel = "CITATION.cff";
  const cff = readIfExists(path.join(root, cffRel));
  if (cff !== null) {
    write(
      cffRel,
      cff
        .replace(/^version:\s*.*$/m, `version: ${newVersion}`)
        .replace(/^date-released:\s*.*$/m, `date-released: "${date}"`),
    );
  }

  const landingRel = "landing/index.html";
  const landing = readIfExists(path.join(root, landingRel));
  if (landing !== null && /forgekit v\d+\.\d+\.\d+/.test(landing)) {
    write(landingRel, landing.replace(/forgekit v\d+\.\d+\.\d+/g, `forgekit v${newVersion}`));
  }

  const clRel = "CHANGELOG.md";
  const changelog = readIfExists(path.join(root, clRel));
  if (changelog !== null) {
    write(clRel, rotateChangelog(changelog, newVersion, currentVersion, date));
  }

  return changed;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function gitCommitsSinceLastTag(root) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    let range;
    try {
      const tag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
      range = [`${tag}..HEAD`];
    } catch {
      range = ["HEAD"]; // no tag yet: consider all commits
    }
    const raw = git(["log", ...range, "--pretty=%s%x1f%b%x1e"]);
    return raw
      .split("\x1e")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [subject, body = ""] = c.split("\x1f");
        return { subject: subject.trim(), body: body.trim() };
      });
  } catch {
    return null; // not a git checkout
  }
}

function runCheck(root) {
  const found = collectVersions(root);
  const versions = new Set(Object.values(found));
  if (versions.size === 1) {
    process.stderr.write(`version fields agree: ${[...versions][0]}\n`);
    return 0;
  }
  process.stderr.write("version drift detected:\n");
  for (const [file, v] of Object.entries(found)) process.stderr.write(`  ${file}: ${v}\n`);
  return 1;
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const args = argv.filter((a) => !a.startsWith("--"));
  const dryRun = flags.includes("--dry-run");
  const cmd = args[0];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (cmd === "check") return runCheck(root);

  if (!["patch", "minor", "major", "auto"].includes(cmd)) {
    process.stderr.write(
      "usage: node scripts/bump.mjs <patch|minor|major|auto|check> [--dry-run]\n",
    );
    return 2;
  }

  const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  let kind = cmd;
  if (cmd === "auto") {
    const commits = gitCommitsSinceLastTag(root);
    kind = inferKindFromCommits(commits);
    if (!kind) {
      kind = inferKindFromChangelog(
        extractUnreleased(readIfExists(path.join(root, "CHANGELOG.md")) || ""),
      );
    }
    if (!kind) {
      process.stderr.write(
        "auto: no commits since the last tag and an empty CHANGELOG [Unreleased] — nothing to release\n",
      );
      return 1;
    }
    process.stderr.write(`auto -> ${kind}\n`);
  }

  const next = computeNext(current, kind);
  if (dryRun) {
    process.stderr.write(`dry-run: ${current} -> ${next} (no files written)\n`);
  } else {
    const changed = applyBump(root, current, next, today());
    process.stderr.write(`bumped ${current} -> ${next}: ${changed.join(", ")}\n`);
  }
  process.stdout.write(`${next}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

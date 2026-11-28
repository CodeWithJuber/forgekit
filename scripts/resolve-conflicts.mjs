#!/usr/bin/env node
/**
 * Resolve the merge conflicts that have one right answer, and leave the rest for a person.
 *
 *   git merge origin/master                     # stops with conflicts
 *   node scripts/resolve-conflicts.mjs [--commit]  # resolves what is safe, re-renders, stages
 *   npm run sync:master                          # both, then commits the merge
 *
 * `.github/workflows/pr-sync.yml` runs the same thing for every open pull request when
 * master moves, so most conflicts are gone before anyone opens the PR page.
 *
 * Most conflicts between parallel pull requests here are not disagreements. Two branches
 * each ADD lines at the same spot (a row in a table, a bullet in a list) and git cannot
 * order them, or both regenerate the same machine-owned block. For every conflicted file the
 * script recreates the conflict with its common base (`git checkout --conflict=diff3`) and
 * looks at each hunk:
 *
 *   - inside a `forge:render` block → take the base branch's side; `forge docs render`
 *     rebuilds the block from the merged sources afterwards;
 *   - the base is empty (both sides only inserted lines) → keep both: the base branch's lines
 *     first, then this branch's;
 *   - anything else (both sides edited the same existing lines) → a real disagreement: left
 *     in place for a person, and the script exits 1.
 *
 * Zero dependencies. Run it from the repository root with the merge still in progress.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { encoding: "utf8" });

/**
 * Resolve one diff3-style conflicted text. Pure.
 * @param {string} text the file with `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` markers
 * @returns {{text: string, resolved: number, unresolved: number, rendered: number}}
 */
export function resolveText(text) {
  // A Windows checkout writes conflict markers with CRLF; keep the file's own line ending.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  /** @type {string[]} */
  const out = [];
  let inRender = false;
  let resolved = 0;
  let unresolved = 0;
  let rendered = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("<<<<<<< ")) {
      if (/forge:render:[\w-]+:begin/.test(line)) inRender = true;
      if (/forge:render:[\w-]+:end/.test(line)) inRender = false;
      out.push(line);
      continue;
    }
    // Collect one hunk: ours | base | theirs.
    const ours = [];
    const base = [];
    const theirs = [];
    let part = ours;
    let hasBase = false;
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith(">>>>>>> "); j++) {
      if (lines[j].startsWith("||||||| ")) {
        part = base;
        hasBase = true;
      } else if (lines[j] === "=======") part = theirs;
      else part.push(lines[j]);
    }
    const hunk = lines.slice(i, j + 1);
    if (inRender) {
      out.push(...theirs); // rebuilt by docs render from the merged sources
      rendered++;
      resolved++;
    } else if (hasBase && base.every((l) => !l.trim())) {
      out.push(...theirs, ...ours.filter((l) => !theirs.includes(l) || !l.trim()));
      resolved++;
    } else {
      out.push(...hunk);
      unresolved++;
    }
    i = j;
  }
  return { text: out.join(eol), resolved, unresolved, rendered };
}

function main() {
  const files = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  if (!files.length) {
    console.log("no conflicted files");
    return 0;
  }
  let open = 0;
  let render = false;
  for (const file of files) {
    git(["checkout", "--conflict=diff3", "--", file]); // markers with the common base
    const r = resolveText(readFileSync(file, "utf8"));
    writeFileSync(file, r.text);
    if (r.rendered) render = true;
    if (r.unresolved) {
      open += r.unresolved;
      console.log(`  ✗ ${file}: ${r.unresolved} hunk(s) edit the same lines — resolve by hand`);
    } else {
      git(["add", "--", file]);
      console.log(`  ✓ ${file}: ${r.resolved} hunk(s) resolved`);
    }
  }
  if (render && !open) {
    execFileSync(process.execPath, ["src/cli.js", "docs", "render"], { stdio: "ignore" });
    git(["add", "-A"]);
    console.log("  ✓ generated blocks re-rendered");
  }
  if (open) return 1;
  if (process.argv.includes("--commit")) {
    git(["commit", "--no-edit"]); // the merge commit
    console.log("  ✓ merge committed");
  }
  return 0;
}

if (process.argv[1]?.endsWith("resolve-conflicts.mjs")) process.exitCode = main();

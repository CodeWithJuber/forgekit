// forge docs sync — the diff-driven half of docs↔code alignment. `docs check` reconciles
// REGISTRIES (commands, env vars, MCP tools) against the contract docs; this sweep answers
// the other question: given WHAT JUST CHANGED, which prose mentions it? Diff → identifiers
// → scan every doc artifact → UPDATED (the doc moved with the change), STALE (mentions a
// changed identifier but didn't move — with file:line hits), or VERIFIED-UNAFFECTED (zero
// mentions, and the reason is RECORDED: checked, not assumed). Pure reporter — updating
// prose is the agent's job; refusing "done" without it is the completion gate's.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { load as loadAtlas, RULES } from "./atlas.js";
import { CALL_IGNORE, extractCalledSymbols } from "./extract.js";
import { statePath } from "./handoff.js";
import { isTestFile } from "./substrate.js";

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

// Definition names on changed lines — the SAME grammars the atlas parses, so the sweep
// and the graph can never disagree about what counts as a definition.
function definedNames(rel, text) {
  const rules = RULES[extname(rel)];
  if (!rules) return [];
  const out = [];
  for (const { re } of rules) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
  }
  return out;
}

/**
 * The identifier set of a diff: changed rel paths + called symbols + definition names on
 * the changed lines (added AND removed — a deleted symbol makes docs stale too).
 */
export function changedIdentifiers(root, { base = "HEAD" } = {}) {
  const diff =
    git(root, ["diff", "--unified=0", base]) || git(root, ["diff", "--unified=0", "--cached"]);
  const perFile = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.*)$/.exec(line);
    if (header) {
      current = header[1] === "/dev/null" ? null : header[1];
      if (current && !perFile.has(current)) perFile.set(current, []);
      continue;
    }
    const gone = /^--- a\/(.*)$/.exec(line);
    if (gone && gone[1] !== "/dev/null" && !perFile.has(gone[1])) perFile.set(gone[1], []);
    if (!current) continue;
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )
      perFile.get(current).push(line.slice(1));
  }
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)) {
    if (!perFile.has(f)) {
      let text = "";
      try {
        text = readFileSync(join(root, f), "utf8");
      } catch {}
      perFile.set(f, text.split("\n")); // a brand-new file: every line is a changed line
    }
  }
  const identifiers = new Set();
  const changedFiles = [...perFile.keys()].sort();
  // Precision rules (dogfooding found them): symbols come ONLY from code-class files —
  // prose parentheses in a changed .md line are not call sites — and never from test
  // files (docs don't document test internals). A plain lowercase English word that
  // happens to be a variable (`status`, `body`) would flag every doc that uses the
  // word, so only code-shaped names (case transition, digit, _ . / -) are scanned.
  const codeShaped = (s) => /[A-Z0-9_./\\-]/.test(s);
  for (const [rel, lines] of perFile) {
    identifiers.add(rel);
    if (!RULES[extname(rel)] || isTestFile(rel)) continue;
    const text = lines.join("\n");
    for (const s of extractCalledSymbols(text))
      if (s.length >= 3 && codeShaped(s)) identifiers.add(s);
    for (const d of definedNames(rel, text))
      if (d.length >= 3 && !CALL_IGNORE.has(d) && codeShaped(d)) identifiers.add(d);
  }
  return { base, changedFiles, identifiers: [...identifiers].sort() };
}

// CHANGELOG and the decisions log are append-only HISTORY — their mentions of changed
// identifiers are correct-by-design (same reasoning as the atlas DOC_SKIP set).
const HISTORY_RE = /(^|[/\\])CHANGELOG\.md$/i;

/** Every doc artifact the sweep owes an answer for: atlas doc nodes + the contract docs
 *  + the session-state snapshot (when they exist). */
export function docSet(root, atlas = loadAtlas(root)) {
  const docs = new Set();
  for (const n of atlas?.nodes || []) if (n.kind === "doc" && n.file) docs.add(n.file);
  for (const d of ["README.md", join("docs", "GUIDE.md"), "ARCHITECTURE.md"])
    if (existsSync(join(root, d))) docs.add(d);
  if (existsSync(statePath(root))) docs.add(join(".forge", "state.md"));
  return [...docs].filter((f) => !HISTORY_RE.test(f)).sort();
}

// The newest session baseline on disk — `docs sync` defaults to "what changed THIS
// session" when a baseline exists, falling back to HEAD (uncommitted work) otherwise.
export function newestBaseline(root) {
  try {
    const dir = join(root, ".forge", "sessions");
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".base"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return null;
    const sha = readFileSync(join(dir, newest.f), "utf8").trim();
    return git(root, ["rev-parse", "--verify", `${sha}^{commit}`]) ? sha : null;
  } catch {
    return null;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The sweep. Per doc artifact: UPDATED (changed in this diff), STALE (mentions changed
 * identifiers — every hit cited file:line), or VERIFIED-UNAFFECTED with the recorded
 * reason. `base` defaults to the newest session baseline, then HEAD.
 * @param {string} root
 * @param {{base?: string, atlas?: object|null, maxHitsPerDoc?: number}} [opts]
 */
export function docsSyncReport(root, { base, atlas, maxHitsPerDoc = 20 } = {}) {
  const resolvedBase = base || newestBaseline(root) || "HEAD";
  const { changedFiles, identifiers } = changedIdentifiers(root, { base: resolvedBase });
  const docs = docSet(root, atlas === undefined ? loadAtlas(root) : atlas);
  const report = {
    base: resolvedBase,
    changedFiles,
    identifiers,
    updated: [],
    stale: [],
    unaffected: [],
  };
  if (!identifiers.length) return report;
  const scanRe = new RegExp(`(?:^|[^\\w$/.-])(${identifiers.map(esc).join("|")})(?![\\w$])`, "g");
  for (const doc of docs) {
    if (changedFiles.includes(doc)) {
      report.updated.push({ file: doc, reason: "changed in this diff" });
      continue;
    }
    let text;
    try {
      text = readFileSync(join(root, doc), "utf8");
    } catch {
      continue;
    }
    const hits = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxHitsPerDoc; i += 1) {
      scanRe.lastIndex = 0;
      let m;
      while ((m = scanRe.exec(lines[i])) && hits.length < maxHitsPerDoc) {
        if (m[1] === doc) continue; // a doc naming itself is not staleness
        hits.push({ identifier: m[1], line: i + 1, text: lines[i].trim().slice(0, 160) });
      }
    }
    if (hits.length) report.stale.push({ file: doc, hits });
    else
      report.unaffected.push({
        file: doc,
        reason: `mentions none of the ${identifiers.length} changed identifiers`,
      });
  }
  return report;
}

/** Human rendering — one line per artifact, hits cited as file:line. */
export function renderDocsSync(report) {
  const out = [
    `docs sync — diff vs ${report.base}: ${report.changedFiles.length} changed file(s), ${report.identifiers.length} identifier(s)`,
  ];
  if (!report.changedFiles.length) {
    out.push("  clean — nothing changed, nothing owed.");
    return out.join("\n");
  }
  for (const u of report.updated) out.push(`  UPDATED     ${u.file} (${u.reason})`);
  for (const s of report.stale) {
    out.push(`  STALE       ${s.file} — mentions changed identifiers:`);
    for (const h of s.hits.slice(0, 5))
      out.push(`                ${s.file}:${h.line}  \`${h.identifier}\` — ${h.text}`);
    if (s.hits.length > 5) out.push(`                (+${s.hits.length - 5} more hits)`);
  }
  for (const v of report.unaffected) out.push(`  VERIFIED    ${v.file} — ${v.reason}`);
  if (report.stale.length)
    out.push(
      `  → update the STALE artifacts (or justify why not), then re-run. History files (CHANGELOG) are exempt by design.`,
    );
  return out.join("\n");
}

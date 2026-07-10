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
 * The identifier sets of a diff:
 * - `identifiers` — changed rel paths + code-shaped symbols from changed lines (added
 *   AND removed — a deleted symbol makes docs stale too), scanned anywhere in a doc.
 * - `soft` — all-lowercase symbols (`cusum`); indistinguishable from English words in
 *   prose, so they are scanned only inside backtick code spans.
 * - `disappeared` — symbols present in removed lines but absent from added ones: their
 *   mentions are stale EVEN in a doc that was touched in the same diff (the rename
 *   case — a doc updated for one reason can still describe a symbol that no longer
 *   exists).
 */
export function changedIdentifiers(root, { base = "HEAD" } = {}) {
  const diff =
    git(root, ["diff", "--unified=0", base]) || git(root, ["diff", "--unified=0", "--cached"]);
  const perFile = new Map();
  const ensure = (rel) => {
    if (!perFile.has(rel)) perFile.set(rel, { added: [], removed: [] });
    return perFile.get(rel);
  };
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.*)$/.exec(line);
    if (header) {
      current = header[1] === "/dev/null" ? null : header[1];
      if (current) ensure(current);
      continue;
    }
    const gone = /^--- a\/(.*)$/.exec(line);
    if (gone && gone[1] !== "/dev/null") ensure(gone[1]);
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) ensure(current).added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---"))
      ensure(current).removed.push(line.slice(1));
  }
  for (const f of git(root, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)) {
    if (!perFile.has(f)) {
      let text = "";
      try {
        text = readFileSync(join(root, f), "utf8");
      } catch {}
      perFile.set(f, { added: text.split("\n"), removed: [] }); // brand-new file: every line added
    }
  }
  // Precision rules (dogfooding + adversarial review found them): symbols come ONLY
  // from code-class files — prose parentheses in a changed .md line are not call
  // sites — and never from test files (docs don't document test internals).
  const codeShaped = (s) => /[A-Z0-9_./\\-]/.test(s);
  const identifiers = new Set();
  const changedFiles = [...perFile.keys()].sort();
  const addedSyms = new Set();
  const removedSyms = new Set();
  const collect = (rel, text, bucket) => {
    for (const s of extractCalledSymbols(text)) if (s.length >= 3) bucket.add(s);
    for (const d of definedNames(rel, text))
      if (d.length >= 3 && !CALL_IGNORE.has(d)) bucket.add(d);
  };
  for (const [rel, { added, removed }] of perFile) {
    identifiers.add(rel);
    if (!RULES[extname(rel)] || isTestFile(rel)) continue;
    collect(rel, added.join("\n"), addedSyms);
    collect(rel, removed.join("\n"), removedSyms);
  }
  const soft = new Set();
  for (const s of new Set([...addedSyms, ...removedSyms])) {
    if (codeShaped(s)) identifiers.add(s);
    else if (s.length >= 4) soft.add(s);
  }
  const disappeared = [...removedSyms]
    .filter((s) => !addedSyms.has(s) && (codeShaped(s) || s.length >= 4))
    .sort();
  return {
    base,
    changedFiles,
    identifiers: [...identifiers].sort(),
    soft: [...soft].sort(),
    disappeared,
  };
}

// CHANGELOG and the decisions log are append-only HISTORY — their mentions of changed
// identifiers are correct-by-design (same reasoning as the atlas DOC_SKIP set).
const HISTORY_RE = /(^|[/\\])CHANGELOG\.md$/i;

/** Every doc artifact the sweep owes an answer for: atlas doc nodes + the contract
 *  docs. The state snapshot (.forge/state.md) is deliberately NOT scanned: handoff
 *  writes the changed-file list into it by design, so scanning it flags the sweep's
 *  own bookkeeping as stale — an unfixable self-reference (review-found). The gate's
 *  mtime check covers state; the sweep covers prose. */
export function docSet(root, atlas = loadAtlas(root)) {
  const docs = new Set();
  for (const n of atlas?.nodes || []) if (n.kind === "doc" && n.file) docs.add(n.file);
  for (const d of ["README.md", join("docs", "GUIDE.md"), "ARCHITECTURE.md"])
    if (existsSync(join(root, d))) docs.add(d);
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
  // An explicit but unknown ref must ERROR, not silently fall back to the index and
  // mislabel the report (review-found: a typo yielded a wrong-but-plausible sweep).
  if (base && !git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim())
    return {
      base,
      error: `unknown base ref: ${base}`,
      changedFiles: [],
      identifiers: [],
      soft: [],
      disappeared: [],
      updated: [],
      stale: [],
      unaffected: [],
    };
  const resolvedBase = base || newestBaseline(root) || "HEAD";
  const { changedFiles, identifiers, soft, disappeared } = changedIdentifiers(root, {
    base: resolvedBase,
  });
  const docs = docSet(root, atlas === undefined ? loadAtlas(root) : atlas);
  const report = {
    base: resolvedBase,
    changedFiles,
    identifiers,
    soft,
    disappeared,
    updated: [],
    stale: [],
    unaffected: [],
  };
  if (!identifiers.length && !soft.length) return report;
  const bound = (ids) => `(?:^|[^\\w$/.-])(${ids.map(esc).join("|")})(?![\\w$])`;
  const generalRe = identifiers.length ? new RegExp(bound(identifiers), "g") : null;
  // Lowercase symbols only count inside backticks — `cusum` in a code span is a code
  // reference; "status" in running prose is English.
  const softRe = soft.length ? new RegExp(`\`(${soft.map(esc).join("|")})\``, "g") : null;
  const goneRe = disappeared.length ? new RegExp(bound(disappeared), "g") : null;
  const scan = (lines, regexes, self) => {
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < maxHitsPerDoc; i += 1) {
      for (const re of regexes) {
        if (!re) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(lines[i])) && hits.length < maxHitsPerDoc) {
          if (m[1] === self) continue; // a doc naming itself is not staleness
          hits.push({ identifier: m[1], line: i + 1, text: lines[i].trim().slice(0, 160) });
        }
      }
    }
    return hits;
  };
  for (const doc of docs) {
    let text;
    try {
      text = readFileSync(join(root, doc), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    if (changedFiles.includes(doc)) {
      // Touched docs still owe an answer for REMOVED symbols: updated-for-one-reason
      // does not mean updated-for-the-rename.
      const hits = scan(lines, [goneRe], doc);
      if (hits.length)
        report.stale.push({ file: doc, hits, note: "touched, but still mentions REMOVED symbols" });
      else report.updated.push({ file: doc, reason: "changed in this diff" });
      continue;
    }
    const hits = scan(lines, [generalRe, softRe], doc);
    if (hits.length) report.stale.push({ file: doc, hits });
    else
      report.unaffected.push({
        file: doc,
        reason: `mentions none of the ${identifiers.length + soft.length} changed identifiers`,
      });
  }
  return report;
}

/** Human rendering — one line per artifact, hits cited as file:line. */
export function renderDocsSync(report) {
  if (report.error) return `docs sync — ${report.error}`;
  const out = [
    `docs sync — diff vs ${report.base}: ${report.changedFiles.length} changed file(s), ${report.identifiers.length + (report.soft?.length ?? 0)} identifier(s)`,
  ];
  if (!report.changedFiles.length) {
    out.push("  clean — nothing changed, nothing owed.");
    return out.join("\n");
  }
  for (const u of report.updated) out.push(`  UPDATED     ${u.file} (${u.reason})`);
  for (const s of report.stale) {
    out.push(`  STALE       ${s.file} — ${s.note ?? "mentions changed identifiers"}:`);
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

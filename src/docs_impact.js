// forge docs impact — a REUSABLE documentation-impact graph. Where `docs check`
// reconciles a fixed list of registries and `docs sync` scans a git diff for raw
// identifiers, this module answers the general question the project keeps forgetting:
// "I changed X — which documented surfaces mention X and are now potentially stale?"
//
// It works in three data-driven stages, none of them hardcoded per file:
//
//   1. ENTITY EXTRACTION. A data-driven EXTRACTORS registry derives the TYPED set of
//      entities the project documents (commands, flags, env vars, MCP tools, exported
//      symbols, brand tokens, the version, package.json fields) from their CANONICAL
//      sources. Adding a new entity type = pushing one entry onto EXTRACTORS, never
//      editing N call sites. The heavy extractors are REUSED from docs_check.js
//      (envVarsRead, srcFiles) and the existing registries (COMMANDS, TOOLS, BRAND).
//
//   2. REFERENCE INDEX. A generic token scan over every prose/doc SURFACE (all tracked
//      *.md, CITATION.cff, the plugin manifests, the landing page, package.json's
//      description/keywords) builds an inverted index  entity → [{file,line,section,
//      context,confidence}].  The scan is word-boundary aware and code-fence aware:
//      English-word-shaped entities (bare symbols) are only counted inside code spans,
//      exactly like docs_sync's "soft" identifiers, so prose doesn't false-positive.
//
//   3. IMPACT QUERY. Given the entities a git diff CHANGED (a command renamed/removed,
//      a flag added, an env var deleted, an export touched, the version bumped), it
//      returns every indexed doc location that references them, ranked by confidence.
//      This is the reusable core: change → index lookup → the exact stale-risk surfaces.
//
// Honest about limits (see the CLI help + README): a token index catches a doc that
// NAMES a changed entity. It cannot catch a paraphrase that never uses the name, a
// screenshot/diagram/image, or a design/wording choice with no textual anchor. It is
// advisory by construction — a high-recall "look here", not a proof of staleness.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { COMMANDS, HIDDEN_COMMANDS } from "./commands.js";
import { envVarsRead, srcFiles } from "./docs_check.js";
import { TOOLS } from "./mcp_tools.js";

const git = (root, args) => {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
};

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A tracked file is a canonical SOURCE (never scanned as a doc — that would flag every
 *  registry as a reference to itself). */
const isSrcJs = (rel) => rel.startsWith("src/") && rel.endsWith(".js");

// History files are append-only and correct-by-design: their mentions of a changed
// entity (a renamed command in an old changelog line) are NOT staleness. Same exemption
// docs_sync applies. Kept out of both the reference index and the impacted output.
const HISTORY_RE = /(^|\/)(CHANGELOG\.md|\.forge\/decisions\.md)$/i;

// ---------------------------------------------------------------------------
// Stage 1 — the data-driven extractor registry.
// ---------------------------------------------------------------------------
// Each extractor is a plain record:
//   type        stable entity-type label (also the confidence bucket)
//   weight      base confidence a plain-prose reference of this type earns (0..1)
//   codeOnly    entity names shaped like English words → only count inside code spans
//   extract()   the canonical current entities: {name, meta?}[]
//   ref(names)  build the doc-scan RegExp (group 1 = matched entity name)
//   isSource    (rel) → is this file a canonical source that DEFINES this type?
//   discover    (text) → entity names found in arbitrary source text (used on a diff's
//               REMOVED lines to detect entities that were DELETED, and on package.json
//               to recover the OLD version). Optional.
//
// Adding "config keys" or any new type is one more record here — nothing else changes.

const boundaryRe = (names) =>
  new RegExp(`(?:^|[^\\w$/.-])(${names.map(esc).join("|")})(?![\\w$])`, "g");

/** @type {Array<{type:string,weight:number,codeOnly?:boolean,extract:(root:string)=>{name:string,meta?:object}[],ref:(names:string[])=>RegExp,isSource:(rel:string)=>boolean,discover?:(text:string)=>string[]}>} */
export const EXTRACTORS = [
  {
    // Command names — reference form is `<cli> <name>` (BRAND.cli, never a literal),
    // which keeps a common word like "docs" from matching bare prose.
    type: "command",
    weight: 0.9,
    extract: () => [
      ...Object.keys(COMMANDS).map((name) => ({ name })),
      ...HIDDEN_COMMANDS.map((name) => ({ name, meta: { hidden: true } })),
    ],
    ref: (names) =>
      new RegExp(`\\b${esc(BRAND.cli)}\\s+(${names.map(esc).join("|")})(?![\\w-])`, "g"),
    isSource: (rel) => rel === "src/commands.js",
    // Table keys in commands.js: `  init: {` / `  taste: "…"`.
    discover: (text) => [...text.matchAll(/^\s{2}([a-z][a-z-]+):/gm)].map((m) => m[1]),
  },
  {
    // CLI flags, canonically declared in the COMMANDS table's `flags`/`usage`.
    type: "flag",
    weight: 0.8,
    extract: () => {
      const flags = new Set();
      for (const entry of Object.values(COMMANDS)) {
        if (typeof entry !== "object") continue;
        for (const f of entry.flags ?? [])
          for (const m of String(f.flag).matchAll(/--[a-z][\w-]*/g)) flags.add(m[0]);
        for (const m of String(entry.usage ?? "").matchAll(/--[a-z][\w-]*/g)) flags.add(m[0]);
      }
      return [...flags].map((name) => ({ name }));
    },
    ref: (names) => boundaryRe(names),
    isSource: (rel) => rel === "src/commands.js",
    discover: (text) => [...text.matchAll(/--[a-z][\w-]*/g)].map((m) => m[0]),
  },
  {
    // Env vars — REUSES docs_check.envVarsRead (the one scanner of process.env + guards).
    type: "env",
    weight: 0.9,
    extract: (root) => [...envVarsRead(root)].map((name) => ({ name })),
    ref: (names) => boundaryRe(names),
    isSource: (rel) => isSrcJs(rel) || /^global\/guards\/.*\.sh$/.test(rel),
    discover: (text) => [
      ...[...text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]),
      ...[
        ...text.matchAll(
          /\b((?:FORGE|ANTHROPIC|LITELLM|OPENROUTER|ENABLE_CORTEX|CLAUDE)_[A-Z0-9_]+)\b/g,
        ),
      ].map((m) => m[1]),
    ],
  },
  {
    // MCP tool names — from the same TOOLS registry docs_check reconciles.
    type: "mcp-tool",
    weight: 0.9,
    extract: () => TOOLS.map((t) => ({ name: t.name })),
    ref: (names) => boundaryRe(names),
    isSource: (rel) => rel === "src/mcp_tools.js",
    discover: (text) => [...text.matchAll(/name:\s*["']([a-z][a-z0-9_]+)["']/gi)].map((m) => m[1]),
  },
  {
    // Exported public symbols — the JS API surface. Word-shaped (build, load, has), so
    // codeOnly: a symbol counts only inside a code span, never in running prose.
    type: "symbol",
    weight: 0.6,
    codeOnly: true,
    extract: (root) => {
      const names = new Set();
      for (const file of srcFiles(root)) {
        let text = "";
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const m of text.matchAll(
          /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g,
        ))
          names.add(m[1]);
      }
      return [...names].map((name) => ({ name }));
    },
    ref: (names) => boundaryRe(names),
    isSource: isSrcJs,
    discover: (text) =>
      [
        ...text.matchAll(
          /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g,
        ),
      ].map((m) => m[1]),
  },
  {
    // Brand tokens — from src/brand.js. Ubiquitous, so low confidence, but a rebrand
    // genuinely touches every surface, which is exactly what this should surface.
    type: "brand",
    weight: 0.35,
    extract: () =>
      [...new Set([BRAND.brand, BRAND.cli, BRAND.pkg, BRAND.home].filter(Boolean))].map((name) => ({
        name,
      })),
    ref: (names) => boundaryRe(names),
    isSource: (rel) => rel === "brand.json",
  },
  {
    // The version string — a bump makes every hardcoded version reference stale.
    // `v?` so `v0.23.1` and `0.23.1` both match; group 1 is the bare version.
    type: "version",
    weight: 0.75,
    // Read the TARGET repo's package.json (root), not forge's own BRAND.version, so a
    // version bump is detected in whatever repo `docs impact` runs against.
    extract: (root) => {
      try {
        const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
        return v ? [{ name: v }] : [];
      } catch {
        return [];
      }
    },
    ref: (names) => new RegExp(`(?<![\\w.])v?(${names.map(esc).join("|")})(?![\\w.])`, "g"),
    isSource: (rel) => rel === "package.json",
    discover: (text) => [...text.matchAll(/"version":\s*"([^"]+)"/g)].map((m) => m[1]),
  },
  {
    // package.json identity fields — name + keywords. Low weight (keywords are common
    // words) but a rename or keyword churn should still point at the docs that echo them.
    type: "pkg-field",
    weight: 0.4,
    extract: (root) => {
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        const names = new Set();
        if (pkg.name) names.add(pkg.name);
        for (const k of pkg.keywords ?? []) if (String(k).length >= 3) names.add(String(k));
        return [...names].map((name) => ({ name }));
      } catch {
        return [];
      }
    },
    ref: (names) => boundaryRe(names),
    isSource: (rel) => rel === "package.json",
  },
];

/**
 * The full current TYPED entity set, one flat list. Fail-open per extractor so a single
 * broken source can't blank the whole graph.
 * @param {string} [root]
 * @returns {{type:string, name:string, weight:number, codeOnly:boolean, meta:object}[]}
 */
export function extractEntities(root = BRAND.root) {
  const out = [];
  const seen = new Set();
  for (const ex of EXTRACTORS) {
    let items = [];
    try {
      items = ex.extract(root) ?? [];
    } catch {
      items = [];
    }
    for (const it of items) {
      // A single-character name (e.g. a stray `process.env.X` in a comment) is
      // indistinguishable from prose and never a real documented entity — drop it.
      if (!it.name || String(it.name).length < 2) continue;
      const key = `${ex.type} ${it.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: ex.type,
        name: it.name,
        weight: ex.weight,
        codeOnly: !!ex.codeOnly,
        meta: it.meta ?? {},
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — the generic, code-fence-aware reference index.
// ---------------------------------------------------------------------------

/** Byte ranges of inline `code` spans on a single line (matched backtick runs). */
function inlineCodeRanges(line) {
  const ranges = [];
  const re = /(`+)/g;
  let m;
  let openIdx = -1;
  let openLen = 0;
  while ((m = re.exec(line))) {
    if (openIdx < 0) {
      openIdx = m.index;
      openLen = m[1].length;
    } else if (m[1].length === openLen) {
      ranges.push([openIdx, m.index + m[1].length]);
      openIdx = -1;
      openLen = 0;
    }
  }
  return ranges;
}

/** Every prose/doc SURFACE the index owes an answer for — discoverable, not a per-file
 *  allow-list: all tracked *.md and *.cff, the plugin manifests, the landing page, and
 *  package.json (its description/keywords are prose). Canonical .js sources and history
 *  files are excluded. Falls back to a fixed set when git is unavailable (tmp fixtures). */
export function docSurfaces(root = BRAND.root) {
  const set = new Set();
  const tracked = git(root, ["ls-files"]);
  const list = tracked
    ? tracked.split("\n").filter(Boolean)
    : ["README.md", "docs/GUIDE.md", "ARCHITECTURE.md", "ROADMAP.md", "package.json"];
  for (const rel of list) {
    if (HISTORY_RE.test(rel)) continue;
    if (/\.(md|cff)$/i.test(rel)) set.add(rel);
  }
  for (const rel of [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".codex-plugin/plugin.json",
    "landing/index.html",
    "package.json",
  ])
    if (existsSync(join(root, rel))) set.add(rel);
  return [...set].sort();
}

// GitHub-style heading slug is overkill here; the raw heading text is a good enough
// "section" label for a human reviewer.
const headingOf = (line) => {
  const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  return m ? m[1].trim() : null;
};

/**
 * Build the inverted index: entityKey → occurrences. Generic over ANY entity list, so it
 * indexes the current entities AND the reconstructed removed ones (old version, deleted
 * command) the impact query needs.
 * @param {string} root
 * @param {{type:string,name:string,weight:number,codeOnly?:boolean}[]} entities
 * @param {string[]} [surfaces]
 * @returns {{index: Map<string, object[]>, surfaces: string[]}}
 */
export function buildReferenceIndex(root, entities, surfaces = docSurfaces(root)) {
  // One RegExp per (type) — an alternation of every name of that type — so a doc line is
  // scanned once per type, not once per entity. group 1 is the matched name.
  const byType = new Map();
  for (const e of entities) {
    if (!byType.has(e.type)) byType.set(e.type, { spec: e, names: [] });
    byType.get(e.type).names.push(e.name);
  }
  const scanners = [];
  for (const [type, { spec, names }] of byType) {
    const ex = EXTRACTORS.find((x) => x.type === type);
    if (!ex || !names.length) continue;
    scanners.push({ type, spec, re: ex.ref(names) });
  }

  const index = new Map();
  const record = (type, name, occ) => {
    const key = `${type} ${name}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(occ);
  };

  for (const rel of surfaces) {
    let text = "";
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    let inFence = false;
    let section = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue; // the fence marker itself is not content
      }
      if (!inFence) {
        const h = headingOf(line);
        if (h) section = h;
      }
      const codeRanges = inFence ? null : inlineCodeRanges(line);
      const inCode = (pos) =>
        inFence || (codeRanges?.some(([a, b]) => pos >= a && pos < b) ?? false);
      for (const { type, spec, re } of scanners) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const name = m[1];
          const pos = m.index + m[0].indexOf(name);
          const code = inCode(pos);
          if (spec.codeOnly && !code) continue; // word-shaped entity in plain prose — skip
          record(type, name, {
            file: rel,
            line: i + 1,
            section,
            context: inFence ? "fence" : code ? "code" : "prose",
            confidence: Math.min(1, spec.weight + (code ? 0.05 : 0)),
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    }
  }
  return { index, surfaces };
}

// ---------------------------------------------------------------------------
// Stage 3 — change detection over canonical sources, then the impact query.
// ---------------------------------------------------------------------------

/** Parse a unified diff into per-file added/removed line arrays. Handles new files
 *  (untracked, when not --staged) as all-added. */
function diffHunks(root, { base, staged }) {
  const args = staged
    ? ["diff", "--unified=0", "--cached"]
    : ["diff", "--unified=0", base || "HEAD"];
  const diff = git(root, args);
  const perFile = new Map();
  const ensure = (rel) => {
    if (!perFile.has(rel)) perFile.set(rel, { added: [], removed: [] });
    return perFile.get(rel);
  };
  let current = null;
  for (const line of diff.split("\n")) {
    const add = /^\+\+\+ b\/(.*)$/.exec(line);
    if (add) {
      current = add[1] === "/dev/null" ? null : add[1];
      if (current) ensure(current);
      continue;
    }
    const del = /^--- a\/(.*)$/.exec(line);
    if (del && del[1] !== "/dev/null") ensure(del[1]);
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) ensure(current).added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---"))
      ensure(current).removed.push(line.slice(1));
  }
  if (!staged) {
    for (const f of git(root, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(Boolean)) {
      if (perFile.has(f)) continue;
      let text = "";
      try {
        text = readFileSync(join(root, f), "utf8");
      } catch {}
      if (text) perFile.set(f, { added: text.split("\n"), removed: [] });
    }
  }
  return perFile;
}

/**
 * The entities a diff changed, TYPED. For each type: (a) a current entity is CHANGED if
 * its name-token appears on a changed line of one of that type's canonical sources; (b) a
 * name the extractor can DISCOVER in that type's REMOVED lines but which is absent from
 * the current set is a REMOVED entity (rename/deletion) — its old doc mentions are stale.
 * Version bumps additionally recover the OLD version from package.json's removed lines.
 * @param {string} root
 * @param {{base?:string, staged?:boolean}} [opts]
 * @returns {{type:string,name:string,reason:string,removed:boolean}[]}
 */
export function changedEntities(root, { base, staged } = {}) {
  const hunks = diffHunks(root, { base, staged });
  const current = extractEntities(root);
  const currentByType = new Map();
  for (const e of current) {
    if (!currentByType.has(e.type)) currentByType.set(e.type, new Set());
    currentByType.get(e.type).add(e.name);
  }

  const changed = [];
  const emitted = new Set();
  const emit = (type, name, reason, removed) => {
    if (!name || String(name).length < 2) return;
    const key = `${type} ${name}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    changed.push({ type, name, reason, removed });
  };

  for (const ex of EXTRACTORS) {
    // Gather this type's changed source hunks.
    let addedText = "";
    let removedText = "";
    let touched = false;
    for (const [rel, { added, removed }] of hunks) {
      if (!ex.isSource(rel)) continue;
      touched = true;
      addedText += `${added.join("\n")}\n`;
      removedText += `${removed.join("\n")}\n`;
    }
    if (!touched) continue;
    const changedText = `${addedText}\n${removedText}`;
    const currentNames = currentByType.get(ex.type) ?? new Set();

    // (a) current entities whose token is on a changed line.
    for (const name of currentNames) {
      const re = new RegExp(`(?:^|[^\\w$-])${esc(name)}(?![\\w$])`);
      if (re.test(changedText)) emit(ex.type, name, "modified", false);
    }
    // (b) discovered names in removed/added text that no longer exist → renamed/removed.
    if (ex.discover) {
      const seen = new Set([...ex.discover(removedText), ...ex.discover(addedText)]);
      for (const name of seen) if (!currentNames.has(name)) emit(ex.type, name, "removed", true);
    }
  }
  return changed;
}

/**
 * The reusable core. Compute the changed entities, index every doc surface for BOTH the
 * current and the removed entities, and return each changed entity with the doc locations
 * that reference it — ranked by confidence.
 * @param {string} root
 * @param {{base?:string, staged?:boolean, minConfidence?:number, surfaces?:string[]}} [opts]
 */
export function docsImpact(root = BRAND.root, opts = {}) {
  const { base, staged, minConfidence = 0, surfaces } = opts;
  const changed = changedEntities(root, { base, staged });

  // Index the CURRENT entities plus the reconstructed removed ones (so an old version or a
  // deleted command still has doc occurrences to point at).
  const entities = extractEntities(root);
  const known = new Set(entities.map((e) => `${e.type} ${e.name}`));
  for (const c of changed) {
    const key = `${c.type} ${c.name}`;
    if (known.has(key)) continue;
    known.add(key);
    const ex = EXTRACTORS.find((x) => x.type === c.type);
    entities.push({
      type: c.type,
      name: c.name,
      weight: ex?.weight ?? 0.5,
      codeOnly: !!ex?.codeOnly,
      meta: { removed: true },
    });
  }

  const { index, surfaces: scanned } = buildReferenceIndex(
    root,
    entities,
    surfaces ?? docSurfaces(root),
  );

  const impacted = [];
  for (const c of changed) {
    const occ = (index.get(`${c.type} ${c.name}`) ?? [])
      .filter((o) => o.confidence >= minConfidence)
      .sort(
        (a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file) || a.line - b.line,
      );
    if (occ.length) impacted.push({ ...c, occurrences: occ });
  }
  // Entities with the most / highest-confidence hits first.
  impacted.sort(
    (a, b) =>
      (b.occurrences[0]?.confidence ?? 0) - (a.occurrences[0]?.confidence ?? 0) ||
      b.occurrences.length - a.occurrences.length,
  );

  const files = new Set();
  for (const e of impacted) for (const o of e.occurrences) files.add(o.file);

  return {
    base: staged ? "--staged" : base || "HEAD",
    changed,
    impacted,
    surfaces: scanned,
    summary: {
      changedEntities: changed.length,
      impactedEntities: impacted.length,
      impactedFiles: files.size,
      occurrences: impacted.reduce((n, e) => n + e.occurrences.length, 0),
    },
  };
}

/** Human rendering — grouped by changed entity, each hit cited file:line with confidence. */
export function renderDocsImpact(report, { maxPerEntity = 8 } = {}) {
  const out = [
    `docs impact — diff vs ${report.base}: ${report.summary.changedEntities} changed entit${
      report.summary.changedEntities === 1 ? "y" : "ies"
    }, ${report.summary.impactedFiles} doc file(s) potentially stale`,
  ];
  if (!report.changed.length) {
    out.push("  clean — no documented entity changed in this diff.");
    return out.join("\n");
  }
  if (!report.impacted.length) {
    out.push(
      `  ${report.summary.changedEntities} entit${
        report.summary.changedEntities === 1 ? "y" : "ies"
      } changed, but no doc surface references them — nothing to review.`,
    );
    return out.join("\n");
  }
  for (const e of report.impacted) {
    const tag = e.removed ? "REMOVED" : "changed";
    out.push(`  ${e.type} \`${e.name}\` (${tag}) — ${e.occurrences.length} reference(s):`);
    for (const o of e.occurrences.slice(0, maxPerEntity)) {
      const where = o.section ? `  [${o.section}]` : "";
      out.push(
        `      ${o.file}:${o.line}  (${o.context}, ${o.confidence.toFixed(2)})${where}  ${o.snippet}`,
      );
    }
    if (e.occurrences.length > maxPerEntity)
      out.push(`      (+${e.occurrences.length - maxPerEntity} more)`);
  }
  out.push(
    "  → review each surface: update it, or confirm the mention is still correct. Advisory — image/design/paraphrase impact is not detectable by a token scan.",
  );
  return out.join("\n");
}

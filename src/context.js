// forge context — context assembly as a budgeted optimization with a completeness
// gate (docs/plans/substrate-v2/04-context-assembly.md). Two failures die here:
// over-stuffing (everything competes for the window on equal terms — P3 of the
// paper) and under-supplying (the agent edits a symbol without its callers, tests,
// or the team's lessons, then "assumes"). Selection gets an objective function
// (greedy knapsack by value density, with a compression ladder instead of silent
// drops) and sufficiency becomes a COMPUTED SET: required knowledge R(edit) from
// the atlas, missing = R \ covered — auto-fetched when resolvable, asked as a
// derived M2 question when not. Context insufficiency stops being a feeling.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { has as atlasHas, query as atlasQuery, impact } from "./atlas.js";
import { claimText, val } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { referencedEntities } from "./preflight.js";

/** chars → tokens heuristic (calibrated in P8; consistent with the reuse estimator). */
export const tokensOf = (text) => Math.ceil(String(text).length / 3.6);

/** Lessons must be THIS trusted to enter the required set (spec §3: lessons*(S)). */
export const LESSON_REQUIRED_VAL = 0.8;
/** Per-source diminishing returns for optional items (spec §2). */
const SOURCE_DISCOUNT = 0.7;
/** Default assembly budget in tokens (callers pass the real per-tool cap). */
export const DEFAULT_BUDGET = 6000;

const readRel = (root, rel) => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
};

// Sibling-test detection (same heuristics family as substrate's predictFailingTests,
// local here to keep the import graph one-directional: substrate → context, never back).
const isTestFile = (f) => /(\.|_)(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\//.test(f);
function siblingTests(root, file) {
  const dir = dirname(file);
  const base = basename(file).replace(/\.[^.]+$/, "");
  const ext = file.match(/\.[^.]+$/)?.[0] ?? ".js";
  const candidates = [
    join(dir, `${base}.test${ext}`),
    join(dir, `${base}.spec${ext}`),
    join(dir, "__tests__", `${base}.test${ext}`),
    join("test", `${base}.test${ext}`),
    join("tests", `${base}.test${ext}`),
  ];
  return candidates.filter((c) => existsSync(join(root, c)));
}

/**
 * The required-knowledge set R(edit) — computed, not vibes (spec §3):
 *   defs(S) ∪ blast₁(S) ∪ tests(S) ∪ lessons*(S)
 * Each entry: { key, kind, name, resolvable } — unresolvable entries are exactly the
 * derived clarifying questions.
 */
export function requiredSet(root, task, { atlas = null, claims = [], nowDay = 0 } = {}) {
  const entities = referencedEntities(String(task || ""));
  const R = [];
  const targetFiles = new Set();

  for (const s of entities.symbols) {
    const known = atlas ? atlasHas(atlas, s) : false;
    R.push({ key: `def:${s}`, kind: "def", name: s, resolvable: known });
    if (known)
      for (const hit of atlasQuery(atlas, s))
        if (hit.name === s || hit.qname === s) targetFiles.add(hit.file);
    if (known) R.push({ key: `deps:${s}`, kind: "deps", name: s, resolvable: true });
  }
  for (const f of entities.files) {
    const onDisk = existsSync(join(root, f));
    R.push({ key: `file:${f}`, kind: "file", name: f, resolvable: onDisk });
    if (onDisk) targetFiles.add(f);
  }
  for (const f of targetFiles) {
    if (isTestFile(f)) continue;
    for (const t of siblingTests(root, f))
      R.push({ key: `tests:${t}`, kind: "tests", name: t, resolvable: true });
  }
  // Team lessons trusted past the floor, scope-matching the targets — required context:
  // an agent editing without them repeats a mistake the ledger already paid for.
  const names = new Set([...entities.symbols, ...entities.files.map((f) => basename(f))]);
  for (const c of claims) {
    if (c.kind !== "lesson" || c.tombstone || val(c, nowDay) < LESSON_REQUIRED_VAL) continue;
    const trig = [...(c.body.trigger?.symbols ?? []), ...(c.body.trigger?.files ?? [])];
    if (trig.some((t) => names.has(t) || names.has(basename(String(t)))))
      R.push({ key: `lesson:${c.id.slice(0, 8)}`, kind: "lesson", name: c.id, resolvable: true });
  }
  // Dedupe by key, deterministic order.
  const seen = new Set();
  return R.filter((r) => (seen.has(r.key) ? false : seen.add(r.key))).sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
}

// An item is one injectable unit with a COMPRESSION LADDER: granularity variants from
// full text down to a one-line pointer. The optimizer may downgrade an item instead of
// dropping it — compression is a lossy move with a known cost, chosen explicitly,
// never by scroll-off (spec §2).
function fileItem(root, rel, { covers, source, score }) {
  const text = readRel(root, rel);
  if (text === null) return null;
  const head = text.split("\n").slice(0, 25).join("\n");
  const variants = [
    { gran: "full", text: `// ${rel}\n${text}`, tokens: tokensOf(text) },
    { gran: "head", text: `// ${rel} (first 25 lines)\n${head}`, tokens: tokensOf(head) },
    { gran: "pointer", text: `- read ${rel}`, tokens: 8 },
  ];
  return { id: `${source}:${rel}`, source, covers, score, variants };
}

/**
 * Assemble the context for a task: pinned required items (downgraded before dropped),
 * optional items greedily by value density, and the missing set as derived questions.
 * @param {string} root
 * @param {string} task
 * @param {{budget?:number, atlas?:any, claims?:any[], nowDay?:number}} [opts]
 */
export function assemble(
  root,
  task,
  { budget = DEFAULT_BUDGET, atlas = null, claims, nowDay = 0 } = {},
) {
  const ledgerDir = repoLedger(root);
  const allClaims = claims ?? (existsSync(join(ledgerDir, "claims")) ? loadClaims(ledgerDir) : []);
  const required = requiredSet(root, task, { atlas, claims: allClaims, nowDay });

  // --- build candidate items, keyed by what they cover -------------------------------
  const items = [];
  for (const r of required) {
    if (!r.resolvable) continue;
    if (r.kind === "def") {
      const hit = atlasQuery(atlas, r.name).find((s) => s.name === r.name || s.qname === r.name);
      if (hit?.file) {
        const it = fileItem(root, hit.file, { covers: [r.key], source: "def", score: 1 });
        if (it) items.push(it);
      }
    } else if (r.kind === "file") {
      const it = fileItem(root, r.name, { covers: [r.key], source: "def", score: 1 });
      if (it) items.push(it);
    } else if (r.kind === "tests") {
      const it = fileItem(root, r.name, { covers: [r.key], source: "tests", score: 0.9 });
      if (it) items.push(it);
    } else if (r.kind === "deps" && atlas) {
      const hop1 = impact(atlas, r.name, { maxHops: 1 })
        .impacted.filter((x) => x.hopDistance === 1)
        .slice(0, 12);
      const text = hop1.length
        ? [
            `direct dependents of ${r.name} (edit these with it or verify them):`,
            ...hop1.map((x) => `  - ${x.node.name} (${x.node.file}, via ${x.edgeKinds[0]})`),
          ].join("\n")
        : `no direct dependents of ${r.name} found in the atlas`;
      items.push({
        id: `deps:${r.name}`,
        source: "deps",
        covers: [r.key],
        score: 1,
        variants: [{ gran: "full", text, tokens: tokensOf(text) }],
      });
    } else if (r.kind === "lesson") {
      const c = allClaims.find((x) => x.id === r.name);
      if (c) {
        const text = `lesson (val ${val(c, nowDay).toFixed(2)}): ${c.body.correctedBehavior}`;
        items.push({
          id: `lesson:${c.id.slice(0, 8)}`,
          source: "lesson",
          covers: [r.key],
          score: 0.95,
          variants: [{ gran: "full", text, tokens: tokensOf(text) }],
        });
      }
    }
  }
  // Optional extras: trusted scope-matching facts (nice-to-have, never required).
  for (const c of allClaims) {
    if (c.kind !== "fact" || c.tombstone) continue;
    const v = val(c, nowDay);
    if (v < 0.5) continue;
    const text = `fact: ${claimText(c)}`;
    items.push({
      id: `fact:${c.id.slice(0, 8)}`,
      source: "fact",
      covers: [],
      score: 0.3 + 0.4 * v,
      variants: [{ gran: "full", text, tokens: tokensOf(text) }],
    });
  }

  // A symbol's definition and an explicitly named file often resolve to the SAME file —
  // merge items by id (union of covered keys) so one span never gets injected twice.
  const byId = new Map();
  for (const it of items) {
    const prev = byId.get(it.id);
    if (prev) {
      prev.covers = [...new Set([...prev.covers, ...it.covers])];
      prev.score = Math.max(prev.score, it.score);
    } else byId.set(it.id, it);
  }
  const merged = [...byId.values()];

  // --- selection: pin required coverage, downgrade before dropping -------------------
  const pinned = merged.filter((i) => i.covers.length);
  const optional = merged
    .filter((i) => !i.covers.length)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const chosen = pinned.map((i) => ({ item: i, v: 0 })); // v = variant index
  const used = () => chosen.reduce((n, c) => n + c.item.variants[c.v].tokens, 0);
  // Downgrade the largest pinned item one rung at a time until the pins fit the budget.
  while (used() > budget) {
    const cand = chosen
      .filter((c) => c.v < c.item.variants.length - 1)
      .sort((a, b) => b.item.variants[b.v].tokens - a.item.variants[a.v].tokens)[0];
    if (!cand) break; // everything is already a pointer — required coverage beats budget
    cand.v++;
  }
  // Greedy fill by value density with per-source diminishing returns.
  const perSource = {};
  for (const item of optional) {
    const variant = item.variants[0];
    const discount = SOURCE_DISCOUNT ** (perSource[item.source] ?? 0);
    if (used() + variant.tokens > budget) continue;
    chosen.push({ item, v: 0 });
    perSource[item.source] = (perSource[item.source] ?? 0) + 1;
    if (discount < 0.2) break; // fourth+ item from one source: value has decayed away
  }

  const covered = new Set(chosen.flatMap((c) => c.item.covers));
  const missing = required.filter((r) => !r.resolvable || !covered.has(r.key));
  const questions = missing
    .filter((r) => !r.resolvable)
    .map((r) =>
      r.kind === "def"
        ? `The task names \`${r.name}\` but the repo doesn't define it — which file implements it (or is it new)?`
        : `The task names \`${r.name}\` but that file doesn't exist — where should this live?`,
    );

  return {
    ok: missing.length === 0,
    budget,
    tokens: used(),
    required: required.map((r) => r.key),
    covered: [...covered].sort(),
    missing: missing.map((r) => r.key),
    questions,
    selection: chosen.map((c) => ({
      id: c.item.id,
      source: c.item.source,
      gran: c.item.variants[c.v].gran,
      tokens: c.item.variants[c.v].tokens,
    })),
    block: chosen.map((c) => c.item.variants[c.v].text).join("\n\n"),
  };
}

/** Human rendering for `forge context`. */
export function renderContext(r) {
  const lines = ["Forge context — budgeted assembly + completeness gate", ""];
  lines.push(
    `  budget: ${r.tokens}/${r.budget} tokens · required ${r.required.length} · ${r.ok ? "COMPLETE" : "INCOMPLETE"}`,
  );
  for (const s of r.selection) lines.push(`    + ${s.id} [${s.gran}] ${s.tokens}t`);
  if (r.missing.length) {
    lines.push("", "  missing (computed, not a feeling):");
    for (const m of r.missing) lines.push(`    - ${m}`);
  }
  if (r.questions.length) {
    lines.push("", "  ask before acting:");
    for (const q of r.questions) lines.push(`    ? ${q}`);
  }
  return lines.join("\n");
}

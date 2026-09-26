// forge context — context assembly as a budgeted optimization with a completeness
// gate (docs/plans/substrate-v2/04-context-assembly.md). Two failures die here:
// over-stuffing (everything competes for the window on equal terms — P3 of the
// paper) and under-supplying (the agent edits a symbol without its callers, tests,
// or the team's lessons, then "assumes"). Selection gets an objective (a greedy
// value-density heuristic with a compression ladder instead of silent drops — no
// approximation guarantee is claimed) and sufficiency becomes a COMPUTED SET: required
// knowledge R(edit) from the atlas, missing = R \ covered — auto-fetched when resolvable,
// asked as a derived M2 question when not. "Covered" means DELIVERED in the block: a
// pointer to a file is a pending read, not coverage (review F03), and a block that cannot
// fit the budget says so instead of claiming completion (review F02).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { has as atlasHas, query as atlasQuery, impact } from "./atlas.js";
import { claimText, val } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { referencedEntities } from "./preflight.js";

/** chars → tokens ESTIMATE (chars/3.6, consistent with the reuse estimator). It is not a
 *  model tokenizer: a hard window limit needs the target model's own tokenizer, so treat
 *  every budget here as an estimate with that stated basis. */
export const tokensOf = (text) => Math.ceil(String(text).length / 3.6);
/** How `tokens` is measured — reported with every assembly so nobody mistakes it for exact. */
export const TOKEN_ESTIMATE = "chars/3.6 estimate of the rendered block";
/** Items are joined with this separator; its cost is budgeted like any other text. */
const SEP = "\n\n";
/** Direct dependents listed by name before the rest are summarized as omitted. */
const DEPS_SHOWN = 12;
/** Lines of source shown after a definition's line in a symbol-span variant. */
const SPAN_AFTER = 40;
const SPAN_BEFORE = 2;
const HEAD_LINES = 25;

/** Lessons must be THIS trusted to enter the required set (spec §3: lessons*(S)). */
export const LESSON_REQUIRED_VAL = 0.8;
/** Per-source diminishing returns for optional items (spec §2): the j-th item taken from
 *  one source is worth δ^(j−1). Once that falls below the floor the source's value has
 *  decayed away — with δ = 0.7 that is the 4th item (δ³ ≈ 0.34), so each source adds at
 *  most three optional items. */
const SOURCE_DISCOUNT = 0.7;
const SOURCE_VALUE_FLOOR = 0.4;
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
// dropping it — compression is a lossy move with a known cost, chosen explicitly, never by
// scroll-off (spec §2). EVERY VARIANT CARRIES ITS OWN COVERAGE (review F03): the full file
// covers all its keys; a symbol span covers the definitions whose declaration line it shows;
// the first-25-lines head covers only what lies inside it; a pointer (`- read <file>`)
// covers NOTHING — it creates a pending read obligation. Availability is not delivery.

/** One variant: its rendered text, estimated tokens, the keys it satisfies, the keys it only
 *  points at (pending reads), and what it truncated. */
const variant = (gran, text, covers, pending = [], truncated = null) => ({
  gran,
  text,
  tokens: tokensOf(text),
  covers,
  pending,
  ...(truncated ? { truncated } : {}),
});

/**
 * All variants of one file, given the required keys it serves: `needs` entries are
 * {key, kind: "def"|"file"|"tests", line?}. Ordered largest → smallest; a variant that is not
 * smaller than the previous one is skipped.
 */
function fileItem(root, rel, { needs, source, score }) {
  const text = readRel(root, rel);
  if (text === null) return null;
  const lines = text.split("\n");
  const total = lines.length;
  const keys = needs.map((n) => n.key);
  const defs = needs.filter((n) => n.kind === "def" && Number.isFinite(n.line));
  const variants = [variant("full", `// ${rel}\n${text}`, keys)];
  // Symbol span: the lines around the requested definitions, when the atlas knows them.
  if (defs.length) {
    const from = Math.max(1, Math.min(...defs.map((d) => d.line)) - SPAN_BEFORE);
    const to = Math.min(total, Math.max(...defs.map((d) => d.line)) + SPAN_AFTER);
    if (from > 1 || to < total) {
      const covers = defs.filter((d) => d.line >= from && d.line <= to).map((d) => d.key);
      variants.push(
        variant(
          "span",
          `// ${rel}:${from}-${to} of ${total} (definition span)\n${lines.slice(from - 1, to).join("\n")}`,
          covers,
          keys.filter((k) => !covers.includes(k)),
          { shownLines: [from, to], totalLines: total },
        ),
      );
    }
  }
  if (total > HEAD_LINES) {
    // The head covers a definition only if its declaration line is inside the head; a whole
    // file or test file is never "covered" by its first 25 lines.
    const covers = needs
      .filter((n) => n.kind === "def" && Number.isFinite(n.line) && n.line <= HEAD_LINES)
      .map((n) => n.key);
    variants.push(
      variant(
        "head",
        `// ${rel} (first ${HEAD_LINES} of ${total} lines)\n${lines.slice(0, HEAD_LINES).join("\n")}`,
        covers,
        keys.filter((k) => !covers.includes(k)),
        { shownLines: [1, HEAD_LINES], totalLines: total },
      ),
    );
  }
  variants.push(variant("pointer", `- read ${rel}`, [], keys));
  const ladder = [];
  for (const v of variants.sort((a, b) => b.tokens - a.tokens))
    if (!ladder.length || v.tokens < ladder[ladder.length - 1].tokens) ladder.push(v);
  return { id: `${source}:${rel}`, source, covers: keys, score, variants: ladder };
}

/**
 * Assemble the context for a task: pinned required items (downgraded before dropped),
 * optional items greedily by value density, and the missing set as derived questions.
 *
 * Honesty contract (review F02/F03):
 *   - `tokens` is measured on the RENDERED block (labels and separators included) with the
 *     chars/3.6 estimate (`tokenEstimate` says so). The block never exceeds `budget` by that
 *     measure: when even pointers cannot fit, required items are DROPPED (lowest score first)
 *     and reported, with `overflow: true`.
 *   - `covered` holds only keys whose content was actually delivered; `pending` holds keys the
 *     block merely points at (a pointer, or a partial span/head) — read obligations; `missing`
 *     holds keys neither delivered nor pointed at (unresolvable, or dropped on overflow).
 *   - `ok` means every required key was DELIVERED within budget: no missing, no pending, no
 *     overflow. It is syntactic delivery, not semantic sufficiency.
 *   - Optional items are chosen greedily by value density (score per token) with per-source
 *     diminishing returns — a heuristic, with no knapsack or set-cover guarantee (the
 *     per-source discount breaks the preconditions those guarantees need).
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
  // File-backed keys are grouped per file first, so one file is one item whose variants
  // know exactly which of its keys each one delivers.
  /** @type {Map<string, {needs: {key:string, kind:string, line?:number}[], source:string, score:number}>} */
  const files = new Map();
  const need = (rel, n, source, score) => {
    const f = files.get(rel) ?? { needs: [], source, score };
    f.needs.push(n);
    if (score > f.score) {
      f.score = score;
      f.source = source;
    }
    files.set(rel, f);
  };
  const items = [];
  /** @type {{id:string, shown:number, total:number, omitted:string[]}[]} */
  const truncated = [];
  for (const r of required) {
    if (!r.resolvable) continue;
    if (r.kind === "def") {
      const hit = atlasQuery(atlas, r.name).find((s) => s.name === r.name || s.qname === r.name);
      if (hit?.file) need(hit.file, { key: r.key, kind: "def", line: hit.line }, "def", 1);
    } else if (r.kind === "file") {
      need(r.name, { key: r.key, kind: "file" }, "def", 1);
    } else if (r.kind === "tests") {
      need(r.name, { key: r.key, kind: "tests" }, "tests", 0.9);
    } else if (r.kind === "deps" && atlas) {
      const hop1 = impact(atlas, r.name, { maxHops: 1 }).impacted.filter(
        (x) => x.hopDistance === 1,
      );
      const shown = hop1.slice(0, DEPS_SHOWN);
      const omitted = hop1.slice(DEPS_SHOWN).map((x) => `${x.node.name} (${x.node.file})`);
      if (omitted.length)
        truncated.push({ id: `deps:${r.name}`, shown: shown.length, total: hop1.length, omitted });
      const text = hop1.length
        ? [
            `direct dependents of ${r.name} (edit these with it or verify them):`,
            ...shown.map((x) => `  - ${x.node.name} (${x.node.file}, via ${x.edgeKinds[0]})`),
            ...(omitted.length
              ? [`  … and ${omitted.length} more, omitted here (\`forge impact ${r.name}\`)`]
              : []),
          ].join("\n")
        : `no direct dependents of ${r.name} found in the atlas`;
      items.push({
        id: `deps:${r.name}`,
        source: "deps",
        covers: [r.key],
        score: 1,
        variants: [
          variant("full", text, [r.key]),
          variant("pointer", `- dependents: \`forge impact ${r.name}\``, [], [r.key]),
        ],
      });
    } else if (r.kind === "lesson") {
      const c = allClaims.find((x) => x.id === r.name);
      if (c) {
        const text = `lesson (val ${val(c, nowDay).toFixed(2)}): ${c.body.correctedBehavior}`;
        const id8 = c.id.slice(0, 8);
        items.push({
          id: `lesson:${id8}`,
          source: "lesson",
          covers: [r.key],
          score: 0.95,
          variants: [
            variant("full", text, [r.key]),
            variant("pointer", `- lesson: \`forge ledger show ${id8}\``, [], [r.key]),
          ],
        });
      }
    }
  }
  for (const [rel, f] of files) {
    const it = fileItem(root, rel, f);
    if (it) items.push(it);
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
      variants: [variant("full", text, [])],
    });
  }

  // --- selection: pin required coverage, downgrade before dropping -------------------
  const pinned = items.filter((i) => i.covers.length).sort((a, b) => (a.id < b.id ? -1 : 1));
  // Value density: score per token of the item's full variant (ties by id, deterministic).
  const density = (i) => i.score / Math.max(1, i.variants[0].tokens);
  const optional = items
    .filter((i) => !i.covers.length)
    .sort((a, b) => density(b) - density(a) || (a.id < b.id ? -1 : 1));
  let chosen = pinned.map((i) => ({ item: i, v: 0 })); // v = variant index
  const sepTokens = tokensOf(SEP);
  // Per-piece ceilings plus separators bound the rendered block's estimate from above.
  const used = () =>
    chosen.reduce((n, c) => n + c.item.variants[c.v].tokens, 0) +
    Math.max(0, chosen.length - 1) * sepTokens;
  // Downgrade the largest pinned item one rung at a time until the pins fit the budget.
  while (used() > budget) {
    const cand = chosen
      .filter((c) => c.v < c.item.variants.length - 1)
      .sort(
        (a, b) =>
          b.item.variants[b.v].tokens - a.item.variants[a.v].tokens ||
          (a.item.id < b.item.id ? -1 : 1),
      )[0];
    if (!cand) break;
    cand.v++;
  }
  // Everything is already at its smallest rung and still does not fit: the budget cannot
  // hold the required set. Drop pinned items (lowest score first, then largest) and SAY so —
  // never return a block over budget, and never call it complete (F02).
  /** @type {string[]} */
  const dropped = [];
  while (used() > budget && chosen.length) {
    const worst = [...chosen].sort(
      (a, b) =>
        a.item.score - b.item.score ||
        b.item.variants[b.v].tokens - a.item.variants[a.v].tokens ||
        (a.item.id < b.item.id ? 1 : -1),
    )[0];
    chosen = chosen.filter((c) => c !== worst);
    dropped.push(worst.item.id);
  }
  const overflow = dropped.length > 0;
  // Greedy fill by value density with per-source diminishing returns. The cut is checked
  // BEFORE taking an item, and skips only that source — other sources keep competing
  // (a `break` here used to end the whole fill, and only after taking a 6th item).
  const perSource = {};
  for (const item of optional) {
    const taken = perSource[item.source] ?? 0;
    if (SOURCE_DISCOUNT ** taken < SOURCE_VALUE_FLOOR) continue; // 4th+ from this source
    const v = item.variants[0];
    if (used() + v.tokens + (chosen.length ? sepTokens : 0) > budget) continue;
    chosen.push({ item, v: 0 });
    perSource[item.source] = taken + 1;
  }

  const block = chosen.map((c) => c.item.variants[c.v].text).join(SEP);
  const covered = new Set(chosen.flatMap((c) => c.item.variants[c.v].covers));
  const pending = new Set(
    chosen.flatMap((c) => c.item.variants[c.v].pending).filter((k) => !covered.has(k)),
  );
  const missing = required.filter(
    (r) => !r.resolvable || (!covered.has(r.key) && !pending.has(r.key)),
  );
  const questions = missing
    .filter((r) => !r.resolvable)
    .map((r) =>
      r.kind === "def"
        ? `The task names \`${r.name}\` but the repo doesn't define it — which file implements it (or is it new)?`
        : `The task names \`${r.name}\` but that file doesn't exist — where should this live?`,
    );
  for (const c of chosen) {
    const t = c.item.variants[c.v].truncated;
    if (t) truncated.push({ id: c.item.id, ...t });
  }

  return {
    ok: missing.length === 0 && pending.size === 0 && !overflow,
    budget,
    tokens: tokensOf(block),
    tokenEstimate: TOKEN_ESTIMATE,
    overflow,
    ...(overflow ? { dropped } : {}),
    required: required.map((r) => r.key),
    covered: [...covered].sort(),
    pending: [...pending].sort(),
    missing: missing.map((r) => r.key),
    questions,
    truncated,
    selection: chosen.map((c) => ({
      id: c.item.id,
      source: c.item.source,
      gran: c.item.variants[c.v].gran,
      tokens: c.item.variants[c.v].tokens,
      covers: c.item.variants[c.v].covers,
    })),
    block,
  };
}

/** Human rendering for `forge context`. */
export function renderContext(r) {
  const lines = ["Forge context — budgeted assembly + completeness gate", ""];
  const state = r.ok ? "COMPLETE" : r.overflow ? "OVER BUDGET — INCOMPLETE" : "INCOMPLETE";
  lines.push(
    `  budget: ${r.tokens}/${r.budget} tokens (${r.tokenEstimate ?? TOKEN_ESTIMATE}) · required ${r.required.length} · ${state}`,
  );
  for (const s of r.selection) lines.push(`    + ${s.id} [${s.gran}] ${s.tokens}t`);
  if (r.overflow)
    lines.push(
      "",
      `  over budget: even pointers could not fit — dropped ${(r.dropped ?? []).join(", ")}`,
    );
  if (r.pending?.length) {
    lines.push("", "  pending reads (pointed at, not delivered — read before acting):");
    for (const p of r.pending) lines.push(`    - ${p}`);
  }
  for (const t of r.truncated ?? [])
    if (t.omitted?.length)
      lines.push(
        `    ~ ${t.id}: ${t.omitted.length} of ${t.total} omitted (${t.omitted.slice(0, 5).join(", ")}${t.omitted.length > 5 ? ", …" : ""})`,
      );
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

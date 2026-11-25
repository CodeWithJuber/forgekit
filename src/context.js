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
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { has as atlasHas, query as atlasQuery, impact, indexedText } from "./atlas.js";
import { workspaceEvidence } from "./harness_tools.js";
import {
  claimText,
  evidenceEvents,
  jaccard,
  refStrength,
  retrieve,
  sketch,
  val,
} from "./ledger.js";
import { claimToLesson } from "./ledger_read.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { referencedEntities } from "./preflight.js";
import { hasSecret } from "./secrets.js";
import { mapToTests } from "./test_select.js";
import { byteCounter } from "./token_count.js";

export const tokensOf = byteCounter.count;
export const TOKEN_ESTIMATE = byteCounter.label;
/** Items are joined with this separator; its cost is budgeted like any other text. */
const SEP = "\n\n";
/** Default assembly budget in tokens (callers pass the real per-tool cap). */
export const DEFAULT_BUDGET = 6000;

// Context pointers may also use resolved imports by discovered test files. Only
// the independently measured graph can authorize executing a smaller test suite.
function relatedTests(root, targets, atlas) {
  if (!targets.size) return [];
  const tests = new Set(mapToTests(root, [...targets]));
  const files = new Map((atlas?.nodes ?? []).map((n) => [n.id, n.file]));
  for (const edge of atlas?.edges ?? []) {
    const consumer = files.get(edge.source);
    if (
      edge.kind === "imports" &&
      edge.resolved &&
      targets.has(files.get(edge.target)) &&
      typeof consumer === "string" &&
      /(?:[._](?:test|spec)\.[^/]+$|(?:^|\/)(?:tests?|__tests__)\/)/.test(consumer)
    )
      tests.add(consumer);
  }
  return [...tests].sort();
}

/**
 * The required-knowledge set R(edit) — computed, not vibes (spec §3):
 *   defs(S) ∪ blast₁(S) ∪ tests(S) ∪ lessons*(S)
 * Each entry: { key, kind, name, resolvable } — unresolvable entries are exactly the
 * derived clarifying questions.
 */
export function requiredSet(root, task, { atlas = null, claims = [] } = {}) {
  const entities = referencedEntities(String(task || ""));
  /** @type {{key:string, kind:string, name:string, resolvable:boolean, withheld?:string}[]} */
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
    const access = workspaceEvidence(root, f, { inspectOnly: true });
    R.push({
      key: `file:${f}`,
      kind: "file",
      name: f,
      resolvable: access.available,
      ...(access.reason && access.reason !== "missing" ? { withheld: access.reason } : {}),
    });
    if (access.available) targetFiles.add(f);
  }
  for (const t of relatedTests(root, targetFiles, atlas))
    R.push({ key: `tests:${t}`, kind: "tests", name: t, resolvable: true });
  // A directly relevant, independently confirmed lesson remains required while uncontested.
  const names = new Set([...entities.symbols, ...entities.files.map((f) => basename(f))]);
  for (const c of claims) {
    if (c.kind !== "lesson" || c.tombstone) continue;
    if (c.body?.correctionVersion === 2 && claimToLesson(c, 0, root).status !== "active") continue;
    const observations = evidenceEvents(c.evidence);
    if (
      observations.some((e) => e.result !== "confirm") ||
      !observations.some(
        (e) =>
          refStrength(e.ref, e.oracle) === "resolved" &&
          String(e.ref).startsWith("git:") &&
          !String(e.author ?? "").startsWith("agent:"),
      )
    )
      continue;
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
// scroll-off (spec §2). EVERY VARIANT CARRIES ITS OWN COVERAGE (review F03, then N04): the
// full file covers all its keys; a span or the first-25-lines head covers a definition only
// when it shows the WHOLE definition, declaration through its last line (the atlas records
// each definition's extent, `endLine`). One that shows the declaration but cuts the body is
// PARTIAL — named in `partial` and still a pending read, so a 104-line function delivered as
// its first 41 lines is never reported as a delivered definition. A definition whose extent
// is unknown is covered by the whole file only. A pointer (`- read <file>`) covers NOTHING —
// it creates a pending read obligation. Availability is not delivery.

/** One variant: its rendered text, estimated tokens, the keys it satisfies, the keys it only
 *  points at (pending reads), what it truncated, and the definitions it shows only in part
 *  (`{key, shown, definition}` line ranges — a partial key is also pending). */
const makeVariant =
  (count) =>
  (gran, text, covers, pending = [], truncated = null, partial = []) => ({
    gran,
    text,
    tokens: count(text),
    covers,
    pending,
    ...(truncated ? { truncated } : {}),
    ...(partial.length ? { partial } : {}),
  });

/** Split definition needs by what a [from, to] line window shows of them: `covers` — the whole
 *  definition; `partial` — the declaration line but not its end (or an unknown end). */
function windowCoverage(defs, from, to) {
  const covers = [];
  const partial = [];
  for (const d of defs) {
    if (d.line < from || d.line > to) continue;
    if (Number.isFinite(d.endLine) && d.endLine <= to) covers.push(d.key);
    else
      partial.push({
        key: d.key,
        shown: [from, to],
        definition: [d.line, Number.isFinite(d.endLine) ? d.endLine : null],
      });
  }
  return { covers, partial };
}

/**
 * All variants of one file, given the required keys it serves: `needs` entries are
 * {key, kind: "def"|"file"|"tests", line?, endLine?}. Ordered largest → smallest; a variant
 * that is not smaller than the previous one is skipped.
 */
function fileItem(text, rel, { needs, source }, atlas, variant) {
  const lines = text.split("\n");
  const total = lines.length;
  const keys = needs.map((n) => n.key);
  // Definition lines and extents come from the atlas and locate a definition only in the text
  // it indexed: in a file edited since (a stale atlas) no window is known to show one, so only
  // the whole file covers it.
  const located = indexedText(atlas, rel, text);
  const defs = located ? needs.filter((n) => n.kind === "def" && Number.isFinite(n.line)) : [];
  const variants = [variant("full", `// ${rel}\n${text}`, keys)];
  const windowed = (gran, label, from, to) => {
    const { covers, partial } = windowCoverage(defs, from, to);
    return variant(
      gran,
      `// ${rel}:${from}-${to} of ${total} (${label})\n${lines.slice(from - 1, to).join("\n")}`,
      covers,
      keys.filter((k) => !covers.includes(k)),
      { shownLines: [from, to], totalLines: total },
      partial,
    );
  };
  const from = defs.length ? Math.min(...defs.map((d) => d.line)) : 1;
  const lastKnown =
    defs.length && defs.every((d) => Number.isFinite(d.endLine))
      ? Math.min(total, Math.max(...defs.map((d) => Number(d.endLine))))
      : total;
  if (defs.length && (from > 1 || lastKnown < total))
    variants.push(windowed("span", "requested definitions", from, lastKnown));
  // Halve the remaining range, giving the allocator successively smaller windows.
  for (
    let length = Math.floor((lastKnown - from + 1) / 2);
    length;
    length = Math.floor(length / 2)
  ) {
    const to = from + length - 1;
    variants.push(windowed(defs.length ? "span" : "head", "source excerpt", from, to));
  }
  variants.push(variant("pointer", `- read ${rel}`, [], keys));
  // The whole file is always the top rung; every lower rung is strictly smaller (a window
  // whose label outweighs the lines it saves is no compression at all, and would otherwise
  // outrank the full file while delivering less of it).
  const [full, ...smaller] = variants;
  const ladder = [full];
  for (const v of smaller.sort((a, b) => b.tokens - a.tokens))
    if (v.tokens < ladder[ladder.length - 1].tokens) ladder.push(v);
  return { id: `${source}:${rel}`, source, covers: keys, score: keys.length, variants: ladder };
}

/**
 * Assemble the context for a task: pinned required items (downgraded before dropped),
 * optional items greedily by value density, and the missing set as derived questions.
 *
 * Honesty contract (review F02/F03/N04):
 *   - `tokens` is measured on the RENDERED block (labels and separators included) with the
 *     selected tokenizer or the reported UTF-8 byte bound. The block never exceeds `budget` by that
 *     measure: when even pointers cannot fit, required items are DROPPED (lowest score first)
 *     and reported, with `overflow: true`.
 *   - `covered` holds only keys whose content was actually delivered — for a definition, the
 *     WHOLE definition, declaration through its last line; `pending` holds keys the block
 *     merely points at (a pointer, a head or span that cuts the body) — read obligations;
 *     `partial` names the definitions whose declaration was shown but whose body was cut
 *     (shown lines vs the definition's extent); `missing` holds keys neither delivered nor
 *     pointed at (unresolvable, or dropped on overflow).
 *   - `ok` means every required key was DELIVERED within budget: no missing, no pending (so
 *     no partial definition), no overflow. It is syntactic delivery, not semantic
 *     sufficiency.
 *   - Optional items are chosen greedily by value density (score per token) discounted by overlap
 *     with already selected evidence. There is no fixed quota on facts from a source.
 * @param {string} root
 * @param {string} task
 * @param {{budget?:number, atlas?:any, claims?:any[], nowDay?:number, includeSegments?:boolean, counter?:import("./token_count.js").ContextCounter}} [opts]
 */
export function assemble(
  root,
  task,
  {
    budget = DEFAULT_BUDGET,
    atlas = null,
    claims,
    nowDay = 0,
    includeSegments = false,
    counter = byteCounter,
  } = {},
) {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new RangeError("context budget must be a nonnegative integer");
  const variant = makeVariant(counter.count);
  const ledgerDir = repoLedger(root);
  const allClaims = claims ?? (existsSync(join(ledgerDir, "claims")) ? loadClaims(ledgerDir) : []);
  const required = requiredSet(root, task, { atlas, claims: allClaims });
  const withheld = required
    .filter((r) => r.withheld)
    .map((r) => ({ source: r.name, reason: r.withheld, keys: [r.key] }));

  // --- build candidate items, keyed by what they cover -------------------------------
  // File-backed keys are grouped per file first, so one file is one item whose variants
  // know exactly which of its keys each one delivers.
  /** @type {Map<string, {needs: {key:string, kind:string, line?:number, endLine?:number}[], source:string}>} */
  const files = new Map();
  const need = (rel, n, source) => {
    const f = files.get(rel) ?? { needs: [], source };
    f.needs.push(n);
    files.set(rel, f);
  };
  const items = [];
  /** @type {{id:string, shown:number, total:number, omitted:string[]}[]} */
  const truncated = [];
  for (const r of required) {
    if (!r.resolvable) continue;
    if (r.kind === "def") {
      const hit = atlasQuery(atlas, r.name).find((s) => s.name === r.name || s.qname === r.name);
      if (hit?.file)
        need(hit.file, { key: r.key, kind: "def", line: hit.line, endLine: hit.endLine }, "def");
    } else if (r.kind === "file") {
      need(r.name, { key: r.key, kind: "file" }, "def");
    } else if (r.kind === "tests") {
      need(r.name, { key: r.key, kind: "tests" }, "tests");
    } else if (r.kind === "deps" && atlas) {
      const hop1 = impact(atlas, r.name, { maxHops: 1 }).impacted.filter(
        (x) => x.hopDistance === 1,
      );
      const lines = hop1.map((x) => `${x.node.name} (${x.node.file}, via ${x.edgeKinds[0]})`);
      const heading = `direct dependents of ${r.name} (edit these with it or verify them):`;
      const text = lines.length
        ? [heading, ...lines.map((x) => `  - ${x}`)].join("\n")
        : `no direct dependents of ${r.name} found in the atlas`;
      const variants = [variant("full", text, [r.key])];
      for (let n = Math.floor(lines.length / 2); n; n = Math.floor(n / 2)) {
        const part = [
          heading,
          ...lines.slice(0, n).map((x) => `  - ${x}`),
          `  … ${lines.length - n} omitted (forge impact ${r.name})`,
        ].join("\n");
        if (counter.count(part) < variants.at(-1).tokens)
          variants.push(
            variant("partial", part, [], [r.key], {
              shown: n,
              total: lines.length,
              omitted: lines.slice(n),
            }),
          );
      }
      variants.push(variant("pointer", `- dependents: \`forge impact ${r.name}\``, [], [r.key]));
      items.push({ id: `deps:${r.name}`, source: "deps", covers: [r.key], score: 1, variants });
    } else if (r.kind === "lesson") {
      const c = allClaims.find((x) => x.id === r.name);
      if (c) {
        if (hasSecret(c.body.correctedBehavior)) {
          withheld.push({
            source: "ledger lesson",
            reason: "secret-shaped-content",
            keys: [r.key],
          });
          continue;
        }
        const text = `lesson (val ${val(c, nowDay).toFixed(2)}): ${c.body.correctedBehavior}`;
        const id8 = c.id.slice(0, 8);
        items.push({
          id: `lesson:${id8}`,
          source: "lesson",
          covers: [r.key],
          score: 1,
          variants: [
            variant("full", text, [r.key]),
            variant("pointer", `- lesson: \`forge ledger show ${id8}\``, [], [r.key]),
          ],
        });
      }
    }
  }
  for (const [rel, f] of files) {
    const input = workspaceEvidence(root, rel);
    if (!input.available || hasSecret(input.text)) {
      withheld.push({
        source: rel,
        reason: input.reason ?? "secret-shaped-content",
        keys: f.needs.map((n) => n.key),
      });
      continue;
    }
    items.push(fileItem(input.text, rel, f, atlas, variant));
  }
  // A free slot alone is no reason to send a fact to a model.
  const facts = allClaims.filter((c) => c.kind === "fact" && !c.tombstone);
  for (const { claim: c, rel, score } of retrieve(task, facts, { nowDay, budget: facts.length })) {
    if (!(rel > 0)) continue;
    const fact = claimText(c);
    if (hasSecret(fact)) {
      withheld.push({ source: "ledger fact", reason: "secret-shaped-content", keys: [] });
      continue;
    }
    const text = `fact: ${fact}`;
    items.push({
      id: `fact:${c.id.slice(0, 8)}`,
      source: "fact",
      covers: [],
      score: score * rel,
      variants: [variant("full", text, [])],
    });
  }

  // --- selection: pin required coverage, downgrade before dropping -------------------
  const pinned = items.filter((i) => i.covers.length).sort((a, b) => (a.id < b.id ? -1 : 1));
  const optional = items.filter((i) => !i.covers.length);
  let chosen = pinned.map((i) => ({ item: i, v: 0 })); // v = variant index
  const sepTokens = counter.count(SEP);
  // BPE merges can change at join boundaries. Measure the rendered text with the same encoder.
  const used = () =>
    counter.descriptor.kind === "utf8-bytes"
      ? chosen.reduce((n, c) => n + c.item.variants[c.v].tokens, 0) +
        Math.max(0, chosen.length - 1) * sepTokens
      : counter.count(chosen.map((c) => c.item.variants[c.v].text).join(SEP));
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
        a.item.variants[a.v].covers.length - b.item.variants[b.v].covers.length ||
        b.item.variants[b.v].tokens - a.item.variants[a.v].tokens ||
        (a.item.id < b.item.id ? 1 : -1),
    )[0];
    chosen = chosen.filter((c) => c !== worst);
    dropped.push(worst.item.id);
  }
  const overflow = dropped.length > 0;
  // Choose optional evidence by marginal value per estimated token. Exact repeats
  // have zero marginal information; related evidence pays a Jaccard penalty. Only
  // compare against optional records: required material retains its coverage rights.
  const available = budget - used() - (chosen.length ? sepTokens : 0);
  const candidates = optional
    .filter(
      (item) => counter.descriptor.kind !== "utf8-bytes" || item.variants[0].tokens <= available,
    )
    .map((item) => ({
      item,
      sketch: sketch(item.variants[0].text),
      similarity: 0,
    }));
  while (candidates.length) {
    let best = -1,
      highest = 0;
    const remaining = budget - used() - (chosen.length ? sepTokens : 0);
    for (const [index, candidate] of candidates.entries()) {
      const { item, similarity } = candidate;
      const v = item.variants[0];
      if (similarity === 1 || (counter.descriptor.kind === "utf8-bytes" && v.tokens > remaining))
        continue;
      const density = (item.score * (1 - similarity)) / Math.max(1, v.tokens);
      if (
        density > highest ||
        (best >= 0 && density === highest && item.id < candidates[best].item.id)
      ) {
        highest = density;
        best = index;
      }
    }
    if (best < 0) break;
    const [selected] = candidates.splice(best, 1);
    chosen.push({ item: selected.item, v: 0 });
    if (counter.descriptor.kind !== "utf8-bytes" && used() > budget) {
      chosen.pop();
      continue;
    }
    for (const candidate of candidates)
      candidate.similarity = Math.max(
        candidate.similarity,
        jaccard(candidate.sketch, selected.sketch),
      );
  }

  const segments = chosen.map((c) => c.item.variants[c.v].text);
  const block = segments.join(SEP);
  const covered = new Set(chosen.flatMap((c) => c.item.variants[c.v].covers));
  const pending = new Set(
    chosen.flatMap((c) => c.item.variants[c.v].pending).filter((k) => !covered.has(k)),
  );
  const missing = required.filter(
    (r) => !r.resolvable || (!covered.has(r.key) && !pending.has(r.key)),
  );
  // Definitions shown only in part (declaration delivered, body cut — review N04). Each is
  // also pending: the rest of the body is a read obligation, never "delivered".
  const partial = chosen
    .flatMap((c) => c.item.variants[c.v].partial ?? [])
    .filter((p) => !covered.has(p.key))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const questions = missing
    .filter((r) => !r.resolvable && !r.withheld)
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
    tokens: counter.count(block),
    tokenizer: counter.descriptor,
    tokenEstimate: counter.label,
    ...(withheld.length ? { withheld } : {}),
    overflow,
    ...(overflow ? { dropped } : {}),
    required: required.map((r) => r.key),
    covered: [...covered].sort(),
    pending: [...pending].sort(),
    partial,
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
    ...(includeSegments ? { segments } : {}),
  };
}

/** Human rendering for `forge context`. */
export function renderContext(r) {
  const lines = ["Forge context — budgeted assembly + completeness gate", ""];
  const state = r.ok ? "COMPLETE" : r.overflow ? "OVER BUDGET — INCOMPLETE" : "INCOMPLETE";
  lines.push(
    `  budget: ${r.tokens}/${r.budget} units (${r.tokenEstimate ?? TOKEN_ESTIMATE}) · required ${r.required.length} · ${state}`,
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
  for (const w of r.withheld ?? []) lines.push(`    withheld ${w.source} (${w.reason})`);
  for (const p of r.partial ?? [])
    lines.push(
      `    ~ ${p.key}: only lines ${p.shown[0]}-${p.shown[1]} shown of a definition spanning ${p.definition[0]}-${p.definition[1] ?? "?"} — the body is not delivered`,
    );
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

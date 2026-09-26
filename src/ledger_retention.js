// Ledger retention and compaction, learned from THIS ledger's own history. Pure: no fs, no
// clock. ledger_store.js supplies the claims and the usage log and applies the plan.
//
// The rule it replaces was a fixed review window (archive a tombstoned or dormant claim
// once 2 × 45 days passed since its last event) and a never-called clusters() at τ = 0.7.
// Nothing learned from use, and the session summaries the Stop hook mints every session
// were never contradicted, so they never went dormant and the ledger grew without bound.
// Here every cut-off is estimated from the ledger being compacted:
//
//  - ARCHIVE an unservable claim (tombstoned, or dormant: retrieve() already skips it, so
//    its chance of being served is zero by construction, not by a tuned threshold).
//  - ARCHIVE a live claim once it has been idle longer than any claim in this ledger has
//    ever been idle and then come back: the longest gap between two consecutive
//    activities of one claim. Past that point the ledger has never seen a reuse, so the
//    empirical chance of one is zero. An archived claim is no longer served and so can no
//    longer be used, which would make a wrong archive self-confirming. That is why the
//    cut-off is the longest comeback, not a typical one. (A replay that fit a cut-off by
//    F1 was tried first: it archived a claim used every 3 days on the day it fell due.)
//    The rule only switches on once the usage log spans longer than that gap. Before
//    then, "not used again" only means "use was not recorded".
//  - GROUP near-duplicates of one kind: each claim's nearest-neighbour similarity is
//    modelled as one Gaussian or two (hard split, Otsu), BIC picks the model, and only a
//    two-component fit yields a duplicate boundary (where the two posteriors are equal).
//    A ledger without duplicates yields none.
//
// Everything this plans is reversible: an archived claim keeps its bytes in the attic and
// its logs in place, and any new evidence brings it back (ledger_store appendRecord).

import { claimText, isDormant, jaccard, SKETCH_K, sketch, val } from "./ledger.js";
import { describeConflicts, semanticConflicts } from "./semantic_guard.js";

/** @typedef {{id: string, kind?: string, body?: any, provenance?: {t?: number},
 *   evidence?: {t?: number}[], tombstone?: {t?: number} | null}} Claim */

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The days a claim was active: minted, given evidence, or served (usage log). Sorted,
 * unique, integers.
 * @param {Claim} claim
 * @param {number[]} [useDays]
 * @returns {number[]}
 */
export function activityDays(claim, useDays = []) {
  const days = new Set();
  const add = (t) => {
    if (Number.isFinite(t)) days.add(Math.floor(t));
  };
  add(claim.provenance?.t);
  for (const e of claim.evidence ?? []) add(e.t);
  for (const t of useDays) add(t);
  return [...days].sort((a, b) => a - b);
}

/**
 * Learn the idle cut-off from the ledger's own history (see the header): the longest gap
 * after which any claim was active again.
 * @param {{days: number[]}[]} histories one per claim (or per id seen only in the usage
 *   log): its sorted activity days
 * @param {number} nowDay
 * @param {{usageSince?: number | null}} opts the first day the usage log recorded anything
 * @returns {{learned: boolean, reason?: string, cutoff?: number, typicalGap?: number,
 *   comebacks?: number, usageSpan?: number}}
 */
export function learnIdleCutoff(histories, nowDay, { usageSince = null } = {}) {
  if (usageSince == null)
    return { learned: false, reason: "no usage recorded yet — live claims are kept" };
  const gaps = [];
  for (const h of histories)
    for (let i = 1; i < h.days.length; i++) gaps.push(h.days[i] - h.days[i - 1]);
  if (!gaps.length)
    return {
      learned: false,
      reason: "no claim has been active twice — no comeback to learn from, live claims are kept",
    };
  const cutoff = Math.max(...gaps);
  const typicalGap = median(gaps) ?? undefined;
  const usageSpan = nowDay - usageSince;
  if (usageSpan <= cutoff)
    return {
      learned: false,
      cutoff,
      typicalGap,
      comebacks: gaps.length,
      usageSpan,
      reason: `the usage log spans ${usageSpan} d, not yet longer than the longest comeback (${cutoff} d) — live claims are kept`,
    };
  return { learned: true, cutoff, typicalGap, comebacks: gaps.length, usageSpan };
}

// ── Duplicates ────────────────────────────────────────────────────────────────────────

/** What a claim ASSERTS, for the semantic guard: a fact's text (its name is a unique label,
 *  not part of the statement), otherwise the claim's retrievable text. */
const statementOf = (c) => (c.kind === "fact" ? String(c.body?.text ?? "") : claimText(c));

/** Log-likelihood of xs under N(mu, v). */
const gaussLL = (xs, mu, v) =>
  xs.reduce((s, x) => s - 0.5 * (Math.log(2 * Math.PI * v) + (x - mu) ** 2 / v), 0);

const meanVar = (xs, floor) => {
  const mu = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length;
  return { mu, v: Math.max(v, floor) };
};

/**
 * One Gaussian or two, chosen by BIC, over nearest-neighbour similarities. The variance
 * floor is the MinHash estimate's own resolution (a step of 1/k, uniform quantisation
 * noise 1/(12k²)), so identical duplicates (similarity exactly 1) cannot make the
 * likelihood infinite. Returns the duplicate boundary, or null when one component wins.
 * @param {number[]} xs
 * @param {number} [k] sketch size
 * @returns {{boundary: number | null, bic1: number, bic2: number | null,
 *   low?: {mu: number, v: number, w: number}, high?: {mu: number, v: number, w: number}}}
 */
export function similarityBoundary(xs, k = SKETCH_K) {
  const n = xs.length;
  const floor = 1 / (12 * k * k);
  const one = meanVar(xs, floor);
  const bic1 = -2 * gaussLL(xs, one.mu, one.v) + 2 * Math.log(n);
  // A two-component fit has 5 parameters; with no more points than that it is not
  // identifiable, so one component stands.
  if (n <= 5) return { boundary: null, bic1, bic2: null };
  const s = [...xs].sort((a, b) => a - b);
  // Otsu: the split that maximises the between-class variance.
  let bestSplit = -1;
  let bestBetween = -1;
  let sumLeft = 0;
  const total = s.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n - 1; i++) {
    sumLeft += s[i];
    if (s[i] === s[i + 1]) continue; // split only between distinct values
    const w0 = (i + 1) / n;
    const m0 = sumLeft / (i + 1);
    const m1 = (total - sumLeft) / (n - i - 1);
    const between = w0 * (1 - w0) * (m0 - m1) ** 2;
    if (between > bestBetween) {
      bestBetween = between;
      bestSplit = i;
    }
  }
  if (bestSplit < 0) return { boundary: null, bic1, bic2: null }; // all values equal
  const lowXs = s.slice(0, bestSplit + 1);
  const highXs = s.slice(bestSplit + 1);
  const lo = { ...meanVar(lowXs, floor), w: lowXs.length / n };
  const hi = { ...meanVar(highXs, floor), w: highXs.length / n };
  const ll2 = xs.reduce(
    (acc, x) =>
      acc +
      Math.log(
        (lo.w * Math.exp((-0.5 * (x - lo.mu) ** 2) / lo.v)) / Math.sqrt(2 * Math.PI * lo.v) +
          (hi.w * Math.exp((-0.5 * (x - hi.mu) ** 2) / hi.v)) / Math.sqrt(2 * Math.PI * hi.v),
      ),
    0,
  );
  const bic2 = -2 * ll2 + 5 * Math.log(n);
  if (!(bic2 < bic1)) return { boundary: null, bic1, bic2, low: lo, high: hi };
  // Where the weighted densities cross between the two means: the Bayes decision point.
  const logDens = (x, c) => Math.log(c.w) - 0.5 * Math.log(c.v) - (0.5 * (x - c.mu) ** 2) / c.v;
  let a = lo.mu;
  let b = hi.mu;
  for (let it = 0; it < 64 && b - a > 1e-12; it++) {
    const m = (a + b) / 2;
    if (logDens(m, hi) >= logDens(m, lo)) b = m;
    else a = m;
  }
  return { boundary: b, bic1, bic2, low: lo, high: hi };
}

/**
 * Near-duplicate groups among live claims of the same kind, with one survivor each: the
 * highest val, then the most evidence, then the earliest minted, then the smallest id.
 * Similarity only PROPOSES a duplicate (review F16): a close pair whose texts differ in
 * polarity, operators, numbers, literals, identifiers or paths ("Enable authentication…" vs
 * "Disable authentication…") is never grouped — it is reported in `conflicts`, both claims
 * stay live, and a person decides.
 * @param {Claim[]} claims live (servable) claims
 * @param {number} nowDay
 * @returns {{boundary: number | null, bic1?: number, bic2?: number | null, compared: number,
 *   groups: {keep: string, drop: {id: string, similarity: number}[]}[],
 *   conflicts: {a: string, b: string, similarity: number, conflicts: string}[]}}
 */
export function duplicateGroups(claims, nowDay) {
  const byKind = new Map();
  for (const c of claims) {
    const k = c.kind ?? "";
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push({ c, s: sketch(claimText(c)) });
  }
  /** @type {{i: any, j: any, sim: number}[]} */
  const pairs = [];
  const nn = [];
  for (const items of byKind.values()) {
    if (items.length < 2) continue;
    const best = new Array(items.length).fill(0);
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++) {
        const sim = jaccard(items[i].s, items[j].s);
        pairs.push({ i: items[i], j: items[j], sim });
        if (sim > best[i]) best[i] = sim;
        if (sim > best[j]) best[j] = sim;
      }
    nn.push(...best);
  }
  if (!nn.length) return { boundary: null, compared: 0, groups: [], conflicts: [] };
  const fit = similarityBoundary(nn);
  if (fit.boundary == null)
    return {
      boundary: null,
      bic1: fit.bic1,
      bic2: fit.bic2,
      compared: nn.length,
      groups: [],
      conflicts: [],
    };
  // Union-find over the pairs at or above the boundary.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const pairKey = (a, b) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);
  /** @type {Map<string, number>} similarity of each pair at or above the boundary */
  const close = new Map();
  /** @type {{a: string, b: string, similarity: number, conflicts: string}[]} */
  const conflicts = [];
  for (const p of pairs) {
    if (p.sim < fit.boundary) continue;
    const differs = semanticConflicts(statementOf(p.i.c), statementOf(p.j.c));
    if (differs.length) {
      conflicts.push({
        a: p.i.c.id,
        b: p.j.c.id,
        similarity: p.sim,
        conflicts: describeConflicts(differs),
      });
      continue;
    }
    for (const it of [p.i, p.j]) if (!parent.has(it.c.id)) parent.set(it.c.id, it.c.id);
    parent.set(find(p.i.c.id), find(p.j.c.id));
    close.set(pairKey(p.i.c.id, p.j.c.id), p.sim);
  }
  const members = new Map();
  const claimById = new Map(claims.map((c) => [c.id, c]));
  for (const id of parent.keys()) {
    const r = find(id);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(claimById.get(id));
  }
  const rank = (c) => [
    -val(c, nowDay),
    -(c.evidence?.length ?? 0),
    c.provenance?.t ?? Number.POSITIVE_INFINITY,
    c.id,
  ];
  const cmp = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
    return 0;
  };
  // A member is dropped only as a duplicate of the SURVIVOR, judged by their own pair. The
  // union-find groups can chain (A–B and B–C close, A–C not): C is then no duplicate of A and
  // stays, and the reported similarity is always the pair that decided.
  const groups = [...members.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const [keep, ...rest] = [...g].sort(cmp);
      const drop = rest
        .map((c) => ({ id: c.id, similarity: close.get(pairKey(keep.id, c.id)) }))
        .filter((d) => d.similarity != null)
        .map((d) => ({ id: d.id, similarity: /** @type {number} */ (d.similarity) }));
      return { keep: keep.id, drop };
    })
    .filter((g) => g.drop.length)
    .sort((a, b) => (a.keep < b.keep ? -1 : 1));
  return {
    boundary: fit.boundary,
    bic1: fit.bic1,
    bic2: fit.bic2,
    compared: nn.length,
    groups,
    conflicts: conflicts.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1)),
  };
}

// ── The plan ──────────────────────────────────────────────────────────────────────────

/**
 * What to archive, and why. `uses` maps claim id → the days it was served.
 * @param {Claim[]} claims every claim in the live store (not the attic)
 * @param {Map<string, number[]>} uses
 * @param {number} nowDay
 * @param {{halfLife?: number, duplicates?: boolean}} [opts] halfLife only feeds isDormant
 * Every archive entry carries a machine-readable `cause` — "tombstoned", "dormant", "idle" or
 * "duplicate" (+ `survivor`) — because archiving is STORAGE lifecycle, not a truth verdict
 * (review F15): an idle or deduplicated claim is not a refuted one, and a reader must be able
 * to tell them apart after the fact.
 * @returns {{archive: {id: string, reason: string, cause: "tombstoned"|"dormant"|"idle"|"duplicate",
 *   survivor?: string}[], retention: ReturnType<typeof learnIdleCutoff>,
 *   duplicates: ReturnType<typeof duplicateGroups> | null}}
 */
export function retentionPlan(claims, uses, nowDay, { halfLife, duplicates = false } = {}) {
  let usageSince = null;
  for (const days of uses.values())
    for (const d of days) if (usageSince == null || d < usageSince) usageSince = d;
  const histories = claims.map((c) => ({ days: activityDays(c, uses.get(c.id) ?? []) }));
  // Claims already in the attic still count as evidence of how long a claim can idle and
  // come back: their served days stay in the usage log.
  const known = new Set(claims.map((c) => c.id));
  const learnFrom = [...histories];
  for (const [id, days] of uses)
    if (!known.has(id)) learnFrom.push({ days: [...new Set(days)].sort((a, b) => a - b) });
  const retention = learnIdleCutoff(learnFrom, nowDay, { usageSince });
  /** @type {{id: string, reason: string, cause: "tombstoned"|"dormant"|"idle"|"duplicate",
   *   survivor?: string}[]} */
  const archive = [];
  const live = [];
  const dormantOpts = halfLife == null ? {} : { halfLife };
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    if (c.tombstone) {
      archive.push({ id: c.id, reason: "tombstoned (never served)", cause: "tombstoned" });
      continue;
    }
    if (isDormant(c, nowDay, dormantOpts)) {
      archive.push({ id: c.id, reason: "dormant (never served)", cause: "dormant" });
      continue;
    }
    const days = histories[i].days;
    const idle = days.length ? nowDay - days[days.length - 1] : null;
    if (retention.learned && idle != null && idle > /** @type {number} */ (retention.cutoff)) {
      archive.push({
        id: c.id,
        reason: `idle ${idle} d > learned cut-off ${retention.cutoff} d`,
        cause: "idle",
      });
      continue;
    }
    live.push(c);
  }
  let dup = null;
  if (duplicates) {
    dup = duplicateGroups(live, nowDay);
    for (const g of dup.groups)
      for (const d of g.drop)
        archive.push({
          id: d.id,
          reason: `near-duplicate of ${g.keep.slice(0, 12)} (similarity ${d.similarity.toFixed(2)} ≥ learned ${dup.boundary?.toFixed(2)})`,
          cause: "duplicate",
          survivor: g.keep,
        });
  }
  return { archive, retention, duplicates: dup };
}

// forge ledger — the Proof-Carrying Memory (PCM) core. PURE logic only (no fs — see
// ledger_store.js): canonical claims, content-addressed ids, evidence outcomes, a
// decayed Beta-posterior confidence, Eq.-3 retrieval scoring, MinHash similarity, and
// the semilattice merge that makes team memory conflict-free by construction.
// Spec: docs/plans/substrate-v2/01-pcm-protocol.md (ADR-0006).
//
// Design invariants (shared with lessons.js, now protocol law for every stored thing):
//  - Confidence is EARNED from independent oracles (tests, CI, human accept/revert),
//    never from the model's self-assessment; retrieval/injection is never confirmation.
//  - Claims are immutable by id; every mutable thing (evidence, tombstones) is an
//    append-only record — which is what makes merge = set union a join-semilattice.
//  - Unreviewed claims decay toward the PRIOR (0.5, uncertainty), not toward false.
import { contentHash } from "./util.js";

// Anything matching this is refused at mint — store a pointer to where the secret
// lives, never the value. Moved here from recall.js (which re-exports it) so NO claim
// kind can persist a credential. See recall.js history for the precision rationale:
// known credential formats, plus a secret-ish key ASSIGNED to a value (a bare English
// mention like "implement password hashing" must NOT be refused).
export const SECRET_RE =
  /(-----BEGIN |\bghp_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{20,}|\bya29\.[A-Za-z0-9._-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|\b[\w-]*(?:api[_-]?key|secret|passwd|password|token)[\w-]*["']?\s*[:=]\s*["']?\S)/i;

export const KINDS = [
  "lesson", // a corrected behavior (cortex)
  "fact", // a durable project fact (recall)
  "artifact", // verified generated code (reuse cache, P3)
  "edge", // a verified dependency edge (atlas overlay, P5)
  "fingerprint", // a design-token vector (UI gate, P6)
  "diagnosis", // a doom-loop root cause (P5)
  "decision", // a ratified team decision (hikma layer)
  "summary", // a compressed context span (P4)
  "outcome", // a raw oracle result (ilm layer)
];

/**
 * Oracle taxonomy — who may move confidence, and how much. `w` = prior reliability;
 * `family` powers the cross-family gate (a lone behavioral signal never moves a claim
 * on its own — same rule as lessons.js scoreMistake). The two `bridge: true` entries
 * exist only for the P1 migration seam (cortex episodes, legacy imports) and carry a
 * deliberately conservative weight.
 */
export const ORACLES = {
  "human.revert": { w: 1.0, family: "human" },
  "human.accept": { w: 0.9, family: "human" },
  "test.run": { w: 0.8, family: "outcome" },
  "ci.run": { w: 0.8, family: "outcome" },
  typecheck: { w: 0.6, family: "outcome" },
  "graph.reval": { w: 0.5, family: "structural" },
  behavioral: { w: 0.3, family: "behavioral" },
  "cortex.episode": { w: 0.5, family: "outcome", bridge: true },
  "legacy.import": { w: 0.5, family: "outcome", bridge: true },
};

export const SCOPE_WEIGHT = { symbol: 1.0, dir: 0.8, repo: 0.6, global: 0.4 };

/** Retrieval weights for Eq. 3 (a=relevance, b=recency, g=validity) — calibrated in P8. */
export const EQ3_WEIGHTS = { a: 0.55, b: 0.15, g: 0.3 };

export const DEFAULT_HALF_LIFE_DAYS = 45;
/** Below this val a claim is dormant: kept for audit, never retrieved. */
export const DORMANT_VAL = 0.35;

/**
 * Deterministic canonical JSON: lexicographically sorted keys, no insignificant
 * whitespace, NFC-normalized strings, no undefined/function values (dropped, as in
 * JSON.stringify). The canonical BYTES are what gets hashed and stored — id stability
 * under re-serialization is a protocol guarantee.
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined && typeof value[k] !== "function")
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return "null"; // undefined / function at the top level
}

/** Content address over (kind, body, scope) ONLY — provenance and evidence excluded, so
 *  two teammates who independently learn the same thing mint the SAME id and their
 *  evidence merges instead of duplicating. */
export function claimId(kind, body, scope = {}) {
  return contentHash(canonicalize({ body, kind, scope }));
}

/**
 * Mint a claim. Refuses secrets and unknown kinds ({ok:false, reason} — same contract
 * as recall.add / lessons_store.save so callers keep one error shape).
 * @param {{kind:string, body:object, scope?:object, provenance?:object, t?:number}} f
 *   `t` is the mint day (epoch days) — passed in, never read from the clock here.
 * @returns {{ok:true, claim:object}|{ok:false, reason:string}}
 */
export function mintClaim({ kind, body, scope = {}, provenance = {}, t = 0 }) {
  if (!KINDS.includes(kind)) return { ok: false, reason: `unknown claim kind: ${kind}` };
  if (body === null || typeof body !== "object")
    return { ok: false, reason: "claim body must be an object" };
  const canon = canonicalize({ body, kind, scope });
  if (SECRET_RE.test(canon))
    return {
      ok: false,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  return {
    ok: true,
    claim: {
      v: 1,
      id: claimId(kind, body, scope),
      kind,
      body,
      scope,
      provenance: { ...provenance, t },
      evidence: [],
    },
  };
}

/**
 * Build an evidence outcome. Evidence without a verifiable ref (commit SHA, test-run
 * id, episode id, CI URL) is rejected — "the model said so" is not evidence.
 * @param {{oracle:string, result:"confirm"|"contradict", ref:string, author?:string, t?:number}} f
 * @returns {{ok:true, outcome:object}|{ok:false, reason:string}}
 */
export function outcomeRecord({ oracle, result, ref, author = "", t = 0 }) {
  const o = ORACLES[oracle];
  if (!o) return { ok: false, reason: `unknown oracle: ${oracle}` };
  if (result !== "confirm" && result !== "contradict")
    return { ok: false, reason: `result must be confirm|contradict, got: ${result}` };
  if (!ref || typeof ref !== "string")
    return { ok: false, reason: "evidence requires a verifiable ref" };
  const outcome = { author, oracle, ref, result, t, w: o.w };
  return { ok: true, outcome: { ...outcome, h: contentHash(canonicalize(outcome)) } };
}

const decayed = (outcome, nowDay, halfLife) =>
  outcome.w * 0.5 ** (Math.max(0, nowDay - (outcome.t ?? 0)) / halfLife);

/**
 * Validity — the paper's `val` term as a time-decayed Beta posterior mean with a
 * Beta(1,1) prior:  (1 + Σ confirms·w·λ^Δt/T) / (2 + Σ all·w·λ^Δt/T).
 * Fresh claim → 0.5. Unreviewed evidence decays, pulling val back toward 0.5
 * (uncertainty), never toward 0 — review (new evidence) is what restores weight.
 * Pure function of the evidence set ⇒ identical after any merge order.
 */
export function val(claim, nowDay = 0, { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  let confirms = 0;
  let all = 0;
  for (const e of claim.evidence ?? []) {
    const d = decayed(e, nowDay, halfLife);
    all += d;
    if (e.result === "confirm") confirms += d;
  }
  return (1 + confirms) / (2 + all);
}

/** Recency — λ^(Δt/T) since the last evidence (or mint, if none). */
export function rec(claim, nowDay = 0, { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  const last = Math.max(claim.provenance?.t ?? 0, ...(claim.evidence ?? []).map((e) => e.t ?? 0));
  return 0.5 ** (Math.max(0, nowDay - last) / halfLife);
}

/** Dormant claims are kept for audit but never retrieved. */
export function isDormant(claim, nowDay = 0) {
  return val(claim, nowDay) < DORMANT_VAL;
}

// ---------------------------------------------------------------------------
// MinHash similarity — the dependency-free `rel` term. k independent-ish hash
// functions via affine reseeding of one FNV-1a base hash; Jaccard is estimated by the
// fraction of matching sketch positions (unbiased, SE ≈ sqrt(J(1-J)/k) ≈ 0.044 at
// k=128). Candidate pairing at scale uses LSH banding (P3); here pairwise is fine.
// ---------------------------------------------------------------------------

export const SKETCH_K = 128;

const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

// Fixed odd multipliers/offsets derived from a splitmix-style constant — deterministic
// across runs and platforms (no Math.random, ever: ids and sketches must be stable).
const SEEDS = Array.from({ length: SKETCH_K }, (_, i) => ({
  a: (Math.imul(i + 1, 0x9e3779b1) | 1) >>> 0,
  b: Math.imul(i + 1, 0x85ebca6b) >>> 0,
}));

const normalizeText = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** n-token shingle set of normalized text (short texts fall back to single tokens). */
export function shingles(text, n = 4) {
  const toks = normalizeText(text);
  if (toks.length < n) return new Set(toks.length ? [toks.join(" ")] : []);
  const out = new Set();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

/** MinHash sketch of a text: k per-seed minima over the shingle hashes. */
export function sketch(text, k = SKETCH_K) {
  const sh = shingles(text);
  const mins = new Array(k).fill(0xffffffff);
  for (const s of sh) {
    const h = fnv1a(s);
    for (let i = 0; i < k; i++) {
      const v = (Math.imul(h, SEEDS[i].a) + SEEDS[i].b) >>> 0;
      if (v < mins[i]) mins[i] = v;
    }
  }
  return mins;
}

/** Jaccard estimate = fraction of agreeing sketch positions (1 for identical texts). */
export function jaccard(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) eq++;
  return eq / n;
}

/** The retrievable text of a claim, per kind (fallback: its canonical body). */
export function claimText(claim) {
  const b = claim.body ?? {};
  switch (claim.kind) {
    case "lesson":
      return [
        b.whatWentWrong,
        b.correctedBehavior,
        ...(b.trigger?.keywords ?? []),
        ...(b.trigger?.symbols ?? []),
      ]
        .filter(Boolean)
        .join(" ");
    case "fact":
      return [b.name, b.text].filter(Boolean).join(" ");
    case "diagnosis":
      return [b.signature, b.note].filter(Boolean).join(" ");
    case "summary":
      return b.text ?? canonicalize(b);
    default:
      return canonicalize(b);
  }
}

/**
 * Eq. 3 retrieval score (paper §7.1): σ(a·rel + b·rec + g·val) × scope weight.
 * `query` may be a string or a precomputed sketch. The `g·val` term is the protocol's
 * load-bearing addition — outcome-confirmed claims outrank merely-recent ones.
 */
export function score(query, claim, { nowDay = 0, weights = EQ3_WEIGHTS } = {}) {
  const qs = Array.isArray(query) ? query : sketch(query);
  const rel = jaccard(qs, claim._sketch ?? sketch(claimText(claim)));
  const x = weights.a * rel + weights.b * rec(claim, nowDay) + weights.g * val(claim, nowDay);
  const sigma = 1 / (1 + Math.exp(-x));
  const scopeW = SCOPE_WEIGHT[claim.scope?.level] ?? 0.5;
  return sigma * scopeW;
}

/** Rank live (non-dormant, non-tombstoned) claims for a query; caps at `budget`. */
export function retrieve(query, claims, { nowDay = 0, budget = 12, weights = EQ3_WEIGHTS } = {}) {
  const qs = sketch(String(query));
  return claims
    .filter((c) => !c.tombstone && !isDormant(c, nowDay))
    .map((c) => ({ claim: c, score: score(qs, c, { nowDay, weights }) }))
    .sort((a, b) => b.score - a.score || (a.claim.id < b.claim.id ? -1 : 1))
    .slice(0, budget);
}

/**
 * Consolidation clustering (the murāja‘a job, ilm→fahm): union-find over pairs with
 * Jaccard ≥ tau. O(n²) pairwise on sketches — fine at session scale; LSH banding is
 * the documented scale path. Returns clusters of ≥2 as arrays of claim ids.
 */
export function clusters(claims, { tau = 0.7 } = {}) {
  const items = claims.map((c) => ({ id: c.id, s: c._sketch ?? sketch(claimText(c)) }));
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (jaccard(items[i].s, items[j].s) >= tau) parent.set(find(items[i].id), find(items[j].id));
  const groups = new Map();
  for (const it of items) {
    const r = find(it.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it.id);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => g.sort());
}

// ---------------------------------------------------------------------------
// The CRDT merge. State = { claims: {id→claim}, evidence: {id→outcome[]}, tombstones:
// {id→tomb} } — three grow-only maps keyed by content. Merge is set union with
// evidence deduped by hash; (S, ⊔) is a join-semilattice (commutative, associative,
// idempotent), so replicas converge under ANY merge order. Property-tested.
// ---------------------------------------------------------------------------

const sortOutcomes = (arr) => {
  const byHash = new Map();
  for (const o of arr) if (!byHash.has(o.h)) byHash.set(o.h, o);
  return [...byHash.values()].sort(
    (a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0),
  );
};

/** Semilattice join of two ledger states. Pure; inputs are not mutated. */
export function mergeStates(s1, s2) {
  const claims = { ...s1.claims };
  for (const [id, c] of Object.entries(s2.claims ?? {})) claims[id] ??= c;
  const evidence = {};
  for (const id of new Set([...Object.keys(s1.evidence ?? {}), ...Object.keys(s2.evidence ?? {})]))
    evidence[id] = sortOutcomes([...(s1.evidence?.[id] ?? []), ...(s2.evidence?.[id] ?? [])]);
  const tombstones = { ...(s1.tombstones ?? {}) };
  for (const [id, t] of Object.entries(s2.tombstones ?? {})) tombstones[id] ??= t;
  return { claims, evidence, tombstones };
}

/** Materialize a state into claim objects with evidence + tombstones attached. */
export function liveClaims(state) {
  return Object.values(state.claims)
    .map((c) => ({
      ...c,
      evidence: state.evidence?.[c.id] ?? [],
      tombstone: state.tombstones?.[c.id],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

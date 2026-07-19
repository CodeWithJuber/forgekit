// forge ledger — the Proof-Carrying Memory (PCM) core. PURE logic only (no fs — see
// ledger_store.js): canonical claims, content-addressed ids, evidence outcomes, a
// decayed Beta-posterior confidence, Eq.-3 retrieval scoring, MinHash similarity, and
// the semilattice merge that makes team memory conflict-free by construction.
// Spec: docs/plans/substrate-v2/01-pcm-protocol.md (ADR-0006).
//
// Design invariants (shared with lessons.js, now protocol law for every stored thing):
//  - Confidence is EARNED from independent oracles (tests, CI, human accept/revert),
//    never from the model's self-assessment; retrieval/injection is never confirmation.
//    val() takes oracle weights from the ORACLES table, NEVER from the stored record —
//    a forged/corrupted evidence line cannot buy confidence it isn't entitled to.
//  - A claim's persisted bytes are a pure function of (kind, body, scope): anything
//    author- or time-varying (provenance, evidence, tombstones) lives in append-only
//    logs. That is what makes every file either byte-identical across teammates or
//    union-mergeable — the join-semilattice property is structural, not aspirational.
//  - Unreviewed claims decay toward the PRIOR (0.5, uncertainty), not toward false.
import { hasSecret } from "./secrets.js";
import { contentHash } from "./util.js";

// Anything secret-shaped is refused at mint — store a pointer to where the secret
// lives, never the value. Detection lives in secrets.js (format grammars + entropy
// gate) so NO claim kind — and no shell guard — can disagree about what a secret is.
// SECRET_RE stays re-exported here because recall.js/lessons_store.js/tests
// historically import it from this module.
export { hasSecret, SECRET_RE } from "./secrets.js";

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
 * deliberately conservative weight — Stop-hook revert detection is regex-based and
 * routinely matches innocent `git restore`s, so it must NOT ride the full-weight
 * human.revert oracle (that one is reserved for explicit, unambiguous human signals).
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

/** One source of truth for scope weighting — lessons.js re-exports this. */
export const SCOPE_WEIGHT = { symbol: 1.0, dir: 0.8, repo: 0.6, global: 0.4 };

/** Retrieval weights for Eq. 3 (a=relevance, b=recency, g=validity) — calibrated in P8. */
export const EQ3_WEIGHTS = { a: 0.55, b: 0.15, g: 0.3 };

export const DEFAULT_HALF_LIFE_DAYS = 45;
/** Below this val a claim is dormant: kept for audit, never retrieved. The trusted
 *  band starts at the mirror threshold (1 − DORMANT_VAL) — stats uses both. */
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

/** Stamp a record with its content hash (the dedupe key in every append-only log). */
export function sealRecord(record) {
  return { ...record, h: contentHash(canonicalize(record)) };
}

/**
 * Mint a claim. Refuses secrets and unknown kinds ({ok:false, reason} — same contract
 * as recall.add / lessons_store.save so callers keep one error shape). The body/scope
 * are normalized through JSON first (Dates → ISO strings, Maps/Sets → {}), so a
 * non-JSON value can never make two different bodies collide on one address.
 * `provenance` rides on the in-memory claim but is NEVER part of the id or the claim
 * file bytes — the store appends it to a per-claim log instead.
 * @param {{kind:string, body:object, scope?:object, provenance?:object, t?:number}} f
 *   `t` is the mint day (epoch days) — passed in, never read from the clock here.
 * @returns {{ok:true, claim:any}|{ok:false, reason:string}}
 */
export function mintClaim({ kind, body, scope = {}, provenance = {}, t = 0 }) {
  if (!KINDS.includes(kind)) return { ok: false, reason: `unknown claim kind: ${kind}` };
  if (body === null || typeof body !== "object")
    return { ok: false, reason: "claim body must be an object" };
  const nBody = JSON.parse(JSON.stringify(body));
  const nScope = JSON.parse(JSON.stringify(scope));
  const canon = canonicalize({ body: nBody, kind, scope: nScope });
  if (hasSecret(canon))
    return {
      ok: false,
      reason: "refused: looks like a secret/credential — store a pointer, not the value",
    };
  return {
    ok: true,
    claim: {
      v: 1,
      id: claimId(kind, nBody, nScope),
      kind,
      body: nBody,
      scope: nScope,
      provenance: sealRecord({ ...provenance, t }),
      evidence: [],
    },
  };
}

// Typed evidence refs are `<type>:<value>`. Only these types are recognized; anything
// else (or a ref with no `type:` prefix) is treated as an untyped/legacy ref and accepted
// unchanged for back-compat. `git:` is the one type forge can cheaply AND soundly resolve —
// the object must exist in THIS repo — so it is ALWAYS resolved when a resolver is supplied.
// The rest now carry real FORMAT grammars (ME-05): `ci:` must be a CI locator, `human:`
// must be an explicit ratification, `file:` must resolve to an existing path when a repo
// root is available. A `test:` run id remains format-only — it is unverifiable — which is
// why it can never lift confidence into the trusted band (see refStrength/val).
export const REF_TYPES = new Set(["git", "file", "test", "ci", "human"]);

// A `ci:` ref must be a real CI locator: an http(s) URL, an `owner/repo@run` reference,
// or a bare numeric run id. Prose like "not-a-url" is refused so a made-up string can
// never masquerade as evidence.
const CI_REF_RE = /^(https?:\/\/\S+|[\w.-]+\/[\w.-]+@\S+|\d+)$/;
// A `human:` ref is an EXPLICIT ratification: a named person `@` the thing they ratified
// (e.g. `alice@decision-42`). "the-model-said-yes" is not a human ratifying anything —
// the model's own assertion is refused.
const HUMAN_REF_RE = /^[^@\s]+@\S+$/;

/** Parse a typed ref into {type, value}, or null for an untyped/legacy ref. */
export function parseRef(ref) {
  const m = /^([a-z]+):(.*)$/.exec(String(ref ?? ""));
  if (!m || !REF_TYPES.has(m[1])) return null;
  return { type: m[1], value: m[2] };
}

/**
 * Validate an evidence ref (record-integrity FORMAT + optional resolution). Untyped/legacy
 * → accepted. Typed-but-empty → rejected. Typed refs are format-checked purely (`ci:` is a
 * CI locator, `human:` is a ratification) and, for the two I/O-resolvable types, resolved
 * through injected predicates (execFileSync/existsSync live in the impure store, keeping
 * this module pure): `git:` via `resolveGit(sha)`, `file:` via `resolveFile(path)`. A typed
 * ref whose resolver is supplied but returns false is rejected.
 *
 * NOTE: passing FORMAT is not the same as the evidence being TRUE — see refStrength/val for
 * how merely-format-valid evidence is weighted below the serving threshold.
 * @param {string} ref
 * @param {{resolveGit?: (sha:string)=>boolean, resolveFile?: (path:string)=>boolean}} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateRef(ref, { resolveGit, resolveFile } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: true }; // untyped/legacy — kept for back-compat
  if (!parsed.value) return { ok: false, reason: `evidence ref "${ref}" is typed but empty` };
  if (parsed.type === "git" && typeof resolveGit === "function" && !resolveGit(parsed.value))
    return {
      ok: false,
      reason: `evidence ref "${ref}" is unresolvable (no such git object)`,
    };
  if (parsed.type === "ci" && !CI_REF_RE.test(parsed.value))
    return {
      ok: false,
      reason: `evidence ref "${ref}" is not a CI locator (URL, owner/repo@run, or run id)`,
    };
  if (parsed.type === "human" && !HUMAN_REF_RE.test(parsed.value))
    return {
      ok: false,
      reason: `evidence ref "${ref}" is not an explicit human ratification (author@ref)`,
    };
  if (parsed.type === "file" && typeof resolveFile === "function" && !resolveFile(parsed.value))
    return {
      ok: false,
      reason: `evidence ref "${ref}" is unresolvable (no such file)`,
    };
  return { ok: true };
}

// The trust model (ME-05): record-integrity validity (validateRef/validOutcome) is NOT the
// same as evidence being RESOLVED. Only resolved evidence may lift confidence into the
// trusted/serving band. Two tiers, both re-derived PURELY from the ref so a forged log line
// can never buy a strength it isn't entitled to (same discipline as the ORACLES weights):
//  - RESOLVED: untyped/legacy (historical trust), `git:` (resolved at the append gate —
//    the one soundly-resolvable type), `ci:` (only well-formed CI locators pass validateRef),
//    and `human:` (only explicit ratifications pass). These count at full weight.
//  - FORMAT-ONLY: `file:` and `test:`. A path existing or a run id being well-formed is
//    record integrity, NOT proof the claim is true, and pure val() cannot re-check existence.
//    These count at a REDUCED weight and, on their own, are capped below the serving floor.
const RESOLVED_REF_TYPES = new Set(["git", "ci", "human"]);

/** Resolution strength of a ref for confidence weighting: "resolved" or "format".
 *  Pure and total — never throws, never does I/O. */
export function refStrength(ref) {
  const parsed = parseRef(ref);
  if (!parsed) return "resolved"; // untyped/legacy — historical full trust
  return RESOLVED_REF_TYPES.has(parsed.type) ? "resolved" : "format";
}

/** Weight multiplier applied to merely-format-valid (unresolved) evidence in val(). */
export const UNRESOLVED_WEIGHT = 0.5;
/** A claim whose confirming evidence is ALL format-only may never be lifted to/above the
 *  serving band. This cap sits below both the reuse SERVE_FLOOR (0.6) and the trusted band
 *  (1 − DORMANT_VAL = 0.65): such a claim stays retrievable but is never "trusted". */
export const UNRESOLVED_VAL_CAP = 0.55;

/**
 * Build an evidence outcome. Evidence without a verifiable ref (commit SHA, test-run
 * id, episode id, CI URL) is rejected — "the model said so" is not evidence. A typed ref
 * (`git:`/`file:`/`test:`/`ci:`/`human:`) is validated; `git:`/`file:` are resolved when a
 * `resolveGit`/`resolveFile` predicate is supplied. A secret-shaped ref or author is refused
 * here too (ME-06) — the same detector putClaim runs over claim content — so credentials
 * never enter the evidence log. The oracle's table weight is recorded for audit, but val()
 * re-reads the table.
 * @param {{oracle:string, result:"confirm"|"contradict", ref:string, author?:string, t?:number, resolveGit?:(sha:string)=>boolean, resolveFile?:(path:string)=>boolean}} f
 * @returns {{ok:true, outcome:any}|{ok:false, reason:string}}
 */
export function outcomeRecord({
  oracle,
  result,
  ref,
  author = "",
  t = 0,
  resolveGit,
  resolveFile,
}) {
  const o = ORACLES[oracle];
  if (!o) return { ok: false, reason: `unknown oracle: ${oracle}` };
  if (result !== "confirm" && result !== "contradict")
    return {
      ok: false,
      reason: `result must be confirm|contradict, got: ${result}`,
    };
  if (!ref || typeof ref !== "string")
    return { ok: false, reason: "evidence requires a verifiable ref" };
  const v = validateRef(ref, { resolveGit, resolveFile });
  if (!v.ok) return { ok: false, reason: v.reason ?? "invalid evidence ref" };
  if (hasSecret(ref) || hasSecret(author))
    return {
      ok: false,
      reason: "refused: evidence ref/author looks like a secret/credential",
    };
  return {
    ok: true,
    outcome: sealRecord({ author, oracle, ref, result, t, w: o.w }),
  };
}

/** An evidence record val() will count: known oracle, valid result, a well-formed ref,
 *  a hash. Ref checking is the PURE half of validateRef only (untyped/legacy accepted —
 *  read-path parity with what append accepts; typed-but-empty like `git:` rejected);
 *  git resolution stays on the append/import/verify paths, never on a read. */
export function validOutcome(e) {
  return Boolean(
    e &&
      ORACLES[e.oracle] &&
      (e.result === "confirm" || e.result === "contradict") &&
      typeof e.ref === "string" &&
      e.ref &&
      validateRef(e.ref).ok &&
      e.h,
  );
}

// Weight comes from the ORACLES table — a stored `w` is audit metadata, never trusted
// (a hand-edited or forged log line must not be able to buy extra confidence).
const decayed = (outcome, nowDay, halfLife) =>
  ORACLES[outcome.oracle].w * 0.5 ** (Math.max(0, nowDay - (outcome.t ?? 0)) / halfLife);

/**
 * Validity — the paper's `val` term as a time-decayed Beta posterior mean with a
 * Beta(1,1) prior:  (1 + Σ confirms·w·λ^Δt/T) / (2 + Σ all·w·λ^Δt/T).
 * Fresh claim → 0.5. Unreviewed evidence decays, pulling val back toward 0.5
 * (uncertainty), never toward 0 — review (new evidence) is what restores weight.
 * Records that fail validOutcome (unknown oracle, malformed) are IGNORED, not
 * trusted. Optional `trust` (author → u, see authorTrust) scales each record by its
 * appender's earned reliability. Pure function of (evidence set, trust map) ⇒
 * identical after any merge order.
 *
 * Resolution strength (ME-05): merely-format-valid evidence (`file:`/`test:` — a pointer,
 * not a demonstration) counts at UNRESOLVED_WEIGHT, and a claim with NO resolved
 * confirmation is capped at UNRESOLVED_VAL_CAP so `test:made-up-run` (and friends) can
 * never lift confidence into the trusted/serving band. The cap only lowers — contradictions
 * still sink val toward 0 as before.
 * @param {any} claim
 * @param {number} [nowDay]
 * @param {{halfLife?: number, trust?: Record<string, number>}} [opts]
 */
export function val(claim, nowDay = 0, { halfLife = DEFAULT_HALF_LIFE_DAYS, trust } = {}) {
  let confirms = 0;
  let all = 0;
  let resolvedConfirm = false;
  for (const e of claim.evidence ?? []) {
    if (!validOutcome(e)) continue;
    const resolved = refStrength(e.ref) === "resolved";
    const strength = resolved ? 1 : UNRESOLVED_WEIGHT;
    const d = decayed(e, nowDay, halfLife) * (trust?.[e.author ?? ""] ?? 1) * strength;
    all += d;
    if (e.result === "confirm") {
      confirms += d;
      if (resolved) resolvedConfirm = true;
    }
  }
  const v = (1 + confirms) / (2 + all);
  return resolvedConfirm ? v : Math.min(v, UNRESOLVED_VAL_CAP);
}

/**
 * Per-author trust u(author) ∈ [0.5, 1] — the historical confirm rate of the claims
 * an author MINTED (docs/plans/substrate-v2/02-team-memory.md §3): authors whose
 * claims keep being contradicted by oracles contribute less evidence weight going
 * forward. Smoothed so a no-history author starts at 1.0 (never punish the new
 * teammate) and floored at 0.5 (never silence anyone).
 *   u(a) = max(0.5, (confirms_a + s) / (confirms_a + contradictions_a + s)),  s = 2
 * Counts are oracle-weighted, and an author's own evidence on their own claims is
 * EXCLUDED — self-confirmation must not raise one's trust (C12 discipline).
 * @returns {Record<string, number>} author → u
 */
export function authorTrust(claims) {
  const tally = new Map(); // author → {c, m}
  for (const claim of claims) {
    const author = claim.provenance?.author ?? "";
    if (!author) continue;
    const t = tally.get(author) ?? { c: 0, m: 0 };
    for (const e of claim.evidence ?? []) {
      if (!validOutcome(e) || (e.author ?? "") === author) continue;
      const w = ORACLES[e.oracle].w;
      if (e.result === "confirm") t.c += w;
      else t.m += w;
    }
    tally.set(author, t);
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [a, { c, m }] of tally) out[a] = Math.max(0.5, (c + 2) / (c + m + 2));
  return out;
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

// Memoize on the claim object — sketch(claimText) is deterministic per id and claims
// are immutable, so first-use caching is safe and keeps retrieve()/clusters() from
// re-hashing every claim on every call. (noAssignInExpressions is off in biome.json.)
const sketchOf = (claim) => (claim._sketch ??= sketch(claimText(claim)));

/**
 * Eq. 3 retrieval score (paper §7.1): σ(a·rel + b·rec + g·val) × scope weight.
 * `query` may be a string or a precomputed sketch. The `g·val` term is the protocol's
 * load-bearing addition — outcome-confirmed claims outrank merely-recent ones.
 *
 * `sim` (optional) replaces the lexical `rel` term with a caller-supplied similarity
 * (the ADR-0005 embeddings tier — built by callers from embed.js; this pure core
 * NEVER imports a provider). It returns a cosine in [-1,1] or null; null (or any
 * non-finite value) falls back to MinHash Jaccard per claim, and negatives clamp to 0
 * — "anti-similar" is just irrelevant, never a penalty below unrelated.
 * @param {*} query
 * @param {any} claim
 * @param {{nowDay?:number, weights?:typeof EQ3_WEIGHTS, sim?:(query:any, claim:any)=>number|null}} [opts]
 */
export function score(query, claim, { nowDay = 0, weights = EQ3_WEIGHTS, sim } = {}) {
  let rel = null;
  if (sim) {
    const s = sim(query, claim);
    if (typeof s === "number" && Number.isFinite(s)) rel = Math.max(0, Math.min(1, s));
  }
  if (rel === null) {
    const qs = Array.isArray(query) ? query : sketch(query);
    rel = jaccard(qs, sketchOf(claim));
  }
  const x = weights.a * rel + weights.b * rec(claim, nowDay) + weights.g * val(claim, nowDay);
  const sigma = 1 / (1 + Math.exp(-x));
  const scopeW = SCOPE_WEIGHT[claim.scope?.level] ?? 0.5;
  return sigma * scopeW;
}

/** Rank live (non-dormant, non-tombstoned) claims for a query; caps at `budget`.
 *  Optional `sim` as in score() — the caller-built embedding similarity; the query
 *  string (not the sketch) is what a sim sees.
 *  @param {*} query
 *  @param {any[]} claims
 *  @param {{nowDay?:number, budget?:number, weights?:typeof EQ3_WEIGHTS,
 *           sim?:((query:any, claim:any)=>number|null)|null}} [opts] */
export function retrieve(
  query,
  claims,
  { nowDay = 0, budget = 12, weights = EQ3_WEIGHTS, sim } = {},
) {
  const q = String(query);
  const qs = sketch(q);
  const boundSim = sim ? (_qs, c) => sim(q, c) : undefined;
  return claims
    .filter((c) => !c.tombstone && !isDormant(c, nowDay))
    .map((c) => ({
      claim: c,
      score: score(qs, c, { nowDay, weights, sim: boundSim }),
    }))
    .sort((a, b) => b.score - a.score || (a.claim.id < b.claim.id ? -1 : 1))
    .slice(0, budget);
}

/**
 * Consolidation clustering (the murāja‘a job, ilm→fahm): union-find over pairs with
 * Jaccard ≥ tau. O(n²) pairwise on sketches — fine at session scale; LSH banding is
 * the documented scale path. Returns clusters of ≥2 as arrays of claim ids.
 */
export function clusters(claims, { tau = 0.7 } = {}) {
  const items = claims.map((c) => ({ id: c.id, s: sketchOf(c) }));
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
// The CRDT merge. State = four grow-only maps:
//   claims:     id → {v, kind, body, scope}        (bytes are pure content — identical
//                                                   for the same id on every replica)
//   evidence:   id → outcome[]                     (union by content hash)
//   provenance: id → record[]                      (union by content hash — every
//                                                   author's mint is kept, attribution
//                                                   is a set, not a fight)
//   tombstones: id → record[]                      (union by content hash — concurrent
//                                                   retractions both survive)
// Merge is set union throughout; (S, ⊔) is a join-semilattice (commutative,
// associative, idempotent), so replicas converge under ANY merge order. The single-
// record views (claim.provenance, claim.tombstone) are derived deterministically
// (earliest by (t, h)), so they converge too. Property-tested.
// ---------------------------------------------------------------------------

/** Dedupe by content hash and sort by (t, h) — the ONE record order everywhere, so a
 *  log's on-disk line order (which differs across replicas after a union merge) can
 *  never leak into views or derived values. */
export const sortRecords = (arr) => {
  const byHash = new Map();
  for (const o of arr) if (o?.h && !byHash.has(o.h)) byHash.set(o.h, o);
  return [...byHash.values()].sort(
    (a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0),
  );
};

const mergeLogMap = (m1 = {}, m2 = {}) => {
  const out = {};
  for (const id of new Set([...Object.keys(m1), ...Object.keys(m2)]))
    out[id] = sortRecords([...(m1[id] ?? []), ...(m2[id] ?? [])]);
  return out;
};

/** An empty ledger state. */
export function emptyState() {
  return { claims: {}, evidence: {}, provenance: {}, tombstones: {} };
}

/** Semilattice join of two ledger states. Pure; inputs are not mutated. */
export function mergeStates(s1, s2) {
  const claims = { ...s1.claims };
  // Claim values are pure content keyed by their own hash — identical bytes on every
  // replica, so first-in is not a choice, it's a no-op.
  for (const [id, c] of Object.entries(s2.claims ?? {})) claims[id] ??= c;
  return {
    claims,
    evidence: mergeLogMap(s1.evidence, s2.evidence),
    provenance: mergeLogMap(s1.provenance, s2.provenance),
    tombstones: mergeLogMap(s1.tombstones, s2.tombstones),
  };
}

/** Materialize a state into claim views: evidence attached, provenance = earliest
 *  mint record, tombstone = earliest retraction (deterministic across replicas). */
export function liveClaims(state) {
  return Object.values(state.claims)
    .map((c) => ({
      ...c,
      evidence: state.evidence?.[c.id] ?? [],
      provenance: state.provenance?.[c.id]?.[0] ?? c.provenance ?? {},
      provenanceAll: state.provenance?.[c.id] ?? [],
      tombstone: state.tombstones?.[c.id]?.[0],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

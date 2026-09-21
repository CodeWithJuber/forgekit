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

/** Retrieval weights for Eq. 3 (a=relevance, b=recency, g=validity, s=scope). a/b/g are the
 *  spec defaults (01-pcm-protocol.md §4); they are NOT calibrated — the planned
 *  logistic-regression calibration on retrieval outcomes has not been run. `s` puts scope
 *  INSIDE the linear term as a small prior (symbol vs global differ by s·0.6 = 0.06): it
 *  breaks ties between comparably relevant claims but can never outrank a relevance gap. */
export const EQ3_WEIGHTS = { a: 0.55, b: 0.15, g: 0.3, s: 0.1 };

export const DEFAULT_HALF_LIFE_DAYS = 45;
/** Below this val a claim is dormant: kept for audit, never retrieved. The trusted
 *  band starts at the mirror threshold (1 − DORMANT_VAL) — stats uses both. */
export const DORMANT_VAL = 0.35;

/**
 * Every string in a canonical document — key or value — passes through here.
 *
 * NORMALIZED, both deliberately:
 *   - Unicode NFC. The same text typed on macOS (NFD) and on Linux (NFC) is one fact.
 *   - CRLF → LF. A checkout's line endings are a property of the MACHINE, not of the
 *     claim: `core.autocrlf` hands the same file to a Windows worktree with \r\n and to
 *     a Linux one with \n, so the same logical claim minted on each side used to land on
 *     two different content addresses and never merge — one fact, two "copies", evidence
 *     split between them forever.
 *
 * DELIBERATELY LEFT ALONE — each one can carry meaning, and canonicalization must never
 * silently rewrite a claim's content:
 *   - A LONE \r. In captured terminal output (which is exactly what a `diagnosis` body
 *     holds) a bare carriage return is a progress-bar control character, not a line
 *     ending. Folding it into \n would edit the evidence. Same conservative rule as
 *     `normalizeError()` in src/diagnose.js.
 *   - Leading/trailing and interior whitespace, blank lines, indentation — "  x" and "x"
 *     are different claims, and a code snippet's indentation is its content.
 *   - Case, punctuation, and every other Unicode fold beyond NFC (no NFKC: "ﬁ" ≠ "fi").
 *   - Non-string values: numbers, booleans and null serialize as JSON.stringify does.
 */
const canonText = (s) => s.normalize("NFC").replace(/\r\n/g, "\n");

/**
 * Deterministic canonical JSON: lexicographically sorted keys, no insignificant
 * whitespace, NFC + LF-normalized strings (see `canonText`), no undefined/function values
 * (dropped, as in JSON.stringify). The canonical BYTES are what gets hashed and stored —
 * id stability under re-serialization is a protocol guarantee.
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(canonText(value));
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
  if (typeof value === "object") {
    // Normalize keys BEFORE sorting: sorting the raw spelling and normalizing afterwards made
    // an NFD key sort where its NFC twin doesn't, so a claim written with one spelling failed
    // its own address check once re-parsed (the NFC bytes sort differently). Two raw keys that
    // collapse to one NFC key are a malformed input; the first in raw-key order wins,
    // deterministically. Keys take the same normalization as values — one rule for every
    // string in the document, so a key can't fork an id the way a value used to.
    const entries = new Map();
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined || typeof value[k] === "function") continue;
      const nk = canonText(k);
      if (!entries.has(nk)) entries.set(nk, value[k]);
    }
    const keys = [...entries.keys()].sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(entries.get(k))}`).join(",")}}`;
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

// Typed evidence refs are `<type>:<value>`. Only these types are format-checked; anything
// else (or a ref with no `type:` prefix) is accepted for back-compat but counts only at
// FORMAT strength (see refStrength). `git:` is the one type forge can cheaply AND soundly
// resolve — the object must exist in THIS repo — so it is ALWAYS resolved when a resolver is
// supplied. The rest carry FORMAT grammars (ME-05): `ci:` must be a CI locator, `human:`
// must be an explicit ratification, `file:` must resolve to an existing path when a repo
// root is available. None of those proves the claim, so none lifts confidence into the
// trusted band on its own (see refStrength/val).
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

// The trust model (ME-05, tightened after review C2): record-integrity validity
// (validateRef/validOutcome) is NOT the same as evidence being RESOLVED. Only resolved
// evidence may lift confidence into the trusted/serving band, and "resolved" means FORGE
// re-derived the pointer — not that someone typed a plausible string. Two tiers, both
// re-derived PURELY from the record so a forged log line can never buy a strength it isn't
// entitled to (same discipline as the ORACLES weights):
//  - RESOLVED: a `git:` ref naming an OBJECT ID (hex, 7–64 chars). It is resolved against
//    this repo at every append/import gate and re-resolved by verify(). A symbolic revision
//    (`git:HEAD`, `git:main`) names no fixed object — HEAD moves — so it is not resolved.
//    Also the two bridge pointers, and only on the bridge oracle that mints them
//    (`episode:` ↔ cortex.episode, `legacy:` ↔ legacy.import): forge's own observers, whose
//    deliberately conservative table weight (0.5) already is the discount.
//  - FORMAT-ONLY: everything else. Untyped refs (`lgtm`), unknown prefixes (`session:x`),
//    and the typed-but-unverifiable `ci:`/`human:`/`test:`/`file:` — a CI locator, a named
//    ratifier, a run id or an existing path is record integrity, not proof, and pure val()
//    cannot check any of them. These count at a REDUCED weight and, on their own, are
//    capped below the serving floor.
// A human-family oracle authored by an `agent:` identity (e.g. the MCP tools' `agent:mcp`)
// is never resolved either: an agent is not a human, whatever ref it cites.
const GIT_OID_RE = /^[0-9a-f]{7,64}$/i;
const BRIDGE_REF_ORACLE = { episode: "cortex.episode", legacy: "legacy.import" };

/** Resolution strength of a ref for confidence weighting: "resolved" or "format". `oracle`
 *  binds a bridge pointer to the one oracle allowed to cite it. Pure and total — never
 *  throws, never does I/O.
 *  @param {string} ref
 *  @param {string} [oracle] */
export function refStrength(ref, oracle) {
  const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(String(ref ?? ""));
  if (!m) return "format"; // untyped — nothing forge can re-derive
  const [, type, value] = m;
  if (type === "git") return GIT_OID_RE.test(value) ? "resolved" : "format";
  return oracle !== undefined && BRIDGE_REF_ORACLE[type] === oracle ? "resolved" : "format";
}

/** The strength val() actually applies to one evidence record: refStrength, except that an
 *  `agent:` identity can never supply HUMAN-family evidence at resolved strength. */
const recordStrength = (e) =>
  ORACLES[e.oracle]?.family === "human" && /^agent:/.test(String(e.author ?? ""))
    ? "format"
    : refStrength(e.ref, e.oracle);

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
// The age is the DISTANCE from now: a future-dated record (a teammate's skewed clock, a
// hand-written t) decays by how far ahead it claims to be, instead of counting at full
// weight — and pinning rec at 1 — until the calendar catches up with it.
const ageOf = (t, nowDay) => Math.abs(nowDay - (t ?? 0));
const decayed = (outcome, nowDay, halfLife) =>
  ORACLES[outcome.oracle].w * 0.5 ** (ageOf(outcome.t, nowDay) / halfLife);

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
 * Resolution strength (ME-05/C2): evidence forge did not resolve (anything but a `git:`
 * object id or a bridge pointer — see refStrength) counts at UNRESOLVED_WEIGHT, and a claim
 * with NO resolved confirmation is capped at UNRESOLVED_VAL_CAP so `lgtm`,
 * `test:made-up-run` (and friends) can never lift confidence into the trusted/serving band. The cap only lowers — contradictions
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
    const resolved = recordStrength(e) === "resolved";
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

/** Recency — λ^(Δt/T) since the last CONFIRMATION (or the mint, if none). A contradiction
 *  is not "recent evidence for" a claim: counting it let a fresh refutation raise a stale
 *  claim's Eq. 3 score (review C5). Δt is the distance from now (see ageOf). */
export function rec(claim, nowDay = 0, { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  let nearest = ageOf(claim.provenance?.t, nowDay);
  for (const e of claim.evidence ?? [])
    if (e?.result === "confirm" && validOutcome(e)) nearest = Math.min(nearest, ageOf(e.t, nowDay));
  return 0.5 ** (nearest / halfLife);
}

/**
 * The claim's val AT each of its own evidence events, in (t, h) order — "what did this claim
 * look like the moment that record landed". Between events val moves only by decay, and decay
 * is monotone toward 0.5 (every term shares one factor), so a threshold can only be crossed
 * AT an event or by that monotone drift: evaluating here plus once at `nowDay` is exact, not
 * a sample. This is what lets dormancy latch and lesson activation be sticky while staying a
 * pure function of the evidence SET (so replicas still agree after any merge order).
 * @param {any} claim
 * @param {{halfLife?:number}} [opts]
 * @returns {{t:number, v:number, result:string}[]}
 */
export function valTimeline(claim, { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  const evs = sortRecords((claim.evidence ?? []).filter(validOutcome));
  return evs.map((e, i) => ({
    t: e.t ?? 0,
    result: e.result,
    v: val({ evidence: evs.slice(0, i + 1) }, e.t ?? 0, { halfLife }),
  }));
}

/**
 * Dormant claims are kept for audit but never retrieved — and dormancy LATCHES. Once a
 * claim's val drops below DORMANT_VAL when a record lands, only a later CONFIRMATION can
 * lift it back out; decay alone must not. (Before: a claim refuted by a human revert sat at
 * 0.333, then drifted back toward the 0.5 prior and re-entered retrieval 11 days later with
 * no new evidence at all — review C7. Unreviewed claims decay toward uncertainty, but
 * "nobody has said anything since" is not a reason to start trusting a refuted one again.)
 * @param {any} claim
 * @param {number} [nowDay]
 * @param {{halfLife?:number}} [opts]
 */
export function isDormant(claim, nowDay = 0, { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  let latched = false;
  for (const p of valTimeline(claim, { halfLife })) {
    if (p.v < DORMANT_VAL) latched = true;
    else if (latched && p.result === "confirm") latched = false; // review restores weight
  }
  return latched || val(claim, nowDay, { halfLife }) < DORMANT_VAL;
}

/**
 * Sticky threshold crossing with hysteresis: "on" once val reaches `high` at an evidence
 * event, and off again only when it falls below `low` (by a contradiction, or by decay past
 * the lower bar). A single threshold FLAPS — one confirm put a lesson at exactly 0.6 against
 * an `active` bar of 0.6, so one day of decay retired it and it was never injected again
 * (review C6). Pure; deterministic across replicas.
 * @param {any} claim
 * @param {{high:number, low:number, nowDay?:number, halfLife?:number}} opts
 * @returns {boolean}
 */
export function sticky(claim, { high, low, nowDay = 0, halfLife = DEFAULT_HALF_LIFE_DAYS }) {
  let on = false;
  for (const p of valTimeline(claim, { halfLife })) {
    if (on && p.v < low) on = false;
    if (p.v >= high) on = true;
    else if (p.v < low) on = false;
  }
  return on && val(claim, nowDay, { halfLife }) >= low;
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

// Unicode-aware tokens: letters, digits and combining marks of ANY script. The old
// `[^a-z0-9]` split turned every non-ASCII text into the EMPTY token set, and two empty sets
// "agreed" on all 128 sketch lanes — any two Arabic (or Chinese, or Greek) texts scored 1.
const normalizeText = (text) =>
  String(text)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
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

/** A sketch lane no hash reached — only an EMPTY shingle set leaves lanes at this value. */
const EMPTY_LANE = 0xffffffff;

/** Jaccard estimate = fraction of agreeing sketch positions (1 for identical non-empty
 *  texts). An empty set shares nothing with anything, itself included: untouched lanes
 *  are not agreement. */
export function jaccard(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i] && a[i] !== EMPTY_LANE) eq++;
  return eq / n;
}

// Function words carry no topic; dropping them keeps "the"/"to" from making every claim
// look half-relevant to a short query.
const STOPWORDS = new Set(
  "a an the to of in on at by for from with and or but not no nor so as if then than that this these those it its is are was were be been being do does did can could will would should must may might shall i me my we us our you your he him his she her they them their what which who whom whose when where why how all any each into onto over under up down out off per via about also just only very".split(
    " ",
  ),
);

/** Query-side precomputation for rel(): its MinHash sketch and its content terms (the
 *  query's tokens minus stopwords; all tokens when it is nothing but stopwords). */
export function relQuery(text) {
  const toks = normalizeText(text);
  const content = toks.filter((t) => !STOPWORDS.has(t));
  return { sketch: sketch(text), terms: new Set(content.length ? content : toks) };
}

/**
 * Lexical relevance ∈ [0,1] = max(shingle Jaccard, query-term coverage). MinHash over
 * 4-token shingles is the spec's cheap `rel`, but a 2–3 word query is ONE shingle that no
 * claim contains, so "csrf login" scored ~0 against the CSRF fact (review C5). Coverage —
 * the fraction of the query's content terms the claim mentions — is the unigram backstop
 * that makes short queries work; long near-duplicate texts still score through Jaccard.
 * @param {{sketch:number[], terms?:Set<string>}} q a relQuery() (or {sketch} alone)
 * @param {any} claim
 */
export function lexicalRel(q, claim) {
  const j = jaccard(q.sketch, sketchOf(claim));
  if (!q.terms?.size) return j;
  const have = termsOf(claim);
  let hit = 0;
  for (const t of q.terms) if (have.has(t)) hit++;
  return Math.max(j, hit / q.terms.size);
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
const termsOf = (claim) => (claim._terms ??= new Set(normalizeText(claimText(claim))));

/**
 * Eq. 3 retrieval score (paper §7.1): σ(a·rel + b·rec + g·val + s·scope). The `g·val` term is
 * the protocol's load-bearing addition — outcome-confirmed claims outrank merely-recent ones.
 * Scope sits INSIDE the linear term as a small prior (EQ3_WEIGHTS.s). It used to multiply
 * σ from outside; with a+b+g = 1, σ only spans [0.5, 0.731], so the multiplier made scope a
 * strict priority — an unrelated, 400-day-old, contradicted symbol claim (0.5375) outranked a
 * perfect-match repo claim (0.3853) (review C5).
 *
 * `query` may be a string, a relQuery() object, or (legacy) a bare sketch array — the last
 * gets Jaccard-only relevance. `sim` (optional) replaces the lexical `rel` term with a
 * caller-supplied similarity (the ADR-0005 embeddings tier — built by callers from embed.js;
 * this pure core NEVER imports a provider). It returns a cosine in [-1,1] or null; null (or
 * any non-finite value) falls back to lexical relevance, and negatives clamp to 0 —
 * "anti-similar" is just irrelevant, never a penalty below unrelated. (retrieve() decides the
 * backend once per ranking, so one ranking never mixes cosine with Jaccard.)
 * @param {*} query
 * @param {any} claim
 * @param {{nowDay?:number, weights?:{a:number,b:number,g:number,s?:number}, sim?:(query:any, claim:any)=>number|null}} [opts]
 */
export function score(query, claim, opts = {}) {
  return scoreParts(query, claim, opts).score;
}

/** score() plus the relevance term it used — retrieve() reports `rel` so callers (déjà vu)
 *  can gate on relevance rather than on the whole score.
 *  @param {*} query
 *  @param {any} claim
 *  @param {{nowDay?:number, weights?:{a:number,b:number,g:number,s?:number},
 *           sim?:((query:any, claim:any)=>number|null)|null}} [opts]
 *  @returns {{score:number, rel:number}} */
function scoreParts(query, claim, { nowDay = 0, weights = EQ3_WEIGHTS, sim } = {}) {
  let rel = null;
  if (sim) {
    const s = sim(query, claim);
    if (typeof s === "number" && Number.isFinite(s)) rel = Math.max(0, Math.min(1, s));
  }
  if (rel === null) {
    const q =
      typeof query === "string"
        ? relQuery(query)
        : Array.isArray(query)
          ? { sketch: query }
          : query;
    rel = lexicalRel(q, claim);
  }
  const scopeW = SCOPE_WEIGHT[claim.scope?.level] ?? 0.5;
  const x =
    weights.a * rel +
    weights.b * rec(claim, nowDay) +
    weights.g * val(claim, nowDay) +
    (weights.s ?? 0) * scopeW;
  return { score: 1 / (1 + Math.exp(-x)), rel };
}

/** Rank live (non-dormant, non-tombstoned) claims for a query; caps at `budget`. Each row is
 *  {claim, score, rel}. Optional `sim` as in score() — the caller-built embedding
 *  similarity; the query string is what a sim sees. The backend is chosen ONCE per ranking:
 *  cosine only when the provider embedded every candidate, lexical for all otherwise —
 *  dense cosines sit at 0.4–0.6 for unrelated same-domain text while Jaccard sits near 0,
 *  so a partially embedded ledger used to rank every embedded claim above every lexical one.
 *  @param {*} query
 *  @param {any[]} claims
 *  @param {{nowDay?:number, budget?:number, weights?:{a:number,b:number,g:number,s?:number},
 *           sim?:((query:any, claim:any)=>number|null)|null}} [opts]
 *  @returns {{claim:any, score:number, rel:number}[]} */
export function retrieve(
  query,
  claims,
  { nowDay = 0, budget = 12, weights = EQ3_WEIGHTS, sim } = {},
) {
  const q = String(query);
  const rq = relQuery(q);
  const live = claims.filter((c) => !c.tombstone && !isDormant(c, nowDay));
  let boundSim;
  if (sim && live.length) {
    const sims = live.map((c) => sim(q, c));
    if (sims.every((x) => typeof x === "number" && Number.isFinite(x))) {
      const byClaim = new Map(live.map((c, i) => [c, sims[i]]));
      boundSim = (_q, c) => byClaim.get(c);
    }
  }
  return live
    .map((c) => {
      const p = scoreParts(rq, c, { nowDay, weights, sim: boundSim });
      return { claim: c, score: p.score, rel: p.rel };
    })
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

// ---------------------------------------------------------------------------
// Temporal views + Merkle state root. The store is append-only and every record
// carries its day, so any past day's beliefs are RECOMPUTABLE, never guessed —
// and a whole state can be summarized in one permutation-invariant hash.
// ---------------------------------------------------------------------------

/**
 * The state as it stood at end of `day`: claims whose mint day ≤ day — the earliest
 * provenance-log record, falling back to the claim's inline mint record, then 0
 * (mint-day-unknown must not hide a claim) — with every log filtered to records with
 * t ≤ day. Pure; inputs are not mutated. A lattice morphism:
 * stateAt(merge(a,b), d) ≡ merge(stateAt(a,d), stateAt(b,d)) — property-tested next
 * to the semilattice suite.
 * @param {{claims:any, evidence:any, provenance:any, tombstones:any}} state
 * @param {number} day epoch day (inclusive cutoff)
 */
export function stateAt(state, day) {
  const cut = (recs = []) => sortRecords(recs).filter((r) => (r.t ?? 0) <= day);
  const out = emptyState();
  for (const [id, c] of Object.entries(state.claims ?? {})) {
    const provAll = sortRecords(state.provenance?.[id] ?? []);
    const mintDay = provAll.length ? (provAll[0].t ?? 0) : (c.provenance?.t ?? 0);
    if (mintDay > day) continue; // minted after `day` — didn't exist yet
    out.claims[id] = c;
    out.provenance[id] = provAll.filter((r) => (r.t ?? 0) <= day);
    out.evidence[id] = cut(state.evidence?.[id] ?? []);
    out.tombstones[id] = cut(state.tombstones?.[id] ?? []);
  }
  return out;
}

/**
 * What changed between two days — with val() evaluated AT each day's own clock, so
 * this answers "what did we believe then", not "what does today think of then".
 *   appeared:     minted in (dayA, dayB]
 *   retired:      first tombstone lands in (dayA, dayB]
 *   strengthened: |Δval| ≥ epsilon upward     weakened: downward
 * @param {{claims:any, evidence:any, provenance:any, tombstones:any}} state
 * @param {number} dayA earlier day
 * @param {number} dayB later day
 * @param {{epsilon?:number, halfLife?:number}} [opts]
 * @returns {{appeared:any[], retired:any[], strengthened:any[], weakened:any[]}}
 *   rows are {id, kind, text, from, to} sorted by |Δval| desc then id asc
 */
export function beliefDiff(
  state,
  dayA,
  dayB,
  { epsilon = 0.05, halfLife = DEFAULT_HALF_LIFE_DAYS } = {},
) {
  const before = new Map(liveClaims(stateAt(state, dayA)).map((c) => [c.id, c]));
  const after = liveClaims(stateAt(state, dayB));
  const appeared = [];
  const retired = [];
  const moved = [];
  for (const c of after) {
    const prev = before.get(c.id);
    const text = claimText(c).slice(0, 120);
    // The tombstone test must run before the appeared test: a claim minted AND
    // retracted inside the window came and went — reporting it as "appeared" with a
    // live val would present a retracted claim as believed-at-dayB (review-verified).
    if (c.tombstone && !prev?.tombstone) {
      retired.push({
        id: c.id,
        kind: c.kind,
        text,
        from: prev ? round4(val(prev, dayA, { halfLife })) : null,
        to: null,
      });
      continue;
    }
    // Already dead at dayA: a retired belief does not "strengthen" or "weaken" by
    // pure decay — it is out of the belief set on both days, so no row at all.
    if (prev?.tombstone && c.tombstone) continue;
    if (!prev) {
      appeared.push({
        id: c.id,
        kind: c.kind,
        text,
        from: null,
        to: round4(val(c, dayB, { halfLife })),
      });
      continue;
    }
    const from = val(prev, dayA, { halfLife });
    const to = val(c, dayB, { halfLife });
    if (Math.abs(to - from) >= epsilon)
      moved.push({
        id: c.id,
        kind: c.kind,
        text,
        from: round4(from),
        to: round4(to),
      });
  }
  const byDelta = (a, b) =>
    Math.abs((b.to ?? 0) - (b.from ?? 0)) - Math.abs((a.to ?? 0) - (a.from ?? 0)) ||
    (a.id < b.id ? -1 : 1);
  appeared.sort(byDelta);
  retired.sort((a, b) => (b.from ?? 0) - (a.from ?? 0) || (a.id < b.id ? -1 : 1));
  return {
    appeared,
    retired,
    strengthened: moved.filter((m) => m.to > m.from).sort(byDelta),
    weakened: moved.filter((m) => m.to < m.from).sort(byDelta),
  };
}

const round4 = (x) => Number(x.toFixed(4));

/**
 * Merkle root over a ledger state. Leaf per claim id = hash of the claim's canonical
 * content plus its three logs in sortRecords order; shard hash per 2-hex-char id
 * prefix (the store's on-disk sharding) over its sorted "id:leaf" lines; root over
 * the sorted "prefix:shardHash" lines. Permutation- and merge-order-invariant by
 * construction: two replicas share a root ⇔ their verified states are identical, and
 * when they differ the differing shard hashes localize where.
 * @param {{claims:any, evidence:any, provenance:any, tombstones:any}} state
 * @returns {{root:string, shards:Record<string,string>, claims:number}}
 */
export function stateRoot(state) {
  const leaves = new Map(); // prefix → "id:leafHash" lines
  const ids = Object.keys(state.claims ?? {}).sort();
  for (const id of ids) {
    const leaf = contentHash(
      canonicalize({
        claim: state.claims[id],
        evidence: sortRecords(state.evidence?.[id] ?? []),
        provenance: sortRecords(state.provenance?.[id] ?? []),
        tombstones: sortRecords(state.tombstones?.[id] ?? []),
      }),
    );
    const prefix = id.slice(0, 2);
    if (!leaves.has(prefix)) leaves.set(prefix, []);
    leaves.get(prefix).push(`${id}:${leaf}`);
  }
  /** @type {Record<string, string>} */
  const shards = {};
  for (const prefix of [...leaves.keys()].sort())
    shards[prefix] = contentHash(leaves.get(prefix).join("\n"));
  const root = contentHash(
    Object.keys(shards)
      .sort()
      .map((p) => `${p}:${shards[p]}`)
      .join("\n"),
  );
  return { root, shards, claims: ids.length };
}

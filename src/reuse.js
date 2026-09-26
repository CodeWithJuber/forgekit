// forge reuse — the proof-carrying code cache (docs/plans/substrate-v2/03-reuse-cache.md).
// Verified artifacts become ledger claims keyed by a normalized task fingerprint;
// before generating, ask "have we (or a teammate) already built this?". A hit is
// served ONLY while its proof holds: confidence above the floor (evidence-earned,
// never asserted) AND its dependencies still resolving in the atlas — stale or
// discredited code silently stops being served, because the cache is pruned by
// ground truth, not by an LRU.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { has as atlasHas } from "./atlas.js";
import { claimSim, simLabel } from "./embed.js";
import { isDormant, jaccard, mintClaim, outcomeRecord, SKETCH_K, sketch, val } from "./ledger.js";
import { appendEvidence, loadClaims, putClaim, readEvidence, repoLedger } from "./ledger_store.js";
import { record as recordMetric } from "./metrics.js";
import { describeConflicts, semanticConflicts } from "./semantic_guard.js";
import { contentHash, gitAuthor } from "./util.js";

/** Serving floor: an artifact is reused only when independent oracles have earned it
 *  past this (a fresh, unverified mint sits at the 0.5 prior and does NOT serve —
 *  proof-carrying means the proof comes first). */
export const SERVE_FLOOR = 0.6;
/** Jaccard thresholds for the lookup ladder. */
export const NEAR_J = 0.8;
export const ADAPT_J = 0.6;
/** Cosine thresholds when the optional embedding sim (FORGE_EMBED) is active. They sit
 *  HIGHER than the Jaccard bars because the scales have different noise floors:
 *  Jaccard over 4-token shingles is ≈0 for unrelated specs, so 0.8/0.6 are far above
 *  noise — but dense embedding cosines routinely land at 0.4–0.6 for unrelated
 *  sentences in the same domain (vectors share background components). Reusing 0.8/0.6
 *  would over-serve; 0.85/0.7 keeps precision comparable to the MinHash ladder. */
export const NEAR_COS = 0.85;
export const ADAPT_COS = 0.7;

// ---------------------------------------------------------------------------
// Normalization — TWO forms, because "the same neighbourhood" and "the same task" are
// different questions (review C9, then review F04):
//   • specKey (IDENTITY) — LOSSLESS except for whitespace: Unicode NFC and runs of whitespace
//     collapsed, NOTHING else. Case, operators, literals, paths and punctuation all stay: the
//     old identity form lowercased and trimmed punctuation per token, so `accept ages >= 18`
//     and `<= 18`, `return "ADMIN"` and `"admin"`, `set enabled = true` and `!= true`, and
//     `getURL` and `getUrl` shared ONE exact key — an exact hit could serve the opposite
//     requirement. Two specs now share an exact key only when they are the same text.
//   • normalizeSpec (SHAPE) — volatile literals and identifiers become typed placeholders,
//     so those two specs still land in one near-NEIGHBOURHOOD and the adapt tier can offer
//     the artifact as a verified starting point ("generate only the delta").
// Similarity (the near tier's MinHash over the identity key, or an embedding cosine) finds
// NEIGHBOURS; it never by itself authorizes serving code as-is: a near candidate must also
// pass the semantic guard (same operators, numbers, literals, identifiers, paths and
// polarity words), else it is only offered at the adapt tier, for review.
// Both tokenizers are Unicode-aware: the ASCII `\w` trim erased every Arabic (or Chinese,
// or Greek) word, so any two non-ASCII specs normalized to "" and collided as exact.
// ---------------------------------------------------------------------------

/** The identity-key format version. v1 keys (pre-F04) were lossy, so they never exact-hit. */
export const KEY_VERSION = 2;

const NUM_RE = /^-?\d[\d.,_]*$/;
const PATH_RE = /[\\/]|\.(?:m?[jt]sx?|py|go|rs|java|rb|json|ya?ml|toml|md|css|html)$/i;
const STR_RE = /^["'`].*["'`]$/;
// camelCase, PascalCase-with-inner-cap, snake_case (incl. SCREAMING_SNAKE), dotted.paths
// — code identifiers, not prose. A single ALLCAPS word (DESC, RATE, TODO) is treated as
// prose emphasis and lowercased: shouting is not an identifier. (SHAPE form only — the
// identity form keeps case, and the semantic guard treats ALLCAPS as identity.)
const IDENT_RE = /^(?:[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z]|\w+_\w+|\w+\.\w+)\w*$/;

// Trim leading/trailing punctuation while keeping what MAKES a token: letters, digits and
// marks of any script, plus the code punctuation the classifiers below key on.
const TRIM_RE = /^[^\p{L}\p{N}\p{M}_"'`./\\-]+|[^\p{L}\p{N}\p{M}_"'`./\\-]+$/gu;

/** Identity normalization: NFC + whitespace runs collapsed + ends trimmed — nothing else. The
 *  exact key: two specs match here only when they are the SAME text. */
export function specKey(text) {
  return String(text).normalize("NFC").trim().split(/\s+/).filter(Boolean).join(" ");
}

/** Deterministic, pure spec SHAPE normalization (unit-tested surface). */
export function normalizeSpec(text) {
  return String(text)
    .split(/\s+/)
    .map((raw) => {
      const tok = raw.replace(TRIM_RE, "");
      if (!tok) return "";
      if (STR_RE.test(tok)) return "⟨str⟩";
      if (NUM_RE.test(tok)) return "⟨num⟩";
      if (PATH_RE.test(tok)) return "⟨path⟩";
      if (IDENT_RE.test(tok)) return "⟨ident⟩";
      return tok.toLowerCase();
    })
    .filter(Boolean)
    .join(" ");
}

/** The cache keys: `exact` (identity key + graph-slice context), `keySketch` (what the near
 *  tier measures) and `sketch` (the shape form the adapt tier and the LSH prefilter use). */
export function fingerprint(spec, slice = "") {
  const norm = normalizeSpec(spec);
  const key = specKey(spec);
  return {
    norm,
    key,
    exact: contentHash(`${key}\u0000${slice}`),
    sketch: sketch(norm),
    keySketch: sketch(key),
  };
}

// ---------------------------------------------------------------------------
// LSH banding — 32 bands × 4 rows over the 128-lane sketch. Collision probability
// 1−(1−J⁴)³²: ≈1.00 at J=0.8, 0.99 at J=0.6 (the ADAPT bar), 0.56 at J=0.4, 0.23 at J=0.3.
// A prefilter that keeps essentially every real candidate while still pruning the unrelated
// mass (unrelated specs sit at J≈0). The old 16×8 banding was documented as "≈0.96 at J=0.8
// and ≈0.17 at J=0.5"; the true figures were 0.95 and 0.06, and at the adapt threshold
// J=0.6 recall was 0.24 — three of every four adapt-tier hits were silently dropped once a
// ledger passed 32 artifacts (review C9).
// ---------------------------------------------------------------------------

const BANDS = 32;
const ROWS = SKETCH_K / BANDS;

export function bandKeys(sk) {
  const keys = [];
  for (let b = 0; b < BANDS; b++)
    keys.push(`${b}:${contentHash(sk.slice(b * ROWS, (b + 1) * ROWS).join(",")).slice(0, 16)}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Artifact claims
// ---------------------------------------------------------------------------

/**
 * Mint an artifact claim body. `code` is a verifiable pointer — {path, sha256} of the
 * committed file (or {inline} for snippets); `iface` = what it exports; `deps` = the
 * codebase symbols it requires (what revalidation checks); `form` = function/module/
 * component/config/test.
 * @returns {{ok:boolean, reason?:string, claim?:any}}
 */
export function artifactClaim(
  {
    spec,
    slice = "",
    iface = [],
    deps = [],
    depContracts = {},
    code,
    lang = "",
    form = "function",
  },
  t = 0,
) {
  return mintClaim({
    kind: "artifact",
    body: {
      code: code ?? {},
      // name → fingerprint of the dependency's declaration at mint time (review F05): a
      // same-name dependency whose signature changed invalidates the artifact.
      ...(Object.keys(depContracts).length ? { depContracts: sortedObject(depContracts) } : {}),
      deps: [...deps].sort(),
      form,
      iface: [...iface].sort(),
      // `key` is the LOSSLESS identity form (exact + near); `spec` stays the SHAPE form (adapt
      // and the LSH prefilter). A pre-C9 artifact has no key and can only reach adapt; a
      // pre-F04 key (no keyV) was lossy and never reaches exact.
      key: specKey(spec),
      keyV: KEY_VERSION,
      lang,
      slice,
      spec: normalizeSpec(spec),
    },
    scope: { level: "repo" },
    provenance: { agent: "reuse", author: gitAuthor() },
    t,
  });
}

/**
 * Cache-fill: mint the artifact and attach its verification evidence in one step.
 * Without evidence the artifact sits at the 0.5 prior and will NOT serve — pass the
 * oracle result that proved it (a test run, a human accept).
 * @param {string} dir ledger directory
 * @param {object} fields artifactClaim fields
 * @param {{evidence?: {oracle:string, result:"confirm"|"contradict", ref:string}, t?: number}} [opts]
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean, serves?:boolean}}
 */
export function mintArtifact(dir, fields, { evidence, t = 0 } = {}) {
  const minted = artifactClaim(fields, t);
  if (!minted.ok) return { ok: false, reason: minted.reason };
  const put = putClaim(dir, minted.claim);
  if (!put.ok) return put;
  if (evidence) {
    const o = outcomeRecord({ author: gitAuthor(), t, ...evidence });
    if (!o.ok) return { ok: false, reason: "reason" in o ? o.reason : "invalid evidence" };
    const a = appendEvidence(dir, minted.claim.id, o.outcome);
    if (!a.ok) return a;
  }
  // `serves` is what the proof actually earns, not "some evidence was passed": a ref forge
  // cannot resolve (`--ref lgtm`, `ci:1`) is recorded but capped below SERVE_FLOOR (C2).
  const serves = val({ evidence: readEvidence(dir, minted.claim.id) }, t) >= SERVE_FLOOR;
  return { ok: true, id: minted.claim.id, existed: put.existed, serves };
}

// ---------------------------------------------------------------------------
// The lookup ladder — pure over a claim list (store- and fs-free, fully testable).
// ---------------------------------------------------------------------------

const sortedObject = (o) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * A dependency's contract fingerprint: the hash of its DECLARATION as the source reads now
 * (the declaration line through the opening brace/arrow, whitespace-normalized) — what a
 * caller relies on. `null` when the atlas does not know the symbol or the file is unreadable.
 * With several same-name definitions the first by (file, line) is used, deterministically.
 * @param {string} root
 * @param {any} atlas
 * @param {string} name
 * @returns {string|null}
 */
export function depContract(root, atlas, name) {
  const sym = (atlas?.symbols ?? [])
    .filter((x) => x.name === name || x.qname === name)
    .sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0),
    )[0];
  if (!sym?.file || !sym.line) return null;
  let text;
  try {
    text = readFileSync(join(root, sym.file), "utf8");
  } catch {
    return null;
  }
  const decl = text
    .split(/\r?\n/)
    .slice(sym.line - 1, sym.line + 5)
    .join(" ");
  const cut = decl.search(/\{|=>/);
  const head = (cut >= 0 ? decl.slice(0, cut) : decl).replace(/\s+/g, " ").trim();
  return head ? contentHash(`${sym.kind ?? ""}\u0000${head}`).slice(0, 16) : null;
}

/**
 * Revalidation at the serving boundary (review F05). A proof is about the bytes and the
 * interfaces that existed when it was earned; before an artifact is served it must be checked
 * against what exists NOW:
 *   - its file (a `{path, sha256}` pointer) must exist with the SAME content digest — a proof
 *     of old bytes does not validate the current file, and a deleted file is not reusable;
 *   - every dependency must still resolve in the atlas, and every dependency contract recorded
 *     at mint must still match the current declaration (same name, changed signature ⇒ stale).
 * `status` is "valid", "invalid" (with `problems`) or "unknown": no repo root means the file
 * could not be checked, and no fresh atlas means the dependencies could not — UNKNOWN, never
 * silently "ok". Inline artifacts carry their own code and need no file check.
 * @param {any} artifact
 * @param {any} atlas
 * @param {{root?: string|null}} [opts]
 * @returns {{status: "valid"|"invalid"|"unknown", ok: boolean, checked: boolean,
 *   missing: string[], changed: string[], problems: string[], unknown: string[]}}
 */
export function revalidate(artifact, atlas, { root = null } = {}) {
  const code = artifact?.body?.code ?? {};
  const deps = artifact?.body?.deps ?? [];
  const problems = [];
  const unknown = [];
  if (code.path) {
    if (!root) unknown.push(`file ${code.path} (no repo root to check it against)`);
    else {
      let text = null;
      try {
        text = readFileSync(join(root, code.path), "utf8");
      } catch {}
      if (text === null) problems.push(`file ${code.path} no longer exists`);
      else if (code.sha256 && contentHash(text) !== code.sha256)
        problems.push(`file ${code.path} changed since it was verified`);
    }
  }
  const missing = [];
  const changed = [];
  if (!atlas) {
    if (deps.length) unknown.push("dependencies (no fresh atlas)");
  } else {
    for (const d of deps) if (!atlasHas(atlas, d)) missing.push(d);
    for (const [name, sig] of Object.entries(artifact?.body?.depContracts ?? {})) {
      if (missing.includes(name)) continue;
      const now = root ? depContract(root, atlas, name) : null;
      if (now === null) unknown.push(`contract of ${name}`);
      else if (now !== sig) changed.push(name);
    }
  }
  if (missing.length) problems.push(`missing ${missing.join(", ")}`);
  if (changed.length) problems.push(`changed contract: ${changed.join(", ")}`);
  const status = problems.length ? "invalid" : unknown.length ? "unknown" : "valid";
  return {
    status,
    ok: status === "valid",
    checked: status !== "unknown",
    missing,
    changed,
    problems,
    unknown,
  };
}

/**
 * exact → near → adapt → miss (docs/plans/substrate-v2/03 §3).
 * Optional `sim(normSpec, claim) → cosine|null` (the embeddings tier — built by
 * callers via embed.claimSim, keeping this ladder provider-free): when it yields a
 * number for a candidate, cosine thresholds NEAR_COS/ADAPT_COS apply; when it yields
 * null for that candidate (missing vector), MinHash Jaccard with NEAR_J/ADAPT_J is the
 * per-candidate fallback — a partially-embedded ledger never loses lexical recall.
 * Similarity alone never serves code as-is (review F04): a near candidate whose operators,
 * numbers, literals, identifiers, paths or polarity words differ from the query is held at
 * the adapt tier (a starting point to review), with the conflict named in `reasons`.
 * Every hit is revalidated at the serving boundary (review F05, see revalidate): an
 * `invalid` artifact is never served; an `unknown` one is returned with
 * `requiresRevalidation: true` — never presented as checked.
 * @param {any[]} claims live ledger claims (any kind — filtered here)
 * @param {string} spec the task
 * @param {{slice?:string, atlas?:any, nowDay?:number, root?:string|null,
 *          sim?:((query:any, claim:any)=>number|null)|null}} opts
 * @returns {{tier:"exact"|"near"|"adapt"|"miss", artifact?:any, jaccard?:number,
 *            similarity?:number, simBackend?:string, revalidation?:object,
 *            requiresRevalidation?:boolean, reasons:string[], sim?:string,
 *            invalidated?:{id:string, missing:string[], changed:string[], problems:string[]}[]}}
 *            `sim` is stamped by reuseQuery/reusePeek (the backend label the CLI prints);
 *            lookup itself never sets it.
 */
export function lookup(
  claims,
  spec,
  { slice = "", atlas = null, nowDay = 0, sim = null, root = null } = {},
) {
  const { key, sketch: qs, keySketch: qk } = fingerprint(spec, slice);
  const reasons = [];
  const invalidated = [];
  const artifacts = claims.filter(
    (c) => c.kind === "artifact" && !c.tombstone && !isDormant(c, nowDay),
  );

  const proved = (c, why) => {
    const v = val(c, nowDay);
    if (v >= SERVE_FLOOR) return true;
    reasons.push(`${why} ${c.id.slice(0, 8)} below proof floor (val ${v.toFixed(2)})`);
    return false;
  };
  // Revalidate at the boundary; an invalid artifact is recorded and skipped.
  const servable = (c, why) => {
    const rv = revalidate(c, atlas, { root });
    if (rv.status !== "invalid") return rv;
    invalidated.push({
      id: c.id,
      missing: rv.missing,
      changed: rv.changed,
      problems: rv.problems,
    });
    reasons.push(`${why} ${c.id.slice(0, 8)} failed revalidation: ${rv.problems.join("; ")}`);
    return null;
  };
  const served = (tier, c, rv, extra = {}) => ({
    tier,
    artifact: c,
    ...extra,
    revalidation: rv,
    ...(rv.status === "valid" ? {} : { requiresRevalidation: true }),
    reasons,
    invalidated,
  });

  // 1. exact: the same task (LOSSLESS identity key, current key version), same graph-slice
  //    context. An empty key is not an identity, so a spec that normalizes to nothing never
  //    matches anything.
  for (const c of artifacts) {
    if (
      key &&
      c.body.keyV === KEY_VERSION &&
      c.body.key === key &&
      (c.body.slice ?? "") === slice &&
      proved(c, "exact")
    ) {
      const rv = servable(c, "exact");
      if (rv) return served("exact", c, rv, { jaccard: 1, similarity: 1 });
    }
  }

  // 2–3. near/adapt: LSH candidates when the pool is big, all-pairs when small. With a
  // sim the LSH prefilter is skipped — banding indexes MinHash sketches, not vectors,
  // and would drop exactly the paraphrase candidates only the embedding can see
  // (cosine over precomputed vectors is cheap, so all-pairs is fine).
  // (`_specSketch`/`_keySketch`, not `_sketch`: ledger.js memoizes the CLAIM-text sketch
  //  under that name, and the two would overwrite each other.)
  const shapeOf = (c) => (c._specSketch ??= sketch(c.body.spec ?? ""));
  const keyOf = (c) => (c._keySketch ??= sketch(c.body.key ?? ""));
  let pool = artifacts;
  if (!sim && artifacts.length > 32) {
    const qBands = new Set(bandKeys(qs));
    pool = artifacts.filter((c) => bandKeys(shapeOf(c)).some((k) => qBands.has(k)));
  }
  // near compares IDENTITY (same names, reworded prose); adapt compares SHAPE too, so
  // `add pagination to listOrders` can still be offered the listUsers artifact as a
  // starting point — the tier that says "generate only the delta" — but never as-is.
  const measure = (c) => {
    if (sim) {
      const s = sim(key, c);
      if (typeof s === "number" && Number.isFinite(s))
        return { c, v: s, backend: "embed", near: s >= NEAR_COS, adapt: s >= ADAPT_COS };
    }
    const jKey = c.body.key ? jaccard(qk, keyOf(c)) : 0;
    const jShape = jaccard(qs, shapeOf(c));
    const v = Math.max(jKey, jShape);
    return { c, v, backend: "minhash", near: jKey >= NEAR_J, adapt: v >= ADAPT_J };
  };
  const ranked = pool
    .map(measure)
    .filter((x) => x.adapt)
    .sort((a, b) => b.v - a.v || (a.c.id < b.c.id ? -1 : 1));
  // F04: similarity found a neighbour; the semantic guard decides whether it is the same
  // instruction. Any behaviour-bearing difference holds the candidate at adapt.
  for (const x of ranked) {
    if (!x.near) continue;
    const conflicts = semanticConflicts(spec, x.c.body.key ?? "");
    if (!conflicts.length) continue;
    x.near = false;
    reasons.push(
      `near ${x.c.id.slice(0, 8)} held at adapt — differs in ${describeConflicts(conflicts)}`,
    );
  }

  const hit = (tier, x, revalidation) =>
    served(tier, x.c, revalidation, {
      // `jaccard` keeps its honest meaning (a Jaccard estimate) — only set on the
      // MinHash backend. `similarity` is the score the tier decision actually used.
      jaccard: x.backend === "minhash" ? x.v : undefined,
      similarity: x.v,
      simBackend: x.backend,
    });
  // No early break: backends interleave in one ranking, so a non-near embed candidate
  // may sort above a near MinHash one — skip, don't stop.
  for (const x of ranked) {
    if (!x.near || !proved(x.c, "near")) continue;
    const rv = servable(x.c, "near");
    if (rv) return hit("near", x, rv);
  }
  for (const x of ranked) {
    if (x.near) continue; // handled above
    if (!proved(x.c, "adapt")) continue;
    // adapt injects the artifact as a starting point: its FILE must still be the verified
    // bytes (a deleted/changed file is no starting point); its deps are the delta's problem.
    const rv = revalidate({ ...x.c, body: { ...x.c.body, deps: [], depContracts: {} } }, null, {
      root,
    });
    if (rv.status === "invalid") {
      reasons.push(`adapt ${x.c.id.slice(0, 8)} skipped: ${rv.problems.join("; ")}`);
      continue;
    }
    return hit("adapt", x, rv);
  }
  return { tier: "miss", reasons, invalidated };
}

// ---------------------------------------------------------------------------
// Store-level query: lookup + evidence write-back + metrics — what the CLI and the
// substrate stage call.
// ---------------------------------------------------------------------------

/** Rough tokens a hit avoids generating (chars/3.6 heuristic; calibrated in P8). */
const savedEstimate = (tier, artifact) => {
  const size =
    JSON.stringify(artifact?.body?.code ?? {}).length + (artifact?.body?.spec.length ?? 0);
  const factor = tier === "exact" ? 1 : tier === "near" ? 0.85 : 0.5;
  return Math.round((size / 3.6) * factor);
};

/** Build the optional embedding sim for the ladder (FORGE_EMBED set → cosine over
 *  NORMALIZED specs, the same text space MinHash compares; unset or provider failure
 *  → null and the caller's MinHash path is unchanged). One provider call embeds the
 *  query plus every candidate spec, disk-cached under `.forge/embed-cache.jsonl`. */
const specSim = (root, spec, claims) =>
  claimSim(
    root,
    specKey(spec),
    claims.filter((c) => c.kind === "artifact" && !c.tombstone),
    // The IDENTITY text, so the vector sees the identifiers the tier decision cares about
    // (a pre-C9 artifact has only the shape form).
    (c) => c.body?.key ?? c.body?.spec ?? "",
  );

export function reuseQuery(root, spec, { slice = "", atlas = null, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  const claims = existsSync(join(dir, "claims")) ? loadClaims(dir) : [];
  const sim = specSim(root, spec, claims);
  const r = lookup(claims, spec, { slice, atlas, nowDay, sim, root });
  r.sim = simLabel(sim);

  // A FAILED revalidation is an oracle outcome (graph.reval): an artifact whose deps
  // vanished demotes itself — for everyone. A PASSING one is not written back: serving is
  // never confirmation (review C2 — ten daily serves used to lift val 0.643 → 0.864 and
  // kept an artifact served after two failing test runs). Only a real oracle raises val.
  // A changed file or dependency CONTRACT is not written back either: the proof was true of
  // the bytes it saw — the artifact is merely not servable as the current code (review F05).
  for (const inv of r.invalidated ?? []) {
    if (!inv.missing.length) continue;
    const o = outcomeRecord({
      oracle: "graph.reval",
      result: "contradict",
      ref: `atlas:missing:${inv.missing.slice(0, 3).join(",")}`,
      author: gitAuthor(),
      t: nowDay,
    });
    if (o.ok) appendEvidence(dir, inv.id, o.outcome);
  }

  recordMetric(root, {
    stage: "cache",
    outcome: r.tier === "miss" ? "miss" : `hit_${r.tier}`,
    savedEstimate: r.tier === "miss" ? 0 : savedEstimate(r.tier, r.artifact),
    ref: r.artifact?.id,
  });
  return r;
}

/** Read-only lookup for the ambient/hook path — never appends evidence or metrics
 *  (hooks must not write on every prompt; the explicit gate meters instead).
 *  @returns {ReturnType<typeof lookup>} */
export function reusePeek(root, spec, { slice = "", atlas = null, nowDay = 0 } = {}) {
  const dir = repoLedger(root);
  if (!existsSync(join(dir, "claims"))) return { tier: "miss", reasons: [], sim: "minhash" };
  const claims = loadClaims(dir);
  const sim = specSim(root, spec, claims);
  const r = lookup(claims, spec, { slice, atlas, nowDay, sim, root });
  r.sim = simLabel(sim);
  return r;
}

// ---------------------------------------------------------------------------
// Cache-fill helpers for `forge reuse mint` — extract the verifiable pointer and
// the structural facts from a real file (regex tier, same honesty as the atlas).
// ---------------------------------------------------------------------------

const EXPORT_RES = [
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
];
const IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+["']\.{1,2}\//g;

/**
 * The verifiable pointer + structural facts of a real file: `{path, sha256}`, exports, the
 * codebase symbols it imports, and — given an atlas — each dependency's contract
 * fingerprint, so a later signature change invalidates the artifact (review F05).
 * @param {string} root
 * @param {string} relPath
 * @param {{atlas?: any}} [opts]
 */
export function describeFile(root, relPath, { atlas = null } = {}) {
  const abs = join(root, relPath);
  const text = readFileSync(abs, "utf8");
  const iface = [];
  for (const re of EXPORT_RES) for (const m of text.matchAll(re)) iface.push(m[1]);
  const deps = [];
  for (const m of text.matchAll(IMPORT_RE))
    deps.push(
      ...m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .filter(Boolean),
    );
  const uniqueDeps = [...new Set(deps)];
  /** @type {Record<string, string>} */
  const depContracts = {};
  if (atlas)
    for (const d of uniqueDeps) {
      const sig = depContract(root, atlas, d);
      if (sig) depContracts[d] = sig;
    }
  return {
    code: { path: relPath, sha256: contentHash(text) },
    iface: [...new Set(iface)],
    deps: uniqueDeps,
    depContracts,
    lang: relPath.split(".").pop() ?? "",
  };
}

// forge ledger storage — the on-disk PCM ledger (docs/plans/substrate-v2/02-team-memory.md):
// one immutable canonical-JSON file per claim (sharded by id prefix), one append-only
// evidence log per claim, tombstones as marker files, and a generated human index.
// Every path is content-addressed, so two teammates' ledgers merge in git with zero
// conflicts (evidence logs use the union merge driver; see .gitattributes note below).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalize, claimId, liveClaims, mergeStates, SECRET_RE, val } from "./ledger.js";

/** The canonical repo ledger. (recall's global store keeps its own sibling ledger.) */
export const repoLedger = (root = process.cwd()) => join(root, ".forge", "ledger");

const claimPath = (dir, id) => join(dir, "claims", id.slice(0, 2), `${id}.json`);
const evidencePath = (dir, id) => join(dir, "evidence", `${id}.log`);
const tombPath = (dir, id) => join(dir, "tombstones", `${id}.json`);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // one corrupt file must never take down the whole ledger
  }
};

/**
 * Persist a claim (idempotent — content-addressed, so rewriting the same claim is a
 * no-op). Refuses id mismatches and secrets; stores canonical bytes only (evidence and
 * tombstones live in their own append-only files, never inside the claim file).
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean}}
 */
export function putClaim(dir, claim) {
  if (!claim?.id || claim.id !== claimId(claim.kind, claim.body, claim.scope))
    return { ok: false, reason: "claim id does not match canonical content hash" };
  const text = canonicalize({
    body: claim.body,
    kind: claim.kind,
    provenance: claim.provenance ?? {},
    scope: claim.scope ?? {},
    v: claim.v ?? 1,
  });
  if (SECRET_RE.test(text))
    return { ok: false, reason: "refused: claim looks like it contains a secret/credential" };
  const path = claimPath(dir, claim.id);
  if (existsSync(path)) return { ok: true, id: claim.id, existed: true };
  mkdirSync(join(dir, "claims", claim.id.slice(0, 2)), { recursive: true });
  writeFileSync(path, `${text}\n`);
  return { ok: true, id: claim.id, existed: false };
}

/** Append one evidence outcome (deduped by its content hash — append is idempotent). */
export function appendEvidence(dir, id, outcome) {
  if (!outcome?.h) return { ok: false, reason: "outcome missing content hash (use outcomeRecord)" };
  if (!existsSync(claimPath(dir, id)))
    return { ok: false, reason: `no such claim in ledger: ${id}` };
  const existing = readEvidence(dir, id);
  if (existing.some((e) => e.h === outcome.h)) return { ok: true, deduped: true };
  mkdirSync(join(dir, "evidence"), { recursive: true });
  appendFileSync(evidencePath(dir, id), `${canonicalize(outcome)}\n`);
  return { ok: true, deduped: false };
}

/** All evidence outcomes for a claim (corrupt lines skipped, duplicates dropped). */
export function readEvidence(dir, id) {
  const path = evidencePath(dir, id);
  if (!existsSync(path)) return [];
  const seen = new Set();
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o?.h && !seen.has(o.h)) {
        seen.add(o.h);
        out.push(o);
      }
    } catch {}
  }
  return out;
}

/** Retract a claim (grow-only marker — the claim file stays, for audit). */
export function tombstone(dir, id, { author = "", reason = "", t = 0 } = {}) {
  if (!existsSync(claimPath(dir, id)))
    return { ok: false, reason: `no such claim in ledger: ${id}` };
  mkdirSync(join(dir, "tombstones"), { recursive: true });
  const path = tombPath(dir, id);
  if (!existsSync(path)) writeFileSync(path, `${canonicalize({ author, reason, t })}\n`);
  return { ok: true };
}

/** Load the full ledger state {claims, evidence, tombstones} from disk. */
export function loadState(dir) {
  const state = { claims: {}, evidence: {}, tombstones: {} };
  const claimsRoot = join(dir, "claims");
  if (existsSync(claimsRoot)) {
    for (const shard of readdirSync(claimsRoot).sort()) {
      const shardDir = join(claimsRoot, shard);
      for (const f of readdirSync(shardDir)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const c = readJson(join(shardDir, f));
        const id = f.replace(/\.json$/, "");
        // Verify the address on read: a tampered/corrupt claim is skipped, not trusted.
        if (c && claimId(c.kind, c.body, c.scope) === id) {
          state.claims[id] = { ...c, id };
          state.evidence[id] = readEvidence(dir, id);
        }
      }
    }
  }
  const tombsRoot = join(dir, "tombstones");
  if (existsSync(tombsRoot)) {
    for (const f of readdirSync(tombsRoot).filter((f) => f.endsWith(".json"))) {
      const t = readJson(join(tombsRoot, f));
      if (t) state.tombstones[f.replace(/\.json$/, "")] = t;
    }
  }
  return state;
}

/** All claims with evidence + tombstones attached (the retrieval input). */
export function loadClaims(dir) {
  return liveClaims(loadState(dir));
}

/** Semilattice import: merge another ledger state into this directory (P2's `forge
 *  ledger merge` core). Idempotent; safe to re-run. */
export function importState(dir, other) {
  const merged = mergeStates(loadState(dir), other);
  let claims = 0;
  let outcomes = 0;
  for (const c of Object.values(merged.claims)) {
    const r = putClaim(dir, c);
    if (r.ok && !r.existed) claims++;
    for (const o of merged.evidence[c.id] ?? []) {
      const a = appendEvidence(dir, c.id, o);
      if (a.ok && !a.deduped) outcomes++;
    }
  }
  for (const [id, t] of Object.entries(merged.tombstones)) tombstone(dir, id, t);
  reindex(dir);
  return { claims, outcomes };
}

/** Regenerate LEDGER.md — the human index (like recall's MEMORY.md). */
export function reindex(dir, nowDay = 0) {
  const claims = loadClaims(dir);
  mkdirSync(dir, { recursive: true });
  const rows = claims
    .filter((c) => !c.tombstone)
    .map((c) => `- \`${c.id.slice(0, 12)}\` ${c.kind} · val ${val(c, nowDay).toFixed(2)}`);
  writeFileSync(
    join(dir, "LEDGER.md"),
    ["# Proof-Carrying Memory ledger", "", ...rows, ""].join("\n"),
  );
  return rows.length;
}

/**
 * Normal-form check (CI-friendly): every claim parses and matches its address, every
 * evidence line parses with a valid shape and a ref, no secrets anywhere.
 * @returns {{ok:boolean, claims:number, outcomes:number, issues:string[]}}
 */
export function verify(dir) {
  const issues = [];
  let claims = 0;
  let outcomes = 0;
  const claimsRoot = join(dir, "claims");
  if (existsSync(claimsRoot)) {
    for (const shard of readdirSync(claimsRoot).sort()) {
      for (const f of readdirSync(join(claimsRoot, shard))
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const raw = readFileSync(join(claimsRoot, shard, f), "utf8");
        const c = readJson(join(claimsRoot, shard, f));
        const id = f.replace(/\.json$/, "");
        if (!c) issues.push(`claim ${id}: unparseable`);
        else if (claimId(c.kind, c.body, c.scope) !== id) issues.push(`claim ${id}: id mismatch`);
        else claims++;
        if (SECRET_RE.test(raw)) issues.push(`claim ${id}: contains secret-like content`);
      }
    }
  }
  const evRoot = join(dir, "evidence");
  if (existsSync(evRoot)) {
    for (const f of readdirSync(evRoot).filter((f) => f.endsWith(".log"))) {
      const id = f.replace(/\.log$/, "");
      for (const [n, line] of readFileSync(join(evRoot, f), "utf8").split("\n").entries()) {
        if (!line.trim()) continue;
        let o = null;
        try {
          o = JSON.parse(line);
        } catch {}
        if (!o?.h || !o.ref || !o.oracle) issues.push(`evidence ${id}:${n + 1}: invalid outcome`);
        else outcomes++;
        if (SECRET_RE.test(line)) issues.push(`evidence ${id}:${n + 1}: secret-like content`);
      }
    }
  }
  return { ok: issues.length === 0, claims, outcomes, issues };
}

/** Move dormant/tombstoned claim files to the attic (audit trail, never retrieved). */
export function pruneToAttic(dir, id) {
  const from = claimPath(dir, id);
  if (!existsSync(from)) return { ok: false, reason: "no such claim" };
  mkdirSync(join(dir, "attic"), { recursive: true });
  renameSync(from, join(dir, "attic", `${id}.json`));
  return { ok: true };
}

/** Counts + val distribution for `forge ledger stats` and the dashboard. */
export function stats(dir, nowDay = 0) {
  const claims = loadClaims(dir);
  const byKind = {};
  const buckets = { dormant: 0, uncertain: 0, trusted: 0 };
  for (const c of claims) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const v = val(c, nowDay);
    if (v < 0.35) buckets.dormant++;
    else if (v < 0.65) buckets.uncertain++;
    else buckets.trusted++;
  }
  return {
    total: claims.length,
    tombstoned: claims.filter((c) => c.tombstone).length,
    byKind,
    val: buckets,
  };
}

// forge ledger storage — the on-disk PCM ledger (docs/plans/substrate-v2/02-team-memory.md):
// one immutable canonical-JSON file per claim (sharded by id prefix, bytes = pure
// content so every replica writes the identical file), plus three append-only logs per
// claim — evidence, provenance, tombstones — that git union-merges without conflicts
// (`forge init` emits the .gitattributes rule). Everything author- or time-varying is
// a log line; nothing on disk is ever edited in place.
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
import {
  authorTrust,
  canonicalize,
  claimId,
  DORMANT_VAL,
  emptyState,
  liveClaims,
  mergeStates,
  ORACLES,
  SECRET_RE,
  sealRecord,
  sortRecords,
  val,
  validOutcome,
} from "./ledger.js";

/** The canonical repo ledger. (recall's global store keeps its own sibling ledger.) */
export const repoLedger = (root = process.cwd()) => join(root, ".forge", "ledger");

/** The union-merge rule consumer repos need for conflict-free ledger merges —
 *  emitted into .gitattributes by `forge init` (see init.js). NOTE: .gitattributes
 *  supports full-line comments only, so the rule ships with a comment line above it. */
export const GITATTRIBUTES_RULE = [
  "# PCM ledger logs are hash-deduped append-only sets - union merge is conflict-free (forge)",
  ".forge/ledger/*/*.log merge=union",
].join("\n");

const LOGS = ["evidence", "provenance", "tombstones"];
const claimPath = (dir, id) => join(dir, "claims", id.slice(0, 2), `${id}.json`);
const logPath = (dir, log, id) => join(dir, log, `${id}.log`);

/** Claim file bytes: pure content only. Identical for the same id on every replica. */
const claimBytes = (claim) =>
  `${canonicalize({ body: claim.body, kind: claim.kind, scope: claim.scope ?? {}, v: claim.v ?? 1 })}\n`;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // one corrupt file must never take down the whole ledger
  }
};

/** Parse an append-only log: one canonical-JSON record per line, deduped by content
 *  hash, corrupt lines skipped. The single reader every log goes through. */
function readLog(dir, log, id) {
  const path = logPath(dir, log, id);
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  // sortRecords, not file order: after a git union merge the two replicas' logs hold
  // the same set in different line orders — views must not depend on that.
  return sortRecords(records);
}

/** Append one sealed record to a log iff its hash isn't already present. */
function appendRecord(dir, log, id, record) {
  if (!record?.h) return { ok: false, reason: "record missing content hash" };
  if (!existsSync(claimPath(dir, id)))
    return { ok: false, reason: `no such claim in ledger: ${id}` };
  if (readLog(dir, log, id).some((e) => e.h === record.h)) return { ok: true, deduped: true };
  mkdirSync(join(dir, log), { recursive: true });
  appendFileSync(logPath(dir, log, id), `${canonicalize(record)}\n`);
  return { ok: true, deduped: false };
}

/** Walk every claim file: yields {id, path, raw, claim(valid-or-null)}. Shared by
 *  loadState (keep valid) and verify (report invalid) so the two can never drift. */
function* walkClaimFiles(dir) {
  const claimsRoot = join(dir, "claims");
  if (!existsSync(claimsRoot)) return;
  for (const shard of readdirSync(claimsRoot).sort()) {
    for (const f of readdirSync(join(claimsRoot, shard))
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const path = join(claimsRoot, shard, f);
      const id = f.replace(/\.json$/, "");
      const parsed = readJson(path);
      // Verify the address: a tampered/corrupt claim is surfaced as claim:null.
      const valid = parsed && claimId(parsed.kind, parsed.body, parsed.scope) === id;
      yield { id, path, raw: readFileSync(path, "utf8"), claim: valid ? { ...parsed, id } : null };
    }
  }
}

/**
 * Persist a claim (idempotent — content-addressed). Bytes contain content only;
 * the claim's provenance record (if any) is appended to the provenance log. A
 * corrupt/truncated file at the claim's path is REPAIRED by rewriting the canonical
 * bytes — a killed process must never leave a claim permanently unloadable.
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean}}
 */
export function putClaim(dir, claim) {
  if (!claim?.id || claim.id !== claimId(claim.kind, claim.body, claim.scope))
    return { ok: false, reason: "claim id does not match canonical content hash" };
  const text = claimBytes(claim);
  if (SECRET_RE.test(text))
    return { ok: false, reason: "refused: claim looks like it contains a secret/credential" };
  const path = claimPath(dir, claim.id);
  const already = existsSync(path);
  const healthy = already && readJson(path) !== null && readFileSync(path, "utf8") === text;
  if (!healthy) {
    mkdirSync(join(dir, "claims", claim.id.slice(0, 2)), { recursive: true });
    writeFileSync(path, text);
  }
  if (claim.provenance?.h) appendRecord(dir, "provenance", claim.id, claim.provenance);
  return { ok: true, id: claim.id, existed: already && healthy };
}

/** Append one evidence outcome (deduped by its content hash — append is idempotent). */
export function appendEvidence(dir, id, outcome) {
  if (!validOutcome(outcome)) return { ok: false, reason: "invalid outcome (use outcomeRecord)" };
  return appendRecord(dir, "evidence", id, outcome);
}

/** All evidence outcomes for a claim (corrupt lines skipped, duplicates dropped). */
export function readEvidence(dir, id) {
  return readLog(dir, "evidence", id);
}

/** Retract a claim — an append-only record, so two teammates retracting concurrently
 *  both survive the merge (the view shows the earliest deterministically). */
export function tombstone(dir, id, { author = "", reason = "", t = 0 } = {}) {
  return appendRecord(dir, "tombstones", id, sealRecord({ author, reason, t }));
}

/** Load the full ledger state {claims, evidence, provenance, tombstones}. */
export function loadState(dir) {
  const state = emptyState();
  for (const { id, claim } of walkClaimFiles(dir)) {
    if (!claim) continue;
    state.claims[id] = claim;
    for (const log of LOGS) state[log][id] = readLog(dir, log, id);
  }
  return state;
}

/** All claims with evidence/provenance/tombstone views attached (retrieval input). */
export function loadClaims(dir) {
  return liveClaims(loadState(dir));
}

/** Find one claim by id prefix without scanning the whole ledger (ids are sharded by
 *  their first two hex chars, so any prefix ≥ 2 chars pins the shard). */
export function getClaimByPrefix(dir, prefix) {
  if (!prefix || prefix.length < 2) return null;
  const shardDir = join(dir, "claims", prefix.slice(0, 2));
  if (!existsSync(shardDir)) return null;
  const f = readdirSync(shardDir)
    .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
    .sort()[0];
  if (!f) return null;
  const id = f.replace(/\.json$/, "");
  const claim = readJson(join(shardDir, f));
  if (!claim || claimId(claim.kind, claim.body, claim.scope) !== id) return null;
  const state = emptyState();
  state.claims[id] = { ...claim, id };
  for (const log of LOGS) state[log][id] = readLog(dir, log, id);
  return liveClaims(state)[0];
}

/** `forge ledger merge <path>` — semilattice merge of another on-disk ledger into
 *  this one. Idempotent and order-independent by the CRDT property, so merging a
 *  teammate's checkout, a backup, or a branch worktree is always safe. */
export function mergeDirs(dstDir, srcDir) {
  return importState(dstDir, loadState(srcDir));
}

/**
 * `forge ledger blame <id-prefix>` — the full accountability view of one claim: who
 * minted it (every author, via the provenance log), every evidence record in (t, h)
 * order, retractions, and the per-author trust the ledger has earned (17:36's audit
 * trail: every channel the agent used can be questioned).
 */
export function blame(dir, prefix, nowDay = 0) {
  const claim = getClaimByPrefix(dir, prefix);
  if (!claim) return null;
  const trust = authorTrust(loadClaims(dir));
  return {
    id: claim.id,
    kind: claim.kind,
    body: claim.body,
    scope: claim.scope,
    minted: claim.provenanceAll,
    evidence: claim.evidence,
    tombstones: readLog(dir, "tombstones", claim.id),
    val: val(claim, nowDay),
    valTrustWeighted: val(claim, nowDay, { trust }),
    trust: Object.fromEntries(
      [
        ...new Set(
          [...claim.provenanceAll, ...claim.evidence].map((r) => r.author).filter(Boolean),
        ),
      ].map((a) => [a, trust[a] ?? 1]),
    ),
  };
}

/** Semilattice import: merge another ledger state into this directory (the mergeDirs
 *  core). Idempotent; safe to re-run. */
export function importState(dir, other) {
  const merged = mergeStates(loadState(dir), other);
  let claims = 0;
  let records = 0;
  for (const c of Object.values(merged.claims)) {
    const r = putClaim(dir, c);
    if (r.ok && !r.existed) claims++;
    for (const log of LOGS) {
      for (const rec of merged[log][c.id] ?? []) {
        const a = appendRecord(dir, log, c.id, rec);
        if (a.ok && !a.deduped) records++;
      }
    }
  }
  reindex(dir);
  return { claims, records };
}

/** Regenerate LEDGER.md — the human index (like recall's MEMORY.md). */
export function reindex(dir, nowDay = 0) {
  const rows = loadClaims(dir)
    .filter((c) => !c.tombstone)
    .map((c) => `- \`${c.id.slice(0, 12)}\` ${c.kind} · val ${val(c, nowDay).toFixed(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "LEDGER.md"),
    ["# Proof-Carrying Memory ledger", "", ...rows, ""].join("\n"),
  );
  return rows.length;
}

/**
 * Normal-form check (CI-friendly): every claim parses and matches its address; every
 * log line parses, carries a TRUE content hash, and (for evidence) names a known
 * oracle with the table weight; no secrets anywhere. Everything loadState silently
 * skips, verify names.
 * @returns {{ok:boolean, claims:number, outcomes:number, issues:string[]}}
 */
export function verify(dir) {
  const issues = [];
  let claims = 0;
  let outcomes = 0;
  const ids = [];
  for (const { id, raw, claim } of walkClaimFiles(dir)) {
    if (!claim) issues.push(`claim ${id}: unparseable or id mismatch`);
    else {
      claims++;
      ids.push(id);
    }
    if (SECRET_RE.test(raw)) issues.push(`claim ${id}: contains secret-like content`);
  }
  for (const log of LOGS) {
    const logRoot = join(dir, log);
    if (!existsSync(logRoot)) continue;
    for (const f of readdirSync(logRoot).filter((f) => f.endsWith(".log"))) {
      const id = f.replace(/\.log$/, "");
      for (const [n, line] of readFileSync(join(logRoot, f), "utf8").split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const where = `${log} ${id}:${n + 1}`;
        let o = null;
        try {
          o = JSON.parse(line);
        } catch {}
        if (!o?.h) {
          issues.push(`${where}: unparseable or missing hash`);
          continue;
        }
        const { h, ...rest } = o;
        if (sealRecord(rest).h !== h) {
          issues.push(`${where}: content hash mismatch (forged/corrupt)`);
        } else if (log === "evidence") {
          if (!validOutcome(o)) issues.push(`${where}: invalid outcome (oracle/result/ref)`);
          else if (o.w !== ORACLES[o.oracle].w)
            issues.push(`${where}: recorded weight ${o.w} != oracle table ${ORACLES[o.oracle].w}`);
          else outcomes++;
        }
        if (SECRET_RE.test(line)) issues.push(`${where}: secret-like content`);
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

/** Counts + val distribution for `forge ledger stats` and the dashboard. Buckets use
 *  the protocol's DORMANT_VAL threshold (and its mirror) — never a local literal. */
export function stats(dir, nowDay = 0) {
  const claims = loadClaims(dir);
  const byKind = {};
  const buckets = { dormant: 0, uncertain: 0, trusted: 0 };
  for (const c of claims) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const v = val(c, nowDay);
    if (v < DORMANT_VAL) buckets.dormant++;
    else if (v < 1 - DORMANT_VAL) buckets.uncertain++;
    else buckets.trusted++;
  }
  return {
    total: claims.length,
    tombstoned: claims.filter((c) => c.tombstone).length,
    byKind,
    val: buckets,
  };
}

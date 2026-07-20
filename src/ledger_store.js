// forge ledger storage — the on-disk PCM ledger (docs/plans/substrate-v2/02-team-memory.md):
// one immutable canonical-JSON file per claim (sharded by id prefix, bytes = pure
// content so every replica writes the identical file), plus three append-only logs per
// claim — evidence, provenance, tombstones — that git union-merges without conflicts
// (`forge init` emits the .gitattributes rule). Everything author- or time-varying is
// a log line; nothing on disk is ever edited in place.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  authorTrust,
  canonicalize,
  claimId,
  DORMANT_VAL,
  emptyState,
  hasSecret,
  liveClaims,
  mergeStates,
  mintClaim,
  ORACLES,
  sealRecord,
  sortRecords,
  val,
  validateRef,
  validOutcome,
} from "./ledger.js";
import { redactSecrets } from "./secrets.js";
import { contentHash, readJsonSafe } from "./util.js";

/** The canonical repo ledger. (recall's global store keeps its own sibling ledger.) */
export const repoLedger = (root = process.cwd()) => join(root, ".forge", "ledger");

/** The union-merge rule consumer repos need for conflict-free ledger merges —
 *  emitted into .gitattributes by `forge init` (see init.js). NOTE: .gitattributes
 *  supports full-line comments only, so the rule ships with a comment line above it. */
export const GITATTRIBUTES_RULE = [
  "# PCM ledger logs are hash-deduped append-only sets - union merge is conflict-free (forge)",
  ".forge/ledger/*/*.log merge=union",
].join("\n");

// A ledger lives at <root>/.forge/ledger, so the repo root is two levels up — the cwd a
// `git:` evidence ref must resolve against.
const repoRootOf = (dir) => dirname(dirname(dir));

// `git:` ref resolver: the object must exist in THIS repo (`git cat-file -e <sha>`), a non-zero
// exit → unresolvable. Only ever invoked by validateRef for git-typed refs, so non-git refs
// (and non-git repos) never spawn git.
const gitResolver = (root) => (sha) => {
  try {
    // `--` guards against a ref that begins with "-" being read as a flag (defense in
    // depth; execFileSync already avoids the shell, and refs here are validated).
    execFileSync("git", ["cat-file", "-e", "--", sha], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

// `file:` ref resolver (ME-05): the referenced path must exist. Relative paths resolve
// against the repo root; absolute paths are used as-is. Pure existence check — no read,
// no throw — so a `file:/does/not/exist` ref is rejected before it can buy confidence.
const fileResolver = (root) => (p) => {
  try {
    return existsSync(isAbsolute(p) ? p : join(root, p));
  } catch {
    return false;
  }
};

const LOGS = ["evidence", "provenance", "tombstones"];
const claimPath = (dir, id) => join(dir, "claims", id.slice(0, 2), `${id}.json`);
const logPath = (dir, log, id) => join(dir, log, `${id}.log`);

/** Claim file bytes: pure content only. Identical for the same id on every replica. */
const claimBytes = (claim) =>
  `${canonicalize({ body: claim.body, kind: claim.kind, scope: claim.scope ?? {}, v: claim.v ?? 1 })}\n`;

/** Parse an append-only log: one canonical-JSON record per line, deduped by content
 *  hash, corrupt lines skipped. The single reader every log goes through — and the
 *  single choke point where every line must PROVE its content hash (re-sealing the
 *  h-less rest must reproduce `h`) before it can reach any view, dedupe set, or val().
 *  Evidence lines must additionally be valid outcomes. A forged/hand-edited line is
 *  simply invisible at read time; verify() is where it gets NAMED. The internal
 *  `verifyHashes:false` escape hatch exists ONLY so imports can read a source raw and
 *  QUARANTINE bad records instead of silently dropping them. */
function readLog(dir, log, id, { verifyHashes = true } = {}) {
  const path = logPath(dir, log, id);
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {}
    if (!rec?.h) continue;
    if (verifyHashes) {
      const { h, ...rest } = rec;
      if (sealRecord(rest).h !== h) continue; // forged/corrupt — cannot buy confidence
      if (log === "evidence" && !validOutcome(rec)) continue;
    }
    records.push(rec);
  }
  // sortRecords, not file order: after a git union merge the two replicas' logs hold
  // the same set in different line orders — views must not depend on that.
  return sortRecords(records);
}

/** Append one sealed record to a log iff its hash isn't already present. The seal is
 *  RECHECKED here — a record whose `h` does not match its own content never lands — and
 *  the record is scanned for secrets (ME-06): a credential in an evidence ref/author, a
 *  tombstone reason, or provenance metadata is refused BEFORE it can touch disk, exactly
 *  as putClaim refuses secret-bearing claim content. This is the single append choke point
 *  for every metadata log, so no channel can smuggle a secret onto disk (or into a merge). */
function appendRecord(dir, log, id, record) {
  if (!record?.h) return { ok: false, reason: "record missing content hash" };
  const { h, ...rest } = record;
  if (sealRecord(rest).h !== h)
    return {
      ok: false,
      reason: "record content hash mismatch (forged/corrupt)",
    };
  if (hasSecret(canonicalize(record)))
    return {
      ok: false,
      reason: "refused: record metadata looks like a secret/credential",
    };
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
      const parsed = readJsonSafe(path);
      // Verify the address: a tampered/corrupt claim is surfaced as claim:null.
      const valid = parsed && claimId(parsed.kind, parsed.body, parsed.scope) === id;
      yield {
        id,
        path,
        raw: readFileSync(path, "utf8"),
        claim: valid ? { ...parsed, id } : null,
      };
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
    return {
      ok: false,
      reason: "claim id does not match canonical content hash",
    };
  const text = claimBytes(claim);
  if (hasSecret(text))
    return {
      ok: false,
      reason: "refused: claim looks like it contains a secret/credential",
    };
  const path = claimPath(dir, claim.id);
  const already = existsSync(path);
  const healthy = already && readJsonSafe(path) !== null && readFileSync(path, "utf8") === text;
  if (!healthy) {
    mkdirSync(join(dir, "claims", claim.id.slice(0, 2)), { recursive: true });
    writeFileSync(path, text);
  }
  if (claim.provenance?.h) appendRecord(dir, "provenance", claim.id, claim.provenance);
  return { ok: true, id: claim.id, existed: already && healthy };
}

/** Append one evidence outcome (deduped by its content hash — append is idempotent). A typed,
 *  unresolvable ref (e.g. a `git:` sha absent from this repo) is REJECTED here, before it can
 *  reach val() and buy confidence. */
export function appendEvidence(dir, id, outcome) {
  if (!validOutcome(outcome)) return { ok: false, reason: "invalid outcome (use outcomeRecord)" };
  const root = repoRootOf(dir);
  const v = validateRef(outcome.ref, {
    resolveGit: gitResolver(root),
    resolveFile: fileResolver(root),
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? "unresolvable evidence ref" };
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

/**
 * Ratify a claim — the fahm→ḥikma promotion (08-dashboard-ux.md §2): mint a `decision`
 * claim pointing at the ratified claim's full id. Promotion is HUMAN-ONLY by design:
 * the caller supplies the author (a person's identity, via gitAuthor()); nothing in the
 * substrate ever calls this automatically. Append-only and content-addressed, so
 * ratifying the same claim twice converges on the same decision ({existed:true}).
 * @param {string} dir
 * @param {string} idPrefix
 * @param {{author?: string, t?: number}} [opts]
 * @returns {{ok:boolean, reason?:string, decisionId?:string, ratifies?:string, existed?:boolean}}
 */
export function ratify(dir, idPrefix, { author = "", t = 0 } = {}) {
  const target = getClaimByPrefix(dir, idPrefix);
  if (!target) return { ok: false, reason: `no claim matching ${idPrefix}` };
  const minted = mintClaim({
    kind: "decision",
    body: { ratifies: target.id, note: "" },
    provenance: { agent: "dash", author },
    t,
  });
  if (!minted.ok)
    return {
      ok: false,
      reason: "reason" in minted ? minted.reason : "mint failed",
    };
  const put = putClaim(dir, minted.claim);
  if (!put.ok)
    return {
      ok: false,
      reason: put.reason ?? "could not persist the decision claim",
    };
  return {
    ok: true,
    decisionId: minted.claim.id,
    ratifies: target.id,
    existed: put.existed,
  };
}

/** Load the full ledger state {claims, evidence, provenance, tombstones}. Log lines
 *  are hash-verified on read (see readLog); `verifyHashes:false` is internal-only —
 *  mergeDirs reads its SOURCE raw so bad records get quarantined, not silently lost.
 *  @param {string} dir
 *  @param {{verifyHashes?: boolean}} [opts] */
export function loadState(dir, { verifyHashes = true } = {}) {
  const state = emptyState();
  for (const { id, claim } of walkClaimFiles(dir)) {
    if (!claim) continue;
    state.claims[id] = claim;
    for (const log of LOGS) state[log][id] = readLog(dir, log, id, { verifyHashes });
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
  const claim = readJsonSafe(join(shardDir, f));
  if (!claim || claimId(claim.kind, claim.body, claim.scope) !== id) return null;
  const state = emptyState();
  state.claims[id] = { ...claim, id };
  for (const log of LOGS) state[log][id] = readLog(dir, log, id);
  return liveClaims(state)[0];
}

/** Try to import one raw source log line into `dir`; returns {ok, deduped} on success or
 *  {reason} on rejection, so mergeDirs can quarantine what it can't import. Unlike the
 *  state-based path, this NEVER loses a line to the read-path hash-dedup or the no-`h`
 *  drop: every source line is either imported or quarantined by trusted identity. */
function tryImportLine(dir, log, id, rec) {
  if (!rec?.h)
    return {
      reason: "malformed: unparseable log line or missing content hash",
    };
  const a = log === "evidence" ? appendEvidence(dir, id, rec) : appendRecord(dir, log, id, rec);
  return a.ok ? { ok: true, deduped: a.deduped } : { reason: a.reason ?? "rejected" };
}

/** `forge ledger merge <path>` — semilattice merge of another on-disk ledger into
 *  this one. Idempotent and order-independent by the CRDT property, so merging a
 *  teammate's checkout, a backup, or a branch worktree is always safe.
 *
 *  The SOURCE is read RAW, line by line (ME-07): every candidate record is re-validated
 *  against THIS ledger and either appended (deduped) or quarantined under a trusted
 *  identity. Reading raw — instead of through loadState's hash-dedup — is what lets two
 *  forged records sharing one fake `h`, and malformed no-`h` lines, all reach quarantine
 *  instead of being silently collapsed or dropped. */
export function mergeDirs(dstDir, srcDir) {
  let claims = 0;
  let records = 0;
  let quarantined = 0;
  // 1. Bring over claim files (pure content). Corrupt source claim files are named by
  //    verify(), not merged — putClaim would reject a bad address anyway.
  for (const { claim } of walkClaimFiles(srcDir)) {
    if (!claim) continue;
    const r = putClaim(dstDir, claim);
    if (r.ok && !r.existed) claims++;
  }
  // 2. For every claim now in the destination, merge the source's log lines RAW.
  const ids = [];
  for (const { id, claim } of walkClaimFiles(dstDir)) if (claim) ids.push(id);
  for (const id of ids) {
    for (const log of LOGS) {
      const path = logPath(srcDir, log, id);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let rec = null;
        try {
          rec = JSON.parse(line);
        } catch {}
        const res = tryImportLine(dstDir, log, id, rec);
        if (res.ok) {
          if (!res.deduped) records++;
        } else {
          quarantined += quarantineRecord(dstDir, id, rec ?? { raw: line }, res.reason);
        }
      }
    }
  }
  reindex(dstDir);
  return { claims, records, quarantined };
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

/** Quarantine one rejected import record — an append-only audit line under
 *  quarantine/<claimId>.log. Two hardening rules (ME-07):
 *   - The stored `rec` is REDACTED first: the quarantine log is an audit trail, never a
 *     place to persist the very credential we just refused (ME-06). A malformed line that
 *     never parsed is captured as {raw:"…"} so nothing is silently dropped.
 *   - Dedup is by a TRUSTED `qhash` computed with contentHash over the (redacted) record
 *     PLUS the rejection reason — NEVER the rejected record's own attacker-chosen `h`. Two
 *     distinct forged records that share one fake `h` therefore get DISTINCT identities and
 *     both survive; a malformed line with no `h` gets one too. Returns 1 when newly
 *     quarantined, 0 on a trusted-identity dupe (re-merges stay idempotent). */
function quarantineRecord(dir, id, rec, reason) {
  let redacted;
  try {
    redacted = JSON.parse(redactSecrets(canonicalize(rec ?? null)));
  } catch {
    redacted = { redacted: true };
  }
  const qhash = contentHash(canonicalize({ reason, rec: redacted }));
  if (readLog(dir, "quarantine", id).some((q) => q.qhash === qhash)) return 0;
  mkdirSync(join(dir, "quarantine"), { recursive: true });
  appendFileSync(
    logPath(dir, "quarantine", id),
    `${canonicalize(sealRecord({ qhash, reason, rec: redacted, t: rec?.t ?? 0 }))}\n`,
  );
  return 1;
}

/** Semilattice import: merge another ledger state into this directory (the mergeDirs
 *  core). Idempotent; safe to re-run. Imported records get NO validation bypass:
 *  evidence goes through the full appendEvidence gate (validOutcome + ref resolution
 *  against THIS repo) and every record must prove its content hash in appendRecord —
 *  rejects land in quarantine/ for audit and are counted in `quarantined`. */
export function importState(dir, other) {
  const merged = mergeStates(loadState(dir), other);
  let claims = 0;
  let records = 0;
  let quarantined = 0;
  for (const c of Object.values(merged.claims)) {
    const r = putClaim(dir, c);
    if (r.ok && !r.existed) claims++;
    for (const log of LOGS) {
      for (const rec of merged[log][c.id] ?? []) {
        const a =
          log === "evidence" ? appendEvidence(dir, c.id, rec) : appendRecord(dir, log, c.id, rec);
        if (a.ok && !a.deduped) records++;
        else if (!a.ok) quarantined += quarantineRecord(dir, c.id, rec, a.reason ?? "rejected");
      }
    }
  }
  reindex(dir);
  return { claims, records, quarantined };
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
  const root = repoRootOf(dir);
  const resolveGit = gitResolver(root);
  const resolveFile = fileResolver(root);
  for (const { id, raw, claim } of walkClaimFiles(dir)) {
    if (!claim) issues.push(`claim ${id}: unparseable or id mismatch`);
    else {
      claims++;
      ids.push(id);
    }
    if (hasSecret(raw)) issues.push(`claim ${id}: contains secret-like content`);
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
          else {
            // Typed, unresolvable refs (e.g. a `git:` sha absent from this repo) are named
            // so CI catches evidence that can never be re-derived.
            const v = validateRef(o.ref, { resolveGit, resolveFile });
            if (!v.ok) issues.push(`${where}: ${v.reason ?? "unresolvable evidence ref"}`);
            else outcomes++;
          }
        }
        if (hasSecret(line)) issues.push(`${where}: secret-like content`);
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

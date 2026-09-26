// forge ledger storage — the on-disk PCM ledger (docs/plans/substrate-v2/02-team-memory.md):
// one immutable canonical-JSON file per claim (sharded by id prefix, bytes = pure
// content so every replica writes the identical file), plus three append-only logs per
// claim — evidence, provenance, tombstones — that git union-merges without conflicts
// (`forge init` emits the .gitattributes rule). Everything author- or time-varying is
// a log line; nothing on disk is ever edited in place.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  authorTrust,
  canonicalize,
  claimId,
  claimText,
  DEFAULT_HALF_LIFE_DAYS,
  DORMANT_VAL,
  emptyState,
  hasSecret,
  legacyClaimId,
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
import { retentionPlan } from "./ledger_retention.js";
import { redactSecrets } from "./secrets.js";
import { contentHash, epochDay, readJsonSafe } from "./util.js";

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

/** Append one line to a log, first terminating a TORN final line (a process killed
 *  mid-append, or a union merge that dropped the trailing newline). Without this the next
 *  record is glued onto the fragment, becomes one unparseable line, and silently vanishes
 *  while the append still reports ok:true. The fragment itself stays unparseable — readLog
 *  skips it and verify() names it. */
function appendLine(path, line) {
  let torn = false;
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const fd = openSync(path, "r");
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        torn = last[0] !== 0x0a;
      } finally {
        closeSync(fd);
      }
    }
  } catch {} // no file yet — nothing to terminate
  appendFileSync(path, `${torn ? "\n" : ""}${line}\n`);
}
const claimPath = (dir, id) => join(dir, "claims", id.slice(0, 2), `${id}.json`);
const atticPath = (dir, id) => join(dir, "attic", `${id}.json`);
const logPath = (dir, log, id) => join(dir, log, `${id}.log`);
/** A pruned claim is ARCHIVED, not missing: its file sits in attic/ and its logs never move. */
const inAttic = (dir, id) => existsSync(atticPath(dir, id));

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
  const live = existsSync(claimPath(dir, id));
  const archived = !live && inAttic(dir, id);
  if (!live && !archived) return { ok: false, reason: `no such claim in ledger: ${id}` };
  if (readLog(dir, log, id).some((e) => e.h === record.h)) return { ok: true, deduped: true };
  // NEW evidence on a pruned claim brings it back out of the attic — review restores weight
  // (01-pcm-protocol.md §3). Any other record (a tombstone, another author's mint) is
  // appended without un-archiving it.
  if (archived && log === "evidence") {
    mkdirSync(join(dir, "claims", id.slice(0, 2)), { recursive: true });
    renameSync(atticPath(dir, id), claimPath(dir, id));
  }
  mkdirSync(join(dir, log), { recursive: true });
  appendLine(logPath(dir, log, id), canonicalize(record));
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
      // Verify the address: a tampered/corrupt claim is surfaced as claim:null. A claim
      // minted before the CRLF fold carries the PRE-fold address in its filename, so that
      // address counts too — otherwise the fold would delete, not migrate: every such claim
      // failed its own check and disappeared from loadClaims. Only reads accept it; every
      // write uses the current rule, so the pre-fold form dies out as claims are rewritten.
      const valid =
        parsed &&
        (claimId(parsed.kind, parsed.body, parsed.scope) === id ||
          legacyClaimId(parsed.kind, parsed.body, parsed.scope) === id);
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
 * @returns {{ok:boolean, reason?:string, id?:string, existed?:boolean, pruned?:boolean}}
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
  // Re-importing a claim this replica has PRUNED must not resurrect it into the live set:
  // the attic copy is the same content-addressed bytes, and new evidence is what brings a
  // claim back (see appendRecord). Reported as existing, so merge counts stay honest.
  if (!existsSync(path) && inAttic(dir, claim.id)) {
    if (claim.provenance?.h) appendRecord(dir, "provenance", claim.id, claim.provenance);
    return { ok: true, id: claim.id, existed: true, pruned: true };
  }
  const already = existsSync(path);
  const healthy = already && readJsonSafe(path) !== null && readFileSync(path, "utf8") === text;
  if (!healthy) {
    mkdirSync(join(dir, "claims", claim.id.slice(0, 2)), { recursive: true });
    writeFileSync(path, text);
  }
  if (claim.provenance?.h) appendRecord(dir, "provenance", claim.id, claim.provenance);
  return { ok: true, id: claim.id, existed: already && healthy };
}

// The full object id a `git:` abbreviation names in THIS repo, or null (ambiguous, unknown,
// or not a git repo). `^{object}` peels nothing; `--verify` refuses ambiguity.
const gitFullId = (root, sha) => {
  try {
    const out = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${sha}^{object}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    return null;
  }
};

/** Append one evidence outcome (deduped by its content hash — append is idempotent). A typed,
 *  unresolvable ref (e.g. a `git:` sha absent from this repo) is REJECTED here, before it can
 *  reach val() and buy confidence. A resolvable `git:` abbreviation is stored under its FULL
 *  object id (re-sealed), so one commit has one spelling in the log (review F06; val() also
 *  dedupes aliases already on disk). */
export function appendEvidence(dir, id, outcome) {
  if (!validOutcome(outcome)) return { ok: false, reason: "invalid outcome (use outcomeRecord)" };
  const root = repoRootOf(dir);
  const v = validateRef(outcome.ref, {
    resolveGit: gitResolver(root),
    resolveFile: fileResolver(root),
  });
  if (!v.ok) return { ok: false, reason: v.reason ?? "unresolvable evidence ref" };
  const m = /^git:([0-9a-f]{7,39})$/i.exec(String(outcome.ref));
  const full = m ? gitFullId(root, m[1]) : null;
  if (full) {
    const { h: _h, ...rest } = outcome;
    return appendRecord(dir, "evidence", id, sealRecord({ ...rest, ref: `git:${full}` }));
  }
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

/** A full claim id — what an irreversible or agent-initiated write must name exactly. */
export const FULL_ID_RE = /^[0-9a-f]{64}$/;

/** The identity every agent-callable (MCP) ledger write is stamped with — never the human's
 *  git identity. val() never counts an `agent:` author as human evidence (ledger.js). */
export const MCP_AUTHOR = "agent:mcp";

/**
 * Ratify a claim — the fahm→ḥikma promotion (08-dashboard-ux.md §2): mint a `decision`
 * claim pointing at the ratified claim's full id. A human ratification is the default
 * (the CLI and dashboard pass the person's gitAuthor()). An agent may only PROPOSE one:
 * the MCP tool passes `author: MCP_AUTHOR` plus a note, which makes it a distinct claim, so
 * an agent proposal can never be mistaken for — or deduped into — a human's ratification.
 * Neither changes the ratified claim's val: a decision is not evidence. Append-only and
 * content-addressed, so ratifying the same claim twice converges ({existed:true}).
 * @param {string} dir
 * @param {string} idPrefix an unambiguous id prefix (≥2 chars) or the full id
 * @param {{author?: string, t?: number, agent?: string, note?: string}} [opts]
 * @returns {{ok:boolean, reason?:string, decisionId?:string, ratifies?:string, existed?:boolean}}
 */
export function ratify(dir, idPrefix, { author = "", t = 0, agent = "dash", note = "" } = {}) {
  const target = getClaimByPrefix(dir, idPrefix);
  if (!target)
    return { ok: false, reason: `no claim matching ${idPrefix} (or the prefix is ambiguous)` };
  const minted = mintClaim({
    kind: "decision",
    body: { note, ratifies: target.id },
    provenance: { agent, author },
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

/**
 * PROPOSE a retraction without making it: an agent-callable tool must not make a permanent
 * change on its own (models propose; a human authorizes; corrections supersede rather than
 * erase). Mints a `decision` claim {retracts, reason} stamped `agent:mcp` — append-only,
 * content-addressed (the same proposal twice converges), synced like any claim, and visible
 * via retractionProposals()/stats(). It lowers nothing: the target stays live until a human
 * runs `forge ledger retract <full id>`, which writes the real tombstone.
 * @param {string} dir
 * @param {string} id the target's FULL 64-char claim id — a prefix is refused
 * @param {{reason?: string, t?: number, author?: string}} [opts]
 * @returns {{ok:boolean, reason?:string, proposalId?:string, retracts?:string, existed?:boolean}}
 */
export function proposeRetraction(dir, id, { reason = "", t = 0, author = MCP_AUTHOR } = {}) {
  if (!FULL_ID_RE.test(String(id ?? "")))
    return { ok: false, reason: "a retraction must name one full 64-character claim id" };
  const target = getClaimByPrefix(dir, id);
  if (!target || target.id !== id) return { ok: false, reason: `no claim matching ${id}` };
  const minted = mintClaim({
    kind: "decision",
    body: { note: "proposed retraction — pending human confirmation", reason, retracts: id },
    provenance: { agent: "mcp", author },
    t,
  });
  if (!minted.ok) return { ok: false, reason: "reason" in minted ? minted.reason : "mint failed" };
  const put = putClaim(dir, minted.claim);
  if (!put.ok) return { ok: false, reason: put.reason ?? "could not persist the proposal" };
  return { ok: true, proposalId: minted.claim.id, retracts: id, existed: put.existed };
}

/** Pending retraction proposals by target id — proposals whose target is still live (a
 *  human retraction resolves them). Pure over a loadClaims() list.
 *  @param {any[]} claims
 *  @returns {Map<string, {proposalId:string, reason:string, author:string, t:number}[]>} */
export function retractionProposals(claims) {
  const live = new Set(claims.filter((c) => !c.tombstone).map((c) => c.id));
  const out = new Map();
  for (const c of claims) {
    const target = c.kind === "decision" && !c.tombstone ? c.body?.retracts : null;
    if (!target || !live.has(target)) continue;
    if (!out.has(target)) out.set(target, []);
    out.get(target).push({
      proposalId: c.id,
      reason: String(c.body?.reason ?? ""),
      author: c.provenance?.author ?? "",
      t: c.provenance?.t ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read path + snapshot cache. A ledger is one small file per claim plus its logs — great
// for byte-identical replicas and union merges, brutal to re-read: 300 claims is 900 files,
// ~4 s of syscalls on Windows, and the per-prompt hooks ask three times (lessons, déjà vu,
// reuse peek). Nothing compacted it, so the cost grew with the ledger forever (review C11).
//
// The fix is a DERIVED snapshot, never a second source of truth: a fingerprint of every
// file's (path, size, mtime) — stat-only, ~0.2 ms per file against ~4 ms to read and parse
// one — decides whether `.state-cache.json` still describes the directory. Any external
// edit (a git merge, a hand-edited line, a truncation, a prune) changes the fingerprint and
// the snapshot is rebuilt from the files. The cache is local and disposable; it is
// gitignored next to the ledger.
// ---------------------------------------------------------------------------

const CACHE_FILE = ".state-cache.json";
const GITIGNORE_FILE = ".gitignore";
/** dir → {sig, state} for the life of THIS process (a hook asks several times). */
const stateMemo = new Map();

const fileStamp = (path, rel) => {
  try {
    const s = statSync(path);
    return `${rel}:${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return `${rel}:gone`;
  }
};

/** Cheap, sound fingerprint of everything loadState reads. */
function ledgerSignature(dir) {
  const parts = [];
  const claimsRoot = join(dir, "claims");
  if (!existsSync(claimsRoot)) return "empty";
  for (const shard of readdirSync(claimsRoot).sort())
    for (const f of readdirSync(join(claimsRoot, shard)).sort())
      parts.push(fileStamp(join(claimsRoot, shard, f), `claims/${shard}/${f}`));
  for (const log of LOGS) {
    const root = join(dir, log);
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root).sort()) parts.push(fileStamp(join(root, f), `${log}/${f}`));
  }
  return contentHash(parts.join("\n"));
}

function readStateCache(dir, sig) {
  const cached = readJsonSafe(join(dir, CACHE_FILE));
  if (!cached || cached.sig !== sig || !cached.state?.claims) return null;
  return cached.state;
}

/** Keep a machine-local file out of git: add `name` to the ledger's .gitignore if absent. */
function ensureLocalIgnored(dir, name, comment) {
  const path = join(dir, GITIGNORE_FILE);
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {} // no file yet
  if (current.split(/\r?\n/).includes(name)) return;
  // APPEND, never rewrite: two processes (a hook and a CLI) can reach this at once, and a
  // read-modify-write would drop the other's line. Appending can at worst duplicate a
  // comment, which git ignores.
  appendLine(path, `# ${comment} (forge)\n${name}`);
}

function writeStateCache(dir, sig, state) {
  try {
    mkdirSync(dir, { recursive: true });
    ensureLocalIgnored(
      dir,
      CACHE_FILE,
      "derived read cache — rebuilt from the claim files whenever they change",
    );
    writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ sig, state }));
  } catch {} // a read-only checkout just pays the full read every time
}

// ---------------------------------------------------------------------------
// Usage log. Retention learns from which claims actually get served (ledger_retention.js),
// and nothing recorded that: retrieve() is pure and every caller discarded the ids. Each
// place that SERVES claims to an agent or a person now appends one line here: the session
// lesson block, pre-edit lessons, the déjà-vu advisory, `forge ledger query` and the MCP
// query. It is machine-local (gitignored) and outside ledgerSignature, so appending never
// invalidates the snapshot cache.
// ---------------------------------------------------------------------------

export const USAGE_FILE = ".usage.jsonl";

/**
 * Record that these claims were served. Best-effort: never throws (hooks call it), and a
 * missing ledger directory records nothing.
 * @param {string} dir
 * @param {string[]} ids
 * @param {{via?: string, t?: number}} [opts]
 */
export function recordUse(dir, ids, { via = "", t = epochDay() } = {}) {
  try {
    const list = [...new Set((ids ?? []).filter((x) => typeof x === "string" && x))];
    if (!list.length || !existsSync(dir)) return;
    ensureLocalIgnored(dir, USAGE_FILE, "which claims were served, and when — local use log");
    // appendLine terminates a line a killed process left torn, so the next record never
    // glues onto it and both are lost (the same guard the claim logs use).
    appendLine(join(dir, USAGE_FILE), JSON.stringify({ t, via, ids: list }));
  } catch {}
}

/**
 * Claim id → the days it was served. Malformed lines are skipped.
 * @param {string} dir
 * @returns {Map<string, number[]>}
 */
export function readUses(dir) {
  /** @type {Map<string, number[]>} */
  const out = new Map();
  let text = "";
  try {
    text = readFileSync(join(dir, USAGE_FILE), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isFinite(rec?.t) || !Array.isArray(rec?.ids)) continue;
    for (const id of rec.ids) {
      if (typeof id !== "string") continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id)?.push(rec.t);
    }
  }
  return out;
}

function readStateFromDisk(dir, verifyHashes) {
  const state = emptyState();
  for (const { id, claim } of walkClaimFiles(dir)) {
    if (!claim) continue;
    state.claims[id] = claim;
    for (const log of LOGS) state[log][id] = readLog(dir, log, id, { verifyHashes });
  }
  return state;
}

/** Load the full ledger state {claims, evidence, provenance, tombstones}. Log lines
 *  are hash-verified on read (see readLog); `verifyHashes:false` is internal-only —
 *  mergeDirs reads its SOURCE raw so bad records get quarantined, not silently lost (and
 *  is never cached). The returned state is shared with the snapshot cache: treat it as
 *  READ-ONLY, like every other view in this module.
 *  @param {string} dir
 *  @param {{verifyHashes?: boolean}} [opts] */
export function loadState(dir, { verifyHashes = true } = {}) {
  if (!verifyHashes) return readStateFromDisk(dir, false);
  const sig = ledgerSignature(dir);
  const memo = stateMemo.get(dir);
  if (memo?.sig === sig) return memo.state;
  let state = readStateCache(dir, sig);
  if (!state) {
    state = readStateFromDisk(dir, true);
    writeStateCache(dir, sig, state);
  }
  stateMemo.set(dir, { sig, state });
  return state;
}

/** All claims with evidence/provenance/tombstone views attached (retrieval input). */
export function loadClaims(dir) {
  return liveClaims(loadState(dir));
}

/** Find one claim by id prefix without scanning the whole ledger (ids are sharded by
 *  their first two hex chars, so any prefix ≥ 2 chars pins the shard). An AMBIGUOUS prefix
 *  (≥2 claims match) returns null — silently picking the first sorted match let a short
 *  prefix ratify or retract a claim nobody named.
 *  @param {string} dir
 *  @param {string} prefix
 *  @param {{attic?: boolean}} [opts] also look in the attic (read-only callers only); an
 *    archived hit carries `archived: true` */
export function getClaimByPrefix(dir, prefix, { attic = false } = {}) {
  if (!prefix || prefix.length < 2) return null;
  const shardDir = join(dir, "claims", prefix.slice(0, 2));
  const live = existsSync(shardDir)
    ? readdirSync(shardDir)
        .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
        .map((f) => join(shardDir, f))
    : [];
  // Read-only callers (show, blame) may also look in the attic: pruning archives a
  // tombstoned claim at once, and the attic is its audit trail. Writers never do — new
  // evidence on an archived claim goes through appendEvidence, which restores it.
  const atticDir = join(dir, "attic");
  const archived =
    attic && !live.length && existsSync(atticDir)
      ? readdirSync(atticDir)
          .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
          .map((f) => join(atticDir, f))
      : [];
  const matches = live.length ? live : archived;
  if (matches.length !== 1) return null;
  const path = matches[0];
  const id = path.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
  const claim = readJsonSafe(path);
  if (!claim || claimId(claim.kind, claim.body, claim.scope) !== id) return null;
  const state = emptyState();
  state.claims[id] = { ...claim, id };
  for (const log of LOGS) state[log][id] = readLog(dir, log, id);
  const view = liveClaims(state)[0];
  return live.length ? view : { ...view, archived: true };
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
export function mergeDirs(dstDir, srcDir, { nowDay = epochDay() } = {}) {
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
  pruneLedger(dstDir, nowDay);
  reindex(dstDir, nowDay);
  return { claims, records, quarantined };
}

/**
 * `forge ledger blame <id-prefix>` — the full accountability view of one claim: who
 * minted it (every author, via the provenance log), every evidence record in (t, h)
 * order, retractions, and the per-author trust the ledger has earned (17:36's audit
 * trail: every channel the agent used can be questioned).
 */
export function blame(dir, prefix, nowDay = 0) {
  const claim = getClaimByPrefix(dir, prefix, { attic: true });
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
  appendLine(
    logPath(dir, "quarantine", id),
    canonicalize(sealRecord({ qhash, reason, rec: redacted, t: rec?.t ?? 0 })),
  );
  return 1;
}

/** Semilattice import: merge another ledger state into this directory (the mergeDirs
 *  core). Idempotent; safe to re-run. Imported records get NO validation bypass:
 *  evidence goes through the full appendEvidence gate (validOutcome + ref resolution
 *  against THIS repo) and every record must prove its content hash in appendRecord —
 *  rejects land in quarantine/ for audit and are counted in `quarantined`. */
export function importState(dir, other, { nowDay = epochDay() } = {}) {
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
  pruneLedger(dir, nowDay);
  reindex(dir, nowDay);
  return { claims, records, quarantined };
}

/** The merge rule for the generated index, shipped INSIDE the ledger directory so the
 *  ledger carries its own conflict-free guarantee wherever it is copied (git reads nested
 *  .gitattributes files). Paths are relative to this directory. */
const LEDGER_GITATTRIBUTES = [
  "# Generated by forge from the claim files — rebuilt on every write, so a union merge is",
  "# always safe and never conflicts (docs/plans/substrate-v2/02-team-memory.md).",
  "LEDGER.md merge=union linguist-generated=true",
  "",
].join("\n");

/**
 * Regenerate LEDGER.md — the human index (like recall's MEMORY.md).
 *
 * Rows are STABLE: id, kind and the claim's own text, with no val. The old rows carried
 * `val 0.50`, which changes with the clock and with each replica's evidence, so the same
 * claim produced a different line on every branch and every day — and since the file is
 * rewritten on every ledger write, two teammates adding one fact each got a CONFLICT in the
 * "conflict-free by construction" store (review C11). With stable rows, a union merge of
 * the two branches is exactly the union of their claims, and the next write rewrites it
 * cleanly anyway.
 */
// (`_nowDay` is kept for call-site compatibility and is deliberately unused: the index no
//  longer prints anything that depends on the clock.)
export function reindex(dir, _nowDay = 0) {
  const rows = loadClaims(dir)
    .filter((c) => !c.tombstone)
    .map(
      (c) =>
        `- \`${c.id.slice(0, 12)}\` ${c.kind} · ${claimText(c).replace(/\s+/g, " ").trim().slice(0, 100)}`,
    );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitattributes"), LEDGER_GITATTRIBUTES);
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
/**
 * Re-address every claim still stored under its PRE-CRLF-fold id (see legacyClaimId).
 * Reads already accept that address, so nothing is broken without this — but the old and
 * the newly-minted form of one fact stay TWO entries until their bytes agree, which is the
 * fork the fold exists to prevent. This moves the claim file to its current address and
 * takes its logs with it, unioning into an existing log rather than overwriting one (the
 * logs are append-only sets deduped by content hash, so a union is the merge).
 * Idempotent: a second run finds nothing to do. `dryRun` reports the same summary (what
 * would move, what would merge into an existing twin) and writes nothing — a migration is
 * previewed before it touches a shared store (review A11).
 * @param {string} dir ledger dir
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{migrated: string[], merged: string[], failed: string[], dryRun: boolean}}
 */
export function migrateAddresses(dir, { dryRun = false } = {}) {
  const migrated = [];
  const merged = [];
  const failed = [];
  for (const { id, path, claim } of [...walkClaimFiles(dir)]) {
    if (!claim) continue;
    const current = claimId(claim.kind, claim.body, claim.scope);
    if (current === id) continue; // already at its current address
    if (legacyClaimId(claim.kind, claim.body, claim.scope) !== id) continue; // not ours to touch
    if (dryRun) {
      (existsSync(claimPath(dir, current)) ? merged : migrated).push(current);
      continue;
    }
    try {
      const target = claimPath(dir, current);
      const already = existsSync(target);
      if (!already) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, claimBytes({ ...claim, id: current }));
      }
      for (const log of LOGS) {
        const from = logPath(dir, log, id);
        if (!existsSync(from)) continue;
        const lines = readFileSync(from, "utf8");
        const to = logPath(dir, log, current);
        mkdirSync(dirname(to), { recursive: true });
        for (const line of lines.split(/\r?\n/)) if (line.trim()) appendLine(to, line);
        rmSync(from, { force: true });
      }
      rmSync(path, { force: true });
      (already ? merged : migrated).push(current);
    } catch {
      failed.push(id);
    }
  }
  return { migrated, merged, failed, dryRun };
}

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

/**
 * Prune to the attic, by the retention plan LEARNED from this ledger (ledger_retention.js):
 * a tombstoned or dormant claim is archived at once (retrieve() never serves it), and a live
 * claim is archived once its idle time passes the cut-off the ledger's own history supports
 * (none until the usage log covers a full learned horizon). This replaced a fixed 2 × 45-day
 * window. Nothing is lost: the claim bytes move to attic/, every log stays, `forge ledger
 * show/blame` still read the attic, and new evidence un-archives the claim. Idempotent.
 * Near-duplicates are only grouped by `compactLedger` (an explicit command): the pairwise
 * pass is too slow for the Stop hook that calls this.
 * @param {string} dir
 * @param {number} [nowDay]
 * @param {{halfLife?:number}} [opts] only feeds isDormant
 * @returns {{pruned:string[], retention: ReturnType<typeof retentionPlan>["retention"]}}
 */
export function pruneLedger(dir, nowDay = epochDay(), { halfLife = DEFAULT_HALF_LIFE_DAYS } = {}) {
  const plan = retentionPlan(loadClaims(dir), readUses(dir), nowDay, { halfLife });
  const pruned = [];
  for (const a of plan.archive)
    if (pruneToAttic(dir, a.id, { ...archiveWhy(a), t: nowDay }).ok) pruned.push(a.id);
  return { pruned, retention: plan.retention };
}

/** The archive record fields of one retention-plan entry. */
const archiveWhy = (a) => ({
  cause: a.cause,
  reason: a.reason,
  ...(a.survivor ? { survivor: a.survivor } : {}),
});

/**
 * `forge ledger compact`: the prune plan plus near-duplicate grouping, with every learned
 * number reported so a person can see why each claim was archived. `dryRun` plans only.
 * @param {string} dir
 * @param {number} [nowDay]
 * @param {{dryRun?: boolean, halfLife?: number}} [opts]
 */
export function compactLedger(
  dir,
  nowDay = epochDay(),
  { dryRun = false, halfLife = DEFAULT_HALF_LIFE_DAYS } = {},
) {
  const claims = loadClaims(dir);
  const uses = readUses(dir);
  const plan = retentionPlan(claims, uses, nowDay, { halfLife, duplicates: true });
  const archived = [];
  if (!dryRun)
    for (const a of plan.archive)
      if (pruneToAttic(dir, a.id, { ...archiveWhy(a), t: nowDay }).ok) archived.push(a.id);
  return {
    dryRun,
    claims: claims.length,
    servedClaims: uses.size,
    retention: plan.retention,
    duplicates: plan.duplicates,
    archive: plan.archive,
    archived,
  };
}

const atticLogPath = (dir, id) => join(dir, "attic", `${id}.log`);

/**
 * Move one claim file to the attic (audit trail, never retrieved) and record WHY (review F15):
 * `cause` is "tombstoned", "dormant", "idle" or "duplicate" (with the `survivor` it duplicates).
 * Archiving is storage lifecycle, not a verdict — an idle or duplicate claim was not refuted,
 * and readers (e.g. learned-lesson consolidation) must not treat it as refuted. The record is
 * a sealed, append-only line in `attic/<id>.log` (union-merged like every ledger log).
 * @param {string} dir
 * @param {string} id
 * @param {{cause?: string, reason?: string, survivor?: string, t?: number}} [why]
 */
export function pruneToAttic(dir, id, why = {}) {
  const from = claimPath(dir, id);
  if (!existsSync(from)) return { ok: false, reason: "no such claim" };
  mkdirSync(join(dir, "attic"), { recursive: true });
  renameSync(from, join(dir, "attic", `${id}.json`));
  if (why.cause) {
    try {
      const rec = sealRecord({
        cause: String(why.cause),
        reason: redactSecrets(String(why.reason ?? "")).slice(0, 300),
        ...(why.survivor ? { survivor: String(why.survivor) } : {}),
        t: why.t ?? 0,
      });
      appendLine(atticLogPath(dir, id), canonicalize(rec));
    } catch {} // the move is the archive; the reason is best-effort metadata
  }
  return { ok: true };
}

/**
 * Why a claim was archived: the latest verified record of `attic/<id>.log` ({cause, reason,
 * survivor?, t}), or null when none was recorded (claims archived before reasons existed).
 * @param {string} dir
 * @param {string} id
 */
export function archiveRecord(dir, id) {
  let text = "";
  try {
    text = readFileSync(atticLogPath(dir, id), "utf8");
  } catch {
    return null;
  }
  const recs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const { h, ...rest } = rec ?? {};
      if (h && sealRecord(rest).h === h && typeof rest.cause === "string") recs.push(rec);
    } catch {}
  }
  const sorted = sortRecords(recs);
  return sorted.length ? sorted[sorted.length - 1] : null;
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
    // Agent-proposed retractions awaiting a human `forge ledger retract <full id>`.
    pendingRetractions: retractionProposals(claims).size,
    byKind,
    val: buckets,
  };
}

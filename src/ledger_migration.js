// Migrate from a private, content-addressed snapshot so an interrupted run and a
// later restore always use precisely the bytes that were inspected.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { brainStore, buildIndex } from "./brain.js";
import { outcomeRecord } from "./ledger.js";
import { factClaim, lessonClaim } from "./ledger_bridge.js";
import {
  appendEvidenceBatch,
  getClaimByPrefix,
  loadClaims,
  putClaim,
  reindex,
  repoLedger,
  tombstone,
  verify,
} from "./ledger_store.js";
import { parse as parseLesson } from "./lessons_store.js";
import { outsideWorkspace, readBounded } from "./private_paths.js";
import { defaultStore, parseStoredFact, reindex as reindexRecall } from "./recall.js";
import { withConfigLock } from "./repo_config.js";
import { hasSecret } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { slug, userStateDir } from "./util.js";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const sourceDirs = (personal) => (personal ? ["facts"] : [".forge/brain/facts", ".forge/lessons"]);
const MAX_SOURCE = 1024 * 1024;
const MAX_TOTAL = 32 * MAX_SOURCE;
const MAX_RECORDS = 10000;
const MAX_MANIFEST = 2 * MAX_TOTAL;

function requireDirectory(path, { privateOwner = false } = {}) {
  const st = lstatSync(path);
  if (
    !st.isDirectory() ||
    (privateOwner &&
      process.platform !== "win32" &&
      (st.uid !== process.getuid() || st.mode & 0o077))
  )
    throw new Error("Migration requires a real directory with the expected owner and permissions");
}

function regularBytes(path, max, privateOwner = false) {
  const st = lstatSync(path);
  if (
    privateOwner &&
    process.platform !== "win32" &&
    (st.uid !== process.getuid() || st.mode & 0o077)
  )
    throw new Error("Migration requires private user-owned backup files");
  const bytes = readBounded(path, max).bytes;
  const after = lstatSync(path);
  if (st.dev !== after.dev || st.ino !== after.ino || st.mtimeMs !== after.mtimeMs)
    throw new Error("Migration input changed while being read");
  return bytes;
}

function safeEntry(path, personal) {
  if (typeof path !== "string" || /[\\:\p{Cc}]/u.test(path)) return false;
  const parts = path.split("/");
  const name = parts.pop();
  return (
    sourceDirs(personal).includes(parts.join("/")) &&
    typeof name === "string" &&
    name.length > 3 &&
    name.endsWith(".md")
  );
}

function capture(base, personal) {
  const files = [];
  let total = 0;
  for (const dir of sourceDirs(personal)) {
    let location = base;
    for (const segment of dir.split("/")) {
      location = join(location, segment);
      if (lstatSync(location, { throwIfNoEntry: false })) requireDirectory(location);
    }
    if (!existsSync(location)) continue;
    for (const name of readdirSync(location)
      .filter((n) => n.endsWith(".md"))
      .sort()) {
      const path = `${dir}/${name}`;
      if (!safeEntry(path, personal)) throw new Error("Invalid legacy memory filename");
      const bytes = regularBytes(join(location, name), MAX_SOURCE);
      total += bytes.length;
      if (total > MAX_TOTAL || files.length >= MAX_RECORDS)
        throw new Error("Legacy snapshot exceeds migration limit");
      files.push({ path, data: bytes.toString("base64") });
    }
  }
  return files;
}

function locations(root, personal) {
  const workspace = realpathSync.native(sourceWorkspaceRoot(root));
  const source = personal
    ? outsideWorkspace(workspace, defaultStore(), "Keep personal recall outside the worktree")
    : workspace;
  const state = outsideWorkspace(
    workspace,
    resolve(userStateDir(), "ledger-migrations-v1"),
    "Keep migration backups outside the worktree",
  );
  const key = sha(JSON.stringify([personal ? "personal" : "repo", source]));
  const backup = join(state, key);
  return { source, backup, ledger: personal ? join(source, "ledger") : repoLedger(source) };
}

function atomicPrivate(path, bytes) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function decode(entries, personal) {
  if (!Array.isArray(entries) || entries.length > MAX_RECORDS)
    throw new Error("Invalid migration snapshot");
  const seen = new Set();
  let outcomes = 0,
    size = 0;
  return entries.map(({ path, data }) => {
    if (!safeEntry(path, personal) || seen.has(path) || typeof data !== "string")
      throw new Error("Invalid migration entry");
    seen.add(path);
    const bytes = Buffer.from(data, "base64");
    size += bytes.length;
    if (bytes.toString("base64") !== data || bytes.length > MAX_SOURCE || size > MAX_TOTAL)
      throw new Error("Invalid migration data");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (hasSecret(raw) || hasSecret(path))
      throw new Error("Legacy memory contains credential-shaped content; migration stopped");
    const sourceHash = sha(bytes);
    let claim, lesson;
    if (path.startsWith(".forge/lessons/")) {
      lesson = parseLesson(raw);
      if (
        !lesson.id ||
        !lesson.correctedBehavior ||
        !["candidate", "active", "quarantined", "retired"].includes(lesson.status)
      )
        throw new Error(`Invalid legacy lesson: ${path}`);
      for (const n of [
        lesson.evidenceCount,
        lesson.contradictionCount,
        lesson.createdDay,
        lesson.lastConfirmedDay,
      ])
        if (!Number.isSafeInteger(n) || n < 0)
          throw new Error(`Invalid legacy lesson counters: ${path}`);
      outcomes += lesson.evidenceCount + lesson.contradictionCount;
      if (outcomes > MAX_RECORDS) throw new Error("Legacy evidence exceeds migration limit");
      claim = lessonClaim(lesson, lesson.createdDay, {
        migration: sourceHash,
        author: "legacy.import",
      });
    } else {
      const fact = parseStoredFact(basename(path, ".md"), raw);
      if (!fact.name || !fact.text) throw new Error(`Empty legacy fact: ${path}`);
      claim = factClaim(fact.name, fact.text, 0, 0, {
        migration: sourceHash,
        author: "legacy.import",
      });
    }
    if (!claim.ok) throw new Error(claim.reason);
    return { path, bytes, lesson, claim: claim.claim, sourceHash };
  });
}

function readSnapshot(backup, id, personal) {
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid backup ID");
  const data = regularBytes(join(backup, `${id}.json`), MAX_MANIFEST, true);
  if (sha(data) !== id) throw new Error("Migration backup hash mismatch");
  const manifest = JSON.parse(data.toString("utf8"));
  if (manifest.version !== 1 || manifest.personal !== personal)
    throw new Error("Migration backup scope mismatch");
  return decode(manifest.files, personal);
}

// A checkout cannot redirect generated indexes, claim files or append-only logs outside
// its store. Walk without following links before reading or updating an existing ledger.
function checkTargets(ledger, store) {
  const queue = [ledger, join(store, "MEMORY.md"), join(store, "AGENTS.brain.md")];
  while (queue.length) {
    const path = queue.pop();
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (realpathSync.native(path) !== path) throw new Error("Linked migration target");
      for (const name of readdirSync(path)) queue.push(join(path, name));
    } else if (!st.isFile() || st.nlink !== 1 || realpathSync.native(path) !== path)
      throw new Error("Migration target must contain regular unlinked files");
  }
}

function identity(c) {
  return c.kind === "fact" ? `fact:${slug(c.body.name) || "fact"}` : `lesson:${c.provenance?.task}`;
}

// Keep existing claims, including tombstones and locally archived records. A receipt
// in provenance allows only an interrupted import of this exact file to complete.
function ledgerIdentities(ledger) {
  const known = new Map();
  for (const c of loadClaims(ledger)) known.set(identity(c), c);
  const attic = join(ledger, "attic");
  if (existsSync(attic))
    for (const file of readdirSync(attic).filter((f) => /^[0-9a-f]{64}\.json$/.test(f))) {
      const archived = getClaimByPrefix(ledger, file.slice(0, -5), { attic: true });
      if (archived) known.set(identity(archived), archived);
    }
  return known;
}

function* historicalOutcomes(lesson) {
  for (const [kind, count, day] of [
    ["confirm", lesson.evidenceCount, lesson.lastConfirmedDay],
    ["contradict", lesson.contradictionCount, lesson.createdDay],
  ]) {
    for (let i = 0; i < count; i++) {
      const outcome = outcomeRecord({
        oracle: "legacy.import",
        result: kind,
        ref: `legacy:${lesson.id}#${kind}${i}`,
        t: day,
      });
      if (!outcome.ok) throw new Error("Invalid legacy evidence");
      yield outcome.outcome;
    }
  }
}

function apply(ledger, entries, intentFile) {
  const known = ledgerIdentities(ledger);
  // Persist which identities were absent before any writes. If a process exits
  // between a claim's atomic publish and its provenance append, only that same
  // first import may fill in the missing receipt and aggregate outcomes.
  if (!existsSync(intentFile)) {
    const eligible = entries
      .filter(
        ({ claim }) =>
          !known.has(identity(claim)) && !getClaimByPrefix(ledger, claim.id, { attic: true }),
      )
      .map(({ claim }) => claim.id);
    atomicPrivate(intentFile, JSON.stringify(eligible));
  }
  const eligible = new Set(JSON.parse(regularBytes(intentFile, MAX_SOURCE, true).toString("utf8")));
  const result = { lessons: 0, facts: 0, outcomes: 0, retained: 0, refused: [] };
  for (const { lesson, claim, sourceHash } of entries) {
    const key = identity(claim);
    const prior = known.get(key) ?? getClaimByPrefix(ledger, claim.id, { attic: true });
    const incomplete = prior && !prior.provenanceAll?.length && !prior.evidence?.length;
    if (
      !eligible.has(claim.id) ||
      (prior &&
        (prior.id !== claim.id ||
          prior.archived ||
          prior.tombstone ||
          !lesson ||
          (!incomplete &&
            !(prior.provenanceAll ?? [prior.provenance]).some((p) => p?.migration === sourceHash))))
    ) {
      result.retained++;
      continue;
    }
    const written = putClaim(ledger, claim);
    if (!written.ok) throw new Error(written.reason);
    if (!written.existed) result[lesson ? "lessons" : "facts"]++;
    if (!lesson) continue;
    result.outcomes += appendEvidenceBatch(ledger, claim.id, historicalOutcomes(lesson));
    if (lesson.status === "retired") {
      const retired = tombstone(ledger, claim.id, {
        author: "legacy.import",
        reason: "retired-in-legacy-store",
        t: lesson.lastConfirmedDay,
      });
      if (!retired.ok) throw new Error(retired.reason);
    }
  }
  return result;
}

export function migrateLegacy(root, { personal = false } = {}) {
  const { source, backup, ledger } = locations(root, personal);
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  requireDirectory(backup, { privateOwner: true });
  const latest = join(backup, "latest");
  return withConfigLock(latest, () => {
    const files = capture(source, personal);
    let id;
    if (files.length || !existsSync(latest)) {
      const bytes = Buffer.from(JSON.stringify({ version: 1, personal, files }));
      decode(files, personal); // Refuse malformed or sensitive records before making a backup.
      id = sha(bytes);
      const path = join(backup, `${id}.json`);
      if (!existsSync(path)) atomicPrivate(path, bytes);
    } else id = regularBytes(latest, 64, true).toString("ascii");
    const entries = readSnapshot(backup, id, personal);
    checkTargets(ledger, personal ? source : brainStore(source));
    atomicPrivate(latest, id);
    const before = verify(ledger);
    if (!before.ok)
      throw new Error("Resolve existing ledger verification failures before migration");
    const result = apply(ledger, entries, join(backup, `${id}.intent.json`));
    if (entries.length) {
      reindex(ledger);
      reindexRecall(personal ? source : brainStore(source));
      if (!personal) buildIndex(brainStore(source));
    }
    const verification = verify(ledger);
    if (!verification.ok)
      throw new Error(
        "Migrated ledger failed verification; the snapshot is available for recovery",
      );
    return { ...result, snapshot: id, files: entries.length, verified: true };
  });
}

export function restoreLegacy(root, destination, { personal = false, snapshot = undefined } = {}) {
  const { backup } = locations(root, personal);
  requireDirectory(backup, { privateOwner: true });
  const id = snapshot ?? regularBytes(join(backup, "latest"), 64, true).toString("ascii");
  const entries = readSnapshot(backup, id, personal);
  if (!destination) throw new Error("Supply a new directory for the restored files");
  const target = resolve(destination);
  const dest = join(realpathSync.native(dirname(target)), basename(target));
  requireDirectory(dirname(dest));
  // mkdir is an exclusive claim on the destination, including concurrent restores.
  mkdirSync(dest, { mode: 0o700 });
  for (const entry of entries) {
    const path = join(dest, entry.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, entry.bytes, { flag: "wx", mode: 0o600, flush: true });
    if (sha(regularBytes(path, MAX_SOURCE, true)) !== entry.sourceHash)
      throw new Error("Restored memory failed verification");
  }
  return { snapshot: id, destination: realpathSync(dest), files: entries.length, verified: true };
}

// forge ledger sync — cross-machine convergence for the PCM ledger. The ledger is
// already a state-based CRDT (content-addressed claims + hash-deduped append-only
// logs, joined by the semilattice `mergeStates`); sync is just a transport that moves
// that state between replicas and re-runs the join. Two transports:
//
//   • dir mode — a shared directory (USB, NFS, a synced folder): bidirectional
//     `mergeDirs`, the same union-merge `forge ledger merge` already does, both ways.
//   • ref mode — a git remote: the state is serialized to a canonical `state.json`
//     blob under a dedicated ref (refs/<cli>/ledger) via git plumbing
//     (hash-object → mktree → commit-tree → update-ref → push). Pull = fetch the ref,
//     read the blob, `importState`. A non-fast-forward push (a teammate raced us) is
//     not a conflict: re-fetch, re-import (monotone — nothing is ever lost), rebuild
//     on the new parent, retry.
//
// FAIL-OPEN like update.js/gate.js: no target, offline, a corrupt remote blob, or a
// lost race all return a result object with `ok:false` and an honest reason — nothing
// here throws. The git runner is injectable (`run`) so tests drive it with local
// bare remotes and never touch the network.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BRAND } from "./brand.js";
import { canonicalize } from "./ledger.js";
import { importState, loadState, mergeDirs } from "./ledger_store.js";
import { gitAuthor } from "./util.js";

const STATE_FILE = "state.json";

// Contract note: syncTarget takes its environment via the injectable `env` param
// (defaulting to process.env) and reads process.env.FORGE_SYNC_DIR from it — named
// literally here so docs_check.envVarsRead collects FORGE_SYNC_DIR into the documented
// env contract (README + docs/GUIDE.md) even though the read goes through `env`.

/**
 * @typedef {object} SyncResult
 * @property {boolean} ok
 * @property {string} mode "dir" | "ref" | "none"
 * @property {string} [reason]
 * @property {string} [dir]
 * @property {string} [remote]
 * @property {string} [ref]
 * @property {*} [pulled] import counts {claims, records, quarantined}
 * @property {*} [pushed] dir mode: {claims, records}; ref mode: boolean
 * @property {boolean} [upToDate]
 * @property {number} [retries]
 * @property {string[]} [notes]
 */

/** The default git ref the ledger state rides on. Brand-tokenized (equals
 *  `refs/forge/ledger` today) so a rebrand never strands a hardcoded ref, and the
 *  `--personal` ledger gets a sibling ref so personal facts can never land on the
 *  repo's shared ledger by accident. */
export const defaultRef = (personal = false) =>
  `refs/${BRAND.cli}/ledger${personal ? "-personal" : ""}`;

/**
 * The real git runner. stderr is PIPED (not ignored) so a non-fast-forward rejection
 * is classifiable from the thrown error's `.stderr`. Throws on non-zero exit — callers
 * that expect failure (ref probes, first-sync fetch) wrap in try/catch.
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, env?: Record<string,string>}} [opts]
 * @returns {string} trimmed stdout
 */
export function defaultRun(args, { cwd = process.cwd(), input, env } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  }).trim();
}

/** The canonical state.json payload for a ledger dir: deterministic bytes (sorted
 *  keys, NFC) so the same on-disk state hashes to the same blob on every replica —
 *  which is what makes the idempotence check (tree-SHA equality) exact. */
export function stateBytes(dir) {
  return `${canonicalize(loadState(dir))}\n`;
}

/** Committer/author identity for the sync commit, parsed from a `Name <email>`
 *  string (gitAuthor()). Falls back to the brand so commit-tree never fails when no
 *  git identity is configured. */
function commitEnv(author) {
  const m = /^(.*?)\s*<(.*)>$/.exec(String(author || ""));
  const name = (m ? m[1].trim() : String(author || "").trim()) || BRAND.brand;
  const email = (m ? m[2].trim() : "") || `${BRAND.cli}@localhost`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Resolve the sync target by the spec's precedence: an explicit `--dir` wins; then
 * `--remote`/`--ref` force ref mode; then a git remote on the repo (ref mode); then
 * `FORGE_SYNC_DIR` (dir mode); else an honest "no target". Pure + injectable env/run
 * so it is unit-testable without a repo.
 * @param {{root?: string, personal?: boolean, dirTarget?: string, remote?: string,
 *   ref?: string, env?: Record<string,string|undefined>, run?: typeof defaultRun}} [opts]
 * @returns {{mode:"dir", dir:string} | {mode:"ref", remote:string, ref:string} |
 *   {mode:"none", reason:string}}
 */
export function syncTarget({
  root = process.cwd(),
  personal = false,
  dirTarget,
  remote,
  ref,
  env = process.env,
  run = defaultRun,
} = {}) {
  if (dirTarget) return { mode: "dir", dir: dirTarget };
  if (remote || ref)
    return {
      mode: "ref",
      remote: remote || "origin",
      ref: ref || defaultRef(personal),
    };
  let remotes = "";
  try {
    remotes = run(["remote"], { cwd: root });
  } catch {
    remotes = "";
  }
  const first = remotes
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (first) return { mode: "ref", remote: first, ref: defaultRef(personal) };
  if (env.FORGE_SYNC_DIR) return { mode: "dir", dir: env.FORGE_SYNC_DIR };
  return {
    mode: "none",
    reason: "no sync target: pass --dir <path>, --remote/--ref, or set FORGE_SYNC_DIR",
  };
}

/**
 * Dir transport: bidirectional union-merge with a shared ledger directory. Pull =
 * merge the other dir into ours, push = merge ours into the other — both idempotent
 * and order-independent by the CRDT property, so both dirs converge to the union.
 * @param {string} localDir
 * @param {string} otherDir
 * @returns {SyncResult}
 */
export function syncDir(localDir, otherDir) {
  if (!existsSync(otherDir))
    return {
      ok: false,
      mode: "dir",
      dir: otherDir,
      reason: `no sync directory at ${otherDir}`,
    };
  const pulled = mergeDirs(localDir, otherDir);
  const pushed = mergeDirs(otherDir, localDir);
  return { ok: true, mode: "dir", dir: otherDir, pulled, pushed };
}

/** Read the remote ref's state.json blob and import it into localDir. Returns import
 *  counts; a missing/corrupt blob degrades to {claims:0,records:0} + a note (never
 *  throws) so a garbled remote can never take the local ledger down. */
function pullRef(localDir, root, ref, run, notes) {
  try {
    const raw = run(["cat-file", "blob", `${ref}:${STATE_FILE}`], {
      cwd: root,
    });
    const remoteState = JSON.parse(raw);
    return importState(localDir, remoteState);
  } catch {
    notes.push("remote ledger state unreadable — treated as empty");
    return { claims: 0, records: 0, quarantined: 0 };
  }
}

/** The local commit at `ref`, or null if the ref does not exist. `--verify --quiet`
 *  exits non-zero (→ throw → null) when the ref is absent. */
function refCommit(root, ref, run) {
  try {
    return run(["rev-parse", "--verify", "--quiet", ref], { cwd: root }) || null;
  } catch {
    return null;
  }
}

/**
 * Ref transport: push-pull the ledger through a git ref via plumbing.
 * @param {string} localDir
 * @param {{root:string, remote:string, ref:string, run?: typeof defaultRun,
 *   author?: string, maxRetries?: number}} opts
 * @returns {SyncResult}
 */
export function syncRef(
  localDir,
  { root, remote, ref, run = defaultRun, author = gitAuthor(), maxRetries = 3 },
) {
  const notes = [];
  const base = { mode: "ref", remote, ref };
  // Preflight — an honest miss beats an exception.
  try {
    if (run(["rev-parse", "--is-inside-work-tree"], { cwd: root }) !== "true")
      return { ok: false, ...base, reason: "not a git repository" };
  } catch {
    return { ok: false, ...base, reason: "not a git repository" };
  }
  try {
    run(["remote", "get-url", remote], { cwd: root });
  } catch {
    return { ok: false, ...base, reason: `no such git remote: ${remote}` };
  }

  // PULL: fetch the remote ledger ref. A missing ref is a first sync, not an error;
  // anything else (no network, auth) fails open with an honest reason. The ref name is a
  // single fixed name shared across remotes, so a local ref left over from syncing a
  // DIFFERENT remote must never be mistaken for THIS remote's state — track whether the
  // fetch actually found the ref on this remote, and only trust the idempotence
  // short-circuit when it did (else a new/pruned remote is silently never pushed to).
  let remoteHasRef = false;
  let pulled = { claims: 0, records: 0, quarantined: 0 };
  try {
    run(["fetch", remote, `+${ref}:${ref}`], { cwd: root });
    remoteHasRef = true;
  } catch (e) {
    const msg = String(e?.stderr || e?.message || "");
    if (!/couldn't find remote ref|not our ref|no matching|does not exist/i.test(msg))
      return {
        ok: false,
        ...base,
        reason: "fetch failed (offline or no access?)",
      };
  }
  if (refCommit(root, ref, run)) pulled = pullRef(localDir, root, ref, run, notes);

  // PUSH: serialize local state to a blob/tree; skip entirely when the remote tree
  // already equals ours (idempotence — re-running sync is a byte-level no-op). A
  // non-fast-forward rejection means a teammate raced us: re-fetch, re-import
  // (monotone), rebuild on the new parent, retry up to maxRetries.
  for (let retries = 0; ; ) {
    const bytes = stateBytes(localDir);
    let blob;
    let tree;
    try {
      blob = run(["hash-object", "-w", "--stdin"], { cwd: root, input: bytes });
      tree = run(["mktree"], {
        cwd: root,
        input: `100644 blob ${blob}\t${STATE_FILE}\n`,
      });
    } catch {
      return {
        ok: false,
        ...base,
        reason: "could not write ledger state object",
        retries,
        notes,
      };
    }
    const parent = refCommit(root, ref, run);
    if (parent) {
      let parentTree = null;
      try {
        parentTree = run(["rev-parse", `${ref}^{tree}`], { cwd: root });
      } catch {}
      if (remoteHasRef && parentTree === tree)
        return {
          ok: true,
          ...base,
          pulled,
          pushed: false,
          upToDate: true,
          retries,
          notes,
        };
    }
    const commitArgs = ["commit-tree", tree, "-m", `${BRAND.cli} ledger sync`];
    if (parent) commitArgs.push("-p", parent);
    let commit;
    try {
      commit = run(commitArgs, { cwd: root, env: commitEnv(author) });
      run(["update-ref", ref, commit], { cwd: root });
    } catch {
      return {
        ok: false,
        ...base,
        reason: "could not build sync commit",
        retries,
        notes,
      };
    }
    try {
      run(["push", remote, `${ref}:${ref}`], { cwd: root });
      return {
        ok: true,
        ...base,
        pulled,
        pushed: true,
        upToDate: false,
        retries,
        notes,
      };
    } catch (e) {
      const msg = String(e?.stderr || e?.message || "");
      const raced = /non-fast-forward|fetch first|rejected|stale info|cannot lock ref/i.test(msg);
      if (!raced || retries >= maxRetries)
        return {
          ok: false,
          ...base,
          reason: raced ? "push kept losing the race (retries exhausted)" : "push failed",
          retries,
          notes,
        };
      retries++;
      try {
        run(["fetch", remote, `+${ref}:${ref}`], { cwd: root });
        remoteHasRef = true; // a race means the remote now has the ref
      } catch {
        return {
          ok: false,
          ...base,
          reason: "re-fetch after race failed",
          retries,
          notes,
        };
      }
      const more = pullRef(localDir, root, ref, run, notes);
      pulled = {
        claims: pulled.claims + more.claims,
        records: pulled.records + more.records,
        quarantined: (pulled.quarantined ?? 0) + (more.quarantined ?? 0),
      };
    }
  }
}

/**
 * Resolve the target and run the matching transport. Thin dispatcher; every path
 * returns a result object and nothing throws (fail-open).
 * @param {{dir?:string, root?:string, personal?:boolean, dirTarget?:string,
 *   remote?:string, ref?:string, env?:Record<string,string|undefined>,
 *   run?: typeof defaultRun, author?:string, maxRetries?:number}} [opts]
 * @returns {SyncResult}
 */
export function ledgerSync({
  dir,
  root = process.cwd(),
  personal = false,
  dirTarget,
  remote,
  ref,
  env = process.env,
  run = defaultRun,
  author,
  maxRetries,
} = {}) {
  const target = syncTarget({
    root,
    personal,
    dirTarget,
    remote,
    ref,
    env,
    run,
  });
  if (target.mode === "none") return { ok: false, ...target };
  if (target.mode === "dir") return syncDir(dir, target.dir);
  return syncRef(dir, {
    root,
    remote: target.remote,
    ref: target.ref,
    run,
    author,
    maxRetries,
  });
}

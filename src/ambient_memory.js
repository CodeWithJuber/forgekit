// Bounded candidate selection for prompt hooks. The index stores only addresses. Every
// candidate is re-read from the current checkout before ranking, including its tombstone.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { claimText } from "./ledger.js";
import { outsideWorkspace, physicalPath } from "./private_paths.js";
import { contentHash, userStateDir } from "./util.js";

const KINDS = new Set(["lesson", "summary", "diagnosis", "artifact"]);
const MAX_TERMS = 16,
  MAX_BUCKET_BYTES = 4096,
  MAX_CANDIDATES = 64,
  MAX_ENTRIES = 128;
const fullId = /^[0-9a-f]{64}$/;
export function ambientIndexDir(dir) {
  const root = basename(dirname(dir)) === ".forge" ? dirname(dirname(dir)) : dir;
  return outsideWorkspace(
    root,
    join(userStateDir(), "claim-index-v1", contentHash(physicalPath(dir))),
    "Configure a state directory outside the workspace for the private claim index.",
  );
}
function keys(text) {
  const words =
    String(text)
      .slice(0, 8192)
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_TERMS)
    .map((word) => contentHash(word).slice(0, 4));
}
export function indexClaim(dir, claim) {
  if (!KINDS.has(claim.kind)) return "ignored";
  try {
    const dest = ambientIndexDir(dir);
    // The receipt is written after all postings. A retry after a partial write repairs
    // the missing entries. Even postings older than the bounded read tail stay unique
    // on subsequent complete index passes.
    const receipts = join(dest, "indexed", claim.id.slice(0, 2));
    const receipt = join(receipts, claim.id);
    if (existsSync(receipt)) return "indexed";
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    const words = keys(
      [claimText(claim), ...(claim.body?.trigger?.files ?? []), claim.body?.code?.path].join(" "),
    );
    for (const key of new Set(words)) {
      if (!postings(dest, key).includes(claim.id))
        writeFileSync(join(dest, key), `${claim.id}\n`, { mode: 0o600, flag: "a" });
    }
    writeFileSync(receipt, "", { mode: 0o600, flag: "a" });
    return "indexed";
  } catch {
    return "failed";
  }
}
function postings(dir, key) {
  let fd;
  try {
    fd = openSync(
      join(dir, key),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const st = fstatSync(fd);
    if (!st.isFile()) return [];
    const size = Math.min(MAX_BUCKET_BYTES, st.size),
      tail = Buffer.alloc(size);
    const n = readSync(fd, tail, 0, size, st.size - size);
    return tail
      .toString("utf8", 0, n)
      .split("\n")
      .filter((id) => fullId.test(id))
      .reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
// Bound directory iteration even in a foreign checkout without Forge's private index.
function localCandidates(dir) {
  const ids = [],
    root = join(dir, "claims");
  let seen = 0;
  function visit(path, accept) {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
    const handle = opendirSync(path);
    try {
      let e;
      while (seen < MAX_ENTRIES && ids.length < MAX_CANDIDATES && (e = handle.readSync())) {
        seen++;
        accept(e);
      }
    } finally {
      handle.closeSync();
    }
  }
  try {
    visit(root, (e) => {
      if (!e.isDirectory() || !/^[0-9a-f]{2}$/.test(e.name)) return;
      visit(join(root, e.name), (f) => {
        const id = f.name.slice(0, -5);
        if (f.isFile() && f.name.endsWith(".json") && fullId.test(id) && id.startsWith(e.name))
          ids.push(id);
      });
    });
  } catch {
    /* A concurrently removed shard can be revisited on the next prompt. */
  }
  return ids;
}
export function ambientCandidates(dir, text, getLive) {
  const scores = new Map();
  try {
    const index = ambientIndexDir(dir);
    for (const key of new Set(keys(text))) {
      const ids = new Set(postings(index, key));
      // Inverse posting frequency favors specific terms even when the tail is capped.
      const weight = 1 / Math.log2(2 + ids.size);
      for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + weight);
    }
  } catch {}
  const ranked = [...scores.keys()].sort(
    (a, b) => scores.get(b) - scores.get(a) || a.localeCompare(b),
  );
  const ids = [...new Set([...ranked, ...localCandidates(dir)])].slice(0, MAX_CANDIDATES);
  const claims = [];
  for (const id of ids) {
    try {
      const claim = getLive(dir, id);
      if (claim && !claim.tombstone && KINDS.has(claim.kind)) claims.push(claim);
    } catch {}
  }
  return { claims, examined: ids.length, maxCandidates: MAX_CANDIDATES, exhaustive: false };
}

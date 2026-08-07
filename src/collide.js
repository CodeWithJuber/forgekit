// forge collide — the parallel-session conflict radar. The everyday failure of the
// agent-fleet era: two sessions (your agent and a teammate's, or two of your own)
// silently edit the same or import-coupled files and the collision surfaces only at
// merge time. The ledger already holds the answer — deja mints a session-summary claim
// (body.files) for every session, and those claims team-merge over git — so "who else
// was just in here?" is a pure read: no server, no presence protocol, no new storage.
// (The idea is old workspace-awareness research — Palantír-style conflict early
// warning — rebuilt on a CRDT ledger instead of a central server.)
//
// The formula (DECISIONS are formulas): risk = 1 − ∏(1 − rec_i × s_i) — the house
// noisy-OR over recent foreign sessions, where rec_i is the ledger's recency decay
// (short half-life: a session from last month is not a collision) and s_i is the
// touched-overlap strength: direct hits count full, import-coupled neighbors half.
// Fail-open: no ledger, no git, no sessions → quiet empty report, never a block.
import { gitFiles } from "./anchor.js";
import { rec } from "./ledger.js";
import { loadClaims, repoLedger } from "./ledger_store.js";
import { importGraph } from "./scope.js";
import { clamp01, epochDay, gitAuthor, toPosix } from "./util.js";

/** Recency half-life for collision relevance, in days. Deliberately much shorter than
 *  the ledger's 45-day belief half-life: a collision is about what is happening NOW. */
export const COLLIDE_HALF_LIFE_DAYS = 7;

/** Strip a root prefix so absolute hook-minted paths match repo-relative graph paths
 *  (same normalization the rank history join needs — hook paths arrive absolute). */
const relify = (p, prefix) => {
  const posix = toPosix(String(p));
  return prefix && posix.startsWith(prefix) ? posix.slice(prefix.length) : posix;
};

/**
 * Pure collision scoring over session-summary claims.
 * @param {any[]} claims live ledger claims (loadClaims output)
 * @param {string[]} mine repo-relative files this session is touching
 * @param {{nodes:string[], edges:Map<string, Set<string>>}} graph undirected import graph
 * @param {{nowDay?:number, author?:string, root?:string, halfLife?:number}} [opts]
 *   author: sessions minted by this author are skipped (your own past work is not a
 *   collision); pass "" to keep everything.
 * @returns {{risk:number, sessions:{id:string, author:string, day:number, rec:number,
 *   strength:number, direct:string[], coupled:string[]}[]}}
 */
export function collisions(
  claims,
  mine,
  graph,
  { nowDay = 0, author = "", root = "", halfLife = COLLIDE_HALF_LIFE_DAYS } = {},
) {
  const prefix = root ? `${toPosix(String(root)).replace(/\/+$/, "")}/` : "";
  const mineSet = new Set(mine);
  // 1-hop import neighborhood of my files — editing a file collides with sessions
  // that touched what it imports or what imports it.
  const near = new Set();
  for (const f of mine) for (const n of graph.edges?.get(f) ?? []) if (!mineSet.has(n)) near.add(n);
  const sessions = [];
  for (const claim of claims ?? []) {
    if (claim.kind !== "summary" || claim.tombstone) continue;
    const who = claim.provenance?.author ?? "";
    if (author && who === author) continue;
    const files = [...new Set((claim.body?.files ?? []).map((f) => relify(f, prefix)))];
    const direct = files.filter((f) => mineSet.has(f)).sort();
    const coupled = files.filter((f) => near.has(f)).sort();
    if (!direct.length && !coupled.length) continue;
    const r = rec(claim, nowDay, { halfLife });
    const strength = clamp01((direct.length + 0.5 * coupled.length) / Math.max(1, mine.length));
    sessions.push({
      id: claim.id,
      author: who,
      day: Math.max(claim.provenance?.t ?? 0, ...(claim.evidence ?? []).map((e) => e.t ?? 0)),
      rec: Number(r.toFixed(4)),
      strength: Number(strength.toFixed(4)),
      direct,
      coupled,
    });
  }
  sessions.sort((a, b) => b.rec * b.strength - a.rec * a.strength || (a.id < b.id ? -1 : 1));
  const risk = 1 - sessions.reduce((acc, s) => acc * (1 - s.rec * s.strength), 1);
  return { risk: Number(risk.toFixed(4)), sessions };
}

/**
 * The impure assembler: my working diff (or explicit files), the import graph, the
 * ledger — composed into one advisory report.
 * @param {string} root
 * @param {{files?:string[]}} [opts]
 */
export function collideReport(root, { files } = {}) {
  const mine = (files?.length ? files : gitFiles(root)).map((f) => toPosix(String(f)));
  if (!mine.length) return { risk: 0, mine: [], sessions: [] };
  let claims = [];
  try {
    claims = loadClaims(repoLedger(root));
  } catch {
    claims = []; // no ledger → quiet
  }
  let graph = { nodes: [], edges: new Map() };
  try {
    graph = importGraph(root);
  } catch {
    // unreadable tree → direct overlaps only
  }
  const r = collisions(claims, mine, graph, {
    nowDay: epochDay(),
    author: gitAuthor(),
    root,
  });
  return { ...r, mine };
}

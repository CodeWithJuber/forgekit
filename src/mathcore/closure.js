// What can a change affect, and which documented claims does it put in doubt?
//
// Edge [u, v] means v depends on u. The walk covers the union of the dependency graphs before
// and after the change: a consumer whose edge the change deleted is still affected, and a walk
// over the new graph alone misses it. An unknown node or an incomplete graph returns everything,
// because "not found" is not evidence of "not affected".

/**
 * @param {{nodes:string[], oldEdges:[string,string][], newEdges:[string,string][],
 *   changed:string[], incomplete?:boolean}} input
 * @returns {Set<string>} the changed nodes and everything that transitively depends on them
 */
export function impacted({ nodes, oldEdges, newEdges, changed, incomplete = false }) {
  const all = new Set(nodes);
  if (incomplete || changed.some((c) => !all.has(c))) return new Set(all);
  /** @type {Map<string, string[]>} */
  const next = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of [...oldEdges, ...newEdges]) {
    if (!all.has(u) || !all.has(v)) return new Set(all);
    /** @type {string[]} */ (next.get(u)).push(v);
  }
  const seen = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    for (const v of /** @type {string[]} */ (next.get(/** @type {string} */ (queue.shift())))) {
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

/**
 * Documentation as claims over code. A claim cites symbols, each with the content hash it was
 * last checked against.
 *   unresolved  a cited symbol no longer exists
 *   stale       a cited symbol's content changed, or the symbol is in the impact set
 *   valid       every cited symbol exists with the same hash and none is affected
 * A symbol that only moved keeps its hash, so a pure move leaves its claims valid.
 * @param {{claims:{id:string, sources:{symbol:string, hash:string}[]}[],
 *   hashes:Record<string,string>, affected?:Set<string>}} input
 * @returns {{id:string, state:"valid"|"stale"|"unresolved", because:string[]}[]}
 */
export function classifyClaims({ claims, hashes, affected = new Set() }) {
  return claims.map((claim) => {
    const missing = claim.sources.filter((s) => !Object.hasOwn(hashes, s.symbol));
    if (missing.length)
      return {
        id: claim.id,
        state: /** @type {"unresolved"} */ ("unresolved"),
        because: missing.map((s) => s.symbol),
      };
    const moved = claim.sources.filter(
      (s) => hashes[s.symbol] !== s.hash || affected.has(s.symbol),
    );
    return {
      id: claim.id,
      state: /** @type {"valid"|"stale"} */ (moved.length ? "stale" : "valid"),
      because: moved.map((s) => s.symbol),
    };
  });
}

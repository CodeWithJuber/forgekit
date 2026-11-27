// Remove statements that compete with the evidence before a context window is packed.
//
// Why this and not "make it shorter": a 2026 retrieval study (arXiv:2611.04169) found neutral
// filler costs almost nothing while a statement of the same form with a rival value multiplies
// the loss many times over. Length is a budget; rivals are the hazard. Two statements are rivals
// when they answer the same key with different values. A later statement supersedes an earlier
// one. Two different values with the same time cannot be ordered, so neither is packed and the
// pair is reported: the caller resolves it, because packing both is the measured worst case.
//
// A statement is { id, key, value, at } where `at` is any number that orders statements about
// one key (a commit index, a day, a ledger sequence). Statements with different keys never
// interact. Pure and order-independent: shuffling the input changes nothing.

/**
 * @param {{id:string,key:string,value:unknown,at:number}[]} statements
 * @returns {{keep:{id:string,key:string,value:unknown,at:number}[],
 *   superseded:{id:string,by:string}[], conflicts:{key:string,ids:string[]}[]}}
 */
export function dropRivals(statements) {
  const byKey = new Map();
  for (const s of statements) {
    if (!Number.isFinite(s.at)) throw new TypeError(`statement ${s.id} has no finite order`);
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(s);
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keep = [];
  const superseded = [];
  const conflicts = [];
  for (const [key, group] of [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const latest = Math.max(...group.map((s) => s.at));
    const current = group.filter((s) => s.at === latest).sort((a, b) => (a.id < b.id ? -1 : 1));
    const agree = current.every((s) => same(s.value, current[0].value));
    // Restating the current value is not rivalry; one copy carries it.
    const winner = agree ? current[0] : null;
    if (winner) keep.push(winner);
    else conflicts.push({ key, ids: current.map((s) => s.id) });
    for (const s of group) {
      if (s === winner || (!winner && s.at === latest)) continue;
      superseded.push({ id: s.id, by: winner ? winner.id : `conflict:${key}` });
    }
  }
  superseded.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { keep, superseded, conflicts };
}

/** How many statements in a packed set still face a rival value: 0 for any `dropRivals` output. */
export function rivalCount(statements) {
  const values = new Map();
  for (const s of statements) {
    if (!values.has(s.key)) values.set(s.key, new Set());
    values.get(s.key).add(JSON.stringify(s.value));
  }
  let n = 0;
  for (const s of statements) if (values.get(s.key).size > 1) n++;
  return n;
}

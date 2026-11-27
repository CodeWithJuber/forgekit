// Evidence selection when token cost is not additive.
//
// Each question has a weight and alternative witness sets (sets of record ids that together answer
// it). costOf(set) is the MEASURED size of the serialized packet. Two properties are assumed and
// must be checked on a calibration sample for the destination tokenizer:
//   monotone:       removing a record never increases costOf
//   near-additive:  costOf(A) >= sum of single costs - kappa * (|A| - 1)
// Monotonicity makes "some optimum is a union of complete witnesses" true. Near-additivity gives an
// admissible lower bound, so pruning by partial cost can never discard the optimum. kappa = 0 is
// the additive case.
//
// This is exact selection for a small candidate set. src/context.js packs by a greedy
// value-density heuristic and claims no guarantee; nothing there calls this module yet.

function unionKey(ids) {
  return [...ids].sort().join("\u0000");
}

export function chooseEvidence({ questions, single, costOf, kappa = 0, budget }) {
  if (!(budget >= 0)) throw new Error("budget must be nonnegative");
  if (!(kappa >= 0)) throw new Error("kappa must be nonnegative");
  const lowerBound = (ids) => {
    let sum = 0;
    let top = 0;
    for (const id of ids) {
      sum += single[id];
      top = Math.max(top, single[id]);
    }
    return Math.max(top, sum - kappa * Math.max(0, ids.size - 1));
  };
  let frontier = new Map([["", new Set()]]);
  for (const q of questions) {
    const next = new Map(frontier);
    for (const have of frontier.values()) {
      for (const option of q.options) {
        const merged = new Set([...have, ...option]);
        if (lowerBound(merged) > budget) continue; // admissible: true cost is at least this
        next.set(unionKey(merged), merged);
      }
    }
    frontier = next;
  }
  let best = null;
  let measured = 0;
  for (const ids of frontier.values()) {
    const cost = costOf(ids);
    measured++;
    if (cost > budget) continue;
    const weight = questions.reduce(
      (acc, q) => acc + (q.options.some((o) => o.every((id) => ids.has(id))) ? q.weight : 0),
      0,
    );
    const key = unionKey(ids);
    const better =
      best === null ||
      weight > best.weight ||
      (weight === best.weight &&
        (cost < best.cost ||
          (cost === best.cost &&
            (ids.size < best.ids.length || (ids.size === best.ids.length && key < best.key)))));
    if (better) best = { weight, cost, ids: [...ids].sort(), key };
  }
  return { weight: best.weight, cost: best.cost, ids: best.ids, measured };
}

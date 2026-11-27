// Should a temporary script, procedure or skill be kept for reuse?
//
// Keeping it pays when the expected saving over its remaining uses exceeds what it costs to
// verify and to carry in the tool index:
//
//   reuse * (regenCost - invokeCost) * L  >  verifyCost + contextCost
//
// L is a LOWER bound on the pass rate, not the observed rate, and it is computed only from
// HELD-OUT runs: requests the artefact was not derived from. A 2026 study (arXiv:2609.39148)
// found that of 21 skills which improved on their training tasks only 5 kept the whole gain on
// held-out tasks, so the tasks an artefact came from say little about the next one. The bound
// stays valid when it is re-read after every run (sequential.js).

import { anytimeLower } from "./sequential.js";

/**
 * @param {{heldOutPass:number, heldOutFail:number, expectedReuse:number, regenCost:number,
 *   invokeCost:number, verifyCost:number, contextCost:number, alpha?:number}} input
 * @returns {{keep:boolean, passLower:number, saving:number, overhead:number,
 *   breakEvenReuse:number, reason:string}}
 */
export function promotionDecision({
  heldOutPass,
  heldOutFail,
  expectedReuse,
  regenCost,
  invokeCost,
  verifyCost,
  contextCost,
  alpha = 0.05,
}) {
  for (const [name, v] of Object.entries({ heldOutPass, heldOutFail, expectedReuse }))
    if (!(v >= 0)) throw new RangeError(`${name} must be >= 0`);
  const passLower =
    heldOutPass + heldOutFail === 0 ? 0 : anytimeLower(heldOutPass, heldOutFail, alpha);
  const perUse = (regenCost - invokeCost) * passLower;
  const overhead = verifyCost + contextCost;
  const saving = expectedReuse * perUse;
  const breakEvenReuse = perUse > 0 ? overhead / perUse : Number.POSITIVE_INFINITY;
  const keep = saving > overhead;
  const reason =
    heldOutPass + heldOutFail === 0
      ? "no held-out runs: nothing is known about the next request"
      : regenCost <= invokeCost
        ? "invoking it costs at least as much as regenerating it"
        : keep
          ? "expected saving exceeds verification and index cost"
          : `needs more than ${Number.isFinite(breakEvenReuse) ? breakEvenReuse.toFixed(1) : "any number of"} reuses at this pass bound`;
  return { keep, passLower, saving, overhead, breakEvenReuse, reason };
}

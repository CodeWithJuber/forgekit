// Spectrum-based fault localisation: rank code units by how strongly their execution goes with
// failing tests. For a unit, ef and ep count the failing and passing tests that ran it; nf and
// np count those that did not.
//
//   Ochiai     ef / sqrt((ef + nf) * (ef + ep))
//   DStar(2)   ef^2 / (ep + nf)
//   Tarantula  (ef/F) / (ef/F + ep/P)
//
// A unit no failing test ran scores 0 in all three. DStar is unbounded: a unit run by every
// failing test and no passing one scores Infinity and ranks first.
//
// A 2026 study (arXiv:2610.36015) found frontier models locate nearly all single-line faults in
// short programs from source alone, so this is for large suites where coverage already exists.
// It needs per-test coverage, which nothing in this project collects yet.

/**
 * @param {{coverage:Record<string,string[]>, failing:string[]}} input
 *   `coverage` maps a test id to the units it ran; `failing` lists the test ids that failed
 * @param {{formula?:"ochiai"|"dstar"|"tarantula"}} [options]
 * @returns {{unit:string, score:number, ef:number, ep:number}[]} most suspicious first
 */
export function suspiciousness({ coverage, failing }, { formula = "ochiai" } = {}) {
  const failed = new Set(failing);
  const tests = Object.keys(coverage);
  const F = tests.filter((t) => failed.has(t)).length;
  const P = tests.length - F;
  /** @type {Map<string, {ef:number, ep:number}>} */
  const counts = new Map();
  for (const t of tests) {
    for (const unit of new Set(coverage[t])) {
      const c = counts.get(unit) ?? { ef: 0, ep: 0 };
      if (failed.has(t)) c.ef++;
      else c.ep++;
      counts.set(unit, c);
    }
  }
  const score = ({ ef, ep }) => {
    if (ef === 0) return 0;
    const nf = F - ef;
    if (formula === "ochiai") return ef / Math.sqrt((ef + nf) * (ef + ep));
    if (formula === "dstar")
      return ep + nf === 0 ? Number.POSITIVE_INFINITY : (ef * ef) / (ep + nf);
    if (formula === "tarantula") {
      const failRate = ef / F;
      const passRate = P === 0 ? 0 : ep / P;
      return failRate / (failRate + passRate);
    }
    throw new TypeError(`unknown formula: ${formula}`);
  };
  return [...counts]
    .map(([unit, c]) => ({ unit, score: score(c), ef: c.ef, ep: c.ep }))
    .sort((a, b) => b.score - a.score || b.ef - a.ef || (a.unit < b.unit ? -1 : 1));
}

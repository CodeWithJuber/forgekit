// Order vulnerability findings by exploit probability times the probability the vulnerable code
// can be reached, with reachability as a THREE-valued fact.
//
// The usual formula scores an "unreachable" finding zero. That is only sound when the dependency
// or call graph is complete. A study of 78,612 SBOMs (arXiv:2607.22140) found 52.9% declare no
// dependency edges at all and for 61.7% a missing path says nothing about reachability. So:
//
//   reach "yes"                      -> P(reach) = 1
//   reach "no" on a complete graph   -> P(reach) = residual   (what the analyser misses)
//   reach "no" on an incomplete graph, or "unknown" -> P(reach) = unknownPrior
//
// The defaults are the conservative ends: unknownPrior = 1 ranks an unknown exactly as plain
// EPSS would, and residual = 0 trusts a complete graph. Pass measured values to do better. A
// finding may be suppressed only when it is "no" on a complete graph; nothing else ever is.

const clamp01 = (x, name) => {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`${name} must be in [0, 1]`);
  return x;
};

/**
 * @param {{reach:"yes"|"no"|"unknown", graphComplete?:boolean}} finding
 * @param {{unknownPrior?:number, residual?:number}} [options]
 */
export function reachProbability(finding, { unknownPrior = 1, residual = 0 } = {}) {
  clamp01(unknownPrior, "unknownPrior");
  clamp01(residual, "residual");
  if (finding.reach === "yes") return 1;
  if (finding.reach === "no" && finding.graphComplete === true) return residual;
  if (finding.reach === "no" || finding.reach === "unknown") return unknownPrior;
  throw new TypeError(`unknown reach value: ${finding.reach}`);
}

/**
 * @param {{id:string, epss:number, reach:"yes"|"no"|"unknown", graphComplete?:boolean}[]} findings
 * @param {{unknownPrior?:number, residual?:number}} [options]
 * @returns {{id:string, priority:number, pReach:number, verdict:"reachable"|"unreachable"|"unknown",
 *   suppressible:boolean}[]} highest priority first; ties broken by id
 */
export function rankVulnerabilities(findings, options = {}) {
  return findings
    .map((f) => {
      const pReach = reachProbability(f, options);
      const verdict =
        f.reach === "yes"
          ? "reachable"
          : f.reach === "no" && f.graphComplete === true
            ? "unreachable"
            : "unknown";
      return {
        id: f.id,
        priority: clamp01(f.epss, "epss") * pReach,
        pReach,
        verdict: /** @type {"reachable"|"unreachable"|"unknown"} */ (verdict),
        suppressible: verdict === "unreachable",
      };
    })
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

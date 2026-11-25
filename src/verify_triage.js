// Only repeated, counted executions under comparable recorded conditions establish disagreement.
import { countVerdict } from "./test_counts.js";

export function triageVerifyEvents(events) {
  const groups = new Map();
  let ignoredRuns = 0;
  const seen = new Set();
  for (const e of events) {
    if (
      !e.runId ||
      seen.has(e.runId) ||
      !e.inCheckout ||
      e.authScope !== "event" ||
      !e.pre?.dirtyHash ||
      !e.pre.scheme ||
      !e.pre.head ||
      !e.environment?.digest ||
      e.pre.head !== e.post?.head ||
      e.pre.dirtyHash !== e.post?.dirtyHash ||
      e.pre.unbound?.length ||
      e.post.unbound?.length ||
      e.external?.length
    ) {
      ignoredRuns++;
      continue;
    }
    seen.add(e.runId);
    const observed = new Set();
    for (const s of e.suites ?? []) {
      const verdict = countVerdict(s.reportedCounts);
      if (!s.label || !s.cwd || (verdict !== "PASS" && verdict !== "FAIL") || s.status !== verdict)
        continue;
      const identity = [
        e.verifier,
        e.verifierVersion,
        e.pre.scheme,
        e.pre.head,
        e.pre.dirtyHash,
        e.environment.digest,
        s.cwd,
        s.label,
        [...(s.covers ?? [])].sort(),
      ];
      const key = JSON.stringify(identity);
      if (observed.has(key)) continue;
      observed.add(key);
      const g = groups.get(key) ?? {
        suite: s.label,
        cwd: s.cwd,
        head: e.pre.head,
        checkoutHash: e.pre.dirtyHash,
        environment: e.environment.digest,
        passes: [],
        failures: [],
      };
      (verdict === "PASS" ? g.passes : g.failures).push(e.runId);
      groups.set(key, g);
    }
  }
  const suites = [...groups.values()].map((g) => ({
    ...g,
    status:
      g.passes.length && g.failures.length
        ? "inconsistent"
        : g.passes.length + g.failures.length === 1
          ? "one-observation"
          : g.failures.length
            ? "consistently-failed"
            : "consistently-passed",
  }));
  return {
    schemaVersion: 1,
    ignoredRuns,
    suites,
    inconsistent: suites.filter((s) => s.status === "inconsistent").length,
  };
}

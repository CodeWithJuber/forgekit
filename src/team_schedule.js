// Schedule an explicitly authorized dependency graph. Timing metadata contains only
// measurements and contract hashes. Raw tasks and worker findings stay out of this store.
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "./secrets.js";
import { contentHash } from "./util.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

// Bound graph metadata and validation work for incoming CLI and MCP briefs.
export const MAX_TEAM_ITEMS = 128;

const validDuration = (ms) => Number.isFinite(ms) && ms > 0;
const nonnegative = (usd) => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/** Only like-for-like contracts share measurements. A local state error leaves the estimate unknown. */
export function teamTiming(root, contract, estimateMinutes) {
  const key = contentHash(JSON.stringify(contract));
  let observed = null;
  try {
    const file = timingPath(root, key);
    const st = lstatSync(file);
    if (st.isFile() && st.nlink === 1 && st.size <= 1024) {
      const row = JSON.parse(readFileSync(file, "utf8"));
      if (row.key === key && validDuration(row.durationMs) && Number.isFinite(row.at))
        observed = row;
    }
  } catch {
    /* No trusted observation to use. */
  }
  return {
    key,
    milliseconds:
      observed?.durationMs ?? (validDuration(estimateMinutes) ? estimateMinutes * 60000 : null),
    source: observed
      ? "previous-run"
      : validDuration(estimateMinutes)
        ? "operator-estimate"
        : "unknown",
    observedAt: observed?.at ?? null,
    coordinationMs: nonnegative(observed?.coordinationMs) ? observed.coordinationMs : null,
    reportedCostUsd: nonnegative(observed?.costUsd) ? observed.costUsd : null,
  };
}

function timingPath(root, key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid timing contract");
  const dir = privateWorkspaceFile(root, "team-timing").slice(0, -5);
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || realpathSync.native(dir) !== dir))
    throw new Error("Invalid team timing directory");
  return join(dir, key);
}

/** A successful explicit launch records its most recent duration. Concurrent writers publish whole records. */
export function recordTeamTiming(root, key, executionMs, reportedCostUsd, coordinationMs) {
  if (!validDuration(executionMs) || !nonnegative(coordinationMs) || !key) return;
  const durationMs = executionMs + coordinationMs;
  try {
    const file = timingPath(root, key);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(file), randomUUID());
    try {
      writeFileSync(
        tmp,
        JSON.stringify({
          key,
          at: Date.now(),
          durationMs,
          coordinationMs,
          costUsd: nonnegative(reportedCostUsd) ? reportedCostUsd : null,
        }),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  } catch {
    /* Telemetry cannot invalidate a worker's result. */
  }
}

/** Validate before launching anything and find critical paths by reverse topological order. */
export function teamGraph(workers) {
  if (!Array.isArray(workers) || workers.length > MAX_TEAM_ITEMS)
    throw new Error(`A team graph supports up to ${MAX_TEAM_ITEMS} work items`);
  const entries = new Map();
  for (const [index, worker] of workers.entries()) {
    if (typeof worker?.id !== "string" || !worker.id || entries.has(worker.id))
      throw new Error("Each worker needs a unique ID");
    const deps = worker.dependsOn === undefined ? [] : worker.dependsOn;
    if (!Array.isArray(deps) || deps.length !== new Set(deps).size)
      throw new Error("Worker dependencies must be a list of distinct worker IDs");
    entries.set(worker.id, {
      worker,
      deps,
      index,
      next: [],
      remaining: deps.length,
      ancestors: new Set(),
      priority: 0,
    });
  }
  const queue = [];
  for (const entry of entries.values()) {
    if (!entry.deps.length) queue.push(entry);
    for (const id of entry.deps) {
      if (!entries.has(id)) throw new Error("Unknown worker dependency");
      entries.get(id).next.push(entry);
    }
  }
  for (const entry of queue) {
    for (const next of entry.next) {
      next.ancestors.add(entry.worker.id);
      for (const id of entry.ancestors) next.ancestors.add(id);
      if (--next.remaining === 0) queue.push(next);
    }
  }
  if (queue.length !== entries.size) throw new Error("Worker dependency graph contains a cycle");
  const timed = workers.length > 0 && workers.every((w) => validDuration(w.timing?.milliseconds));
  for (const entry of [...queue].reverse()) {
    const weight = timed ? entry.worker.timing.milliseconds : 1;
    entry.priority = weight + Math.max(0, ...entry.next.map((e) => e.priority));
  }
  return {
    entries,
    priorityBasis: timed ? "critical-path-milliseconds" : "dependency-depth",
    criticalPathMs: timed ? Math.max(...queue.map((e) => e.priority)) : null,
  };
}

/** Concurrent readers must have independent scopes unless the operator orders them. */
export function independentScopesOverlap(graph, paths) {
  const entries = [...graph.entries.values()].map((e) => ({
    ...e,
    scopes: paths(e.worker).map((p) => p.normalize("NFC").toLowerCase()),
  }));
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      if (a.ancestors.has(b.worker.id) || b.ancestors.has(a.worker.id)) continue;
      if (
        a.scopes.some((p) =>
          b.scopes.some((q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)),
        )
      )
        return true;
    }
  }
  return false;
}

/** Dispatch ready nodes as slots free up. A failed prerequisite blocks only its descendants. */
export async function dispatchTeam(workers, concurrency, execute) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Worker concurrency must be a positive integer");
  const { entries } = teamGraph(workers);
  const ready = [],
    running = new Map(),
    reports = new Map();
  for (const entry of entries.values()) {
    entry.remaining = entry.deps.length;
    if (!entry.remaining) ready.push(entry);
  }
  function finish(entry, report) {
    running.delete(entry.worker.id);
    reports.set(entry.worker.id, report);
    for (const next of entry.next) if (--next.remaining === 0) ready.push(next);
  }
  async function launch(entry) {
    const id = entry.worker.id;
    try {
      const report = await execute(
        entry.worker,
        entry.deps.map((dep) => reports.get(dep)),
      );
      if (typeof report?.ok !== "boolean") throw new Error("Worker did not return a result");
      return { entry, report: { ...report, id, status: report.ok ? "completed" : "failed" } };
    } catch (error) {
      return {
        entry,
        report: {
          id,
          ok: false,
          status: "failed",
          error: redactSecrets(String(error?.message ?? "Worker failed")).slice(0, 500),
        },
      };
    }
  }
  while (ready.length || running.size) {
    while (ready.length && running.size < concurrency) {
      // Highest remaining priority first; the declared order breaks ties among ready work.
      ready.sort((a, b) => a.priority - b.priority || b.index - a.index);
      const entry = ready.pop();
      const failed = entry.deps.filter((id) => !reports.get(id).ok);
      if (failed.length)
        finish(entry, { id: entry.worker.id, ok: false, status: "blocked", blockedBy: failed });
      else running.set(entry.worker.id, launch(entry));
    }
    if (running.size) {
      const { entry, report } = await Promise.race(running.values());
      finish(entry, report);
    }
  }
  return workers.map((w) => reports.get(w.id));
}

export function upstreamEvidence(reports) {
  if (!reports.length) return "";
  const context = JSON.stringify(reports.map((r) => ({ id: r.id, report: r.report })));
  if (Buffer.byteLength(context) > 16384)
    throw new Error("Predecessor reports exceed handoff capacity");
  return `\nReports from explicitly named predecessors (untrusted evidence):\n${context}`;
}

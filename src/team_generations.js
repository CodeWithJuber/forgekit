// forge team generations — Recursive Collective Intelligence (He et al., arXiv 2611.32606 §3,
// §4.3–4.4, §7.1): "a group shows RCI when its own output, without a teacher or external labels,
// makes its next generation smarter at equal cost."
//
// forgekit trains no weights. What evolves is the team's ORGANIZATION, which §7.1 shows is worth
// writing down (an evolved organization prompt beat a rules-only one by 0.16; its examples are
// structural — "1,2,3 give all unused reading budget to 0"). A generation is a team PLAYBOOK for
// one task class, distilled only from the class's own VERIFIED forward runs:
//   - roles: keep a role only if it forwarded a fact in a verified run (tokens that bought no
//     information are pure cost — the paper's §8 rule);
//   - budgets: 1.25 × the most a role used in a verified run, never above its parent's (the
//     paper keeps "the shortest passing turn");
//   - hubOrder: roles by facts forwarded per token.
// It is STRUCTURE ONLY — never model-written prose (verified output is still untrusted text) —
// and deterministic: the same verified runs always give the same playbook.
//
// A candidate is released only through the paper's gate (§4.4): fresh confirmation tasks, paired
// by task, released iff the paired gain d ≥ 1.645·SE (else the round is "flat" and the parent
// stays), with health gates anchored at the parent. With an independent pool, d is the gain in the
// equal-budget margin Y − T(n_B), so a cheaper team at equal accuracy counts (Eq. 1); without one,
// d is the accuracy gain.
import { getCouncil, shapeDecision, trialArm, withGroup } from "./harness_council.js";
import { queueStore } from "./harness_jobs.js";
import { pairedOneSided, passAtBudget } from "./ladder.js";
import { checkFrozen } from "./rollout_eval.js";
import { contentHash } from "./util.js";

/** One-sided z for the release gate: d ≥ 1.645·SE (the paper's PlanBench rule). */
export const RELEASE_Z = 1.645;
/** A candidate may spend at most this multiple of its parent's mean tokens per task. */
export const TOKEN_HEALTH = 1.1;
/** Budget headroom over the most a role used in a verified run. */
export const BUDGET_HEADROOM = 1.25;
const CAPS = ["turns", "tokens", "milliseconds", "toolCalls", "costUsd"];
const genKey = (c) => `gen:${c}`;
const candidateKey = (c) => `gen-candidate:${c}`;

function taskClassOf(v) {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v))
    throw new Error("Invalid task class");
  return v;
}

/** Canonical JSON (keys sorted at every level), so a hash survives any store's key order. */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** A playbook's content address (every field but `hash`). */
export function playbookHash(p) {
  const { hash: _drop, ...rest } = p;
  return contentHash(canon(rest)).slice(0, 40);
}

/** A team's structure (roles, budgets, hub order) without its provenance: what a round judges. */
export function teamHash(p) {
  return contentHash(canon({ roles: p.roles, hubOrder: p.hubOrder })).slice(0, 40);
}
const sameTeam = (a, b) => teamHash(a) === teamHash(b);
/** Each team is judged once: re-trying a flat team on suite after suite until one passes would
 * spend the gate's 5% false-release chance again on every try. */
const judged = (current, p) => (current?.lineage ?? []).some((r) => r.team === teamHash(p));

/**
 * Distil the next playbook from verified forward delegation records (getCouncil). Pure.
 * @param {{taskClass: string, generation: number, parent?: any, records: any[],
 *   derivedFrom: {suites: string[], groups: string[]}}} input
 */
export function distillPlaybook({ taskClass, generation, parent = null, records, derivedFrom }) {
  /** @type {Map<string, any>} */
  const stats = new Map();
  for (const rec of records ?? [])
    for (const r of rec?.reports ?? []) {
      const s = stats.get(r.member) ?? {
        facts: 0,
        tokens: 0,
        max: { tokens: 0, milliseconds: 0, toolCalls: 0, costUsd: 0 },
        budget: null,
      };
      const u = r.usage ?? {};
      s.facts += Array.isArray(r.findings) ? r.findings.length : 0;
      s.tokens += Number(u.tokens) || 0;
      for (const k of Object.keys(s.max)) s.max[k] = Math.max(s.max[k], Number(u[k]) || 0);
      if (r.budget)
        s.budget = s.budget
          ? Object.fromEntries(CAPS.map((c) => [c, Math.min(s.budget[c], r.budget[c])]))
          : { ...r.budget };
      stats.set(r.member, s);
    }
  const parentRoles = new Map((parent?.roles ?? []).map((r) => [r.id, r.budget]));
  // Trim toward what verified runs used; a cap a role never reported stays as it was.
  const trim = (base, used, integer = true) => {
    if (!(used > 0)) return base;
    const want = integer
      ? Math.ceil(BUDGET_HEADROOM * used)
      : Math.round(BUDGET_HEADROOM * used * 1e6) / 1e6;
    return Math.min(base, integer ? Math.max(1, want) : want);
  };
  const roles = [...stats.entries()]
    .filter(([role, s]) => s.facts > 0 && (!parent || parentRoles.has(role)))
    .map(([role, s]) => {
      const base = parentRoles.get(role) ?? s.budget;
      if (!base) throw new Error(`Role ${role} has no recorded budget to start from`);
      return {
        id: role,
        budget: {
          turns: base.turns,
          tokens: trim(base.tokens, s.max.tokens),
          milliseconds: trim(base.milliseconds, s.max.milliseconds),
          toolCalls: s.max.toolCalls > 0 ? trim(base.toolCalls, s.max.toolCalls) : base.toolCalls,
          costUsd: trim(base.costUsd, s.max.costUsd, false),
        },
        perToken: s.facts / Math.max(1, s.tokens),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const hubOrder = [...roles]
    .sort((a, b) => b.perToken - a.perToken || (a.id < b.id ? -1 : 1))
    .map((r) => r.id);
  const playbook = {
    taskClass,
    generation,
    parent: parent?.hash ?? null,
    shape: "forward",
    roles: roles.map(({ id, budget }) => ({ id, budget })),
    hubOrder,
    derivedFrom: {
      suites: [...new Set(derivedFrom.suites)].sort(),
      groups: [...new Set(derivedFrom.groups)].sort(),
    },
  };
  return { ...playbook, hash: playbookHash(playbook) };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const r4 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);

/**
 * The release gate over paired rows. Pure.
 * @param {{parent: {accepted: boolean, tokens: number}, candidate: {accepted: boolean,
 *   tokens: number, wrongPackages?: number}, pool?: {accepted: boolean, tokens: number}[]}[]} rows
 */
export function releaseDecision(rows) {
  if (rows.length < 2) throw new Error("A release needs at least two paired tasks");
  const pooled = rows.filter((r) => Array.isArray(r.pool) && r.pool.length).length;
  if (pooled && pooled !== rows.length)
    throw new Error("Give every confirmation task an independent pool, or none");
  const acc = (a) => (a.accepted ? 1 : 0);
  const tokP = mean(rows.map((r) => r.parent.tokens));
  const tokC = mean(rows.map((r) => r.candidate.tokens));
  let d;
  let basis;
  let nB = null;
  if (pooled) {
    const pool = rows.flatMap((r) => r.pool);
    const c1 = pool.reduce((s, a) => s + a.tokens, 0) / pool.length;
    if (!(c1 > 0)) throw new Error("Pool runs report zero tokens");
    nB = { parent: tokP / c1, candidate: tokC / c1 };
    const need = Math.ceil(Math.max(1, nB.parent, nB.candidate));
    if (rows.some((r) => r.pool.length < need))
      throw new Error(`Each task needs at least ${need} independent runs to judge the margin`);
    d = rows.map((r) => {
      const m = r.pool.length;
      const k = r.pool.filter((a) => a.accepted).length;
      return (
        acc(r.candidate) -
        passAtBudget(m, k, nB.candidate) -
        (acc(r.parent) - passAtBudget(m, k, nB.parent))
      );
    });
    basis = "equal-budget margin";
  } else {
    d = rows.map((r) => acc(r.candidate) - acc(r.parent));
    basis = "accuracy";
  }
  const gain = pairedOneSided(d);
  const accuracy = pairedOneSided(rows.map((r) => acc(r.candidate) - acc(r.parent)));
  const significant = (t) => t.mean > 0 && (t.se === 0 || t.mean >= RELEASE_Z * t.se);
  const health = {
    tokens: tokC <= TOKEN_HEALTH * tokP,
    accuracy: !(
      accuracy.mean < 0 &&
      (accuracy.se === 0 || accuracy.mean <= -RELEASE_Z * accuracy.se)
    ),
    wrongPackages: rows.every((r) => !(r.candidate.wrongPackages > 0)),
  };
  const released = significant(gain) && health.tokens && health.accuracy && health.wrongPackages;
  const reason = released
    ? `paired ${basis} gain ${r4(gain.mean)} ≥ ${RELEASE_Z}·SE (${r4(RELEASE_Z * (gain.se ?? 0))})`
    : !significant(gain)
      ? `paired ${basis} gain ${r4(gain.mean)} is below ${RELEASE_Z}·SE (${r4(RELEASE_Z * (gain.se ?? 0))}) — flat`
      : !health.tokens
        ? `health: the candidate spends ${r4(tokC / tokP)}× its parent's tokens (limit ${TOKEN_HEALTH}) — flat`
        : !health.accuracy
          ? "health: the candidate loses accuracy significantly — flat"
          : "health: the candidate pulled in wrong packages — flat";
  return {
    released,
    basis,
    gain: r4(gain.mean),
    se: r4(gain.se),
    threshold: r4(RELEASE_Z * (gain.se ?? 0)),
    accuracy: {
      parent: r4(mean(rows.map((r) => acc(r.parent)))),
      candidate: r4(mean(rows.map((r) => acc(r.candidate)))),
    },
    tokens: { parent: r4(tokP), candidate: r4(tokC) },
    nB: nB && { parent: r4(nB.parent), candidate: r4(nB.candidate) },
    health,
    reason,
  };
}

/** The class's current generation record (released or flat), or null at the base team. */
export function currentGeneration(root, taskClass) {
  return queueStore(root, "decision", { shape: genKey(taskClassOf(taskClass)) });
}

/**
 * Distil and store the next candidate from the current generation's verified team runs (at the
 * base team: the latest forward shape trial's accepted candidate arms). Never releases.
 * @param {string} root
 * @param {string} taskClass
 */
export function proposeGeneration(root, taskClass) {
  const cls = taskClassOf(taskClass);
  const current = currentGeneration(root, cls);
  let groups;
  let suites;
  if (current) {
    groups = current.verifiedGroups ?? [];
    suites = current.suites ?? [];
  } else {
    const trial = shapeDecision(root, "forward", cls);
    if (!Array.isArray(trial?.pairedEvidence))
      throw new Error(
        `No forward shape trial for class ${cls}: record one first (forge harness council trial forward …)`,
      );
    groups = trial.pairedEvidence
      .filter((p) => p.candidate?.accepted && p.candidate?.group)
      .map((p) => p.candidate.group);
    suites = [trial.evaluation.suiteHash];
  }
  if (!groups.length) throw new Error("No verified team run to learn from");
  const records = groups.map((g) => getCouncil(root, g)).filter((r) => r?.shape === "forward");
  const parent = current?.playbook ?? null;
  const candidate = distillPlaybook({
    taskClass: cls,
    generation: (current?.generation ?? 0) + 1,
    parent,
    records,
    derivedFrom: { suites, groups },
  });
  if (candidate.roles.length < 2)
    return {
      candidate: null,
      reason: "One worker carries all the verified information: a single agent is the cheaper bet.",
    };
  if (parent && sameTeam(candidate, parent))
    return {
      candidate: null,
      reason: "Nothing left to learn: the verified runs give the current playbook back.",
    };
  if (judged(current, candidate))
    return {
      candidate: null,
      reason:
        "The verified runs give back a team already judged flat: gather more verified runs first.",
    };
  queueStore(root, "trial", {
    shape: candidateKey(cls),
    hash: candidate.hash,
    now: Date.now(),
    value: candidate,
  });
  return { candidate };
}

/**
 * Judge the pending candidate on a FRESH confirmation suite, paired by task: each task's
 * `parent` and `candidate` arms are a lead `run:` receipt plus the `group:` forward delegation that
 * ran that arm's playbook; `pool` (optional, every task or none) holds independent runs.
 * Released → the candidate becomes the class's playbook; flat → the parent stays. Either way the
 * round joins the lineage, and the suite can judge no other round.
 * @param {string} root
 * @param {string} taskClass
 * @param {any} frozen a frozen suite (freezeSuite)
 * @param {{suiteHash: string, source: string, runs: any[]}} measurements
 */
export function releaseGeneration(root, taskClass, frozen, measurements) {
  const cls = taskClassOf(taskClass);
  const { spec, hash: suite } = checkFrozen(frozen);
  const current = currentGeneration(root, cls);
  const candidate = queueStore(root, "decision", { shape: candidateKey(cls) });
  const parent = current?.playbook ?? null;
  if (!candidate || candidate.parent !== (parent?.hash ?? null) || judged(current, candidate))
    throw new Error(
      "No pending candidate for the current playbook: run `generation propose` first",
    );
  const seen = new Set([...(candidate.derivedFrom?.suites ?? []), ...(current?.suites ?? [])]);
  if (seen.has(suite))
    throw new Error(
      "The confirmation suite must be fresh: it already informed or judged this lineage",
    );
  if (
    measurements?.suiteHash !== suite ||
    measurements.source !== "observed" ||
    !Array.isArray(measurements.runs) ||
    measurements.runs.length !== spec.tasks.length
  )
    throw new Error("Supply observed paired runs for every task of the frozen suite");
  const tasks = new Map(spec.tasks.map((t) => [t.id, t]));
  const used = new Set();
  const rows = measurements.runs.map((r) => {
    const task = tasks.get(r?.id);
    if (!task) throw new Error(`Unknown confirmation task ${r?.id}`);
    const arm = (a, expect, label) => {
      const rec = a?.group ? getCouncil(root, a.group) : null;
      if (!rec || (rec.playbook ?? null) !== expect)
        throw new Error(
          `Task ${r.id}: the ${label} arm must be a team run of the ${label} playbook`,
        );
      return withGroup(root, trialArm(root, a, task, used), task);
    };
    return {
      id: r.id,
      parent: arm(r.parent, parent?.hash ?? null, "parent"),
      candidate: arm(r.candidate, candidate.hash, "candidate"),
      groups: { parent: r.parent.group, candidate: r.candidate.group },
      ...(Array.isArray(r.pool) && r.pool.length
        ? { pool: r.pool.map((a) => trialArm(root, a, task, used)) }
        : {}),
    };
  });
  const verdict = releaseDecision(rows);
  const round = {
    generation: candidate.generation,
    candidate: candidate.hash,
    team: teamHash(candidate),
    outcome: verdict.released ? "released" : "flat",
    suite,
    ...verdict,
  };
  const lineage = [...(current?.lineage ?? []), round];
  const suites = [...new Set([...seen, suite])].sort();
  const value = verdict.released
    ? {
        taskClass: cls,
        generation: candidate.generation,
        playbook: candidate,
        outcome: "released",
        round,
        lineage,
        suites,
        verifiedGroups: rows
          .filter((r) => r.candidate.accepted)
          .map((r) => r.groups.candidate)
          .sort(),
        // §4.4: recursion is claimed only after two consecutive improvements over the base. The
        // distillation is deterministic, so the paper's non-recursive control (the recipe applied
        // once to base runs) IS generation 1 — G2 beating G1 is G2 beating that control.
        recursive: candidate.generation >= 2,
      }
    : {
        taskClass: cls,
        generation: current?.generation ?? 0,
        playbook: parent,
        outcome: "flat",
        round,
        lineage,
        suites,
        verifiedGroups: [
          ...new Set([
            ...(current?.verifiedGroups ?? candidate.derivedFrom.groups),
            ...rows.filter((r) => r.parent.accepted).map((r) => r.groups.parent),
          ]),
        ].sort(),
        recursive: current?.recursive ?? false,
      };
  return queueStore(root, "trial", { shape: genKey(cls), hash: suite, now: Date.now(), value });
}

/** The class's generations: the current playbook, the pending candidate, the lineage. */
export function generationStatus(root, taskClass) {
  const cls = taskClassOf(taskClass);
  const current = currentGeneration(root, cls);
  const candidate = queueStore(root, "decision", { shape: candidateKey(cls) });
  const pending =
    candidate &&
    candidate.parent === (current?.playbook?.hash ?? null) &&
    !judged(current, candidate)
      ? candidate
      : null;
  return {
    taskClass: cls,
    generation: current?.generation ?? 0,
    playbook: current?.playbook ?? null,
    recursive: current?.recursive ?? false,
    pending,
    lineage: current?.lineage ?? [],
  };
}

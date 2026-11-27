// Replay engine: answer a repeated request from verified experience, without a model call, only
// where the evidence supports it. Everything else is handed back to the teacher (the model), and
// the teacher's verified trace becomes new evidence.
//
// Decision rule for one step with effect class e:
//   replay beats the teacher when p > q*(e) = (L_e + c_replay) / (L_e + c_teacher),
// where p is the probability the replayed step is right, L_e the owner's loss for a wrong step of
// that class, and c the two costs. The engine replays only when an anytime-valid lower bound on p
// is at least q*. The bound may be inspected after every observation without losing validity.
// Evidence is tied to the hash of the step template: a changed template starts from zero.

import { anytimeLower, EDetector } from "../mathcore/sequential.js";
import {
  addOutputs,
  chooseChild,
  induceFamily,
  instantiate,
  readRequest,
  runtimeSources,
} from "./induce.js";
import { canonical, constantCount, shapeKey, trigramCosine, words } from "./tokens.js";

export class ReplayEngine {
  /**
   * @param {{alpha:number, detectorAlpha?:number, minSupport?:number, maxExamples?:number,
   *   costs:{teacher:number, replay:number},
   *   loss:{pure:number, read:number, write:number}}} options
   */
  constructor({ alpha, detectorAlpha = alpha, minSupport = 2, maxExamples = 64, costs, loss }) {
    if (!(alpha > 0 && alpha < 1)) throw new Error("need 0 < alpha < 1");
    if (!(costs?.teacher > costs?.replay && costs.replay >= 0))
      throw new Error("teacher must cost more than replay");
    for (const e of ["pure", "read", "write"])
      if (!(loss?.[e] >= 0)) throw new Error(`set a loss for ${e} steps`);
    this.alpha = alpha;
    this.detectorAlpha = detectorAlpha;
    this.minSupport = minSupport;
    this.maxExamples = maxExamples;
    this.costs = costs;
    this.loss = loss;
    /** @type {{id: string, examples: any[], model: any}[]} */
    this.families = [];
    /** @type {Map<string, {hash: string, s: number, f: number, retired: boolean, detector: EDetector|null}>} */
    this.stats = new Map();
    this.nextId = 1;
  }

  /** Smallest success probability at which replaying a step of this effect class pays. */
  threshold(effect) {
    if (effect === "irreversible") return Infinity; // authority, not optimization
    const L = this.loss[effect];
    return (L + this.costs.replay) / (L + this.costs.teacher);
  }

  statFor(family, node) {
    const key = `${family.id}${node.pathKey}`;
    let row = this.stats.get(key);
    if (!row || row.hash !== node.hash) {
      row = { hash: node.hash, s: 0, f: 0, retired: false, detector: null };
      this.stats.set(key, row);
    }
    return row;
  }

  /** Count one verified outcome for a step. Returns true when the step was retired by it. */
  record(family, node, ok) {
    const row = this.statFor(family, node);
    if (ok) row.s++;
    else row.f++;
    const floor = this.threshold(node.effect);
    if (!(floor > 0 && floor < 1)) return false;
    row.detector ??= new EDetector({ floor, alpha: this.detectorAlpha });
    if (!row.detector.update(ok ? 1 : 0)) return false;
    // The step stopped behaving as it did. Its evidence is void, and the examples that taught it
    // describe a world that has changed, so they are dropped and the step is learned again.
    Object.assign(row, { s: 0, f: 0, retired: true, detector: null });
    const stale = new Set(node.rows);
    family.examples = family.examples.filter((_, i) => !stale.has(i));
    family.model = family.examples.length
      ? induceFamily(family.examples, { minSupport: this.minSupport })
      : null;
    if (!family.model) this.families = this.families.filter((f) => f !== family);
    return true;
  }

  /** Why this step cannot run now, or null when it may. */
  blocker(family, node, values) {
    if (!node.closed) return "argument_without_source";
    if (node.support < this.minSupport && !node.seen.has(canonical(values)))
      return "seen_too_rarely_to_generalize";
    const floor = this.threshold(node.effect);
    if (floor === Infinity) return "needs_confirmation";
    const row = this.statFor(family, node);
    if (anytimeLower(row.s, row.f, this.alpha) < floor)
      return row.retired ? "retired_until_reverified" : "not_enough_evidence";
    return null;
  }

  /** Families a request is an instance of, most specific first. */
  matches(intent, strict) {
    return this.families
      .map((family) => ({ family, read: readRequest(family.model, intent, { strict }) }))
      .filter((m) => m.read.values)
      .sort(
        (a, b) =>
          constantCount(b.family.model.pattern) - constantCount(a.family.model.pattern) ||
          a.family.id.localeCompare(b.family.id),
      );
  }

  /**
   * Add one verified teacher trace. If the request already matches a family, the trace first tests
   * that family's current predictions (test, then train), which is where the evidence comes from.
   */
  learn(trace) {
    if (trace.outcome !== "verified") throw new Error("only verified traces are evidence");
    const example = { intent: trace.intent, env: trace.env ?? {}, steps: trace.steps };
    const [hit] = this.matches(trace.intent, false);
    if (hit) {
      const shadow = readRequest(hit.family.model, trace.intent).values
        ? this.shadow(hit.family, hit.read.values, example)
        : { tested: 0 };
      const model = induceFamily([...hit.family.examples, example], {
        minSupport: this.minSupport,
      });
      if (model && !shadow.retired) {
        hit.family.examples.push(example);
        hit.family.model = model;
        this.trim(hit.family);
        return { family: hit.family.id, how: "extended", shadow };
      }
    }
    for (const family of this.families) {
      const model = induceFamily([...family.examples, example], { minSupport: this.minSupport });
      if (!model) continue;
      const first = model.root.children.find((c) => c.rows.includes(family.examples.length));
      if (!first || first.end || !first.closed || first.support < 2) continue;
      family.examples.push(example);
      family.model = model;
      this.trim(family);
      return { family: family.id, how: "merged", shadow: { tested: 0 } };
    }
    const family = {
      id: `f${this.nextId++}`,
      examples: [example],
      model: induceFamily([example], { minSupport: this.minSupport }),
    };
    if (!family.model) throw new Error("a request needs at least one word");
    this.families.push(family);
    return { family: family.id, how: "created", shadow: { tested: 0 } };
  }

  /** Keep a bounded window of recent examples so contradicted history ages out. */
  trim(family) {
    if (family.examples.length <= this.maxExamples) return;
    const kept = family.examples.slice(-this.maxExamples);
    const model = induceFamily(kept, { minSupport: this.minSupport });
    if (model) Object.assign(family, { examples: kept, model });
  }

  /** Compare what the engine would have done with what the verified teacher did. */
  shadow(family, values, example) {
    const runtime = runtimeSources(values, example.env);
    let node = family.model.root;
    let tested = 0;
    for (let depth = 0; ; depth++) {
      const child = chooseChild(node, runtime);
      if (!child) return { tested, stopped: "undetermined_branch" };
      const step = example.steps[depth];
      if (child.end) {
        const ok = !step;
        const retired = node.children.length > 1 && this.record(family, child, ok);
        return { tested, agreed: ok, retired };
      }
      if (!step) {
        const retired = this.record(family, child, false);
        return { tested: tested + 1, agreed: false, at: depth, retired };
      }
      if (!child.closed) return { tested, stopped: "argument_without_source" };
      if (child.support < this.minSupport && !child.seen.has(canonical(values)))
        return { tested, stopped: "seen_too_rarely_to_generalize" };
      const made = instantiate(child, runtime);
      const ok =
        !made.missing &&
        shapeKey(step) === child.shape &&
        canonical(made.args) === canonical(step.args ?? {});
      const retired = this.record(family, child, ok);
      tested++;
      if (!ok) return { tested, agreed: false, at: depth, retired };
      addOutputs(runtime, depth, step.out);
      node = child;
    }
  }

  /** Start answering a request. Returns a Run, or a miss with the closest family as a hint only. */
  begin(intent, env = {}) {
    const [hit] = this.matches(intent, true);
    if (hit) return new Run(this, hit.family, hit.read.values, env);
    let hint = null;
    for (const family of this.families)
      for (const e of family.examples) {
        const score = trigramCosine(intent, e.intent);
        if (!hint || score > hint.score) hint = { family: family.id, score };
      }
    return { state: "miss", hint: words(intent).length ? hint : null };
  }
}

export class Run {
  /**
   * @param {ReplayEngine} engine
   * @param {{id: string, examples: any[], model: any}} family
   * @param {string[]} values
   * @param {unknown} env
   */
  constructor(engine, family, values, env) {
    this.engine = engine;
    this.family = family;
    this.values = values;
    this.state = "ready";
    this.runtime = runtimeSources(values, env);
    /** @type {any} */
    this.node = family.model.root;
    /** @type {{tool: string, depth: number}[]} */
    this.executed = [];
    /** @type {any} */
    this.pending = null;
  }

  /** { action: "execute", tool, args, effect } | { action: "handoff", reason } | { action: "done" } */
  next() {
    if (this.pending) throw new Error("report the previous step first");
    if (this.state === "failed") return this.handoff("step_failed");
    const child = chooseChild(this.node, this.runtime);
    if (!child) return this.handoff("undetermined_branch");
    if (child.end && this.node.children.length === 1)
      return { action: "done", executed: this.executed.length };
    const reason = this.engine.blocker(this.family, child, this.values);
    if (reason) return this.handoff(reason);
    if (child.end) return { action: "done", executed: this.executed.length };
    const made = instantiate(child, this.runtime);
    if (made.missing) return this.handoff("missing_source");
    this.pending = child;
    return { action: "execute", tool: child.tool, args: made.args, effect: child.effect };
  }

  /** Tell the engine what happened. `verified` must come from a check independent of the engine. */
  report({ out, verified }) {
    if (!this.pending) throw new Error("no step is waiting for a report");
    const node = this.pending;
    this.pending = null;
    const retired = this.engine.record(this.family, node, Boolean(verified));
    if (!verified) {
      this.state = "failed";
      return { retired };
    }
    addOutputs(this.runtime, node.depth, out);
    this.executed.push({ tool: node.tool, depth: node.depth });
    this.node = node;
    return { retired: false };
  }

  handoff(reason) {
    return { action: "handoff", reason, executed: this.executed.length };
  }
}

/**
 * Upper limit on the share of requests replay can serve: a family with m requests must first earn
 * its gate on `streak` teacher runs. Run this on real logs before building anything.
 */
export function replayOpportunity(requestsPerFamily, streak) {
  const total = requestsPerFamily.reduce((a, b) => a + b, 0);
  const served = requestsPerFamily.reduce((a, m) => a + Math.max(0, m - streak), 0);
  return total ? served / total : 0;
}

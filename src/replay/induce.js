// Induce a replayable procedure from verified traces of one intent family.
//
// The intents and the traces are generalized together. A value that varies across examples is a
// variable, and two positions hold the same variable exactly when their values agree in every
// example. That one rule yields the mapping from request to steps: a step argument is bound to a
// request slot, to the environment, or to an earlier step's output, when its column of values is
// explained by that source in every example.
//
// Provenance closure. A step is closed when each of its arguments is a constant or a deterministic
// function of sources available before the step runs. Only closed steps can run without a model.
// An argument with no source was invented by the model or came from context the trace did not
// record, and the engine hands that step back.
//
// The step structure is a prefix tree of observed step shapes, so every path the engine can follow
// is a path some verified trace took. A first-order step graph can splice halves of different
// traces into a sequence nobody verified. A prefix tree cannot.

import { createHash } from "node:crypto";
import {
  accepts,
  canonical,
  constantCount,
  fine,
  flatten,
  generalize,
  matchPattern,
  patternOf,
  shapeKey,
  slotCount,
  typeOf,
  unflatten,
  words,
} from "./tokens.js";

const SEVERITY = { pure: 0, read: 1, write: 2, irreversible: 3 };
const TRANSFORMS = {
  id: (s) => s,
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
};

export function applyTransform(name, value) {
  if (name === "number") return Number(value);
  return TRANSFORMS[name](String(value));
}

function render(parts, candidatesByKey, row) {
  let text = "";
  for (const part of parts)
    text +=
      part.lit !== undefined ? part.lit : candidatesByKey.get(`${part.src}|${part.f}`).values[row];
  return text;
}

/**
 * Explain a column of strings as one template over the sources. Candidate templates are read off
 * one example, preferring a source wherever its value occurs, and a template is accepted only if
 * rendering it with every example's own source values reproduces that example's string exactly.
 * The check by rendering is what makes coincidences harmless: a value that only happens to occur
 * in one example fails on the others and the search falls back to a literal.
 */
function induceString(column, sources, rows) {
  const candidates = [];
  for (const src of sources) {
    const raw = rows.map((r) => src.values.get(r));
    if (raw.some((v) => v === undefined || (typeof v !== "string" && typeof v !== "number")))
      continue;
    for (const f of Object.keys(TRANSFORMS)) {
      const values = raw.map((v) => TRANSFORMS[f](String(v)));
      if (values.some((v) => !v)) continue;
      if (f !== "id" && values.every((v, i) => v === String(raw[i]))) continue;
      if (values.every((v, i) => column[i].includes(v)))
        candidates.push({ name: src.name, f, values });
    }
  }
  if (!candidates.length) return { free: true };
  const byKey = new Map(candidates.map((c) => [`${c.name}|${c.f}`, c]));
  let budget = 400;
  for (let base = 0; base < Math.min(column.length, 4); base++) {
    const toks = fine(column[base]);
    const needles = candidates
      .map((c) => ({ c, toks: fine(c.values[base]) }))
      .sort((x, y) => y.toks.length - x.toks.length);
    const parts = [];
    const search = (i) => {
      if (budget-- <= 0) return null;
      if (i === toks.length) {
        const merged = [];
        for (const p of parts) {
          if (p.lit !== undefined && merged.length && merged[merged.length - 1].lit !== undefined)
            merged[merged.length - 1].lit += p.lit;
          else merged.push({ ...p });
        }
        if (!merged.some((p) => p.src)) return null;
        return column.every((text, row) => render(merged, byKey, row) === text) ? merged : null;
      }
      for (const n of needles) {
        if (!n.toks.every((t, k) => toks[i + k] === t)) continue;
        parts.push({ src: n.c.name, f: n.c.f });
        const found = search(i + n.toks.length);
        parts.pop();
        if (found) return found;
      }
      parts.push({ lit: toks[i] });
      const found = search(i + 1);
      parts.pop();
      return found;
    };
    const found = search(0);
    if (found) return { parts: found };
  }
  return { free: true };
}

function induceLeaf(column, kind, sources, rows) {
  if (column.every((v) => canonical(v) === canonical(column[0]))) return { lit: column[0] };
  if (kind === "s") return induceString(column, sources, rows);
  for (const src of sources) {
    const raw = rows.map((r) => src.values.get(r));
    if (raw.some((v) => v === undefined)) continue;
    if (raw.every((v, i) => v === column[i])) return { src: src.name, f: "id" };
    if (
      kind === "n" &&
      raw.every((v, i) => typeof v === "string" && v.trim() !== "" && Number(v) === column[i])
    )
      return { src: src.name, f: "number" };
  }
  return { free: true };
}

function sourceOrder(a, b) {
  const rank = { out: 0, env: 1, in: 2 };
  return (
    rank[a.kind] - rank[b.kind] || (b.depth ?? 0) - (a.depth ?? 0) || (a.name < b.name ? -1 : 1)
  );
}

function induceGuard(children, sources, minSupport) {
  if (children.length < 2) return null;
  if (children.some((c) => c.rows.length < minSupport)) return null;
  for (const src of [...sources].sort(sourceOrder)) {
    const table = {};
    let ok = true;
    for (const child of children) {
      const seen = new Set(
        child.rows
          .map((r) => src.values.get(r))
          .map((v) => (v === undefined ? undefined : String(v))),
      );
      if (seen.size !== 1 || seen.has(undefined)) ok = false;
      else {
        const [value] = seen;
        if (value in table) ok = false;
        else table[value] = child.key;
      }
      if (!ok) break;
    }
    if (ok) return { src: src.name, table };
  }
  return null;
}

/** Slot numbers are positional. Renumbering them is not a change to what a step does. */
function renamed(text) {
  const order = new Map();
  return text.replace(/in:(\d+)/g, (_, k) => {
    if (!order.has(k)) order.set(k, order.size);
    return `in:#${order.get(k)}`;
  });
}

function hashOf(value) {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 16);
}

function makeNode(examples, rows, depth, sources, prefix, shape, key) {
  const steps = rows.map((r) => examples[r].steps[depth]);
  const leaves = steps.map((s) => flatten(s.args ?? {}));
  const template = leaves[0].map((leaf, j) => ({
    path: leaf.path,
    kind: leaf.kind,
    t: induceLeaf(
      leaves.map((row) => row[j].v),
      leaf.kind,
      sources,
      rows,
    ),
  }));
  const outs = steps.map(
    (s) => new Map(flatten(s.out ?? {}).map((l) => [JSON.stringify(l.path), l])),
  );
  const outSources = [];
  for (const [p, leaf] of outs[0]) {
    if (!["s", "n", "b"].includes(leaf.kind)) continue;
    if (!outs.every((o) => o.has(p) && o.get(p).kind === leaf.kind)) continue;
    outSources.push({
      name: `out:${depth}:${p}`,
      kind: "out",
      depth,
      values: new Map(rows.map((r, i) => [r, outs[i].get(p).v])),
    });
  }
  const effect = steps
    .map((s) => s.effect ?? "write")
    .reduce((a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b));
  const pathKey = `${prefix}/${hashOf(key)}`;
  return {
    key,
    shape,
    pathKey,
    depth,
    tool: steps[0].tool,
    effect,
    template,
    closed: template.every((leaf) => !leaf.t.free),
    rows,
    support: rows.length,
    after: [...sources, ...outSources],
    hash: hashOf(renamed(canonical([key, template.map((l) => l.t)]))),
  };
}

/** Same step shape, different constants: look for one observed value that explains the split. */
function splitByEvidence(examples, rows, depth, sources, opts, prefix, shape) {
  for (const src of [...sources].sort(sourceOrder)) {
    const parts = new Map();
    for (const r of rows) {
      const v = src.values.get(r);
      if (v === undefined) {
        parts.clear();
        break;
      }
      if (!parts.has(String(v))) parts.set(String(v), []);
      parts.get(String(v)).push(r);
    }
    if (parts.size < 2 || [...parts.values()].some((p) => p.length < opts.minSupport)) continue;
    const nodes = [...parts.keys()]
      .sort()
      .map((v) =>
        makeNode(
          examples,
          parts.get(v),
          depth,
          sources,
          prefix,
          shape,
          `${shape}#${src.name}=${v}`,
        ),
      );
    if (nodes.every((n) => n.closed)) return nodes;
  }
  return null;
}

function buildChildren(examples, rows, depth, sources, opts, prefix) {
  const groups = new Map();
  for (const r of rows) {
    const step = examples[r].steps[depth];
    const key = step ? shapeKey(step) : "END";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  /** @type {any[]} */
  const children = [];
  for (const shape of [...groups.keys()].sort()) {
    const mine = groups.get(shape);
    if (shape === "END") {
      children.push({
        key: "END",
        shape,
        pathKey: `${prefix}/${hashOf("END")}`,
        depth,
        end: true,
        closed: true,
        template: [],
        rows: mine,
        support: mine.length,
        children: [],
        hash: hashOf("END"),
      });
      continue;
    }
    const whole = makeNode(examples, mine, depth, sources, prefix, shape, shape);
    const nodes = whole.closed
      ? [whole]
      : (splitByEvidence(examples, mine, depth, sources, opts, prefix, shape) ?? [whole]);
    for (const node of nodes) {
      node.children = buildChildren(examples, node.rows, depth + 1, node.after, opts, node.pathKey);
      node.guard = induceGuard(node.children, node.after, opts.minSupport);
      delete node.after;
      children.push(node);
    }
  }
  // Stopping early is as consequential as the step it skips.
  const worst = children
    .filter((c) => !c.end)
    .map((c) => c.effect)
    .reduce((a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b), "pure");
  for (const c of children) if (c.end) c.effect = worst;
  return children;
}

function walkNodes(node, visit) {
  for (const child of node.children) {
    visit(child, node);
    walkNodes(child, visit);
  }
}

/**
 * Returns the induced family, or null when the examples cannot share one request pattern
 * (no shared constant, or some example can be read in more than one way).
 */
export function induceFamily(examples, { minSupport = 2 } = {}) {
  if (!examples.length) return null;
  const tokenRows = examples.map((e) => words(e.intent));
  let pattern = patternOf(tokenRows[0]);
  for (const toks of tokenRows.slice(1)) pattern = generalize(pattern, toks);
  if (constantCount(pattern) === 0) return null;
  const bindings = [];
  for (const toks of tokenRows) {
    const found = matchPattern(pattern, toks, 2);
    if (found.length !== 1) return null;
    bindings.push(found[0]);
  }
  const rows = examples.map((_, i) => i);
  const sources = [];
  for (let k = 0; k < slotCount(pattern); k++)
    sources.push({
      name: `in:${k}`,
      kind: "in",
      values: new Map(rows.map((r) => [r, bindings[r][k]])),
    });
  const envs = examples.map(
    (e) => new Map(flatten(e.env ?? {}).map((l) => [JSON.stringify(l.path), l])),
  );
  for (const [p, leaf] of envs[0]) {
    if (!["s", "n", "b"].includes(leaf.kind)) continue;
    if (!envs.every((m) => m.has(p) && m.get(p).kind === leaf.kind)) continue;
    sources.push({
      name: `env:${p}`,
      kind: "env",
      values: new Map(rows.map((r) => [r, envs[r].get(p).v])),
    });
  }
  const root = { key: "ROOT", pathKey: "", rows, children: [] };
  root.children = buildChildren(examples, rows, 0, sources, { minSupport }, "");
  root.guard = induceGuard(root.children, sources, minSupport);
  const used = new Set();
  const note = (name) => name.startsWith("in:") && used.add(Number(name.slice(3)));
  if (root.guard) note(root.guard.src);
  walkNodes(root, (node) => {
    if (node.guard) note(node.guard.src);
    for (const leaf of node.template ?? []) {
      if (leaf.t.src) note(leaf.t.src);
      for (const part of leaf.t.parts ?? []) if (part.src) note(part.src);
    }
    // Which request readings reached this node. Used for nodes seen too rarely to generalize.
    node.seen = new Set(node.rows.map((r) => canonical(bindings[r])));
  });
  const slots = [];
  for (let k = 0; k < slotCount(pattern); k++) {
    const values = bindings.map((b) => b[k]);
    slots.push(
      used.has(k)
        ? { used: true, type: typeOf(values) }
        : { used: false, allowed: new Set(values) },
    );
  }
  return { pattern, slots, root, size: examples.length };
}

/** Read a request against a family. Returns the slot values, or a reason it does not apply. */
export function readRequest(family, intent, { strict = true } = {}) {
  const found = matchPattern(family.pattern, words(intent), 2);
  if (found.length === 0) return { reason: "no_match" };
  if (found.length > 1) return { reason: "ambiguous" };
  const values = found[0];
  if (strict)
    for (let k = 0; k < values.length; k++) {
      const slot = family.slots[k];
      if (slot.used ? !accepts(slot.type, values[k]) : !slot.allowed.has(values[k]))
        return { reason: "slot_out_of_type" };
    }
  return { values };
}

/** Fill a step template from the sources known at run time. */
export function instantiate(node, runtime) {
  const leaves = [];
  for (const leaf of node.template) {
    const t = leaf.t;
    let v;
    if ("lit" in t) v = t.lit;
    else if (t.parts) {
      v = "";
      for (const part of t.parts) {
        if (part.lit !== undefined) v += part.lit;
        else {
          if (!runtime.has(part.src)) return { missing: part.src };
          v += applyTransform(part.f, runtime.get(part.src));
        }
      }
    } else if (t.src) {
      if (!runtime.has(t.src)) return { missing: t.src };
      v = t.f === "number" ? Number(runtime.get(t.src)) : runtime.get(t.src);
    } else return { missing: "free_argument" };
    leaves.push({ path: leaf.path, v });
  }
  if (!leaves.length) return { args: {} };
  return { args: unflatten(leaves) };
}

/** Next node from the current one, or undefined when the observed evidence cannot decide. */
export function chooseChild(node, runtime) {
  if (node.children.length === 1) return node.children[0];
  if (!node.guard || !runtime.has(node.guard.src)) return undefined;
  const key = node.guard.table[String(runtime.get(node.guard.src))];
  return node.children.find((c) => c.key === key);
}

export function runtimeSources(values, env) {
  const runtime = new Map(values.map((v, k) => [`in:${k}`, v]));
  for (const leaf of flatten(env ?? {})) runtime.set(`env:${JSON.stringify(leaf.path)}`, leaf.v);
  return runtime;
}

export function addOutputs(runtime, depth, out) {
  for (const leaf of flatten(out ?? {}))
    runtime.set(`out:${depth}:${JSON.stringify(leaf.path)}`, leaf.v);
}

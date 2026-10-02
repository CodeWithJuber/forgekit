// forge orchestration — the agent-orchestration rule pack and the routing policy for unattended
// agents, both authored once in source/orchestration.json and switched on/off per person and per
// repo. Precedence, key by key: the pack's defaults < the user-level config
// (`<userStateDir>/forge.config.json`) < the repo's `.forge/forge.config.json`. A rule switched
// off disappears from AGENTS.md (and so from every tool that reads it) on the next `forge sync`.
//
// Config shape (both files; every key optional):
//   "orchestration": { "enabled": true, "rules": { "orch.no-polling": false }, "parallelCap": 3 }
//   "route": { "mode": "unattended", "topTier": "never", "raiseConfidence": 0.9,
//              "midConfidence": 0.5, "writesCodeFloor": true, "riskFloor": true,
//              "riskCategories": { "money": ["payment", …], "billing-ops": ["ledger"] } }
// `riskCategories` replaces a category's keyword list when named (an empty list or false turns
// that category off) and adds any category the defaults lack.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import {
  readForgeConfig,
  readUserConfig,
  writeForgeConfig,
  writeUserConfig,
} from "./repo_config.js";

/** The routing modes. `conservative` is the router as it always was. */
export const ROUTE_MODES = ["conservative", "unattended"];
/** When the top tier may be chosen: never; with --allow-top (and the score at its cutoff); or by score alone. */
export const TOP_TIER_GATES = ["never", "explicit", "auto"];

let packCache = null;

/** The shipped pack (source/orchestration.json), parsed once per process. */
export function loadPack() {
  if (!packCache)
    packCache = JSON.parse(readFileSync(join(BRAND.root, "source", "orchestration.json"), "utf8"));
  return packCache;
}

/** Every rule id in the pack, in source order. */
export const ruleIds = () => loadPack().rules.map((r) => r.id);

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const unit = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Read both config layers. Injectable for tests (`layers`), otherwise the real files.
 * @param {string} root
 * @param {{global?: Record<string, any>, project?: Record<string, any>}} [layers]
 */
function readLayers(root, layers) {
  if (layers) return { global: layers.global ?? {}, project: layers.project ?? {} };
  return { global: readUserConfig(), project: readForgeConfig(root) };
}

/**
 * The effective orchestration rule set: each rule's on/off state and which layer decided it.
 * The minimal profile keeps the pack off unless a layer turns it on explicitly — that profile
 * exists for repos that want only the core-safety rules.
 * @param {string} [root]
 * @param {{global?: Record<string, any>, project?: Record<string, any>}} [layers]
 * @returns {{enabled: boolean, enabledSource: string, parallelCap: number,
 *   parallelCapSource: string,
 *   rules: {id:string, text:string, rationale:string, default:boolean, enabled:boolean,
 *     source:"default"|"global"|"project"}[]}}
 */
export function resolveOrchestration(root = process.cwd(), layers) {
  const pack = loadPack();
  const { global, project } = readLayers(root, layers);
  const g = isObj(global.orchestration) ? global.orchestration : {};
  const p = isObj(project.orchestration) ? project.orchestration : {};
  let enabled = project.profile !== "minimal";
  let enabledSource = "default";
  for (const [layer, name] of [
    [g, "global"],
    [p, "project"],
  ]) {
    if (typeof layer.enabled === "boolean") {
      enabled = layer.enabled;
      enabledSource = name;
    }
  }
  let parallelCap = pack.params.parallelCap;
  let parallelCapSource = "default";
  for (const [layer, name] of [
    [g, "global"],
    [p, "project"],
  ]) {
    if (Number.isInteger(layer.parallelCap) && layer.parallelCap >= 1) {
      parallelCap = layer.parallelCap;
      parallelCapSource = name;
    }
  }
  const params = { ...pack.params, parallelCap };
  const rules = pack.rules.map((r) => {
    let on = r.default !== false;
    /** @type {"default"|"global"|"project"} */
    let source = "default";
    if (isObj(g.rules) && typeof g.rules[r.id] === "boolean") {
      on = g.rules[r.id];
      source = "global";
    }
    if (isObj(p.rules) && typeof p.rules[r.id] === "boolean") {
      on = p.rules[r.id];
      source = "project";
    }
    const text = r.text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    return {
      id: r.id,
      text,
      rationale: r.rationale,
      default: r.default !== false,
      enabled: on,
      source,
    };
  });
  return { enabled, enabledSource, parallelCap, parallelCapSource, rules };
}

/**
 * The section sync appends to the canonical rules, or null when the pack is off or every rule
 * in it is. Only the rule TEXT is emitted — rationale stays in `forge orchestration list` and the
 * docs, so AGENTS.md stays inside the tools' size caps.
 * @param {string} [root]
 * @param {{global?: Record<string, any>, project?: Record<string, any>}} [layers]
 * @returns {{id:string, title:string, rules:string[]}|null}
 */
export function orchestrationSection(root = process.cwd(), layers) {
  const state = resolveOrchestration(root, layers);
  if (!state.enabled) return null;
  const on = state.rules.filter((r) => r.enabled);
  if (!on.length) return null;
  const pack = loadPack();
  return { id: pack.id, title: pack.title, rules: on.map((r) => `${r.text} \`[${r.id}]\``) };
}

/**
 * The effective routing policy (defaults < global `route` < project `route`), validated: a
 * value of the wrong type or outside its range is ignored, never trusted.
 * @param {string} [root]
 * @param {{global?: Record<string, any>, project?: Record<string, any>}} [layers]
 * @returns {{mode:string, raiseConfidence:number, midConfidence:number, topTier:string,
 *   writesCodeFloor:boolean, riskFloor:boolean, riskCategories:Record<string,string[]>,
 *   sources:Record<string,string>}}
 */
export function resolveRoutePolicy(root = process.cwd(), layers) {
  const defaults = loadPack().route;
  const { global, project } = readLayers(root, layers);
  const out = {
    mode: defaults.mode,
    raiseConfidence: defaults.raiseConfidence,
    midConfidence: defaults.midConfidence,
    topTier: defaults.topTier,
    writesCodeFloor: defaults.writesCodeFloor,
    riskFloor: defaults.riskFloor,
    riskCategories: { ...defaults.riskCategories },
    /** @type {Record<string,string>} */
    sources: {},
  };
  const valid = {
    mode: (v) => ROUTE_MODES.includes(v),
    topTier: (v) => TOP_TIER_GATES.includes(v),
    raiseConfidence: unit,
    midConfidence: unit,
    writesCodeFloor: (v) => typeof v === "boolean",
    riskFloor: (v) => typeof v === "boolean",
  };
  /** @type {[Record<string, any>, string][]} */
  const ordered = [
    [global, "global"],
    [project, "project"],
  ];
  for (const [cfg, name] of ordered) {
    const layer = isObj(cfg.route) ? cfg.route : {};
    for (const [key, ok] of Object.entries(valid)) {
      if (key in layer && ok(layer[key])) {
        out[key] = layer[key];
        out.sources[key] = name;
      }
    }
    if (isObj(layer.riskCategories)) {
      for (const [cat, words] of Object.entries(layer.riskCategories)) {
        if (words === false) out.riskCategories[cat] = [];
        else if (Array.isArray(words))
          out.riskCategories[cat] = words.filter((w) => typeof w === "string" && w.trim());
      }
      out.sources.riskCategories = name;
    }
  }
  return out;
}

/**
 * Settable keys for `forge orchestration set`, each with its parser. A parse failure returns
 * `undefined` and the CLI refuses the write.
 * @type {Record<string, {path:[string,string], parse:(raw:string)=>any, help:string}>}
 */
export const SETTABLE = {
  parallelCap: {
    path: ["orchestration", "parallelCap"],
    parse: (raw) => (/^[1-9]\d*$/.test(raw) ? Number(raw) : undefined),
    help: "integer ≥ 1",
  },
  "route.mode": {
    path: ["route", "mode"],
    parse: (raw) => (ROUTE_MODES.includes(raw) ? raw : undefined),
    help: ROUTE_MODES.join(" | "),
  },
  "route.topTier": {
    path: ["route", "topTier"],
    parse: (raw) => (TOP_TIER_GATES.includes(raw) ? raw : undefined),
    help: TOP_TIER_GATES.join(" | "),
  },
  "route.raiseConfidence": {
    path: ["route", "raiseConfidence"],
    parse: (raw) => (unit(Number(raw)) && raw.trim() !== "" ? Number(raw) : undefined),
    help: "number in [0, 1]",
  },
  "route.midConfidence": {
    path: ["route", "midConfidence"],
    parse: (raw) => (unit(Number(raw)) && raw.trim() !== "" ? Number(raw) : undefined),
    help: "number in [0, 1]",
  },
  "route.writesCodeFloor": {
    path: ["route", "writesCodeFloor"],
    parse: (raw) => ({ on: true, off: false, true: true, false: false })[raw],
    help: "on | off",
  },
  "route.riskFloor": {
    path: ["route", "riskFloor"],
    parse: (raw) => ({ on: true, off: false, true: true, false: false })[raw],
    help: "on | off",
  },
};

/** Write through the chosen layer: the repo file, or the user-level file with `global`. */
function writeLayer(root, global, mutator) {
  return global ? writeUserConfig(mutator) : writeForgeConfig(root, mutator);
}

/**
 * Switch one rule (or `all` rules, or the whole pack with id `pack`) on or off in one layer.
 * @param {string} root
 * @param {string} id a rule id, `all`, or `pack`
 * @param {boolean} on
 * @param {{global?: boolean}} [opts]
 * @returns {{ok:true, path:string, ids:string[]}|{ok:false, reason:string}}
 */
export function setRule(root, id, on, { global = false } = {}) {
  const known = ruleIds();
  if (id !== "all" && id !== "pack" && !known.includes(id))
    return { ok: false, reason: `unknown rule id: ${id} (known: ${known.join(", ")}, all, pack)` };
  const ids = id === "all" ? known : id === "pack" ? [] : [id];
  const res = writeLayer(root, global, (cfg) => {
    const o = isObj(cfg.orchestration) ? cfg.orchestration : {};
    if (id === "pack") o.enabled = on;
    else {
      const rules = isObj(o.rules) ? o.rules : {};
      for (const r of ids) rules[r] = on;
      o.rules = rules;
      // Turning rules on while the pack is off would change nothing; switch the pack on too.
      if (on && o.enabled === false) o.enabled = true;
    }
    cfg.orchestration = o;
    return cfg;
  });
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, path: res.path, ids };
}

/**
 * Set one SETTABLE key in one layer.
 * @param {string} root
 * @param {string} key
 * @param {string} raw
 * @param {{global?: boolean}} [opts]
 * @returns {{ok:true, path:string, value:any}|{ok:false, reason:string}}
 */
export function setSetting(root, key, raw, { global = false } = {}) {
  const spec = SETTABLE[key];
  if (!spec)
    return {
      ok: false,
      reason: `unknown setting: ${key} (settable: ${Object.keys(SETTABLE).join(", ")})`,
    };
  const value = spec.parse(String(raw ?? ""));
  if (value === undefined) return { ok: false, reason: `${key} expects ${spec.help}` };
  const [top, leaf] = spec.path;
  const res = writeLayer(root, global, (cfg) => {
    const o = isObj(cfg[top]) ? cfg[top] : {};
    o[leaf] = value;
    cfg[top] = o;
    return cfg;
  });
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, path: res.path, value };
}

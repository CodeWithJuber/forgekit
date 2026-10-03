// forge advisor — Claude Code's advisor tool, authored once in Forge's config and checked
// before Claude Code has to refuse it. The advisor is a second, typically stronger model the
// main model consults at decision points (before committing to an approach, when an error keeps
// recurring, before declaring a task done). Claude Code turns it on through the `advisorModel`
// settings key, and it accepts an advisor only when it ranks at or above the session's main
// model (https://code.claude.com/docs/en/advisor). This module owns three things:
//
//   1. the pairing table (source/advisor.json `ranking`) and a pure check over it — which
//      models may advise which, with family aliases (sonnet/opus/fable) resolved to the
//      family's newest row, so `forge advisor check sonnet opus` answers before a session starts;
//   2. the effective advisor for a repo — Forge's config layers (project `.forge/forge.config.json`
//      over the user-level `forge.config.json`), else what Claude Code's own settings files
//      already hold — plus the environment variables that keep the advisor off whatever is set;
//   3. the "Advisor" rule section `forge sync` appends to AGENTS.md when an advisor is
//      configured: when to consult it, when not to, and that evidence beats its guidance.
//
// Config shape (both Forge config files; every key optional):
//   "advisor": { "model": "opus" | "claude-opus-5-5" | "off", "rules": { "advisor.risk": false } }
// The project emitter (src/emit/claude_settings.js) writes `model` into the repo's
// `.claude/settings.json` as `advisorModel`; `--global` writes `~/.claude/settings.json` directly,
// the file `/advisor` itself saves to.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { SAFE_MODEL_ID, tokenize, versionOf } from "./model_catalog.js";
import {
  readForgeConfig,
  readUserConfig,
  writeForgeConfig,
  writeUserConfig,
} from "./repo_config.js";
import { readJsonSafe } from "./util.js";

/** The Claude Code settings key the advisor lives under. */
export const ADVISOR_SETTINGS_KEY = "advisorModel";
/** Set to `1`: the advisor tool is off entirely — `/advisor` disappears and `advisorModel` is ignored. */
export const DISABLE_ADVISOR_ENV = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
/** Variables that turn Claude Code's feature-flag fetching off; the advisor needs it, so it stays off. */
export const FLAG_FETCH_OFF_ENV = ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY"];
/** The family aliases Claude Code accepts for `advisorModel` (haiku can never advise). */
export const ADVISOR_ALIASES = ["sonnet", "opus", "fable"];

let packCache = null;

/** The shipped pack (source/advisor.json), parsed once per process. */
export function loadAdvisorPack() {
  if (!packCache)
    packCache = JSON.parse(readFileSync(join(BRAND.root, "source", "advisor.json"), "utf8"));
  return packCache;
}

/** Every rule id in the pack, in source order. */
export const advisorRuleIds = () => loadAdvisorPack().rules.map((r) => r.id);

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Model ids → ranking rows. Generic rules over the id's own tokens (model_catalog.js), so
// `claude-sonnet-5-5`, `anthropic/claude-sonnet-5.5`, `claude-sonnet-5-5[1m]` and a Bedrock
// `us.anthropic.claude-sonnet-5-5-v1:0` all read as Sonnet 5.5.
// ---------------------------------------------------------------------------

const FAMILIES = ["haiku", "sonnet", "opus", "fable", "mythos"];

/** A version string from the table ("4.5") or an id's parsed version ([4, 5]) as "4.5". */
const versionKey = (v) =>
  Array.isArray(v) ? v.map(String).join(".") : String(v ?? "").replace(/(?:\.0)+$/, "");

/** Compare two dotted versions numerically; a missing version sorts first. */
function compareVersionKeys(a, b) {
  const pa = a ? a.split(".").map(Number) : [];
  const pb = b ? b.split(".").map(Number) : [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Parse a model alias or id into its family and version. Pure; never throws.
 * `opusplan` plans on Opus and executes on Sonnet: it is read as Opus, the stricter side of the
 * pairing check (an advisor accepted by Opus is accepted by Sonnet too).
 * @param {unknown} raw
 * @returns {{raw:string, family:string|null, version:string|null, alias:boolean, note?:string}}
 */
export function parseModel(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { raw: text, family: null, version: null, alias: false };
  // Context-window and provider decorations carry no capability information.
  const bare = text.replace(/\[[^\]]*\]$/, "").replace(/-v\d+:\d+$/, "");
  if (bare.toLowerCase() === "opusplan")
    return {
      raw: text,
      family: "opus",
      version: null,
      alias: true,
      note: "opusplan plans on Opus and executes on Sonnet; checked as Opus, the stricter side",
    };
  const tokens = tokenize(bare);
  const family = FAMILIES.find((f) => tokens.has(f)) ?? null;
  const version = family ? versionOf(bare) : null;
  return {
    raw: text,
    family,
    version: version ? versionKey(version) : null,
    alias: Boolean(family) && !version,
  };
}

/** The ranking rows of one family, oldest first. */
const familyRows = (family) =>
  loadAdvisorPack()
    .ranking.rows.filter((r) => r.family === family)
    .sort((a, b) => compareVersionKeys(a.version, b.version));

/**
 * Place a model in the ranking. `status`:
 *   known    the table names this exact version;
 *   alias    a family alias — resolved to the family's newest row (what Claude Code's built-in
 *            default advances to with each release);
 *   newer    a version above the newest row Forge knows — Claude Code validates it at launch;
 *   older    a version below the oldest row — it predates the advisor and cannot pair;
 *   unknown  not a Claude model family Forge recognises.
 * @param {unknown} raw
 * @returns {{raw:string, family:string|null, version:string|null, label:string, rank:number|null,
 *   advises:boolean, status:"known"|"alias"|"newer"|"older"|"unknown", note?:string}}
 */
export function rankModel(raw) {
  const p = parseModel(raw);
  const base = { raw: p.raw, family: p.family, version: p.version };
  if (!p.family)
    return { ...base, label: p.raw || "(none)", rank: null, advises: false, status: "unknown" };
  const rows = familyRows(p.family);
  const title = p.family[0].toUpperCase() + p.family.slice(1);
  if (p.alias) {
    const newest = rows[rows.length - 1];
    return {
      ...base,
      label: `${newest.label} (${p.raw})`,
      rank: newest.rank,
      advises: newest.advises !== false,
      status: "alias",
      ...(p.note ? { note: p.note } : {}),
    };
  }
  const exact = rows.find((r) => versionKey(r.version) === p.version);
  if (exact)
    return {
      ...base,
      label: exact.label,
      rank: exact.rank,
      advises: exact.advises !== false,
      status: "known",
    };
  const label = `${title} ${p.version}`;
  if (compareVersionKeys(p.version, rows[0].version) < 0)
    return {
      ...base,
      label,
      rank: null,
      advises: false,
      status: "older",
      note: `${label} predates the advisor (the oldest ${title} it supports is ${rows[0].label})`,
    };
  const newest = rows[rows.length - 1];
  return {
    ...base,
    label,
    rank: newest.rank,
    advises: newest.advises !== false,
    status: "newer",
    note: `${label} is newer than ${BRAND.brand}'s pairing table (verified ${loadAdvisorPack().ranking.verified}); ranked as ${newest.label}, and Claude Code validates the pairing at launch`,
  };
}

/**
 * May `advisor` advise a session whose main model is `main`? Pure. `ok` is `true`/`false` when the
 * table decides, `null` when it cannot (no main model set, or a model newer than the table).
 * @param {unknown} main the session's main model (alias or id); empty = the account default
 * @param {unknown} advisor
 * @returns {{ok:boolean|null, status:"ok"|"no-main"|"unknown-main"|"unknown-advisor"|"main-unsupported"|
 *   "cannot-advise"|"below"|"unverified", reason:string,
 *   main:ReturnType<typeof rankModel>|null, advisor:ReturnType<typeof rankModel>}}
 */
export function checkPairing(main, advisor) {
  const a = rankModel(advisor);
  const m =
    main === undefined || main === null || String(main).trim() === "" ? null : rankModel(main);
  const out = (ok, status, reason) => ({ ok, status, reason, main: m, advisor: a });
  if (a.status === "unknown")
    return out(
      false,
      "unknown-advisor",
      `${a.raw || "(empty)"} is not a Claude model ${BRAND.brand} recognises (sonnet, opus, fable, or a full id such as claude-opus-5-5)`,
    );
  if (a.status === "older")
    return out(false, "unknown-advisor", a.note ?? `${a.label} cannot act as an advisor`);
  if (!a.advises)
    return out(false, "cannot-advise", `${a.label} can call the advisor but cannot act as one`);
  if (!m)
    return out(
      null,
      "no-main",
      `${a.label} — the main model is not set (account default); Claude Code checks the pairing at launch`,
    );
  if (m.status === "unknown")
    return out(
      null,
      "unknown-main",
      `${m.raw} is not a Claude model ${BRAND.brand} recognises, so the pairing with ${a.label} is unverified`,
    );
  if (m.status === "older")
    return out(
      false,
      "main-unsupported",
      `${m.label} does not support the advisor (Haiku 4.5, Sonnet 4.6, Opus 4.6 or later, or Fable); ${a.label} would not be attached`,
    );
  if (/** @type {number} */ (a.rank) < /** @type {number} */ (m.rank))
    return out(
      false,
      "below",
      `${a.label} ranks below ${m.label} and cannot advise it (an advisor must rank at or above the main model)`,
    );
  if (a.status === "newer" || m.status === "newer")
    return out(
      null,
      "unverified",
      `${a.label} advising ${m.label}: ${(a.status === "newer" ? a : m).note}`,
    );
  return out(true, "ok", `${a.label} advises ${m.label}`);
}

/**
 * Every table row that may advise `main`, newest-ranked first, and which aliases resolve to one
 * of them. Pure. An unknown or unset main model accepts every advising row.
 * @param {unknown} [main]
 * @returns {{rows:{family:string, version:string, label:string, rank:number}[], aliases:string[]}}
 */
export function acceptedAdvisors(main) {
  const m = main ? rankModel(main) : null;
  const floor = m && typeof m.rank === "number" ? m.rank : Number.NEGATIVE_INFINITY;
  const rows = loadAdvisorPack()
    .ranking.rows.filter((r) => r.advises !== false && r.rank >= floor)
    .sort((a, b) => b.rank - a.rank || compareVersionKeys(b.version, a.version))
    .map(({ family, version, label, rank }) => ({ family, version, label, rank }));
  const aliases = ADVISOR_ALIASES.filter((alias) => {
    const r = rankModel(alias);
    return typeof r.rank === "number" && r.rank >= floor;
  });
  return { rows, aliases };
}

/**
 * The pairing the docs recommend for a main model's family: Opus for Haiku and Sonnet (routine
 * work on the cheap model, planning and completion checks on the stronger one), a second Opus for
 * Opus, Fable for Fable. Pure; null for an unrecognised family.
 * @param {unknown} main
 * @returns {string|null} an advisor alias
 */
export function suggestAdvisor(main) {
  const { family } = parseModel(main);
  return family ? (loadAdvisorPack().ranking.suggest[family] ?? null) : null;
}

// ---------------------------------------------------------------------------
// The effective advisor for a repo.
// ---------------------------------------------------------------------------

/** Read one Claude Code settings file; a missing or corrupt file is `{}` (status is doctor's job). */
const readSettings = (path) => {
  const data = readJsonSafe(path);
  return isObj(data) ? data : {};
};

/**
 * Claude Code's settings layers for a repo, lowest precedence first: user, project, local.
 * `userPath` overrides the user file (the same seam `forge init` uses for tests).
 * @param {string} root
 * @param {{userPath?:string}} [opts]
 */
export function claudeSettingsLayers(root, { userPath } = {}) {
  return [
    { layer: "claude-user", path: userPath || join(homedir(), ".claude", "settings.json") },
    { layer: "claude-project", path: join(root, ".claude", "settings.json") },
    { layer: "claude-local", path: join(root, ".claude", "settings.local.json") },
  ].map((l) => ({ ...l, data: readSettings(l.path) }));
}

/** `off`/false/empty mean "no advisor"; any other string is a model. Undefined = not set here. */
function configModel(section) {
  if (!isObj(section) || !("model" in section)) return undefined;
  const v = section.model;
  if (v === false || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  return /^(off|none|no)$/i.test(v.trim()) ? null : v.trim();
}

/**
 * Which environment variable keeps the advisor off, if any. Pure over `env`.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{by:string, reason:string}|null}
 */
export function advisorDisabledBy(env = process.env) {
  if (String(env[DISABLE_ADVISOR_ENV] ?? "").trim() === "1")
    return {
      by: DISABLE_ADVISOR_ENV,
      reason: `${DISABLE_ADVISOR_ENV}=1 disables the advisor tool entirely (any advisorModel is ignored)`,
    };
  for (const name of FLAG_FETCH_OFF_ENV)
    if (String(env[name] ?? "").trim())
      return {
        by: name,
        reason: `${name} is set, which turns Claude Code's feature-flag fetching off; the advisor needs it, so it stays off`,
      };
  return null;
}

/**
 * The effective advisor and the rule set, with the layer that decided each value.
 * Precedence for the advisor: Forge's project config > Forge's user-level config > Claude Code's
 * local > project > user settings (what `/advisor` saved). The main model comes from
 * ANTHROPIC_MODEL, else Claude Code's settings (local > project > user), else the account default.
 * @param {string} [root]
 * @param {{layers?:{global?:Record<string,any>, project?:Record<string,any>},
 *   settingsPath?:string, env?:Record<string,string|undefined>}} [opts] test seams: Forge's
 *   config layers, the user settings file, the environment
 * @returns {{model:string|null, source:string, forgeConfigured:boolean,
 *   main:{model:string|null, source:string}, disabled:{by:string, reason:string}|null,
 *   pairing:ReturnType<typeof checkPairing>|null,
 *   rules:{id:string, text:string, rationale:string, default:boolean, enabled:boolean,
 *     source:"default"|"global"|"project"}[]}}
 */
export function resolveAdvisor(
  root = process.cwd(),
  { layers, settingsPath, env = process.env } = {},
) {
  const global = layers ? (layers.global ?? {}) : readUserConfig();
  const project = layers ? (layers.project ?? {}) : readForgeConfig(root);
  const g = isObj(global.advisor) ? global.advisor : {};
  const p = isObj(project.advisor) ? project.advisor : {};
  const claude = claudeSettingsLayers(root, { userPath: settingsPath });

  /** @type {string|null} */
  let model = null;
  let source = "none";
  let forgeConfigured = false;
  const fromProject = configModel(p);
  const fromGlobal = configModel(g);
  if (fromProject !== undefined) {
    model = fromProject;
    source = "project";
    forgeConfigured = true;
  } else if (fromGlobal !== undefined) {
    model = fromGlobal;
    source = "global";
    forgeConfigured = true;
  } else {
    for (const l of [...claude].reverse()) {
      const v = l.data[ADVISOR_SETTINGS_KEY];
      if (typeof v === "string" && v.trim()) {
        model = v.trim();
        source = l.layer;
        break;
      }
    }
  }

  let main = { model: /** @type {string|null} */ (null), source: "default" };
  const envModel = String(env.ANTHROPIC_MODEL ?? "").trim();
  if (envModel) main = { model: envModel, source: "env" };
  else {
    for (const l of [...claude].reverse()) {
      if (typeof l.data.model === "string" && l.data.model.trim()) {
        main = { model: l.data.model.trim(), source: l.layer };
        break;
      }
    }
    const fallback = String(env.ANTHROPIC_DEFAULT_MODEL ?? "").trim();
    if (!main.model && fallback) main = { model: fallback, source: "env-default" };
  }

  const rules = loadAdvisorPack().rules.map((r) => {
    let on = r.default !== false;
    /** @type {"default"|"global"|"project"} */
    let from = "default";
    if (isObj(g.rules) && typeof g.rules[r.id] === "boolean") {
      on = g.rules[r.id];
      from = "global";
    }
    if (isObj(p.rules) && typeof p.rules[r.id] === "boolean") {
      on = p.rules[r.id];
      from = "project";
    }
    return {
      id: r.id,
      text: r.text,
      rationale: r.rationale,
      default: r.default !== false,
      enabled: on,
      source: from,
    };
  });

  return {
    model,
    source,
    forgeConfigured,
    main,
    disabled: advisorDisabledBy(env),
    pairing: model ? checkPairing(main.model, model) : null,
    rules,
  };
}

/**
 * The "Advisor" section sync appends to the canonical rules, or null when Forge's config names
 * no advisor (a model set only in Claude Code's own settings is personal and never reaches the
 * shared AGENTS.md), when it is off, or when every rule is off. Only the Forge config layers
 * decide, so the emitted block is the same for everyone who syncs the repo.
 * @param {string} [root]
 * @param {{global?:Record<string,any>, project?:Record<string,any>}} [layers]
 * @returns {{id:string, title:string, rules:string[]}|null}
 */
export function advisorSection(root = process.cwd(), layers) {
  const state = resolveAdvisor(root, { layers: layers ?? undefined, env: {} });
  if (!state.forgeConfigured || !state.model) return null;
  const on = state.rules.filter((r) => r.enabled);
  if (!on.length) return null;
  const pack = loadAdvisorPack();
  const lead = `An advisor — a stronger second model that reads the whole conversation — is configured: \`${state.model}\`. A tool without an advisor tool ignores this section.`;
  return {
    id: pack.id,
    title: pack.title,
    rules: [lead, ...on.map((r) => `${r.text} \`[${r.id}]\``)],
  };
}

// ---------------------------------------------------------------------------
// Hook advisories — one line each, only at the moments the docs name.
// ---------------------------------------------------------------------------

/**
 * The one-line nudge the UserPromptSubmit advisory carries when an advisor is configured and the
 * prompt is a decision point: an under-specified task, a premium-tier route, or a task that names
 * a risk area. Empty otherwise, and always empty while an environment variable keeps the advisor
 * off. Never throws.
 * @param {string} root
 * @param {{assumption?:{shouldAsk?:boolean}, route?:{key?:string}, risk?:boolean}} result the
 *   substrate result (`risk` may be precomputed by the caller)
 * @param {{env?:Record<string,string|undefined>}} [opts]
 * @returns {string}
 */
export function advisorNudge(root, result, { env = process.env } = {}) {
  try {
    const state = resolveAdvisor(root, { env });
    if (!state.model || state.disabled) return "";
    const premium = ["opus", "fable"].includes(String(result?.route?.key ?? ""));
    const decision = Boolean(result?.assumption?.shouldAsk) || premium || Boolean(result?.risk);
    if (!decision) return "";
    const why = result?.assumption?.shouldAsk
      ? "the task is under-specified"
      : result?.risk
        ? "the task touches a risk area"
        : "the task routes to a premium tier";
    const warn =
      state.pairing && state.pairing.ok === false
        ? ` (note: ${state.pairing.reason}, so Claude Code may not attach it)`
        : "";
    return `- Advisor: \`${state.model}\` is configured and ${why} — consult it before committing to an approach, again if an error recurs, and before declaring done${warn}.`;
  } catch {
    return "";
  }
}

/**
 * The sentence the doom-loop advisory appends when an advisor is configured: the recurring
 * failure is exactly the moment the docs say to consult it. Empty when none is configured or an
 * environment variable keeps it off. Never throws.
 * @param {string} root
 * @param {{env?:Record<string,string|undefined>}} [opts]
 * @returns {string}
 */
export function doomLoopAdvisorHint(root, { env = process.env } = {}) {
  try {
    const state = resolveAdvisor(root, { env });
    if (!state.model || state.disabled) return "";
    return `Consult the advisor (\`${state.model}\`) before the next attempt — it reads the whole transcript and this is the moment it is for.`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Writes: Forge's config layers, and Claude Code's settings files.
// ---------------------------------------------------------------------------

/** Write through the chosen layer: the repo file, or the user-level file with `global`. */
const writeLayer = (root, global, mutator) =>
  global ? writeUserConfig(mutator) : writeForgeConfig(root, mutator);

/**
 * Validate a model for the advisor role before anything is written: an alias (sonnet/opus/
 * fable), or a full id of a family that can advise. Haiku and models older than the table are
 * refused with the reason; a model newer than the table is accepted with a note.
 * @param {unknown} raw
 * @returns {{ok:true, model:string, note?:string}|{ok:false, reason:string}}
 */
export function validateAdvisorModel(raw) {
  const text = String(raw ?? "").trim();
  if (!text)
    return {
      ok: false,
      reason: "an advisor model is required (sonnet, opus, fable, or a full id)",
    };
  if (!SAFE_MODEL_ID.test(text))
    return { ok: false, reason: `${JSON.stringify(text)} is not a model id` };
  const r = rankModel(text);
  if (r.status === "unknown")
    return {
      ok: false,
      reason: `${text} is not a Claude model ${BRAND.brand} recognises (sonnet, opus, fable, or a full id such as claude-opus-5-5)`,
    };
  if (r.status === "older")
    return { ok: false, reason: r.note ?? `${r.label} cannot act as an advisor` };
  if (!r.advises)
    return {
      ok: false,
      reason: `${r.label} can call the advisor but cannot act as one — pick sonnet, opus or fable`,
    };
  return { ok: true, model: text, ...(r.note ? { note: r.note } : {}) };
}

/**
 * Set the advisor model (or `off`) in one Forge config layer. Validation happens first, so a
 * refused model never touches the file.
 * @param {string} root
 * @param {string} raw a model, or `off`
 * @param {{global?:boolean}} [opts]
 * @returns {{ok:true, path:string, model:string|null, note?:string}|{ok:false, reason:string}}
 */
export function setAdvisorModel(root, raw, { global = false } = {}) {
  const text = String(raw ?? "").trim();
  const off = /^(off|none|no)$/i.test(text);
  let note;
  if (!off) {
    const v = validateAdvisorModel(text);
    if (v.ok === false) return { ok: false, reason: v.reason };
    note = v.note;
  }
  const res = writeLayer(root, global, (cfg) => {
    const a = isObj(cfg.advisor) ? cfg.advisor : {};
    a.model = off ? "off" : text;
    cfg.advisor = a;
    return cfg;
  });
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, path: res.path, model: off ? null : text, ...(note ? { note } : {}) };
}

/**
 * Remove Forge's advisor choice from one layer, so Claude Code's own settings decide again. The
 * rule switches stay. A file left with an empty `advisor` object loses the key.
 * @param {string} root
 * @param {{global?:boolean}} [opts]
 * @returns {{ok:true, path:string, had:boolean}|{ok:false, reason:string}}
 */
export function resetAdvisorModel(root, { global = false } = {}) {
  let had = false;
  const res = writeLayer(root, global, (cfg) => {
    if (isObj(cfg.advisor) && "model" in cfg.advisor) {
      had = true;
      delete cfg.advisor.model;
      if (!Object.keys(cfg.advisor).length) delete cfg.advisor;
    }
    return cfg;
  });
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, path: res.path, had };
}

/**
 * Switch one rule (or `all`) on or off in one layer.
 * @param {string} root
 * @param {string} id a rule id or `all`
 * @param {boolean} on
 * @param {{global?:boolean}} [opts]
 * @returns {{ok:true, path:string, ids:string[]}|{ok:false, reason:string}}
 */
export function setAdvisorRule(root, id, on, { global = false } = {}) {
  const known = advisorRuleIds();
  if (id !== "all" && !known.includes(id))
    return { ok: false, reason: `unknown rule id: ${id} (known: ${known.join(", ")}, all)` };
  const ids = id === "all" ? known : [id];
  const res = writeLayer(root, global, (cfg) => {
    const a = isObj(cfg.advisor) ? cfg.advisor : {};
    const rules = isObj(a.rules) ? a.rules : {};
    for (const r of ids) rules[r] = on;
    a.rules = rules;
    cfg.advisor = a;
    return cfg;
  });
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, path: res.path, ids };
}

/**
 * Put `advisorModel` into a Claude Code settings file (or take it out with `model: null`),
 * preserving every other key. A corrupt file is refused and left byte for byte; a missing file is
 * created only when there is a model to write. Atomic (temp file + rename), with a timestamped
 * backup of an existing file, like every other settings write Forge does.
 * @param {string} path
 * @param {string|null} model
 * @returns {{action:"written"|"unchanged"|"created"|"removed", path:string}|{action:"error", path:string, reason:string}}
 */
export function writeAdvisorSetting(path, model) {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : null;
  let data = {};
  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (!isObj(data))
      return {
        action: "error",
        path,
        reason: `${path} is not valid JSON — refusing to overwrite (fix or remove it)`,
      };
  }
  const current =
    typeof data[ADVISOR_SETTINGS_KEY] === "string" ? data[ADVISOR_SETTINGS_KEY] : null;
  if (model === null) {
    if (current === null) return { action: "unchanged", path };
    delete data[ADVISOR_SETTINGS_KEY];
  } else {
    if (current === model) return { action: "unchanged", path };
    data[ADVISOR_SETTINGS_KEY] = model;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  if (raw !== null)
    copyFileSync(path, `${path}.forge-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const tmp = `${path}.forge-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
  return { action: raw === null ? "created" : model === null ? "removed" : "written", path };
}

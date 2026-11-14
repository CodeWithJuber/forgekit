// Project-level hooks — the file each agent reads to run forge's guards by itself.
//
// `forge init` wires Claude Code at USER level, on one machine. A teammate, a CI job, a cloud
// agent, or any other agent opening the repository gets nothing from that. This emitter writes
// the same wiring INTO the repository, in each agent's own hook format, so the repository
// carries it: `.claude/settings.json`, `.codex/hooks.json`, `.gemini/settings.json`,
// `.cursor/hooks.json`, `.github/hooks/<cli>.json`. Every entry is one command —
// `<cli> hooks run <host> <event>` — and src/hosts.js does the rest.
//
// Off until asked for (`forge hooks on`): a committed hook is code that runs in every
// teammate's agent, so it is the team's decision, never a side effect of `forge sync`.
//
// Ownership is the command text itself (isForgeHookCommand): forge removes and rewrites only
// entries whose command it wrote, and every other key, hook and file is left byte for byte.
// The command never fails a tool call on a machine without forge: it checks for the CLI first
// and exits 0 when it is absent.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../brand.js";
import { HOSTS, isForgeHookCommand, userLevelWired } from "../hosts.js";
import { readJsonSafe } from "../util.js";
import { writeIfChanged } from "./_shared.js";

/** Seconds a host waits for one hook, per canonical event. */
export const HOOK_TIMEOUT_S = Object.freeze({
  SessionStart: 60,
  UserPromptSubmit: 30,
  PreToolUse: 30,
  PostToolUse: 30,
  PostToolUseFailure: 30,
  Stop: 60,
});
/** A session start that may install the package first needs longer. */
export const BOOTSTRAP_TIMEOUT_S = 180;

/** `name@version` of this very package, as npm knows it — the pin a bootstrap installs. Read
 *  from package.json: the brand name is not the registry name. */
export function packageSpec(root = BRAND.root) {
  const pkg = readJsonSafe(join(root, "package.json"));
  return pkg?.name && pkg?.version ? `${pkg.name}@${pkg.version}` : null;
}

/**
 * The command a host runs for one event. POSIX: stand down when the CLI is not installed (a
 * missing command must never turn into a failed, or worse a denied, tool call). With
 * `bootstrap`, a session start first installs this exact version when the CLI is missing —
 * what makes a fresh cloud or CI machine work with no setup.
 * @param {string} hostId @param {string} nativeEvent
 * @param {{bootstrap?: boolean, shell?: "posix"|"powershell", spec?: string|null}} [o]
 */
export function hookCommand(hostId, nativeEvent, o = {}) {
  const { bootstrap = false, shell = "posix", spec = packageSpec() } = o;
  const cli = BRAND.cli;
  const run = `${cli} hooks run ${hostId} ${nativeEvent}`;
  if (shell === "powershell")
    return `if (Get-Command ${cli} -ErrorAction SilentlyContinue) { ${run} }`;
  const have = `command -v ${cli} >/dev/null 2>&1`;
  const install =
    bootstrap && spec && HOSTS[hostId]?.events[nativeEvent]?.as === "SessionStart"
      ? `${have} || npm install -g --silent ${spec} >/dev/null 2>&1; `
      : "";
  return `${install}${have} || exit 0; ${run}`;
}

/** One hook entry in a host's own shape. @param {string} hostId @param {string} nativeEvent */
function entry(hostId, nativeEvent, { bootstrap = false } = {}) {
  const host = HOSTS[hostId];
  const as = host.events[nativeEvent].as;
  const secs = bootstrap && as === "SessionStart" ? BOOTSTRAP_TIMEOUT_S : HOOK_TIMEOUT_S[as];
  const command = hookCommand(hostId, nativeEvent, { bootstrap });
  const powershell = hookCommand(hostId, nativeEvent, { shell: "powershell" });
  const what = `${BRAND.brand} guards (${as})`;
  if (host.layout === "flat") return { command, timeout: secs };
  if (host.layout === "copilot")
    return { type: "command", bash: command, powershell, cwd: ".", timeoutSec: secs };
  return {
    ...(host.matchAll ? { matcher: host.matchAll } : {}),
    hooks: [
      {
        ...(host.named ? { name: `${BRAND.cli}-${nativeEvent}`, description: what } : {}),
        type: "command",
        command,
        ...(host.windows ? { [host.windows]: powershell } : {}),
        timeout: host.timeoutMs ? secs * 1000 : secs,
      },
    ],
  };
}

/** Did forge write this entry? (Every command in it is one of ours.) @param {any} e */
function owned(e) {
  if (!e || typeof e !== "object") return false;
  if (Array.isArray(e.hooks))
    return e.hooks.length > 0 && e.hooks.every((h) => isForgeHookCommand(h?.command));
  return isForgeHookCommand(e.command) || isForgeHookCommand(e.bash);
}

/**
 * What a host's hook file should hold: the file as it is, minus the entries forge wrote, plus
 * (when enabling) the current ones. Pure. `next: null` means "no file" — nothing of anyone's
 * is left in it.
 * @param {string|null} text the file as it is on disk
 * @param {string} hostId
 * @param {{enable?: boolean, bootstrap?: boolean}} [o]
 * @returns {{next: string|null, error?: string}}
 */
export function planHooks(text, hostId, { enable = true, bootstrap = false } = {}) {
  const host = HOSTS[hostId];
  /** @type {Record<string, any>} */
  let doc = {};
  if (text?.trim()) {
    try {
      doc = JSON.parse(text);
    } catch {
      return { next: text, error: "not valid JSON — left as it is" };
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc))
      return { next: text, error: "not a JSON object — left as it is" };
  }
  const had = doc.hooks !== undefined;
  /** @type {Record<string, any>} */
  const hooks = doc.hooks && typeof doc.hooks === "object" ? { ...doc.hooks } : {};
  // Every event that holds one of ours is cleaned, not only today's events: a release that
  // drops an event must not leave its old entry behind.
  for (const [name, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => !owned(e));
    if (kept.length) hooks[name] = kept;
    else if (kept.length !== list.length) delete hooks[name];
  }
  if (enable)
    for (const nativeEvent of Object.keys(host.events))
      hooks[nativeEvent] = [
        ...(hooks[nativeEvent] ?? []),
        entry(hostId, nativeEvent, { bootstrap }),
      ];
  if (Object.keys(hooks).length) doc.hooks = hooks;
  else if (had || enable) delete doc.hooks;
  // Cursor and Copilot version their hook files; the number leads the file, as their docs show.
  if (host.layout !== "groups" && doc.hooks && doc.version === undefined)
    doc = { version: 1, ...doc };
  // A file that now holds nothing but a version number is one forge created: remove it.
  const rest = Object.keys(doc).filter((k) => !(k === "version" && host.layout !== "groups"));
  if (!rest.length) return { next: null };
  return { next: `${JSON.stringify(doc, null, 2)}\n` };
}

/**
 * Write (or remove) forge's entries in one host's hook file.
 * @param {string} root @param {string} hostId
 * @param {{enable?: boolean, bootstrap?: boolean}} [o]
 * @returns {{tool: string, target: string, action: string, note: string}|null}
 */
export function applyHooks(root, hostId, { enable = true, bootstrap = false } = {}) {
  const host = HOSTS[hostId];
  if (host?.plugin) {
    const note = enable
      ? `In Kimi run /plugins install ${BRAND.root}, then /reload. This user-level install is shared by all projects.`
      : "The project now opts out. Use /plugins disable forgekit in Kimi to disable it across projects.";
    return { tool: host.label, target: "Kimi /plugins", action: "manual", note };
  }
  if (!host?.file) return null;
  const path = join(root, host.file);
  const text = existsSync(path) ? readFileSync(path, "utf8") : null;
  const row = { tool: host.label, target: host.file };
  const { next, error } = planHooks(text, hostId, { enable, bootstrap });
  if (error) return { ...row, action: "skipped", note: error };
  if (next === null) {
    if (text === null) return { ...row, action: "unchanged", note: "no hooks" };
    unlinkSync(path);
    return { ...row, action: "removed", note: "hooks off" };
  }
  const action = writeIfChanged(path, next);
  const events = Object.keys(host.events).length;
  return {
    ...row,
    action,
    note: enable ? `${events} events → ${BRAND.cli} hooks run · ${host.trust}` : "hooks off",
  };
}

/** Hosts that accept a project file or an explicit native-plugin setup choice. */
export const HOOK_HOSTS = Object.keys(HOSTS).filter((id) => HOSTS[id].file || HOSTS[id].plugin);

/**
 * Which hosts a repository's config selects: `hooks.hosts` when it names some, else every host
 * whose tool the repository emits for (`emits` is sync's own selection test).
 * @param {Record<string, any>} cfg @param {(toolKey: string) => boolean} [emits]
 */
export function selectedHosts(cfg, emits = () => true) {
  const named = Array.isArray(cfg?.hooks?.hosts) ? cfg.hooks.hosts : null;
  return HOOK_HOSTS.filter((id) => (named ? named.includes(id) : emits(HOSTS[id].tool)));
}

/**
 * `forge sync`'s share: keep the hook files current once a repository has turned them on.
 * Silent (no rows) while `hooks.project` is not true.
 * @param {{targetRoot: string, config: Record<string, any>, emits?: (toolKey: string) => boolean}} o
 */
export function emitProjectHooks({ targetRoot, config, emits }) {
  if (config?.hooks?.project !== true) return [];
  const bootstrap = config.hooks.bootstrap === true;
  return selectedHosts(config, emits)
    .map((id) => applyHooks(targetRoot, id, { enable: true, bootstrap }))
    .filter(Boolean);
}

/**
 * Where each host stands in this repository: `on` (the file holds exactly what forge would
 * write), `stale` (it holds forge entries, but not today's), `off`, or `via <host>` for an
 * agent served through another host's file.
 * @param {string} root @param {{config?: Record<string, any>, home?: string}} [o]
 */
export function hooksStatus(root, { config = {}, home } = {}) {
  const bootstrap = config?.hooks?.bootstrap === true;
  const hosts = Object.entries(HOSTS).map(([id, host]) => {
    if (host.plugin) {
      const kimiHome = process.env.KIMI_CODE_HOME || join(home || homedir(), ".kimi-code");
      const records = readJsonSafe(join(kimiHome, "plugins", "installed.json"));
      const record =
        Array.isArray(records?.plugins) && records.plugins.find((r) => r?.id === BRAND.pkg);
      const policyOff =
        config?.hooks?.project === false ||
        (Array.isArray(config?.hooks?.hosts) && !config.hooks.hosts.includes(id));
      return {
        host: id,
        label: host.label,
        file: null,
        state: record?.enabled === true && !policyOff ? "enabled in Kimi" : "off",
        note: host.trust,
      };
    }
    if (!host.file) {
      const through = HOSTS[host.via ?? ""];
      const on = through?.file ? isForgeHookCommand(readText(join(root, through.file))) : false;
      return {
        host: id,
        label: host.label,
        file: through?.file ?? null,
        state: on ? `via ${host.via}` : "off",
        note: host.trust,
      };
    }
    const text = readText(join(root, host.file));
    const wired = isForgeHookCommand(text);
    const { next } = planHooks(text, id, { enable: true, bootstrap });
    return {
      host: id,
      label: host.label,
      file: host.file,
      state: !wired ? "off" : next === text ? "on" : "stale",
      note: host.trust,
    };
  });
  return {
    enabled: config?.hooks?.project === true,
    bootstrap,
    userLevel: userLevelWired(home ? { home } : {}),
    hosts,
  };
}

/** @param {string} path @returns {string|null} */
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

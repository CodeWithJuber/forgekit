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
// Pre-tool checks report a native denial when the configured launcher is unavailable.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../brand.js";
import { projectForgeLauncher } from "../forge_launcher.js";
import { HOSTS, isForgeHookCommand, kimiPluginEnabled, render, userLevelWired } from "../hosts.js";
import { readJsonSafe } from "../util.js";
import { writeAtomicIfChanged } from "./_shared.js";
import { applyPlugin, planPlugin } from "./opencode.js";

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
 * The command a host runs for one event. The launcher can be supplied through FORGE_CLI. With
 * `bootstrap`, a session start first installs this exact version when the CLI is missing —
 * what makes a fresh cloud or CI machine work with no setup.
 * @param {string} hostId @param {string} nativeEvent
 * @param {{bootstrap?: boolean, shell?: "posix"|"powershell", spec?: string|null, entrypoint?:string}} [o]
 */
export function hookCommand(hostId, nativeEvent, o = {}) {
  const { bootstrap = false, shell = "posix", spec = packageSpec() } = o;
  const cli = BRAND.cli;
  const entrypoint = o.entrypoint;
  const missing = render(hostId, nativeEvent, {
    decision: "deny",
    reason: "ForgeKit CLI unavailable. Set FORGE_CLI or install forge on PATH.",
    context: "",
    block: "",
  });
  const warning =
    missing.stderr ||
    (missing.stdout ? "" : "ForgeKit CLI unavailable. Set FORGE_CLI or install forge on PATH.");
  const run = `hooks run ${hostId} ${nativeEvent}`;
  // Keep the legacy invocation recognizable for both unmanaged installs and ownership checks.
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
  if (shell === "powershell") {
    const failure = [
      missing.stdout && `Write-Output ${psQuote(missing.stdout)}`,
      warning && `[Console]::Error.WriteLine(${psQuote(warning)})`,
      `exit ${missing.exit}`,
    ]
      .filter(Boolean)
      .join("; ");
    const local = entrypoint
      ? ` elseif (Test-Path -LiteralPath ${psQuote(entrypoint)} -PathType Leaf) { if (Get-Command node -ErrorAction SilentlyContinue) { & node ${psQuote(entrypoint)} ${run}; exit $LASTEXITCODE } }`
      : "";
    return `if ($env:FORGE_CLI) { if (Get-Command -Name $env:FORGE_CLI -ErrorAction SilentlyContinue) { & $env:FORGE_CLI ${run}; exit $LASTEXITCODE } }${local} elseif (Get-Command ${cli} -ErrorAction SilentlyContinue) { ${cli} ${run}; exit $LASTEXITCODE }; ${failure}`;
  }
  const failure = [
    missing.stdout && `printf '%s\\n' ${quote(missing.stdout)}`,
    warning && `printf '%s\\n' ${quote(warning)} >&2`,
    `exit ${missing.exit}`,
  ]
    .filter(Boolean)
    .join("; ");
  const install =
    bootstrap && spec && HOSTS[hostId]?.events[nativeEvent]?.as === "SessionStart"
      ? `command -v ${cli} >/dev/null 2>&1 || npm install -g --silent ${spec} >/dev/null 2>&1; `
      : "";
  const local = entrypoint
    ? `if [ -f ${quote(entrypoint)} ] && command -v node >/dev/null 2>&1; then exec node ${quote(entrypoint)} ${run}; fi; `
    : "";
  return `if [ -n "$FORGE_CLI" ]; then if command -v "$FORGE_CLI" >/dev/null 2>&1; then exec "$FORGE_CLI" ${run}; fi; else ${local}${install}if command -v ${cli} >/dev/null 2>&1; then exec ${cli} ${run}; fi; fi; ${failure}`;
}

/** One hook entry in a host's own shape. @param {string} hostId @param {string} nativeEvent */
function entry(hostId, nativeEvent, { bootstrap = false, entrypoint = "" } = {}) {
  const host = HOSTS[hostId];
  const as = host.events[nativeEvent].as;
  const secs = bootstrap && as === "SessionStart" ? BOOTSTRAP_TIMEOUT_S : HOOK_TIMEOUT_S[as];
  const command = hookCommand(hostId, nativeEvent, { bootstrap, entrypoint });
  const powershell = hookCommand(hostId, nativeEvent, { shell: "powershell", entrypoint });
  const what = `${BRAND.brand} guards (${as})`;
  if (host.layout === "flat")
    return {
      command,
      timeout: secs,
      ...(nativeEvent === "beforeMCPExecution" ? { failClosed: true } : {}),
    };
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
 * @param {{enable?: boolean, bootstrap?: boolean, entrypoint?:string}} [o]
 * @returns {{next: string|null, error?: string}}
 */
export function planHooks(
  text,
  hostId,
  { enable = true, bootstrap = false, entrypoint = "" } = {},
) {
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
  if (!enable && !Object.values(hooks).some((list) => Array.isArray(list) && list.some(owned)))
    return { next: text };
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
        entry(hostId, nativeEvent, { bootstrap, entrypoint }),
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
 * @param {{enable?: boolean, bootstrap?: boolean, entrypoint?:string}} [o]
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
  // OpenCode carries hooks in a generated JavaScript plugin, not a JSON hook file.
  if (host?.layout === "module") {
    const row = applyPlugin(root, { enable });
    return {
      tool: host.label,
      target: host.file,
      ...row,
      note: enable ? `${row.note} · ${host.trust}` : row.note,
    };
  }
  if (!host?.file) return null;
  const path = join(root, host.file);
  const text = existsSync(path) ? readFileSync(path, "utf8") : null;
  const row = { tool: host.label, target: host.file };
  const { next, error } = planHooks(text, hostId, {
    enable,
    bootstrap,
    entrypoint: projectForgeLauncher(root).args[0],
  });
  if (error) return { ...row, action: "skipped", note: error };
  if (next === null) {
    if (text === null) return { ...row, action: "unchanged", note: "no hooks" };
    unlinkSync(path);
    return { ...row, action: "removed", note: "hooks off" };
  }
  const action = writeAtomicIfChanged(path, next);
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
  const owners = new Set(
    Object.entries(HOSTS)
      .filter(([id, host]) =>
        named ? named.includes(id) || named.includes(host.tool) : emits(host.tool),
      )
      .map(([id, host]) => host.via || id),
  );
  return HOOK_HOSTS.filter((id) => owners.has(id));
}

/**
 * `forge sync`'s share: keep the hook files current once a repository has turned them on.
 * Silent (no rows) while `hooks.project` is not true.
 * @param {{targetRoot: string, config: Record<string, any>, emits?: (toolKey: string) => boolean}} o
 */
export function emitProjectHooks({ targetRoot, config, emits }) {
  if (config?.hooks?.project !== true) return [];
  return reconcileProjectHooks(targetRoot, selectedHosts(config, emits), {
    bootstrap: config.hooks.bootstrap === true,
  });
}

/** Plan the complete selection before touching any file. Undo successfully applied changes
 * if a subsequent write fails, respecting concurrent edits by a different writer. */
export function reconcileProjectHooks(
  root,
  selected,
  { bootstrap = false, showInactive = false } = {},
) {
  const entrypoint = projectForgeLauncher(root).args[0];
  const changes = [];
  for (const id of HOOK_HOSTS) {
    const host = HOSTS[id];
    const enable = selected.includes(id);
    const path = host.file ? join(root, host.file) : null;
    const before = path && existsSync(path) ? readFileSync(path, "utf8") : null;
    if (
      !enable &&
      !showInactive &&
      (!before ||
        (host.layout === "module" ? planPlugin(before).error : !isForgeHookCommand(before)))
    )
      continue;
    let after = before;
    if (path) {
      const plan =
        host.layout === "module"
          ? !enable && !before
            ? { next: null }
            : planPlugin(before, { entrypoint })
          : planHooks(before, id, { enable, bootstrap, entrypoint });
      if (plan.error) {
        if (!enable && !isForgeHookCommand(before)) continue;
        throw new Error(`Cannot reconcile ${host.file}: ${plan.error}`);
      }
      after = host.layout === "module" && !enable ? null : plan.next;
    }
    changes.push({ id, enable, path, before, after });
  }
  const applied = [];
  try {
    const rows = [];
    for (const item of changes) {
      if (item.path && readText(item.path) !== item.before)
        throw new Error(`Hook file changed during reconciliation: ${item.path}`);
      const row = applyHooks(root, item.id, { enable: item.enable, bootstrap });
      if (row) rows.push(row);
      if (item.path && item.before !== item.after) applied.push(item);
    }
    return rows;
  } catch (err) {
    for (const item of applied.reverse()) {
      if (readText(item.path) !== item.after) continue;
      if (item.before === null) unlinkSync(item.path);
      else writeAtomicIfChanged(item.path, item.before);
    }
    throw err;
  }
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
      return {
        host: id,
        label: host.label,
        file: null,
        state: record?.enabled === true && kimiPluginEnabled(config) ? "enabled in Kimi" : "off",
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
    if (host.layout === "module") {
      const text = readText(join(root, host.file));
      const { next, error } = planPlugin(text, { entrypoint: projectForgeLauncher(root).args[0] });
      return {
        host: id,
        label: host.label,
        file: host.file,
        state: text === null || error ? "off" : next === text ? "on" : "stale",
        note: error ?? host.trust,
      };
    }
    const text = readText(join(root, host.file));
    const wired = isForgeHookCommand(text);
    const { next } = planHooks(text, id, {
      enable: true,
      bootstrap,
      entrypoint: projectForgeLauncher(root).args[0],
    });
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

// Native registration for one packaged guard. Local settings contain host-specific absolute
// paths. Managed entries are exclusively identified by their full generated shape.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BRAND } from "../brand.js";
import { withConfigLock } from "../repo_config.js";
import { writeAtomicIfChanged } from "./_shared.js";
import { HOOK_TIMEOUT_S } from "./hooks.js";

export function installLocalHook(root, item, enable) {
  const dir = join(realpathSync(root), ".claude");
  const target = ".claude/settings.local.json";
  const path = join(dir, "settings.local.json");
  const result = (status) => ({
    id: item.id,
    host: "claude",
    scope: "project-local",
    target,
    status,
  });
  if (!enable && !existsSync(dir)) return result("absent");
  if (enable) mkdirSync(dir, { recursive: true });
  if (!lstatSync(dir).isDirectory())
    throw new Error("Claude local settings must use a regular project directory");
  return withConfigLock(path, () => {
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (file && !file.isFile()) throw new Error("Claude local settings must be a regular file");
    const settings = file ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      (settings.hooks !== undefined &&
        (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)))
    )
      throw new Error("Invalid Claude local settings");
    const prior = settings.hooks?.[item.event] ?? [];
    if (!Array.isArray(prior)) throw new Error("Invalid Claude event hooks");
    const command = {
      type: "command",
      command: process.execPath,
      args: [
        join(BRAND.root, "src", "cli.js"),
        "hooks",
        "local-run",
        "claude",
        item.event,
        item.id,
      ],
      timeout: HOOK_TIMEOUT_S[item.event],
    };
    const groups = [...new Set(item.matchers)].map((matcher) => ({
      ...(matcher === "*" ? {} : { matcher }),
      hooks: [command],
    }));
    const matches = (group) => groups.some((entry) => isDeepStrictEqual(entry, group));
    // If a person changed our group, leave the entire group (including any new commands)
    // for them to reconcile. Installing another copy could execute a guard twice.
    const partial = prior.some(
      (group) =>
        !matches(group) &&
        Array.isArray(group?.hooks) &&
        group.hooks.some(
          (h) =>
            Array.isArray(h?.args) &&
            h.args[1] === "hooks" &&
            h.args[2] === "local-run" &&
            h.args[3] === "claude" &&
            h.args[4] === item.event &&
            h.args[5] === item.id,
        ),
    );
    if (partial)
      throw new Error(
        "Existing local hook has been customized or points to a different installation",
      );
    const kept = prior.filter((group) => !matches(group));
    if (!enable && kept.length === prior.length) return result("absent");
    const next = enable ? [...kept, ...groups] : kept;
    if (isDeepStrictEqual(next, prior)) return result("enabled");
    const hooks = { ...settings.hooks };
    if (next.length) hooks[item.event] = next;
    else delete hooks[item.event];
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
    writeAtomicIfChanged(path, JSON.stringify(settings, null, 2) + "\n");
    return result(enable ? "enabled" : "disabled");
  });
}

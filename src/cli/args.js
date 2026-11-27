// Strict argument checking for commands whose help entry is complete.
//
// A command whose COMMANDS entry sets `strict: true` has its arguments checked here before
// its handler runs. The option list is derived from the same `flags` array that `--help`
// prints, so help and parsing cannot drift: a flag that is not documented is refused, and a
// documented flag is always accepted. Parsing itself is Node's built-in `util.parseArgs`
// (stable since Node 20), not a hand-written loop.
//
// What is checked, beyond what parseArgs checks on its own:
//   - a flag that belongs to other subcommands (`for`) is refused with the ones it applies to;
//   - `values` restricts a flag to an enumeration;
//   - `int: {min, max}` requires an integer in range;
//   - a near miss gets a suggestion (`--jsn` -> `--json`).
// The handler still reads its own arguments; this layer only refuses what it would have
// silently misread, such as a misspelt flag that used to be folded into the task text.
import { parseArgs } from "node:util";
import { BRAND } from "../brand.js";
import { commandHelp } from "../commands.js";
import { suggest } from "../math.js";

/** Flags every command accepts. `--help`/`-h` never reach a handler; see cli.js run(). */
const GLOBAL_FLAGS = ["--verbose"];

/**
 * @typedef {{flag: string, desc: string, for?: string[], values?: string[],
 *   int?: {min?: number, max?: number}, multiple?: boolean, requires?: string}} FlagSpec
 */

/**
 * The parseArgs option table for one command's flag list. Entries that are not a `--name`
 * (positional placeholders such as `[<file>…]`) are skipped. A flag takes a value when its
 * label carries one (`--top <n>`, `--task "<terms>"`, `--sandbox <auto|required|off>`).
 * @param {FlagSpec[]} flags
 */
export function optionTable(flags) {
  /** @type {Record<string, {type: "string"|"boolean", multiple?: boolean}>} */
  const options = {};
  /** @type {Record<string, FlagSpec>} */
  const byName = {};
  for (const f of flags) {
    const m = /^--([a-z][a-z0-9-]*)(\s+["<[])?/.exec(f.flag);
    if (!m) continue;
    const name = m[1];
    options[name] = {
      type: m[2] ? "string" : "boolean",
      ...(f.multiple ? { multiple: true } : {}),
    };
    byName[name] = f;
  }
  for (const g of GLOBAL_FLAGS) options[g.slice(2)] ??= { type: "boolean" };
  return { options, byName };
}

/** A usage error: the message names the problem; the caller prints it and exits 1. */
export class UsageError extends Error {}

/**
 * Check `argv` (as the handler receives it: argv[0] is the command) against the command's
 * documented flags. Returns null for a command that is not strict, otherwise the parsed
 * `{values, positionals, sub}`. Throws UsageError on anything the help does not allow.
 * @param {string} name
 * @param {string[]} argv
 */
export function checkArgs(name, argv) {
  const help = commandHelp(name);
  const entry = help?.strict ? help : null;
  if (!entry) return null;
  const { options, byName } = optionTable(entry.flags);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      options,
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    const err = /** @type {Error & {code?: string}} */ (e);
    const bad = /'(-{1,2}[^' ]+)/.exec(err.message)?.[1] ?? "";
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const known = Object.keys(options).map((o) => `--${o}`);
      const near = suggest(bad.replace(/=.*$/, ""), known);
      throw new UsageError(`unknown flag ${bad}${near ? ` (did you mean ${near}?)` : ""}`);
    }
    if (err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const opt = /--[a-z0-9-]+/.exec(err.message)?.[0] ?? bad;
      const spec = byName[opt.slice(2)];
      const takes = spec ? spec.flag.slice(opt.length).trim() : "a value";
      throw new UsageError(
        options[opt.slice(2)]?.type === "boolean"
          ? `${opt} takes no value`
          : `${opt} needs a value ${takes}`.trim(),
      );
    }
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;
  const sub = entry.subcommands.includes(positionals[0]) ? positionals[0] : entry.defaultSub;
  for (const [key, value] of Object.entries(values)) {
    const spec = byName[key];
    if (!spec) continue;
    if (spec.for && !(sub && spec.for.includes(sub)))
      throw new UsageError(`--${key} applies to ${spec.for.join(", ")}, not ${sub ?? "this form"}`);
    if (spec.requires && values[spec.requires.slice(2)] === undefined)
      throw new UsageError(`--${key} only applies together with ${spec.requires}`);
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== "string") continue;
      if (spec.values && !spec.values.includes(v))
        throw new UsageError(`--${key} must be one of ${spec.values.join(", ")}, got "${v}"`);
      if (spec.int) {
        const n = Number(v);
        const { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = spec.int;
        if (!/^-?\d+$/.test(v) || n < min || n > max)
          throw new UsageError(
            `--${key} must be a whole number${Number.isFinite(min) ? ` from ${min}` : ""}${Number.isFinite(max) ? ` to ${max}` : ""}, got "${v}"`,
          );
      }
    }
  }
  return { values, positionals, sub };
}

/**
 * Run checkArgs for the dispatcher: on a usage error print it with the usage line and the
 * help hint, set exit status 1, and return false so the handler is not called.
 * @param {string} name
 * @param {string[]} argv
 */
export function guardArgs(name, argv) {
  try {
    checkArgs(name, argv);
    return true;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const usage = commandHelp(name)?.usage;
    process.stderr.write(
      `${BRAND.cli} ${name}: ${e.message}\n` +
        (usage ? `usage: ${usage}\n` : "") +
        `Run \`${BRAND.cli} ${name} --help\` for every flag.\n`,
    );
    process.exitCode = 1;
    return false;
  }
}

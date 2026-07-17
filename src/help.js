// forge help — per-command help rendering. cli.js advertises `forge <cmd> --help` in
// the top-level banner; this module makes that real. Help is rendered from the same
// COMMANDS table docs_check reconciles, via commandHelp() (which normalizes string and
// object entries), so a command's help can never drift from its documented existence.
import { BRAND } from "./brand.js";
import { commandHelp, COMMANDS } from "./commands.js";
import { heading, paint } from "./fmt.js";
import { suggest } from "./math.js";

/**
 * Print detailed help for one command: summary, usage, flags, examples, env. Falls back
 * to a "did you mean" suggestion for an unknown name. Returns an exit code (0 known,
 * 1 unknown) so the CLI can set process.exitCode.
 * @param {string} name
 * @returns {number}
 */
export function printCommandHelp(name) {
  const help = commandHelp(name);
  if (!help) {
    const near = suggest(name, Object.keys(COMMANDS));
    process.stderr.write(
      `Unknown command: ${name}${near ? ` — did you mean \`${BRAND.cli} ${near}\`?` : ""}\n` +
        `Run \`${BRAND.cli} --help\` to see all commands.\n`,
    );
    return 1;
  }
  const out = [];
  out.push(heading(`${BRAND.cli} ${name}`));
  if (help.summary) out.push(`  ${help.summary}`);
  out.push("");
  out.push(paint("Usage:", "dim"));
  out.push(`  ${help.usage || `${BRAND.cli} ${name}`}`);
  if (help.flags.length) {
    out.push("");
    out.push(paint("Flags:", "dim"));
    const w = Math.max(...help.flags.map((f) => f.flag.length));
    for (const f of help.flags) out.push(`  ${f.flag.padEnd(w)}  ${f.desc}`);
  }
  if (help.env.length) {
    out.push("");
    out.push(paint("Environment:", "dim"));
    for (const e of help.env) out.push(`  ${e}`);
  }
  if (help.examples.length) {
    out.push("");
    out.push(paint("Examples:", "dim"));
    for (const ex of help.examples) out.push(`  ${ex}`);
  }
  console.log(out.join("\n"));
  return 0;
}

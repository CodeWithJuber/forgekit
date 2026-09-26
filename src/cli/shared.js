// forge CLI — presentation helpers shared by every command module (src/cli.js and
// src/cli/*.js), defined once so the handler modules cannot drift apart.
import { BRAND } from "../brand.js";
// Color is capability-gated (FORCE_COLOR > NO_COLOR > TERM=dumb > TTY) — piped
// output stays byte-plain, so nothing downstream ever parses an escape code.
import { bar, heading as fmtHeading, paint, table } from "../fmt.js";

export { BRAND, bar, paint, table };

// Per-command title lines ("Forge <cmd> — …") are branding chrome, not results. They
// print only when asked (`--verbose` or FORGE_VERBOSE=1); by default a command emits
// just its output. The `--help`/`--version` banner is unaffected.
export const VERBOSE = process.argv.includes("--verbose") || process.env.FORGE_VERBOSE === "1";
export const heading = (text) => {
  if (VERBOSE) console.log(fmtHeading(text));
};

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BRAND } from "../src/brand.js";
import { bar, heading, paint, supportsColor, supportsTruecolor, table } from "../src/fmt.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TTY = { isTTY: true };
const PIPE = { isTTY: false };

test("supportsColor precedence: FORCE_COLOR > NO_COLOR > TERM=dumb > isTTY", () => {
  // FORCE_COLOR wins both ways — even against NO_COLOR and a non-TTY stream.
  assert.equal(supportsColor(PIPE, { FORCE_COLOR: "1", NO_COLOR: "1" }), true);
  assert.equal(supportsColor(TTY, { FORCE_COLOR: "0" }), false);
  assert.equal(supportsColor(PIPE, { FORCE_COLOR: "" }), false, "empty FORCE_COLOR is unset");
  // NO_COLOR (non-empty) beats a TTY; empty NO_COLOR is unset per no-color.org.
  assert.equal(supportsColor(TTY, { NO_COLOR: "1" }), false);
  assert.equal(supportsColor(TTY, { NO_COLOR: "" }), true);
  // TERM=dumb beats a TTY.
  assert.equal(supportsColor(TTY, { TERM: "dumb" }), false);
  // Otherwise: color iff TTY.
  assert.equal(supportsColor(TTY, {}), true);
  assert.equal(supportsColor(PIPE, {}), false);
  assert.equal(supportsColor(undefined, {}), supportsColor(process.stdout, {}));
});

test("supportsTruecolor reads COLORTERM", () => {
  assert.equal(supportsTruecolor({ COLORTERM: "truecolor" }), true);
  assert.equal(supportsTruecolor({ COLORTERM: "24bit" }), true);
  assert.equal(supportsTruecolor({ COLORTERM: "8bit" }), false);
  assert.equal(supportsTruecolor({}), false);
});

test("paint: identity when disabled or role unknown; SGR-wrapped when enabled", () => {
  assert.equal(paint("hi", "ok", { enabled: false }), "hi");
  // @ts-expect-error deliberately bad role — must never corrupt output
  assert.equal(paint("hi", "nonsense", { enabled: true }), "hi");
  const t = paint("hi", "ok", { enabled: true, truecolor: false });
  assert.equal(t, "\x1b[32mhi\x1b[0m");
  assert.equal(paint(42, "err", { enabled: false }), "42", "non-strings coerce");
});

test("paint truecolor uses the brand.json dark palette hex", () => {
  const t = paint("x", "ok", { enabled: true, truecolor: true });
  // brand.json colors.dark.ok — decompose the hex the same way fmt.js must.
  const n = Number.parseInt(BRAND.colors.dark.ok.slice(1), 16);
  assert.equal(t, `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}mx\x1b[0m`);
});

test("heading: bold + accent when enabled, plain otherwise", () => {
  assert.equal(heading("Title", { enabled: false }), "Title");
  const h = heading("Title", { enabled: true, truecolor: false });
  assert.equal(h.startsWith("\x1b[1m"), true, "bold on");
  assert.equal(h.includes("Title"), true);
  assert.equal(h.endsWith("\x1b[22m"), true, "bold off");
});

test("bar: clamped confidence meter", () => {
  assert.equal(bar(0), "░░░░░░░░░░");
  assert.equal(bar(1), "██████████");
  assert.equal(bar(0.5), "█████░░░░░");
  assert.equal(bar(0.72, 5), "████░");
  assert.equal(bar(7), "██████████", "clamps above 1");
  assert.equal(bar(-3), "░░░░░░░░░░", "clamps below 0");
  assert.equal(bar(Number.NaN), "░░░░░░░░░░", "NaN → 0");
  assert.equal(bar(1, 0), "█", "width floor of 1");
});

test("table aligns on VISIBLE width — painted cells line up with plain ones", () => {
  const rows = [
    [paint("ok", "ok", { enabled: true, truecolor: false }), "short", "end"],
    ["longer-cell", "x", "tail"],
  ];
  const out = table(rows);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes is the point
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(strip(lines[0]), "  ok           short  end");
  assert.equal(strip(lines[1]), "  longer-cell  x      tail");
  assert.equal(/\s$/.test(lines[0]), false, "last column never padded");
  assert.equal(table([]), "");
  assert.equal(table(undefined), "");
  assert.equal(table([["a", "b"]], { indent: "" }), "a  b");
});

// End-to-end wiring: the CLI honors the env contract through a real spawn.
test("CLI: FORCE_COLOR=1 colors piped output; NO_COLOR strips every escape byte", () => {
  const cwd = mkdtempSync(join(tmpdir(), "forge-fmt-"));
  const run = (env) =>
    spawnSync("node", [CLI, "doctor"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "",
        NO_COLOR: "",
        COLORTERM: "",
        ...env,
      },
    });
  const ESC = "\x1b[";
  const colored = run({ FORCE_COLOR: "1" });
  assert.equal(colored.stdout.includes(ESC), true, "escape codes present under FORCE_COLOR=1");
  const plain = run({ NO_COLOR: "1" });
  assert.equal(plain.stdout.includes(ESC), false, "no escape codes under NO_COLOR");
  // Piped without FORCE_COLOR: not a TTY → plain.
  const piped = run({});
  assert.equal(piped.stdout.includes(ESC), false, "piped output is plain by default");
});

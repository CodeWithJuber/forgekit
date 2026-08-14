import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Smoke-test the status line the way Claude Code invokes it: sample session JSON on
// stdin, ANSI segments on stdout. Guards the brand-truecolor palette, the segment
// structure, and the truecolor->256 fallback so a shell edit can't silently break it.
const script = fileURLToPath(new URL("../global/statusline.sh", import.meta.url));

const SAMPLE = JSON.stringify({
  workspace: { current_dir: "/tmp/project" },
  model: { display_name: "Opus 4.8" },
  cost: { total_cost_usd: 0.42, total_lines_added: 12, total_lines_removed: 3 },
  exceeds_200k_tokens: true,
  current_usage: {
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 100,
  },
});

const run = (json, env = {}) =>
  execFileSync("bash", [script], {
    input: json,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("statusline renders every segment from sample JSON", () => {
  const out = run(SAMPLE, { COLORTERM: "truecolor" });
  assert.match(out, /Opus 4\.8/, "model name");
  assert.match(out, /\$0\.420/, "session cost");
  assert.match(out, /\+12/, "lines added");
  assert.match(out, /-3/, "lines removed");
  assert.match(out, /90%/, "cache-hit rate = 900/(900+100)");
  assert.match(out, /ctx>200k/, "over-200k context warning");
  // Separators are " ·(dim) " — the middle dot is wrapped in ANSI, so match the char.
  assert.ok((out.match(/·/g) ?? []).length >= 5, "middle-dot separators between segments");
});

const ESC = String.fromCharCode(27); // avoid a control char in a regex literal

test("statusline uses exact brand hexes in 24-bit truecolor", () => {
  const out = run(SAMPLE, { COLORTERM: "truecolor" });
  // ember #f26430 = 242,100,48 — the brand accent, not the nearest xterm-256 index.
  assert.ok(out.includes(`${ESC}[38;2;242;100;48m`), "ember truecolor");
  assert.ok(out.includes(`${ESC}[38;2;103;232;165m`), "ok/green truecolor #67e8a5");
  assert.ok(out.includes(`${ESC}[38;2;125;114;99m`), "faint taupe truecolor #7d7263");
});

test("statusline falls back to 256-color when truecolor is unavailable", () => {
  const out = run(SAMPLE, { COLORTERM: "" });
  assert.ok(out.includes(`${ESC}[38;5;209m`), "256-color ember fallback");
  assert.ok(!out.includes("38;2;242;100;48"), "no truecolor sequence without COLORTERM");
});

test("statusline degrades gracefully on minimal input", () => {
  // Missing cost/diff/cache fields must not crash or emit 'null' segments.
  const out = run(JSON.stringify({ model: { display_name: "Haiku" } }));
  assert.match(out, /Haiku/);
  assert.doesNotMatch(out, /null/, "no literal null leaks into the line");
});

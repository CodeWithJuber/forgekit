// Hook token budget (hooks/budget.json + global/guards/run.mjs enforcement + lazy recall).
//
// Pins: per-event byte caps load from the shipped config; stdout past the cap is truncated
// with a "[truncated: N bytes over budget]" note; a guard that BLOCKS (exit 2) is never
// truncated (its verdict is security-critical); stderr is untouched; `--event <Name>` is
// stripped before the guard runs; SessionStart recall emits an index, not the full MEMORY.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOOK_BUDGET,
  defaultBudgetPath,
  loadBudget,
  truncateToBudget,
} from "../global/guards/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const guards = join(root, "global", "guards");
const launcher = join(guards, "run.mjs");
const win = process.platform === "win32";
const posixOnly = { skip: win && "bash guard scripts need POSIX" };

const shipped = JSON.parse(
  readFileSync(join(root, "hooks", "budget.json"), "utf8"),
);

// ------------------------------------------------------------------ config shape

test("hooks/budget.json: one config, per-event byte caps", () => {
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]) {
    const cap = shipped.events[event];
    assert.ok(
      Number.isInteger(cap) && cap > 0,
      `${event} must be a positive integer, got ${cap}`,
    );
  }
  assert.ok(
    Number.isInteger(shipped.default_bytes) && shipped.default_bytes > 0,
    "default_bytes must be a positive integer",
  );
});

// ------------------------------------------------------------------ loadBudget

test("defaultBudgetPath: resolves to the shipped hooks/budget.json, not global/hooks/", () => {
  // Regression pin: the first draft resolved two levels up (global/hooks/budget.json),
  // which does not exist — the launcher silently fell back to built-ins and a user's
  // edited budget never applied. The shipped file lives at <root>/hooks/budget.json.
  assert.equal(defaultBudgetPath(), join(root, "hooks", "budget.json"));
  assert.ok(defaultBudgetPath().endsWith(join("hooks", "budget.json")));
});

test("loadBudget: the shipped file loads", () => {
  const b = loadBudget({ env: {} });
  assert.deepEqual(b.events, shipped.events);
  assert.equal(b.default_bytes, shipped.default_bytes);
});

test("loadBudget: HOOK_TOKEN_BUDGET overrides per-event caps and the default", () => {
  const b = loadBudget({
    env: { HOOK_TOKEN_BUDGET: JSON.stringify({ SessionStart: 42 }) },
  });
  assert.equal(b.events.SessionStart, 42);
  assert.equal(b.events.PreToolUse, shipped.events.PreToolUse);
  const d = loadBudget({ env: { HOOK_TOKEN_BUDGET: "777" } });
  assert.equal(d.default_bytes, 777);
});

test("loadBudget: an invalid override never disables the budget", () => {
  const b = loadBudget({ env: { HOOK_TOKEN_BUDGET: "not-json{{{" } });
  assert.deepEqual(b, loadBudget({ env: {} }));
});

test("loadBudget: a missing config falls back to the built-in defaults (fail safe)", () => {
  const b = loadBudget({
    env: {},
    budgetPath: join(tmpdir(), "forge-no-such-budget.json"),
  });
  assert.deepEqual(b, {
    default_bytes: DEFAULT_HOOK_BUDGET.default_bytes,
    events: { ...DEFAULT_HOOK_BUDGET.events },
  });
});

// ------------------------------------------------------------------ truncateToBudget

test("truncateToBudget: under the cap passes through untouched", () => {
  const t = truncateToBudget("hello", 100);
  assert.equal(t.text, "hello");
  assert.equal(t.truncated, false);
  assert.equal(t.over, 0);
});

test("truncateToBudget: over the cap truncates and names the overage", () => {
  const t = truncateToBudget("x".repeat(5000), 100);
  assert.equal(t.truncated, true);
  assert.equal(t.over, 4900);
  assert.ok(t.text.endsWith("[truncated: 4900 bytes over budget]"));
  const body = t.text.split("\n[truncated:")[0];
  assert.ok(
    Buffer.byteLength(body, "utf8") <= 100,
    `body is ${Buffer.byteLength(body)} bytes`,
  );
});

test("truncateToBudget: never splits a UTF-8 character", () => {
  // "é" is 2 bytes; a cap landing mid-character must drop the partial char, not emit U+FFFD.
  const text = `${"a".repeat(99)}é${"b".repeat(99)}`; // é spans bytes 99..100
  const t = truncateToBudget(text, 100);
  assert.equal(t.truncated, true);
  const body = t.text.split("\n[truncated:")[0];
  assert.ok(!body.includes("�"), "no replacement character");
  assert.ok(Buffer.byteLength(body, "utf8") <= 100);
  assert.ok(body.endsWith("a"), "partial é dropped, kept whole chars");
});

// ------------------------------------------------------------------ launcher end to end (real bash)

function launch(args, { env = process.env, input = "" } = {}) {
  const r = spawnSync(process.execPath, [launcher, ...args], {
    input,
    encoding: "utf8",
    env,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function bigGuard(dir, name, { bytes = 5000, exit = 0 } = {}) {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/usr/bin/env bash\nhead -c ${bytes} /dev/zero | tr '\\0' 'x'; echo; exit ${exit}\n`,
  );
  return p;
}

const budgetedEnv = (over) => ({ ...process.env, HOOK_TOKEN_BUDGET: over });

test(
  "launcher: stdout past the event cap is truncated with the overage note",
  posixOnly,
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-budget-"));
    try {
      const g = bigGuard(dir, "big.sh", { bytes: 5000, exit: 0 });
      const r = launch(["--event", "SessionStart", g], {
        env: budgetedEnv(JSON.stringify({ SessionStart: 100 })),
      });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /\[truncated: \d+ bytes over budget\]/);
      const body = r.out.split("\n[truncated:")[0];
      assert.ok(
        Buffer.byteLength(body, "utf8") <= 100,
        `body is ${Buffer.byteLength(body)} bytes`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "launcher: a BLOCK verdict (exit 2) is never truncated — fail closed",
  posixOnly,
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-budget-"));
    try {
      const g = bigGuard(dir, "block.sh", { bytes: 5000, exit: 2 });
      const r = launch(["--event", "PreToolUse", g], {
        env: budgetedEnv(JSON.stringify({ PreToolUse: 100 })),
      });
      assert.equal(r.code, 2, r.err);
      assert.doesNotMatch(r.out, /\[truncated:/);
      assert.ok(
        Buffer.byteLength(r.out, "utf8") > 100,
        "the full block output survived, uncapped",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "launcher: a missing --event falls back to the default budget",
  posixOnly,
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-budget-"));
    try {
      const g = bigGuard(dir, "big.sh", { bytes: 5000, exit: 0 });
      const r = launch([g], { env: budgetedEnv("100") });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /\[truncated: 4901 bytes over budget\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "launcher: --event is stripped — the guard never sees it",
  posixOnly,
  () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-budget-"));
    try {
      const g = join(dir, "echo-args.sh");
      writeFileSync(g, "#!/usr/bin/env bash\nprintf '<%s>' \"$@\"; echo\n");
      const r = launch(["--event", "Stop", g, "capture"], {
        env: budgetedEnv("{}"),
      });
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out.trim(), "<capture>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ------------------------------------------------------------------ lazy recall

test(
  "recall-load.sh: SessionStart emits an index, never the full text",
  posixOnly,
  () => {
    const home = mkdtempSync(join(tmpdir(), "forge-recall-"));
    try {
      mkdirSync(join(home, "recall"), { recursive: true });
      const body = `${"# Memory\n\n## Facts\n\n"}${"- SECRET-BODY-LINE\n".repeat(2000)}`;
      writeFileSync(join(home, "recall", "MEMORY.md"), body);
      const r = spawnSync("bash", [join(guards, "recall-load.sh")], {
        encoding: "utf8",
        env: { ...process.env, FORGE_HOME: home },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        Buffer.byteLength(r.stdout, "utf8") < 3000,
        `index is ${Buffer.byteLength(r.stdout)} bytes for a ${(body.length / 1024).toFixed(0)}KB store`,
      );
      assert.match(r.stdout, /## Facts/);
      assert.match(r.stdout, /Full text:/);
      assert.doesNotMatch(r.stdout, /SECRET-BODY-LINE/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// P0 regression tests for the config-attestation fix in format-on-edit.sh
// (2026-10-11): the hook used to check the HOOK's CWD for config existence and let
// ruff/biome discover (or default) their config from ambient state, so a file edited
// outside the hook's CWD was silently rewritten with defaults or the wrong project's
// config. Now the hook walks UP from the edited file's directory, passes the resolved
// config explicitly (--config / --config-path), logs it, and skips when none exists.
//
// The suite is hermetic: stub `ruff`/`biome` binaries on a minimal PATH record the
// exact argv the hook invokes them with. (POSIX-only: shell stubs + symlinked tool
// dirs — skipped on win32, following the noTimeoutSkip convention in guards.test.js.)
const skipWin = process.platform === "win32" && "symlinked stub PATH (no exec-bit semantics)";

const hook = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "global",
  "guards",
  "format-on-edit.sh",
);

// Minimal tool dir: the hook itself needs bash/sh/cat/dirname; _guardlib.sh needs node;
// the ruff stub additionally needs grep/tr/mv for its format emulation.
function toolBin(extra = {}) {
  const bin = mkdtempSync(join(tmpdir(), "forge-fmtonedit-"));
  for (const t of ["bash", "sh", "cat", "dirname", "grep", "tr", "mv"]) {
    const real = execFileSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, t));
  }
  symlinkSync(process.execPath, join(bin, "node"));
  for (const [name, body] of Object.entries(extra)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

// Stub ruff: records its argv to $FORGE_FMT_CALLS and — only for `format` — emulates
// ruff's formatting honoring the EXPLICITLY PASSED --config (quote-style), so the test
// can prove the hook drove the file's own config rather than CWD state.
const RUFF_STUB = `#!/bin/sh
echo "$@" >> "$FORGE_FMT_CALLS"
cfg=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--config" ]; then cfg="$a"; fi
  prev="$a"
done
if echo "$@" | grep -q "format"; then
  for a in "$@"; do
    case "$a" in *.py) target="$a";; esac
  done
  if grep -q 'quote-style = "single"' "$cfg" 2>/dev/null; then
    tr '"' "'" < "$target" > "$target.tmp" && mv "$target.tmp" "$target"\n
  fi
fi
exit 0
`;

// Stub biome: just records argv (the hook never expects output from it).
const BIOME_STUB = `#!/bin/sh
echo "$@" >> "$FORGE_FMT_CALLS"
exit 0
`;

function runHook(fpath, { bin, cwd, envExtra = {} }) {
  const r = spawnSync("bash", [hook], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: fpath } }),
    cwd,
    env: { PATH: bin, TMPDIR: tmpdir(), ...envExtra },
    encoding: "utf8",
  });
  return { code: r.status ?? 1, out: r.stdout || "", err: r.stderr || "" };
}

function callsOf(tmp) {
  return readFileSync(join(tmp, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
}

const SINGLE = `[tool.ruff]
line-length = 100

[tool.ruff.lint]
select = ["E", "F"]

[tool.ruff.format]
quote-style = "single"
`;

test("ruff: no config anywhere above the file → skipped, file untouched, ruff never runs --write/--fix", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmta-"));
  const bin = toolBin({ ruff: RUFF_STUB });
  const calls = join(tmp, "calls.log");
  writeFileSync(calls, "");
  const proj = join(tmp, "noconfig");
  const cwdProj = join(tmp, "cwdproj");
  const f = join(proj, "app.py");
  execFileSync("bash", ["-c", `mkdir -p ${proj} ${cwdProj}`]);
  writeFileSync(f, `handler = "ok"\nmsg = 'x'\n`);
  // A CWD config must NOT rescue the file: discovery is anchored to the FILE's dir.
  // (It lives in a non-ancestor dir, so the upward walk from the file never sees it.)
  writeFileSync(join(cwdProj, "pyproject.toml"), SINGLE);

  const r = runHook(f, { bin, cwd: cwdProj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0, "hook never fails the turn");
  assert.equal(readFileSync(f, "utf8"), `handler = "ok"\nmsg = 'x'\n`, "file untouched");
  assert.equal(callsOf(tmp).length, 0, "ruff was never invoked");
  assert.match(r.err, /no ruff config found/, "skip reason logged");
  assert.match(r.err, /never --write\/--fix on defaults/, "skip reason names the policy");
});

test("ruff: the FILE's own config is passed explicitly even when the CWD has a different config", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtb-"));
  const bin = toolBin({ ruff: RUFF_STUB });
  const calls = join(tmp, "calls.log");
  writeFileSync(calls, "");
  const fileProj = join(tmp, "fileproj");
  const cwdProj = join(tmp, "cwdproj");
  execFileSync("bash", ["-c", `mkdir -p ${fileProj} ${cwdProj}`]);
  writeFileSync(join(fileProj, "pyproject.toml"), SINGLE);
  writeFileSync(
    join(cwdProj, "pyproject.toml"),
    SINGLE.replace('quote-style = "single"', 'quote-style = "double"'),
  );
  const f = join(fileProj, "app.py");
  writeFileSync(f, `handler = "ok"\n`);

  // CWD = the other project. A CWD-anchored hook would format with double quotes.
  const r = runHook(f, { bin, cwd: cwdProj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  const argv = callsOf(tmp).join("\n");
  assert.match(argv, new RegExp(`--config ${fileProj}/pyproject.toml`), "file's own config passed");
  assert.doesNotMatch(argv, new RegExp(cwdProj), "CWD config never consulted");
  assert.match(
    r.err,
    new RegExp(`ruff config: ${fileProj}/pyproject.toml`),
    "resolved config logged",
  );
  assert.equal(readFileSync(f, "utf8"), `handler = 'ok'\n`, "formatted per the FILE's config");
});

test("ruff: config in a PARENT dir of the file is found by the upward walk", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtc-"));
  const bin = toolBin({ ruff: RUFF_STUB });
  const calls = join(tmp, "calls.log");
  writeFileSync(calls, "");
  const proj = join(tmp, "proj");
  const deep = join(proj, "sub", "deep");
  execFileSync("bash", ["-c", `mkdir -p ${deep}`]);
  writeFileSync(join(proj, "pyproject.toml"), SINGLE);
  const f = join(deep, "app.py");
  writeFileSync(f, `handler = "ok"\n`);

  const r = runHook(f, { bin, cwd: tmp, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  assert.match(
    callsOf(tmp).join("\n"),
    new RegExp(`--config ${proj}/pyproject.toml`),
    "nearest ancestor config passed",
  );
  assert.match(r.err, new RegExp(`ruff config: ${proj}/pyproject.toml`));
  assert.equal(readFileSync(f, "utf8"), `handler = 'ok'\n`);
});

test("biome: the FILE's own biome.json is used via --config-path even from a wrong CWD", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtd-"));
  // Trusted biome on PATH (the user's own install). Project-local binaries are
  // untrusted and must NEVER be executed (P1 supply-chain fix, 2026-10-11): the
  // weaponized stubs below fail the test if the hook ever runs them.
  const bin = toolBin({ biome: BIOME_STUB });
  const calls = join(tmp, "calls.log");
  const evil = join(tmp, "evil.log");
  writeFileSync(calls, "");
  writeFileSync(evil, "");
  const fileProj = join(tmp, "fileproj");
  const cwdProj = join(tmp, "cwdproj");
  for (const p of [fileProj, cwdProj]) {
    const bindir = join(p, "node_modules", ".bin");
    execFileSync("bash", ["-c", `mkdir -p ${bindir}`]);
    writeFileSync(
      join(bindir, "biome"),
      `#!/bin/sh\necho "PROJECT-BINARY-EXECUTED $@" >> "${evil}"\nexit 0\n`,
    );
    chmodSync(join(bindir, "biome"), 0o755);
  }
  writeFileSync(join(fileProj, "biome.json"), '{"formatter":{"indentStyle":"tab"}}\n');
  writeFileSync(
    join(cwdProj, "biome.json"),
    '{"formatter":{"indentStyle":"space","indentWidth":2}}\n',
  );
  const f = join(fileProj, "app.js");
  writeFileSync(f, "function f() {\n\treturn 1;\n}\n");

  // CWD = cwdproj (spaces). Old hook reformatted the file with the CWD config.
  const r = runHook(f, { bin, cwd: cwdProj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  const argv = callsOf(tmp).join("\n");
  assert.match(
    argv,
    new RegExp(`--config-path ${fileProj}/biome.json`),
    "file's own biome.json passed explicitly",
  );
  assert.doesNotMatch(argv, new RegExp(cwdProj), "CWD biome.json never consulted");
  assert.match(r.err, new RegExp(`biome config: ${fileProj}/biome.json`), "resolved config logged");
  assert.equal(
    readFileSync(evil, "utf8"),
    "",
    "project-local biome binary never executed (supply-chain)",
  );
});

test("biome: no biome.json above the file → biome never runs (no silent-default rewrite)", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmte-"));
  const bin = toolBin();
  const calls = join(tmp, "calls.log");
  writeFileSync(calls, "");
  // A biome binary + config in the CWD must NOT touch a file that has none of its own.
  const cwdProj = join(tmp, "cwdproj");
  const bindir = join(cwdProj, "node_modules", ".bin");
  execFileSync("bash", ["-c", `mkdir -p ${bindir}`]);
  writeFileSync(join(bindir, "biome"), BIOME_STUB);
  chmodSync(join(bindir, "biome"), 0o755);
  writeFileSync(join(cwdProj, "biome.json"), '{"formatter":{"indentStyle":"space"}}\n');
  const f = join(tmp, "plain", "app.js");
  execFileSync("bash", ["-c", `mkdir -p ${join(tmp, "plain")}`]);
  writeFileSync(f, "function f() {\n\treturn 1;\n}\n");

  const r = runHook(f, { bin, cwd: cwdProj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  assert.equal(callsOf(tmp).length, 0, "biome was never invoked");
  assert.equal(
    readFileSync(f, "utf8"),
    "function f() {\n\treturn 1;\n}\n",
    "file untouched (no prettier on the stub PATH either)",
  );
});

// Prettier gets the Biome rule: the hook used to run `npx --no-install prettier`, which
// resolves the project's own node_modules/.bin/prettier first (untrusted code), and ran it
// on Prettier's defaults in repos that never configured Prettier at all.
const PRETTIER_STUB = BIOME_STUB;

// A project whose node_modules/.bin/prettier and an `npx` on PATH both record to `evil`.
function plantedPrettierProject(tmp, evil) {
  const proj = join(tmp, "proj");
  const bindir = join(proj, "node_modules", ".bin");
  execFileSync("bash", ["-c", `mkdir -p ${bindir} ${join(proj, "components")}`]);
  writeFileSync(
    join(bindir, "prettier"),
    `#!/bin/sh\necho "PROJECT-LOCAL prettier executed with: $@" >> "${evil}"\nexit 0\n`,
  );
  chmodSync(join(bindir, "prettier"), 0o755);
  writeFileSync(join(proj, "package.json"), '{"name":"demo","private":true}\n');
  return proj;
}
const NPX_STUB = (evil) => `#!/bin/sh\necho "NPX executed with: $@" >> "${evil}"\nexit 0\n`;

test("prettier: project-local binary and npx never run; trusted prettier gets the file's --config", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtp-"));
  const calls = join(tmp, "calls.log");
  const evil = join(tmp, "evil.log");
  writeFileSync(calls, "");
  writeFileSync(evil, "");
  const bin = toolBin({ prettier: PRETTIER_STUB, npx: NPX_STUB(evil) });
  const proj = plantedPrettierProject(tmp, evil);
  writeFileSync(join(proj, ".prettierrc"), '{"semi":false}\n');
  const f = join(proj, "components", "Button.tsx");
  writeFileSync(f, "export const Button = () => <button>ok</button>;\n");

  const r = runHook(f, { bin, cwd: proj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  assert.equal(readFileSync(evil, "utf8"), "", "neither npx nor node_modules/.bin/prettier ran");
  const argv = callsOf(tmp).join("\n");
  assert.match(argv, new RegExp(`--write --config ${proj}/\\.prettierrc ${f}`));
  assert.match(
    r.err,
    new RegExp(`prettier config: ${proj}/\\.prettierrc`),
    "resolved config logged",
  );
});

test("prettier: no Prettier config above the file → never runs, even with package.json + prettier on PATH", {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtq-"));
  const calls = join(tmp, "calls.log");
  const evil = join(tmp, "evil.log");
  writeFileSync(calls, "");
  writeFileSync(evil, "");
  const bin = toolBin({ prettier: PRETTIER_STUB, npx: NPX_STUB(evil) });
  const proj = plantedPrettierProject(tmp, evil);
  const f = join(proj, "components", "Button.tsx");
  const src = "export const Button = () => <button>ok</button>;\n";
  writeFileSync(f, src);

  const r = runHook(f, { bin, cwd: proj, envExtra: { FORGE_FMT_CALLS: calls } });

  assert.equal(r.code, 0);
  assert.equal(callsOf(tmp).length, 0, "prettier never invoked");
  assert.equal(readFileSync(evil, "utf8"), "", "nothing project-local ran");
  assert.equal(readFileSync(f, "utf8"), src, "file untouched");
  assert.match(r.err, /no prettier config found/, "skip reason logged");
});

test('prettier: a package.json "prettier" key counts; a JS config or plugins are refused', {
  skip: skipWin || false,
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtr-"));
  const calls = join(tmp, "calls.log");
  const evil = join(tmp, "evil.log");
  writeFileSync(calls, "");
  writeFileSync(evil, "");
  const bin = toolBin({ prettier: PRETTIER_STUB, npx: NPX_STUB(evil) });
  const proj = plantedPrettierProject(tmp, evil);
  const f = join(proj, "components", "Button.tsx");
  writeFileSync(f, "export const Button = () => <button>ok</button>;\n");
  const env = { FORGE_FMT_CALLS: calls };

  writeFileSync(join(proj, "package.json"), '{"name":"demo","prettier":{"semi":false}}\n');
  let r = runHook(f, { bin, cwd: tmp, envExtra: env });
  assert.match(callsOf(tmp).join("\n"), new RegExp(`--config ${proj}/package\\.json`));

  writeFileSync(calls, "");
  writeFileSync(join(proj, "package.json"), '{"name":"demo","private":true}\n');
  writeFileSync(join(proj, "prettier.config.js"), "export default {};\n");
  r = runHook(f, { bin, cwd: tmp, envExtra: env });
  assert.equal(callsOf(tmp).length, 0, "an executable config is never handed to prettier");
  assert.match(r.err, /an executable config runs project code, skipping/);

  rmSync(join(proj, "prettier.config.js"));
  writeFileSync(join(proj, ".prettierrc.json"), '{"plugins":["prettier-plugin-x"]}\n');
  r = runHook(f, { bin, cwd: tmp, envExtra: env });
  assert.equal(callsOf(tmp).length, 0, "a config that loads plugins is never handed to prettier");
  assert.match(r.err, /loads plugins runs project code, skipping/);
  assert.equal(readFileSync(evil, "utf8"), "", "nothing project-local ran");
});

// Real-ruff end-to-end: the hook's `ruff format --config <file-config>` invocation must
// produce the config's formatting on a real binary. Skipped where ruff isn't installed
// (forgekit CI has python3 but no ruff) — the stub tests above cover the attestation.
const realRuff = (() => {
  try {
    return execFileSync("bash", ["-c", "command -v ruff"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

test("ruff (real binary): config present → formats correctly with the file's own config", {
  skip: realRuff ? skipWin || false : "ruff not installed",
}, () => {
  const tmp = mkdtempSync(join(tmpdir(), "forge-fmtf-"));
  const bin = toolBin();
  const proj = join(tmp, "proj");
  execFileSync("bash", ["-c", `mkdir -p ${proj}`]);
  writeFileSync(join(proj, "pyproject.toml"), SINGLE);
  const f = join(proj, "app.py");
  writeFileSync(f, `handler = "ok"\n`);

  const r = runHook(f, {
    bin,
    cwd: tmp,
    envExtra: { PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(r.code, 0);
  assert.match(r.err, new RegExp(`ruff config: ${proj}/pyproject.toml`));
  assert.equal(readFileSync(f, "utf8"), `handler = 'ok'\n`, "real ruff applied the file's config");
});

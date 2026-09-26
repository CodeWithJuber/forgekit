// forge verify — the independent verification layer. Deterministic-first and
// cross-tool: it trusts the project's OWN tests (never a benchmark number) and
// reuses `atlas` to flag calls to symbols that exist nowhere in the codebase
// (a cheap, zero-LLM hallucination signal). It emits a provenance stamp so a
// reviewer reads WHAT was checked, not the authoring transcript.
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { build as buildAtlas, has, isStale, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { readForgeConfig } from "./repo_config.js";
import {
  detectRunners,
  detectStack,
  matchesWorkspaceGlob,
  rootTestCoversWorkspaces,
} from "./stack.js";

// Shared call-site extractor — one source of truth with atlas.js (they used to duplicate this).
export { extractCalledSymbols } from "./extract.js";

import { extractCalledSymbols } from "./extract.js";

/** Pure: which called symbols are defined nowhere in the atlas (possible hallucinations). */
export function findUnknownSymbols(atlas, symbols) {
  return symbols.filter((s) => !has(atlas, s));
}

// git output can be large (a lockfile regen, a generated asset): the 1 MiB execFileSync
// default turned an over-size diff into "" — for computeCodeState that made every state
// with a big pending change hash identically, so a stale PASS survived later edits.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** @param {string[]} args @param {string} cwd — THROWS on any git error / overflow. */
function gitStrict(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  } catch (err) {
    if (process.env.FORGE_DEBUG === "1")
      process.stderr.write(`forge verify git: ${err?.message ?? err}\n`);
    return "";
  }
}

// ── Evidence authenticity (review B7). The provenance stamp and the Stop gate's
// block-once marker are plain files under `.forge/`, which the agent can write: a
// hand-written `{"tests":{"status":"PASS"}}` satisfied the gate's strong leg. They are now
// MAC'd with a machine-local key kept OUTSIDE the repo (the XDG state dir, mode 0600,
// created on first use), so a file written by hand — or copied from another checkout —
// does not verify.
//
// NOT a security boundary, and deliberately not sold as one: an agent with shell access can
// read the key. What it buys is that forging evidence is no longer a side effect of writing
// one JSON file in the project; it takes a deliberate, visible step outside the repo. Real
// unforgeability needs a signer the agent cannot reach (CI, or a helper process holding the
// key) — see the review's B7 note.
function evidenceKeyPath() {
  if (process.env.FORGE_HOME) return join(process.env.FORGE_HOME, "evidence.key");
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ? join(xdg, "forgekit") : join(homedir(), ".local", "state", "forgekit");
  return join(base, "evidence.key");
}

/**
 * The machine-local evidence key, created on first use. `null` only when the state dir is
 * unwritable AND no key exists — callers then degrade to unsigned evidence rather than
 * bricking the gate (a missing key cannot be an agent's doing: the gate creates it too).
 * @returns {string|null}
 */
export function evidenceKey() {
  const p = evidenceKeyPath();
  try {
    const k = readFileSync(p, "utf8").trim();
    if (k) return k;
  } catch {}
  try {
    mkdirSync(dirname(p), { recursive: true });
    const k = randomBytes(32).toString("hex");
    writeFileSync(p, `${k}\n`, { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {}
    return k;
  } catch {
    return null;
  }
}

/**
 * MAC over the claim an evidence file makes. `null` when no key is available.
 * @param {(string|null|undefined)[]} parts
 * @returns {string|null}
 */
export function evidenceMac(parts) {
  const key = evidenceKey();
  if (!key) return null;
  return createHmac("sha256", key)
    .update(parts.map((p) => String(p ?? "")).join("\u0000"))
    .digest("hex");
}

/** The MAC a `verify` provenance stamp must carry to count as test evidence. It covers the
 *  verdict, the code state it is bound to (fingerprint scheme included, so a stamp minted
 *  under an older, weaker fingerprint no longer verifies) and the verifier run id. */
export const provenanceMac = (prov) =>
  evidenceMac([
    "verify",
    prov?.codeState?.scheme ?? "",
    prov?.tests?.status,
    prov?.codeState?.dirtyHash,
    prov?.codeState?.head,
    prov?.event?.runId ?? "",
  ]);

/** Sign a provenance object in place (no-op when no key is available). */
export function signProvenance(prov) {
  const mac = provenanceMac(prov);
  if (mac) prov.signature = mac;
  return prov;
}

/** The fingerprint scheme. v2 (review F01): a canonical, length-delimited MANIFEST — the v1
 *  hash concatenated untracked files' bytes with no path and no boundary, so renaming an
 *  untracked file, or moving bytes from one file to the next, kept the same hash. */
export const CODE_STATE_SCHEME = "manifest-v2";

/**
 * The per-repo `verify` settings from `.forge/forge.config.json` (`verify` key), validated:
 *   - `workspaces`: "auto" (default — every nested package that declares a suite runs, unless
 *     the root script is a recursive workspace run) or "root" (an explicit declaration that the
 *     root test command covers every nested package).
 *   - `exclude`: package paths (workspace-glob syntax) that are not required suites.
 *   - `generated`: git glob pathspecs for outputs a test run may legitimately write (coverage
 *     reports, build output that is not gitignored). They are excluded from the code-state
 *     fingerprint EVERYWHERE, so they can never invalidate — or be vouched for by — a stamp.
 * Malformed values are dropped, never trusted.
 * @param {string} root
 * @returns {{workspaces: "auto"|"root", exclude: string[], generated: string[]}}
 */
export function verifyConfig(root) {
  let raw = {};
  try {
    raw = readForgeConfig(root)?.verify ?? {};
  } catch {}
  const strings = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  return {
    workspaces: raw?.workspaces === "root" ? "root" : "auto",
    exclude: strings(raw?.exclude),
    generated: strings(raw?.generated),
  };
}

// Interpreter/tool caches that are never source, whatever a repo's .gitignore says: running a
// suite writes them (pytest's __pycache__, .pytest_cache), and counting them as code changes
// would make every Python verify "mutated during the run". Always excluded, stated as policy.
export const BUILTIN_GENERATED = [
  "**/__pycache__/**",
  "**/*.pyc",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
];

// Canonical diff flags: binary-safe, no external drivers/textconv (repo attributes must not be
// able to hide a change), fixed prefixes and no rename detection (user config must not change
// the bytes that are hashed).
const DIFF_FLAGS = [
  "--binary",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/**
 * One manifest record for an untracked path — `[type, path, …]` as canonical JSON, so every
 * field is unambiguously delimited. Symlinks are recorded by TARGET (never followed); a nested
 * repository/directory entry (`sub/`) is bound by path only and reported in `unbound`; a
 * regular file by exec bit, size and content sha256. Throws when a file cannot be read — the
 * caller turns that into an unbindable state instead of hashing around the gap.
 * @param {string} cwd @param {string} rel
 */
function manifestRecord(cwd, rel) {
  const abs = join(cwd, rel);
  if (rel.endsWith("/")) return { record: ["dir", rel], unbound: true };
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return { record: ["symlink", rel, readlinkSync(abs)] };
  if (!st.isFile()) return { record: ["other", rel], unbound: true };
  // git tracks only the executable bit; on Windows it is not meaningful at all.
  const mode = platform() === "win32" ? "-" : st.mode & 0o111 ? "755" : "644";
  const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
  return { record: ["file", rel, mode, st.size, digest] };
}

/**
 * A fingerprint of the exact code state: HEAD plus the FULL working-tree change relative to
 * it — the unstaged diff, the staged diff, and a canonical manifest of every untracked
 * (non-ignored) path. Two states with the same `dirtyHash` have the same HEAD and
 * byte-identical pending changes, file NAMES and boundaries included, so a `verify` stamp can
 * be BOUND to the code state it validated (HI-02): at Stop the gate recomputes this and only
 * trusts the PASS when the hash still matches.
 *
 * Policy (review F01), stated so nothing is implicit:
 *   - tracked changes: `git diff` with canonical flags (paths, contents and mode changes);
 *   - untracked files: path + exec bit + size + sha256 — a rename, a repartition of bytes
 *     between files, an added EMPTY file, or a mode change all change the hash;
 *   - untracked symlinks: bound by their target string, never followed;
 *   - untracked nested repositories: bound by path only (their content is another repo's
 *     state) and listed in `unbound`;
 *   - gitignored files are not code state (generated/untracked-by-design), and neither are
 *     interpreter/tool caches (BUILTIN_GENERATED), the `verify.generated` pathspecs, or forge's
 *     own `.forge/` directory;
 *   - an untracked file that cannot be read makes the state UNBINDABLE (`dirtyHash: null`,
 *     `unbindable` says why) — never hashed around.
 * Never throws; `gitAvailable:false` / `dirtyHash:null` is the honest "cannot bind" signal
 * (the gate then refuses to count the stamp) — including when git cannot produce a diff (an
 * error or an over-size output hashes as "cannot bind", never as the empty diff). Pure w.r.t.
 * the tree — reads git + files, writes nothing.
 * @param {string} [cwd]
 * @returns {{head: string|null, dirtyHash: string|null, gitAvailable: boolean, scheme: string,
 *   unbound?: string[], unbindable?: string}}
 */
export function computeCodeState(cwd = process.cwd()) {
  const scheme = CODE_STATE_SCHEME;
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], cwd).trim() !== "true")
      return { head: null, dirtyHash: null, gitAvailable: false, scheme };
    const head = git(["rev-parse", "HEAD"], cwd).trim() || null;
    const generated = [...BUILTIN_GENERATED, ...verifyConfig(cwd).generated];
    // Generated outputs (built-in caches + what the repo declared) are excluded on BOTH sides.
    const excludes = generated.map((g) => `:(top,exclude,glob)${g}`);
    const trackedSpec = excludes.length ? ["--", ":/", ...excludes] : [];
    const untrackedSpec = excludes.length ? ["--", ".", ...excludes] : [];
    // Exclude forge's OWN state dir: writing provenance.json / session files must never
    // perturb the fingerprint the stamp is bound to (self-reference), and it's ignored in
    // real repos anyway — this keeps the hash stable even if a user forgot to gitignore it.
    const untracked = gitStrict(
      ["ls-files", "--others", "--exclude-standard", "-z", ...untrackedSpec],
      cwd,
    )
      .split("\0")
      .filter((f) => f && !f.startsWith(".forge/"))
      .sort();
    const h = createHash("sha256");
    // Every section is length-prefixed: no section's bytes can masquerade as another's.
    const section = (name, data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      h.update(`${name}\u0000${buf.length}\u0000`);
      h.update(buf);
    };
    section("scheme", scheme);
    section("head", head ?? "");
    section("generated", JSON.stringify(generated));
    // Unborn HEAD (no commit yet): index-vs-worktree + staged covers the whole change.
    section(
      "worktree",
      gitStrict(
        head
          ? ["diff", "HEAD", ...DIFF_FLAGS, ...trackedSpec]
          : ["diff", ...DIFF_FLAGS, ...trackedSpec],
        cwd,
      ),
    );
    section("index", gitStrict(["diff", "--cached", ...DIFF_FLAGS, ...trackedSpec], cwd));
    const unbound = [];
    const lines = [];
    for (const f of untracked) {
      let rec;
      try {
        rec = manifestRecord(cwd, f);
      } catch (err) {
        return {
          head,
          dirtyHash: null,
          gitAvailable: true,
          scheme,
          unbindable: `untracked file ${f} could not be read (${err?.code ?? "error"})`,
        };
      }
      if (rec.unbound) unbound.push(f);
      lines.push(JSON.stringify(rec.record));
    }
    section("untracked", lines.join("\n"));
    return {
      head,
      dirtyHash: h.digest("hex"),
      gitAvailable: true,
      scheme,
      ...(unbound.length ? { unbound } : {}),
    };
  } catch {
    return { head: null, dirtyHash: null, gitAvailable: false, scheme };
  }
}

// Run the project's OWN tests, driven off the stack detector (never a benchmark). The verdict
// is an honest four-state `status`:
//   PASS           — a real verifier ran and passed
//   FAIL           — a real verifier ran and failed
//   NOT_CONFIGURED — no test runner exists for this repo (nothing ran → NEVER ok)
//   INCOMPLETE     — a runner was expected but couldn't complete (timeout, executor binary
//                    missing, or no built-in executor for the detected command)
// The DETECTED runner is what actually executes (a pnpm/yarn/bun repo runs its own package
// manager, never a hardcoded `npm`), via the executor whitelist below — shell-free spawn of
// a known bin only, never npx (it can download arbitrary packages).
// `ran`/`passed` are kept for back-compat (consensus.js reads them). Bounded by a timeout
// (FORGE_VERIFY_TIMEOUT_MS, default 10 min) so a hanging test can't hang the gate.
/**
 * One executed (or attempted) suite's per-suite detail (HI-01/ME-02).
 * @typedef {object} SuiteResult
 * @property {string} label            human-readable runner command
 * @property {"PASS"|"FAIL"|"INCOMPLETE"} status
 * @property {string} [cwd]            where it ran, relative to the verified root ("." = root)
 * @property {string[]} [covers]       the package dirs this suite's verdict speaks for
 * @property {number|null} [exitCode]  process exit code (0 pass, non-zero fail, null if it never ran)
 * @property {string} [code]           spawn error code (ENOENT/EACCES/ENOEXEC/…) when it did not execute
 * @property {string} [signal]         terminating signal, if any
 * @property {boolean} [timedOut]      true when the suite was killed for exceeding the timeout
 * @property {string} [output]         tail of the suite's own output (failures)
 */
/**
 * Which package dirs needed a verdict, and which got one (review F08). `required` is "." (the
 * root, when it declares a suite) plus every nested package that declares its own suite and is
 * not excluded; `covered` ran to a verdict (PASS/FAIL) by some suite; `uncovered` did not.
 * @typedef {object} SuiteCoverage
 * @property {string[]} required
 * @property {string[]} covered
 * @property {string[]} uncovered
 * @property {{path: string, reason: string}[]} excluded
 * @property {boolean} rootCoversWorkspaces  the root command runs every declared workspace
 * @property {boolean} [truncated]           the package scan was a sample (non-git fallback)
 */
/**
 * @typedef {object} VerifyTests
 * @property {boolean} ran
 * @property {boolean} [passed]
 * @property {"PASS"|"FAIL"|"INCOMPLETE"|"NOT_CONFIGURED"} status
 * @property {string} [runner]
 * @property {boolean} [timedOut]
 * @property {string[]} [detected]
 * @property {SuiteResult[]} [executed]   every suite forge actually spawned, with its per-suite verdict
 * @property {string[]} [notExecuted]     labels of detected suites forge has no built-in executor for
 * @property {SuiteCoverage} [coverage]   which packages the verdict actually covers
 * @property {boolean} [mutated]          the code state changed while the suites ran (review F10)
 * @property {string} [output]
 */
// Bins forge is willing to execute directly. Everything else stays report-only.
const EXECUTORS = new Set(["npm", "pnpm", "yarn", "bun", "pytest"]);
// Fallback when a detectStack result has no `testRunners` field (older shape):
// rebuild descriptors from the command strings.
/** @param {string[]} cmds @returns {import("./stack.js").TestRunner[]} */
function parseRunnerStrings(cmds) {
  return cmds.map((c) => {
    const cmd = c.trim();
    const pm = /(^|\s)(npm|pnpm|yarn|bun)\s+test\b/.exec(cmd);
    if (pm) return { bin: pm[2], args: ["test"], label: `${pm[2]} test` };
    if (/\bpytest\b/.test(cmd)) return { bin: "pytest", args: ["-q"], label: "pytest -q" };
    return { label: cmd };
  });
}
// A `test` script that can never fail is not a verifier (review B7): `node --test || true`
// exits 0 whatever the tests do, so `forge verify` reported PASS and the Stop gate accepted
// it as evidence. Detect the failure-masking shapes and report INCOMPLETE — "the runner
// cannot produce a verdict" — instead of a PASS that proves nothing.
const MASKS_FAILURE = /(\|\||;)\s*(true\b|:\s*$|:\s|exit\s+0\b)|\|\|\s*echo\b|--passWithNoTests\b/;

/** The repo's `scripts.test` when it masks failure, else null. Pure w.r.t. the tree.
 *  @param {string} cwd @returns {string|null} */
export function maskedTestScript(cwd) {
  try {
    const script = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))?.scripts?.test;
    return typeof script === "string" && MASKS_FAILURE.test(script) ? script : null;
  } catch {
    return null;
  }
}

/** Is this descriptor one forge can execute directly (whitelisted bin, and a
 *  package.json present for the package-manager runners)? Pure. */
function isExecutable(r, cwd) {
  return !!(
    r?.bin &&
    EXECUTORS.has(r.bin) &&
    (r.bin === "pytest" || existsSync(join(cwd, "package.json")))
  );
}

/**
 * Classify ONE suite's spawn failure — pure, so every branch is testable without a real
 * signal (POSIX-only fixtures made the ME-02 case untestable on Windows, where a shebang
 * script cannot self-kill and simply exits with a real code). Only a completed run with a
 * real exit code is a FAIL; anything that never reached a verdict is INCOMPLETE.
 * @param {{code?: string, status?: number|null, signal?: string|null, stdout?: unknown, message?: string}} e
 * @param {{label: string, bin?: string, timeout: number}} ctx
 * @returns {SuiteResult}
 */
export function classifySuiteFailure(e, { label, bin, timeout }) {
  if (e.code === "ENOENT") {
    // The detected runner's binary isn't installed here — nothing ran, and silently
    // substituting another package manager would verify the wrong thing.
    return {
      label,
      status: "INCOMPLETE",
      exitCode: null,
      code: "ENOENT",
      output: `executor unavailable (${bin ?? label} not on PATH)`,
    };
  }
  if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
    // Killed for running too long — it started but never reached a verdict.
    return {
      label,
      status: "INCOMPLETE",
      exitCode: null,
      timedOut: true,
      signal: e.signal ?? undefined,
      output: `exceeded ${timeout}ms`,
    };
  }
  if (typeof e.status === "number") {
    // A real, completed run that exited non-zero — the ONLY true FAIL.
    return {
      label,
      status: "FAIL",
      exitCode: e.status,
      output: String(e.stdout || e.message || "").slice(-600),
    };
  }
  // EACCES / ENOEXEC / other spawn failure / signal termination: the suite did NOT
  // execute, so this is INCOMPLETE, never FAIL (ME-02).
  return {
    label,
    status: "INCOMPLETE",
    exitCode: null,
    code: e.code,
    signal: e.signal ?? undefined,
    output: `did not execute (${e.code || e.signal || "spawn error"})`,
  };
}

// Where nested packages hide that are NOT the project's own suites: test fixtures, recorded
// data, mocks. A declared workspace member is required even if its path matches.
const FIXTURE_SEGMENTS = new Set([
  "fixtures",
  "__fixtures__",
  "fixture",
  "testdata",
  "test-fixtures",
  "__mocks__",
]);
// Never required: vendored or generated trees (mirrors the stack walker's skip list).
const NON_SOURCE_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
]);
const PACKAGE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.py",
  "pytest.ini",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];

/**
 * Every nested package dir (relative, POSIX) under `root`. In a git work tree this is COMPLETE:
 * git lists every tracked or untracked-but-not-ignored manifest, so no package is missed by a
 * scan budget. Outside git it falls back to the stack detector's bounded walk, and says so.
 * @param {string} root
 * @param {ReturnType<typeof detectStack>} stack
 * @returns {{roots: string[], truncated: boolean}}
 */
function nestedPackages(root, stack) {
  const listed = git(
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...PACKAGE_MANIFESTS.map((m) => `:(glob)**/${m}`),
    ],
    root,
  );
  if (listed) {
    const roots = new Set();
    for (const f of listed.split("\0")) {
      const i = f.lastIndexOf("/");
      if (i <= 0) continue; // a root manifest is the root package, not a nested one
      const dir = f.slice(0, i);
      if (dir.split("/").some((seg) => seg.startsWith(".") || NON_SOURCE_SEGMENTS.has(seg)))
        continue;
      roots.add(dir);
    }
    return { roots: [...roots].sort(), truncated: false };
  }
  return {
    roots: [...(stack?.packageRoots ?? [])],
    truncated: stack?.packageRootsTruncated === true,
  };
}

/**
 * The verification plan (review F08/F09): which suites run where, and which package dirs
 * each verdict speaks for. A PASS may only be claimed for what a suite actually covered.
 *   - The root's declared suites run at the root and cover ".".
 *   - A nested package that declares its own suite (an explicit `scripts.test`, a pytest
 *     config, go.mod…) is REQUIRED, unless excluded by `verify.exclude` or by living under
 *     a fixture/test-data directory (a declared workspace member is never excluded that way).
 *   - It is covered by the root run when the root script is a recursive workspace run and the
 *     package is a declared workspace member, or when the repo declares `verify.workspaces:
 *     "root"` — then it is not run twice. Otherwise its own suite runs in its own directory.
 * Runners found only as dependencies are inventory, never obligations (see stack.js).
 * @param {string} root
 * @param {{stack?: any, config?: ReturnType<typeof verifyConfig>}} [opts]
 */
export function planSuites(root, { stack = detectStack(root), config = verifyConfig(root) } = {}) {
  const detected = [...(stack?.testCommands ?? [])];
  const rootRunners = stack?.testRunners?.length
    ? stack.testRunners
    : parseRunnerStrings(stack?.testCommands ?? []);
  const workspaces = stack?.workspaces ?? [];
  const recursive = rootTestCoversWorkspaces(root);
  const declaredRoot = config.workspaces === "root";
  /** @type {{cwd: string, runner: any, label: string, covers: string[]}[]} */
  const nested = [];
  /** @type {{path: string, reason: string}[]} */
  const excluded = [];
  const required = rootRunners.length ? ["."] : [];
  const rootCovers = ["."];
  const scan = nestedPackages(root, stack);
  for (const pkg of scan.roots) {
    const member = workspaces.some((g) => matchesWorkspaceGlob(g, pkg));
    if (config.exclude.some((g) => matchesWorkspaceGlob(g, pkg) || pkg.startsWith(`${g}/`))) {
      excluded.push({ path: pkg, reason: "verify.exclude" });
      continue;
    }
    if (!member && pkg.split("/").some((seg) => FIXTURE_SEGMENTS.has(seg))) {
      excluded.push({ path: pkg, reason: "fixture/test-data directory" });
      continue;
    }
    let runners = [];
    try {
      runners = detectRunners(join(root, pkg), { pmRoot: root });
    } catch {}
    if (!runners.length) continue; // declares no suite — nothing is owed for it
    required.push(pkg);
    if (declaredRoot || (recursive && member)) {
      rootCovers.push(pkg);
      continue;
    }
    for (const r of runners) {
      detected.push(`${r.label} (${pkg})`);
      nested.push({ cwd: pkg, runner: r, label: `${r.label} (${pkg})`, covers: [pkg] });
    }
  }
  const rootSuites = rootRunners.map((r) => ({
    cwd: ".",
    runner: r,
    label: r?.label ?? String(r?.bin ?? "unknown"),
    covers: rootCovers,
  }));
  return {
    suites: [...rootSuites, ...nested],
    detected: [...new Set(detected)],
    coverage: {
      required,
      excluded,
      rootCoversWorkspaces: recursive || declaredRoot,
      ...(scan.truncated ? { truncated: true } : {}),
    },
  };
}

// The project's suite must run as if launched from a terminal. `NODE_TEST_CONTEXT` is node's
// test-runner plumbing: inherited from a parent `node --test` (verify called from inside a
// test run, or from a hook spawned by one), it makes the project's own `node --test` act as a
// reporting child and exit 0 without running its files — a PASS that tested nothing.
const suiteEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

/**
 * Run EVERY planned suite (HI-01 + review F08) — a polyglot repo where a passing Node suite
 * hides a failing pytest suite, or a monorepo where a passing root hides a failing workspace,
 * must NOT report PASS. Aggregate to an honest four-state verdict:
 *   - every required package covered by a suite that ran and PASSED   → PASS
 *   - any executed suite FAILs (real non-zero exit)                     → FAIL
 *   - a planned suite is non-executable, a spawn never completed (ENOENT /
 *     EACCES / ENOEXEC / signal / timeout, ME-02), or a required package
 *     got no verdict (uncovered, or the package scan was only a sample) → INCOMPLETE
 *   - no suites at all                                                   → NOT_CONFIGURED
 * Only a real non-zero EXIT CODE from a suite that actually ran is a FAIL; a suite
 * that never executed is INCOMPLETE, never a false FAIL.
 * @param {string} cwd
 * @param {{plan?: ReturnType<typeof planSuites>}} [opts]
 * @returns {VerifyTests}
 */
function runTests(cwd, { plan = planSuites(cwd) } = {}) {
  const timeout = Number(process.env.FORGE_VERIFY_TIMEOUT_MS) || 600000;
  // No declared suite anywhere → NOT_CONFIGURED, not a forced npm-test failure.
  if (!plan.suites.length) return { ran: false, status: "NOT_CONFIGURED" };

  /** @type {SuiteResult[]} */
  const executed = [];
  /** @type {string[]} */
  const notExecuted = [];
  for (const { cwd: rel, runner: r, label, covers } of plan.suites) {
    const dir = rel === "." ? cwd : join(cwd, rel);
    const where = { cwd: rel, covers };
    const masked = maskedTestScript(dir);
    if (masked && r?.bin && r.bin !== "pytest") {
      // The package script swallows its own failures — running it can only produce a
      // meaningless 0. Say so instead of minting evidence out of it.
      executed.push({
        label,
        status: "INCOMPLETE",
        ...where,
        exitCode: null,
        output: `the package.json test script masks failures (\`${masked.slice(0, 80)}\`) — its exit code cannot be a verdict`,
      });
      continue;
    }
    if (!isExecutable(r, dir)) {
      // No built-in executor (go/cargo/mvn/gradle/dotnet/rspec/phpunit/npx-runners) —
      // report-only. Its absence means a PASS can't be claimed for what it covers.
      notExecuted.push(label);
      continue;
    }
    try {
      execFileSync(r.bin, r.args ?? [], {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
        timeout,
        env: suiteEnv(),
      });
      executed.push({ label, status: "PASS", ...where, exitCode: 0 });
    } catch (e) {
      executed.push({ ...classifySuiteFailure(e, { label, bin: r.bin, timeout }), ...where });
    }
  }

  // Coverage: a package counts as covered only when a suite that covers it reached a verdict.
  const verdict = new Set();
  for (const s of executed)
    if (s.status === "PASS" || s.status === "FAIL") for (const p of s.covers ?? []) verdict.add(p);
  const required = plan.coverage.required;
  /** @type {SuiteCoverage} */
  const coverage = {
    ...plan.coverage,
    covered: required.filter((p) => verdict.has(p)),
    uncovered: required.filter((p) => !verdict.has(p)),
  };

  // Aggregate. A PASS must mean every required package's suite ran and passed.
  const anyFail = executed.some((s) => s.status === "FAIL");
  const anyIncomplete = executed.some((s) => s.status === "INCOMPLETE");
  const ranToVerdict = executed.some((s) => s.status === "PASS" || s.status === "FAIL");
  const timedOut = executed.some((s) => s.timedOut);
  /** @type {"PASS"|"FAIL"|"INCOMPLETE"} */
  let status;
  if (anyFail) status = "FAIL";
  else if (anyIncomplete || notExecuted.length || coverage.uncovered.length || coverage.truncated)
    status = "INCOMPLETE";
  else status = "PASS"; // every required package covered by a passing suite

  // Honest human-readable summary, aggregated across suites.
  const parts = [];
  if (notExecuted.length)
    parts.push(
      `detected "${notExecuted.join('", "')}" — no built-in executor; run it yourself and re-verify`,
    );
  for (const s of executed) {
    if (s.status === "INCOMPLETE") parts.push(`"${s.label}" ${s.output ?? "did not execute"}`);
    else if (s.status === "FAIL") parts.push(`"${s.label}" FAILED: ${s.output ?? ""}`);
  }
  const unexplained = coverage.uncovered.filter(
    (p) =>
      !executed.some((s) => s.covers?.includes(p)) &&
      !notExecuted.some((l) => l.endsWith(`(${p})`)),
  );
  if (unexplained.length) parts.push(`no verdict for package(s): ${unexplained.join(", ")}`);
  if (coverage.truncated)
    parts.push(
      'the package scan was a bounded sample (not a git work tree) — declare `verify.workspaces: "root"` or verify each package',
    );
  const runnerLabels = executed.map((s) => s.label);
  const runner = runnerLabels.join(", ") || plan.suites.map((x) => x.label).filter(Boolean)[0];
  return {
    ran: ranToVerdict,
    passed: status === "PASS",
    status,
    runner,
    ...(timedOut ? { timedOut: true } : {}),
    detected: plan.detected,
    executed,
    notExecuted,
    coverage,
    ...(parts.length ? { output: parts.join("; ") } : {}),
  };
}

/**
 * M6 — checkpoint cadence as an optimal-stopping threshold rule (spec §6:
 * docs/plans/substrate-v2/06-faculties-and-mechanisms.md). Insert a checkpoint once
 * the expected loss of continuing-while-wrong exceeds the check's price:
 * pErr·tokensPerStep·costPerToken·n > checkCost, i.e. check every
 * n* = ⌈checkCost / (pErr · tokensPerStep · costPerToken)⌉ meaningful steps. No
 * magic constants: pErr is measured per tier from ledger outcome history, the costs
 * are priced — riskier/cheaper tiers get smaller n* automatically. Clamped to
 * [1, 50]: even a near-free check shouldn't fire more than every step, and even a
 * near-riskless run must still checkpoint eventually. Pure.
 * @param {{pErr: number, tokensPerStep: number, costPerToken?: number, checkCost: number}} f
 *   pErr = per-step error hazard; tokensPerStep = tokens put at risk per step;
 *   checkCost priced in the same token-cost unit.
 * @returns {number} integer steps between checkpoints, in [1, 50]
 */
export function checkpointCadence({ pErr, tokensPerStep, costPerToken = 1, checkCost }) {
  const n = Math.ceil(checkCost / (pErr * tokensPerStep * costPerToken));
  // Degenerate inputs (NaN from bad measurements) fail SAFE: check every step.
  if (Number.isNaN(n)) return 1;
  return Math.min(50, Math.max(1, n)); // zero risk → Infinity → the 50-step ceiling
}

const VERIFY_EVENTS = (root) => join(root, ".forge", "verify-events.jsonl");

/** The environment a verdict was produced in — part of the verifier event (A01). */
function environmentDigest() {
  const env = { node: process.version, platform: platform(), arch: arch() };
  return {
    ...env,
    digest: createHash("sha256").update(JSON.stringify(env)).digest("hex").slice(0, 16),
  };
}

/**
 * The MAC over one verifier event: the run id, the verdict, and the code state before and
 * after the run. It AUTHENTICATES who recorded the event (this machine's key) — it does not
 * make the verdict true.
 * @param {any} event
 */
export const verifyEventMac = (event) =>
  evidenceMac([
    "verify-event",
    event?.runId,
    event?.status,
    event?.pre?.scheme,
    event?.pre?.head,
    event?.pre?.dirtyHash,
    event?.post?.head,
    event?.post?.dirtyHash,
  ]);

/**
 * Read this checkout's verifier events (`.forge/verify-events.jsonl`), newest last. Lines
 * that fail to parse or whose MAC does not verify are skipped, never trusted.
 * @param {string} root
 * @returns {any[]}
 */
export function readVerifyEvents(root) {
  let text = "";
  try {
    text = readFileSync(VERIFY_EVENTS(root), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const mac = verifyEventMac(e);
      if (typeof e?.runId === "string" && (mac == null || e.mac === mac)) out.push(e);
    } catch {}
  }
  return out;
}

/**
 * Independent verification pass over the working change.
 *
 * The verdict is bound to the code it TESTED (review F10): the code state is captured before
 * and after the suites run, and if it changed in between (a test that rewrites source, a
 * formatter, a concurrent agent edit) the result is INCOMPLETE with `mutated: true` — a PASS
 * is never signed for bytes that were not the bytes tested. The provenance stamp's `codeState`
 * is the PRE-run state; `event` is the immutable verifier event (A01): run id, verifier and
 * version, per-suite cwd/command/verdict, package coverage, pre/post tree identity, timestamps
 * and an environment digest. The event is also appended to `.forge/verify-events.jsonl`, so
 * other evidence (router outcomes, ledger refs) can cite a run by id.
 * @param {{targetRoot?: string, base?: string}} [opts]
 * @returns {{ok: boolean, provenance: object, unknown: string[], tests: VerifyTests,
 *   changedFiles: string[], added: string}}
 *   `ok` is `tests.status === "PASS"` — TRUE only when a real verifier ran and passed, NEVER
 *   when nothing ran. `changedFiles` includes untracked files; `added` includes their contents.
 */
export function verify({ targetRoot = process.cwd(), base = "HEAD" } = {}) {
  const diff =
    git(["diff", "--unified=0", base], targetRoot) ||
    git(["diff", "--unified=0", "--cached"], targetRoot);
  const diffAdded = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  // Untracked (new, not-yet-added) files are part of the change too — a brand-new source file
  // and its call sites would be invisible to `git diff`. Fold their paths into changedFiles and
  // their contents into `added` so provenance and the hallucination check both see them (P0-09).
  const untracked = git(["ls-files", "--others", "--exclude-standard"], targetRoot)
    .split("\n")
    .filter(Boolean);
  // Mirror the diff's --cached fallback so the base file list is derived from the SAME diff that
  // produced `added` (a base whose worktree matches HEAD but whose index differs would otherwise
  // yield `added` from --cached while changedFiles stayed empty, weakening impact/docsdrift).
  const changedFiles = [
    ...new Set([
      ...(
        git(["diff", "--name-only", base], targetRoot) ||
        git(["diff", "--name-only", "--cached"], targetRoot)
      )
        .split("\n")
        .filter(Boolean),
      ...untracked,
    ]),
  ];
  let added = diffAdded;
  for (const f of untracked) {
    try {
      added += `\n${readFileSync(join(targetRoot, f), "utf8")}`;
    } catch {}
  }

  // Verify runs AFTER edits — a cached, stale atlas would miss newly-added-but-undefined symbols
  // (false negatives) or flag just-defined ones (false positives). Rebuild when stale; the
  // incremental build only re-parses the files that changed, so this stays cheap.
  const cached = loadAtlas(targetRoot);
  const atlas = cached && !isStale(targetRoot, cached) ? cached : buildAtlas({ root: targetRoot });
  const symbols = extractCalledSymbols(added);
  // When the graph was capped (huge repo, files dropped), "defined nowhere" is unreliable — a
  // symbol may live in a dropped file — so don't assert hallucinations.
  const unknown = atlas.capped ? [] : findUnknownSymbols(atlas, symbols);

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const plan = planSuites(targetRoot);
  const pre = computeCodeState(targetRoot);
  const tests = runTests(targetRoot, { plan });
  const post = computeCodeState(targetRoot);
  const finishedAt = new Date().toISOString();
  // F10: the tree moved while the suites ran. Neither state is the one that was tested, so
  // no verdict may be bound to either — INCOMPLETE, whatever the suites said.
  // (An unbindable PRE state — no git, or an unreadable file — cannot detect a mutation; its
  //  stamp is unbindable anyway and the gate never counts it.)
  const mutated =
    typeof pre.dirtyHash === "string" &&
    (post.dirtyHash !== pre.dirtyHash || post.head !== pre.head);
  if (mutated && tests.status !== "NOT_CONFIGURED") {
    const note =
      "the code changed while the tests ran (a test, formatter or concurrent edit wrote to the tree) — the verdict cannot be bound to the tested bytes; re-run on a quiet tree, or declare expected outputs in verify.generated";
    tests.mutated = true;
    tests.status = "INCOMPLETE";
    tests.passed = false;
    tests.output = tests.output ? `${note}; ${tests.output}` : note;
  }

  const event = {
    v: 1,
    runId,
    verifier: `${BRAND.cli} verify`,
    verifierVersion: BRAND.version,
    startedAt,
    finishedAt,
    status: tests.status,
    suites: (tests.executed ?? []).map((s) => ({
      label: s.label,
      cwd: s.cwd ?? ".",
      covers: s.covers ?? ["."],
      status: s.status,
      exitCode: s.exitCode ?? null,
    })),
    notExecuted: tests.notExecuted ?? [],
    coverage: tests.coverage ?? null,
    pre: { scheme: pre.scheme, head: pre.head, dirtyHash: pre.dirtyHash },
    post: { head: post.head, dirtyHash: post.dirtyHash },
    environment: environmentDigest(),
  };
  const provenance = {
    base,
    changedFiles,
    untracked,
    tests,
    // Bind the stamp to the exact code it TESTED (HI-02/ME-04/F10): the Stop gate recomputes
    // this and only counts the PASS as test-evidence when the hash still matches.
    codeState: pre,
    ...(mutated ? { codeStateAfter: post } : {}),
    event,
    symbolsChecked: symbols.length,
    unknownSymbols: unknown,
  };
  // MAC the claim (B7): a hand-written stamp in `.forge/` is not test evidence.
  signProvenance(provenance);
  mkdirSync(join(targetRoot, ".forge"), { recursive: true });
  writeFileSync(join(targetRoot, ".forge", "provenance.json"), JSON.stringify(provenance, null, 2));
  try {
    const mac = verifyEventMac(event);
    appendFileSync(
      VERIFY_EVENTS(targetRoot),
      `${JSON.stringify(mac ? { ...event, mac } : event)}\n`,
    );
  } catch {} // the stamp above is the gate's evidence; the event log is best-effort history

  // Hard gate = the project's own tests, keyed off the honest four-state verdict. `ok` is TRUE
  // only when a real verifier PASSED — never when nothing ran (NOT_CONFIGURED/INCOMPLETE).
  // Unknown symbols stay advisory (heuristic).
  const ok = tests.status === "PASS";
  // `added` (added diff lines + untracked file bodies) rides along for the deep lenses
  // (consensus.js: secrets + reviewer read the same bytes this pass already parsed).
  return { ok, provenance, unknown, tests, changedFiles, added };
}

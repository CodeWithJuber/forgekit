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
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { build as buildAtlas, has, isStale, load as loadAtlas } from "./atlas.js";
import { BRAND } from "./brand.js";
import { readForgeConfig } from "./repo_config.js";
import {
  analyzeRecursiveTestRun,
  detectRunners,
  detectStack,
  matchesWorkspaceGlob,
  reachesWorkspace,
  scriptShellProblem,
} from "./stack.js";
import { userStateDir } from "./util.js";

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
// A repository's `core.fsmonitor` is a COMMAND git runs: reading a nested repository's state
// must never execute that repository's configuration (review N05 round 2), so every read here
// turns it off. stderr is never echoed (an unborn HEAD is a state, not an error to print).
const GIT_SAFE = ["-c", "core.fsmonitor=false"];

function gitStrict(args, cwd) {
  return execFileSync("git", [...GIT_SAFE, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function git(args, cwd) {
  try {
    return execFileSync("git", [...GIT_SAFE, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
    });
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
  return join(userStateDir(), "evidence.key");
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
 *  untracked file, or moving bytes from one file to the next, kept the same hash. v3 (review
 *  N05): nested repositories and submodules are bound by their own code state, and declared
 *  `verify.external` paths are part of the hashed policy. */
export const CODE_STATE_SCHEME = "manifest-v3";

/**
 * The per-repo `verify` settings from `.forge/forge.config.json` (`verify` key), validated:
 *   - `workspaces`: "auto" (default — every nested package that declares a suite runs, unless
 *     the root script is a recursive workspace run) or "root" (an explicit declaration that the
 *     root test command covers every nested package).
 *   - `exclude`: package paths (workspace-glob syntax) that are not required suites.
 *   - `generated`: git glob pathspecs for outputs a test run may legitimately write (coverage
 *     reports, build output that is not gitignored). They are excluded from the code-state
 *     fingerprint EVERYWHERE, so they can never invalidate — or be vouched for by — a stamp.
 *   - `external`: paths deliberately OUTSIDE the verified code (a vendored checkout, a nested
 *     repository you do not own). Excluded from the fingerprint like `generated`, but recorded
 *     in every verifier event as a declared boundary (review N05): code the fingerprint cannot
 *     bind otherwise makes a PASS INCOMPLETE.
 * Malformed values are dropped, never trusted.
 * @param {string} root
 * @returns {{workspaces: "auto"|"root", exclude: string[], generated: string[], external: string[]}}
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
    external: strings(raw?.external),
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

/** How deep nested repositories are followed (a repo inside a repo inside a repo…). */
const NESTED_DEPTH = 3;

/**
 * A nested repository's own code state, as a manifest record (review N05). Git lists an
 * untracked embedded repository as one `dir/` entry and a submodule as one gitlink, so its
 * FILES never reach the outer fingerprint: a test could rewrite code it imports from there and
 * the stamp would still match. It is bound by its own HEAD, diffs and untracked manifest,
 * recursively. What cannot be bound (no repository there, too deep, unreadable) is `unbound`.
 * @param {string} cwd @param {string} rel @param {string} type @param {number} depth
 * @returns {{record: any[], unbound?: string[]}}
 */
function nestedRecord(cwd, rel, type, depth, config) {
  const dir = rel.replace(/\/+$/, "");
  const abs = join(cwd, dir);
  // An uninitialized submodule is an empty directory: there is no code there to bind. A
  // registered one whose directory is GONE is not bound either (review N05 round 2).
  if (!existsSync(abs)) return { record: [type, rel, "missing"], unbound: [`${dir}/`] };
  let empty = false;
  try {
    empty = readdirSync(abs).length === 0;
  } catch {}
  if (empty) return { record: [type, rel, "empty"] };
  if (depth >= NESTED_DEPTH || !existsSync(join(abs, ".git")))
    return { record: [type, rel, null], unbound: [`${dir}/`] };
  // The OUTER repository's declarations govern (rebased to the nested root): a nested repo's
  // own forge config cannot exclude its files from the outer proof (review N05 round 2).
  const inner = computeCodeState(abs, { depth: depth + 1, config: rebaseConfig(config, dir) });
  if (typeof inner.dirtyHash !== "string")
    return { record: [type, rel, null], unbound: [`${dir}/`] };
  return {
    record: [type, rel, inner.scheme, inner.head ?? "", inner.dirtyHash],
    ...(inner.unbound ? { unbound: inner.unbound.map((u) => `${dir}/${u}`) } : {}),
  };
}

/**
 * One manifest record for an untracked path — `[type, path, …]` as canonical JSON, so every
 * field is unambiguously delimited. Symlinks are recorded by TARGET (never followed); a nested
 * repository (`sub/`) by its own code state (nestedRecord); a regular file by exec bit, size
 * and content sha256; anything else (a socket, a FIFO) by path only, reported in `unbound`.
 * Throws when a file cannot be read — the caller turns that into an unbindable state instead
 * of hashing around the gap.
 * @param {string} cwd @param {string} rel @param {number} depth
 * @returns {{record: any[], unbound?: string[]}}
 */
function manifestRecord(cwd, rel, depth, config) {
  const abs = join(cwd, rel);
  if (rel.endsWith("/")) return nestedRecord(cwd, rel, "repo", depth, config);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return { record: ["symlink", rel, readlinkSync(abs)] };
  if (!st.isFile()) return { record: ["other", rel], unbound: [rel] };
  // git tracks only the executable bit; on Windows it is not meaningful at all.
  const mode = platform() === "win32" ? "-" : st.mode & 0o111 ? "755" : "644";
  const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
  return { record: ["file", rel, mode, st.size, digest] };
}

/**
 * Every submodule path — each a working tree of another repository: the index's gitlinks
 * (mode 160000 — a repo committed with `git add inner` has one and no `.gitmodules` entry) and
 * the paths `.gitmodules` declares, read by git's own config parser (quoted values, inline
 * comments, any key case: review N05 round 2 — a hand-rolled reader skipped
 * `path = vendor/lib ; pinned` and left the submodule unbound).
 * @param {string} cwd
 */
function submodulePaths(cwd) {
  const out = new Set();
  for (const entry of gitStrict(["ls-files", "-s", "-z"], cwd).split("\0")) {
    const m = /^160000 [0-9a-f]+ \d\t(.+)$/.exec(entry);
    if (m) out.add(m[1]);
  }
  if (existsSync(join(cwd, ".gitmodules")))
    for (const entry of git(
      ["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\..*\\.path$"],
      cwd,
    ).split("\0")) {
      const nl = entry.indexOf("\n");
      const path = nl < 0 ? "" : entry.slice(nl + 1).replace(/\/+$/, "");
      if (path) out.add(path);
    }
  return [...out].sort();
}

/** The outer repository's verify declarations, as they apply INSIDE the nested repository at
 *  `dir`: patterns under `dir/` rebased, `**`-anchored ones kept, the rest dropped. */
function rebaseConfig(config, dir) {
  if (!config) return undefined;
  const rebase = (list) =>
    list.flatMap((g) =>
      g.startsWith(`${dir}/`) ? [g.slice(dir.length + 1)] : g.startsWith("**/") ? [g] : [],
    );
  return {
    ...config,
    generated: rebase(config.generated),
    external: rebase(config.external),
  };
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
 *   - nested repositories — an untracked embedded repo, or a submodule's working tree — are
 *     bound by THEIR OWN code state (HEAD, diffs, untracked manifest), recursively to depth
 *     NESTED_DEPTH (review N05: a test that rewrote code it imported from a nested repo used to
 *     leave the fingerprint unchanged). Whatever cannot be bound is listed in `unbound`, and a
 *     verdict is never PASS while code is unbound (see verify);
 *   - gitignored files are not code state (generated/untracked-by-design), and neither are
 *     interpreter/tool caches (BUILTIN_GENERATED), the `verify.generated` pathspecs, paths
 *     declared `verify.external` (outside the verified code, by declaration), or forge's own
 *     `.forge/` directory;
 *   - an untracked file that cannot be read makes the state UNBINDABLE (`dirtyHash: null`,
 *     `unbindable` says why) — never hashed around.
 * Never throws; `gitAvailable:false` / `dirtyHash:null` is the honest "cannot bind" signal
 * (the gate then refuses to count the stamp) — including when git cannot produce a diff (an
 * error or an over-size output hashes as "cannot bind", never as the empty diff). Pure w.r.t.
 * the tree — reads git + files, writes nothing.
 * @param {string} [cwd]
 * @param {{depth?: number, config?: ReturnType<typeof verifyConfig>}} [opts] nesting depth and
 *   the governing config (internal: nested repositories recurse under the outer config)
 * @returns {{head: string|null, dirtyHash: string|null, gitAvailable: boolean, scheme: string,
 *   unbound?: string[], external?: string[], unbindable?: string}}
 */
export function computeCodeState(cwd = process.cwd(), { depth = 0, config: given } = {}) {
  const scheme = CODE_STATE_SCHEME;
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], cwd).trim() !== "true")
      return { head: null, dirtyHash: null, gitAvailable: false, scheme };
    const head = git(["rev-parse", "--verify", "-q", "HEAD"], cwd).trim() || null;
    const config = given ?? verifyConfig(cwd);
    const generated = [...BUILTIN_GENERATED, ...config.generated];
    const external = config.external;
    // Generated outputs (built-in caches + what the repo declared) and declared-external paths
    // are excluded on BOTH sides; an external path is excluded as itself and as a directory.
    const excludes = [
      ...generated,
      ...external.flatMap((g) => [g, `${g.replace(/\/+$/, "")}/**`]),
    ].map((g) => `:(top,exclude,glob)${g}`);
    const trackedSpec = excludes.length ? ["--", ":/", ...excludes] : [];
    const untrackedSpec = excludes.length ? ["--", ".", ...excludes] : [];
    // Exclude forge's OWN state dir: writing provenance.json / session files must never
    // perturb the fingerprint the stamp is bound to (self-reference), and it's ignored in
    // real repos anyway — this keeps the hash stable even if a user forgot to gitignore it.
    // A nested repository's untracked files are read with its COMMITTED .gitignore files
    // only — never its private `.git/info/exclude` or a global excludes file, which would
    // silently hide its code from the outer proof (review N05 round 2).
    const ignore = depth > 0 ? ["--exclude-per-directory=.gitignore"] : ["--exclude-standard"];
    const untracked = gitStrict(["ls-files", "--others", ...ignore, "-z", ...untrackedSpec], cwd)
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
    section("external", JSON.stringify(external));
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
        rec = manifestRecord(cwd, f, depth, config);
      } catch (err) {
        return {
          head,
          dirtyHash: null,
          gitAvailable: true,
          scheme,
          unbindable: `untracked file ${f} could not be read (${err?.code ?? "error"})`,
        };
      }
      if (rec.unbound) unbound.push(...rec.unbound);
      lines.push(JSON.stringify(rec.record));
    }
    section("untracked", lines.join("\n"));
    // Submodule working trees: the outer diff shows only their commit (plus a "-dirty" flag
    // that cannot tell one edit from the next), so each is bound by its own state.
    const isExternal = (p) =>
      external.some((g) => matchesWorkspaceGlob(g, p) || p.startsWith(`${g.replace(/\/+$/, "")}/`));
    const subs = [];
    for (const p of submodulePaths(cwd)) {
      if (isExternal(p)) continue;
      const rec = nestedRecord(cwd, p, "submodule", depth, config);
      if (rec.unbound) unbound.push(...rec.unbound);
      subs.push(JSON.stringify(rec.record));
    }
    section("submodules", subs.join("\n"));
    return {
      head,
      dirtyHash: h.digest("hex"),
      gitAvailable: true,
      scheme,
      ...(unbound.length ? { unbound: [...new Set(unbound)].sort() } : {}),
      ...(external.length ? { external } : {}),
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
 * @property {Record<string, "measured"|"inferred"|"declared">} [basis]  what each required
 *   package's verdict rests on, weakest link: a suite ran there (measured), the root command
 *   was recognized as a recursive run reaching it (inferred), or `verify.workspaces: "root"`
 *   says so (declared)
 * @property {{tool: string, command: string}} [rootRun]  the recognized recursive root command
 * @property {{tool: string, command: string, reason: string}} [rootRunRefused]  a recognized
 *   recursive root command that is NOT credited (configuration or a cache narrows it, or the
 *   root suite does not run the script) — its members were measured instead
 * @property {string} [declared]             the declaration behind "declared" coverage
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
 * @property {string[]} [unbound]         code the fingerprint could not bind — never a PASS (N05)
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
  const inGit = git(["rev-parse", "--is-inside-work-tree"], root).trim() === "true";
  const listed = inGit
    ? git(
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
      )
    : "";
  // In a git work tree the listing is authoritative even when it is empty (no nested
  // manifests); only outside git does the bounded walk stand in.
  if (inGit) {
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

// The package managers whose `<pm> test` runner is a package's own `scripts.test` — the one
// suite a recursive workspace run executes for it (a pytest or go suite beside it is not).
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
// A runner that executes the package's `scripts.test` — `bun test` is Bun's own runner and
// does not; `bun run test` does.
const isScriptRunner = (r) =>
  SCRIPT_RUNNERS.has(r?.bin) &&
  (r.bin === "bun" ? r.args?.[0] === "run" && r.args?.[1] === "test" : r.args?.[0] === "test");
// Weakest link first: what a package's verdict ultimately rests on (review N03, suggestion 4).
const BASIS_ORDER = ["declared", "inferred", "measured"];

/**
 * The verification plan (review F08/F09/N03): which suites run where, and which package dirs
 * each verdict speaks for. A PASS may only be claimed for what a suite actually covered.
 *   - The root's declared suites run at the root and cover ".".
 *   - A nested package that declares its own suite (an explicit `scripts.test`, a pytest
 *     config, go.mod…) is REQUIRED, unless excluded by `verify.exclude` or by living under
 *     a fixture/test-data directory (a declared workspace member is never excluded that way).
 *   - Its `scripts.test` suite is covered by the root run only when the root `test` script is
 *     an ESTABLISHED recursive run (stack.recursiveTestRun: a recognized, unfiltered
 *     invocation whose failure reaches the script's exit status) and the package is a member
 *     of the workspace list THAT tool iterates; every package's suites are covered when the
 *     repo declares `verify.workspaces: "root"`. Any other suite of the package — and every
 *     suite of a package the run does not reach — runs in the package's own directory.
 * `coverage.basis` says what each required package's verdict rests on, weakest link first:
 * "declared" (the repo's `verify.workspaces: "root"` statement), "inferred" (the recognized
 * recursive command in `coverage.rootRun`), or "measured" (a suite ran in that package and its
 * exit code was read). Runners found only as dependencies are inventory, never obligations.
 * @param {string} root
 * @param {{stack?: any, config?: ReturnType<typeof verifyConfig>}} [opts]
 */
export function planSuites(root, { stack = detectStack(root), config = verifyConfig(root) } = {}) {
  const detected = [...(stack?.testCommands ?? [])];
  const rootRunners = stack?.testRunners?.length
    ? stack.testRunners
    : parseRunnerStrings(stack?.testCommands ?? []);
  const workspaces = stack?.workspaces ?? [];
  // A recursive root script only covers a package when the ROOT suite actually executes that
  // script (review N03 round 2: a root `bun test` ran Bun's runner, never `npm test -ws`).
  const analysis = analyzeRecursiveTestRun(root);
  const established = analysis && !("refused" in analysis) ? analysis : null;
  const run = established && rootRunners.some(isScriptRunner) ? established : null;
  const declaredRoot = config.workspaces === "root";
  /** @type {{cwd: string, runner: any, label: string, covers: string[]}[]} */
  const nested = [];
  /** @type {{path: string, reason: string}[]} */
  const excluded = [];
  const required = rootRunners.length ? ["."] : [];
  /** @type {Record<string, "measured"|"inferred"|"declared">} */
  const basis = rootRunners.length ? { ".": "measured" } : {};
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
    // Reached: a member the tool iterates AND runs, whose own script does not mask a failure
    // (`… || true` passes under the root run too — it is run on its own and reported).
    const reached = !!run && reachesWorkspace(root, run, pkg) && !maskedTestScript(join(root, pkg));
    const bases = new Set();
    for (const r of runners) {
      if (declaredRoot) bases.add("declared");
      else if (reached && isScriptRunner(r)) bases.add("inferred");
      else {
        bases.add("measured");
        detected.push(`${r.label} (${pkg})`);
        nested.push({ cwd: pkg, runner: r, label: `${r.label} (${pkg})`, covers: [pkg] });
        continue;
      }
      if (!rootCovers.includes(pkg)) rootCovers.push(pkg);
    }
    basis[pkg] = /** @type {"measured"|"inferred"|"declared"} */ (
      BASIS_ORDER.find((b) => bases.has(b))
    );
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
      rootCoversWorkspaces: !!run || declaredRoot,
      basis,
      ...(run ? { rootRun: { tool: run.tool, command: run.command } } : {}),
      ...(analysis && "refused" in analysis
        ? {
            rootRunRefused: {
              tool: analysis.tool,
              command: analysis.command,
              reason: analysis.refused,
            },
          }
        : established && !run
          ? {
              rootRunRefused: {
                tool: established.tool,
                command: established.command,
                reason: "the root suite does not run the package's test script",
              },
            }
          : {}),
      ...(declaredRoot ? { declared: "verify.workspaces=root" } : {}),
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
  // A script-shell that is not a shell (`script-shell=/bin/true` in .npmrc) turns every npm
  // or pnpm script into a no-op that exits 0 — no verdict can come from running one.
  const shell = scriptShellProblem(cwd);
  for (const { cwd: rel, runner: r, label, covers } of plan.suites) {
    const dir = rel === "." ? cwd : join(cwd, rel);
    const where = { cwd: rel, covers };
    if (shell && (r?.bin === "npm" || r?.bin === "pnpm")) {
      executed.push({ label, status: "INCOMPLETE", ...where, exitCode: null, output: shell });
      continue;
    }
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
 * The verifier-event CONTRACT version (review suggestion 2). A v2 event's MAC covers the WHOLE
 * event — run id, verifier and version, timestamps, verdict, every suite's cwd/command/covers/
 * status/exit code, what was not executed, package coverage and its basis, the pre/post code
 * state (unbound paths included) and the environment — in canonical form (sorted keys), so no
 * field a consumer reads can be edited without breaking it. v1 events (read-only now) MAC'd
 * the run id, verdict and code state only; their other fields are unauthenticated.
 */
export const VERIFY_EVENT_VERSION = 2;
// Fields a READER derives (readVerifyEvents) — never signed, never trusted from the file.
const DERIVED_EVENT_FIELDS = new Set(["mac", "authenticated", "authScope", "inCheckout"]);

/** Deterministic JSON: keys sorted at every depth, undefined dropped. A non-finite number has
 *  no JSON form (`Infinity` would print as `null`, so a stored `1e999` would verify as a signed
 *  `null` — review N06 round 2): it throws, and such an event is never authenticated. */
const canonicalJson = (v) => {
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
};

/**
 * The MAC over one verifier event (see VERIFY_EVENT_VERSION for what it covers). It
 * AUTHENTICATES who recorded the event (this machine's key) — it does not make the verdict
 * true. `null` when no evidence key is available.
 * @param {any} event
 */
export const verifyEventMac = (event) => {
  if (event?.v === 1)
    return evidenceMac([
      "verify-event",
      event?.runId,
      event?.status,
      event?.pre?.scheme,
      event?.pre?.head,
      event?.pre?.dirtyHash,
      event?.post?.head,
      event?.post?.dirtyHash,
    ]);
  const signed = Object.fromEntries(
    Object.entries(event ?? {}).filter(([k]) => !DERIVED_EVENT_FIELDS.has(k)),
  );
  try {
    return evidenceMac([`verify-event/v${VERIFY_EVENT_VERSION}`, canonicalJson(signed)]);
  } catch {
    return null; // not representable canonically: never authenticated
  }
};

/**
 * The identity of a checkout for verifier events (review N07 round 2): a digest of its real
 * path. Every v2 event records the checkout it ran in, inside the MAC, so an events file
 * copied into another checkout — or a checkout moved elsewhere — names a checkout that is not
 * this one, and its runs back nothing here.
 * @param {string} root
 */
export function checkoutId(root) {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  return createHash("sha256").update(`forge-checkout\0${real}`).digest("hex").slice(0, 16);
}

/**
 * This checkout's verifier events (`.forge/verify-events.jsonl`), newest last, each with three
 * DERIVED fields that are never read from the file:
 *   - `authenticated` — its MAC verifies under this machine's evidence key;
 *   - `authScope` — what that MAC covers: "event" (every field, v2), "verdict" (run id,
 *     verdict and code state only, v1), or null when not authenticated;
 *   - `inCheckout` — it is authenticated AND names this checkout (checkoutId) — an event
 *     copied from another checkout, or from before events named theirs, is not.
 * Existence is not authenticity (review N06): with no key available (an unreadable or
 * unwritable state dir) NOTHING is authenticated — an unsigned line is reported, never
 * promoted into verified evidence. Lines that do not parse or name no run are skipped.
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
  const here = checkoutId(root);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || typeof e.runId !== "string") continue;
    const mac = verifyEventMac(e);
    const authenticated = typeof mac === "string" && e.mac === mac;
    out.push({
      ...e,
      authenticated,
      authScope: authenticated ? (e.v === 1 ? "verdict" : "event") : null,
      inCheckout: authenticated && e.v !== 1 && e.checkout === here,
    });
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
  // Forge's own state dir is not the change under verification (the fingerprint excludes it
  // too): verify's outputs — provenance.json, verify-events.jsonl — never count as changed.
  const untracked = git(["ls-files", "--others", "--exclude-standard"], targetRoot)
    .split("\n")
    .filter((f) => f && !f.startsWith(".forge/"));
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
  // N05: code the fingerprint cannot bind (a nested repository it could not read, a socket…)
  // could change without changing the stamp — so a PASS is never claimed while any is
  // unbound. A path that is deliberately not part of the verified code is DECLARED
  // (`verify.external`), which excludes it and records the boundary in the event instead.
  const unbound = [...new Set([...(pre.unbound ?? []), ...(post.unbound ?? [])])].sort();
  if (unbound.length) {
    tests.unbound = unbound;
    if (tests.status === "PASS") {
      const note = `code the fingerprint cannot bind: ${unbound.join(", ")} — it could change without changing this stamp; declare it in verify.external if it is not part of what you verify`;
      tests.status = "INCOMPLETE";
      tests.passed = false;
      tests.output = tests.output ? `${note}; ${tests.output}` : note;
    }
  }

  const event = {
    v: VERIFY_EVENT_VERSION,
    runId,
    checkout: checkoutId(targetRoot),
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
    pre: {
      scheme: pre.scheme,
      head: pre.head,
      dirtyHash: pre.dirtyHash,
      ...(pre.unbound ? { unbound: pre.unbound } : {}),
    },
    post: {
      head: post.head,
      dirtyHash: post.dirtyHash,
      ...(post.unbound ? { unbound: post.unbound } : {}),
    },
    // Declared boundaries (review N05): paths excluded from the fingerprint by the repo's own
    // statement — inspectable by every evidence consumer, never silently outside the proof.
    ...(pre.external?.length ? { external: pre.external } : {}),
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

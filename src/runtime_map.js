// forge runtime map — which source functions each test file actually runs.
//
// The atlas is a regex-derived graph: it reads imports and call sites, so it cannot see a call
// made through a computed name, a registry, an event, a dynamic import or a child process. A
// test that reaches the code that way is invisible to it. The runtime map is the other kind of
// evidence: each test file runs in its own process with V8's built-in coverage switched on
// (NODE_V8_COVERAGE, no dependency), every process it spawns inherits the switch, and the
// functions that ran are recorded against that test file. `forge impact` then names the tests
// that actually executed the target, and marks the ones the graph missed.
//
// Scope: JavaScript and TypeScript run by Node (node --test, vitest, jest, mocha). A function
// counts as exercised if V8 saw it run at least once; that is "this test executes it", not
// "this test would fail if it broke". The map is a snapshot: a source file whose content
// changed since the recording is reported stale, never silently trusted.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureForgePrivateIgnored } from "./gitignore.js";
import { IGNORE_DIRS, toPosix } from "./util.js";

export const RUNTIME_MAP_VERSION = 1;
const MAP_FILE = join(".forge", "runtime-map.json");
/** A test file by name: `x.test.js`, `x.spec.ts`, anything under `__tests__/`. */
const TEST_NAME = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)__tests__\/.+\.[cm]?[jt]sx?$)/;

/**
 * @typedef {{version: number, recordedAt: string, command: string, tests: number,
 *   failedRuns: string[], sources: Record<string, string>,
 *   runs: Record<string, Record<string, string[]>>}} RuntimeMap
 *   `runs`: test file → source file → names of the functions that ran.
 *   `sources`: source file → content hash at recording time.
 */

/** @param {string} root @returns {string[]} repo-relative test files */
export function findTestFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = toPosix(relative(root, p));
        if (TEST_NAME.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The per-file test command, `{file}` standing for one test file. From the project's own test
 * script where it names a runner; `node --test` (keeping the script's `--import`/`--require`
 * preloads) otherwise.
 * @param {string} root
 */
export function defaultCommand(root) {
  let script = "";
  try {
    script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.test ?? "";
  } catch {}
  if (/\bvitest\b/.test(script)) return "npx vitest run {file}";
  if (/\bjest\b/.test(script)) return "npx jest --runTestsByPath {file}";
  if (/\bmocha\b/.test(script)) return "npx mocha {file}";
  const preloads = [...script.matchAll(/--(import|require|loader)[= ]("[^"]+"|'[^']+'|\S+)/g)]
    .map((m) => `--${m[1]} ${m[2].replace(/^["']|["']$/g, "")}`)
    .join(" ");
  return `node --test ${preloads ? `${preloads} ` : ""}{file}`.replace(/\s+/g, " ");
}

/**
 * The environment of one recorded test run. NODE_TEST_CONTEXT is dropped: inherited from an
 * enclosing `node --test`, it makes the child report to a parent that is not listening.
 * @param {string} dir the coverage directory for this run
 */
function childEnv(dir) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, NODE_V8_COVERAGE: dir };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** @param {string} text */
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Reduce one test file's V8 coverage directory to source file → functions that ran.
 * @param {string} root @param {string} dir @param {Set<string>} testSet
 * @returns {Record<string, string[]>}
 */
export function readCoverageDir(root, dir, testSet) {
  // Coverage URLs carry the real path; a root reached through a symlink (macOS /var → /private)
  // would make every one of them look outside the repository.
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  /** @type {Map<string, Set<string>>} */
  const ran = new Map();
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {}
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue; // a process killed mid-write leaves a partial file
    }
    for (const script of doc.result ?? []) {
      if (typeof script.url !== "string" || !script.url.startsWith("file:")) continue;
      let abs;
      try {
        abs = fileURLToPath(script.url.replace(/[?#].*$/, ""));
      } catch {
        continue;
      }
      const rel = toPosix(relative(realRoot, abs));
      if (rel.startsWith("..") || /(^|\/)node_modules\//.test(rel) || testSet.has(rel)) continue;
      for (const fn of script.functions ?? []) {
        if (!fn.functionName || !(fn.ranges?.[0]?.count > 0)) continue;
        if (!ran.has(rel)) ran.set(rel, new Set());
        /** @type {Set<string>} */ (ran.get(rel)).add(fn.functionName);
      }
    }
  }
  return Object.fromEntries([...ran].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Run every test file in its own process under V8 coverage and record what each one runs.
 * @param {string} root
 * @param {{command?: string, tests?: string[], jobs?: number, timeoutMs?: number,
 *   onProgress?: (done: number, total: number, file: string) => void}} [opts]
 * @returns {Promise<RuntimeMap>}
 */
export async function recordRuntimeMap(root, opts = {}) {
  const command = opts.command ?? defaultCommand(root);
  const tests = opts.tests ?? findTestFiles(root);
  const testSet = new Set(tests);
  const jobs = Math.max(1, opts.jobs ?? 4);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const scratch = mkdtempSync(join(tmpdir(), "forge-runtime-"));
  /** @type {RuntimeMap["runs"]} */
  const runs = {};
  /** @type {string[]} */
  const failedRuns = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tests.length) {
      const test = tests[next++];
      const dir = join(scratch, String(next));
      mkdirSync(dir, { recursive: true });
      const argv = command.split(/\s+/).map((a) => (a === "{file}" ? test : a));
      const code = await new Promise((resolveRun) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: root,
          env: childEnv(dir),
          stdio: "ignore",
          shell: process.platform === "win32",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.on("error", () => resolveRun(-1));
        child.on("exit", (status) => {
          clearTimeout(timer);
          resolveRun(status ?? -1);
        });
      });
      if (code !== 0) failedRuns.push(test);
      runs[test] = readCoverageDir(root, dir, testSet);
      rmSync(dir, { recursive: true, force: true });
      opts.onProgress?.(++done, tests.length, test);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, tests.length || 1) }, worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  /** @type {Record<string, string>} */
  const sources = {};
  for (const ran of Object.values(runs))
    for (const src of Object.keys(ran)) {
      if (src in sources) continue;
      try {
        sources[src] = hash(readFileSync(join(root, src), "utf8"));
      } catch {
        sources[src] = "";
      }
    }
  return {
    version: RUNTIME_MAP_VERSION,
    recordedAt: new Date().toISOString(),
    command,
    tests: tests.length,
    failedRuns: failedRuns.sort(),
    sources,
    runs,
  };
}

/** @param {string} root @param {RuntimeMap} map */
export function saveRuntimeMap(root, map) {
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, MAP_FILE), `${JSON.stringify(map)}\n`);
  try {
    ensureForgePrivateIgnored(root); // per-machine and derived: never committed
  } catch {}
}

/** @param {string} root @returns {RuntimeMap | null} */
export function loadRuntimeMap(root) {
  try {
    const map = JSON.parse(readFileSync(join(root, MAP_FILE), "utf8"));
    return map?.version === RUNTIME_MAP_VERSION && map.runs ? map : null;
  } catch {
    return null;
  }
}

/**
 * The test files that executed `names` in `files` (any function of the file when `names` is
 * empty), and whether any of those files changed since the recording.
 * @param {string} root
 * @param {RuntimeMap} map
 * @param {{files: string[], names?: string[]}} target
 * @returns {{tests: string[], stale: string[]}}
 */
export function runtimeTests(root, map, { files, names = [] }) {
  const want = new Set(files.map(toPosix));
  const fn = new Set(names);
  /** @type {string[]} */
  const tests = [];
  for (const [test, ran] of Object.entries(map.runs)) {
    const hit = Object.entries(ran).some(
      ([src, fns]) => want.has(src) && (!fn.size || fns.some((f) => fn.has(f))),
    );
    if (hit) tests.push(test);
  }
  const stale = [...want].filter((src) => {
    if (!(src in map.sources)) return false;
    try {
      return map.sources[src] !== hash(readFileSync(join(root, src), "utf8"));
    } catch {
      return true;
    }
  });
  return { tests: tests.sort(), stale };
}

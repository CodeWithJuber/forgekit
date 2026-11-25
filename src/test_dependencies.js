// A trusted build/trace producer supplies the complete test universe and the files
// its tests consume. The reverse closure is exact for those declared observations.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { outsideWorkspace, readBounded } from "./private_paths.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const LIMIT = 16 * 1024 * 1024;
function gitRead(root, args) {
  const bytes = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    timeout: 5000,
    maxBuffer: LIMIT,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

// Hash actual input bytes without asking Git to run any worktree filters. Include
// file names, index contents, untracked input, file type and execution mode.
// Unsupported checkouts and resource limits disable narrowing.
function snapshot(root) {
  root = realpathSync.native(root);
  if (realpathSync.native(gitRead(root, ["rev-parse", "--show-toplevel"]).trimEnd()) !== root)
    throw new Error("Compute dependency evidence from the checkout root");
  const revision = gitRead(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const index = gitRead(root, ["ls-files", "--stage", "-z", "--"]);
  const tracked = new Set();
  const paths = new Set(
    gitRead(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])
      .split("\0")
      .filter(Boolean),
  );
  for (const entry of index.split("\0").filter(Boolean)) {
    const i = entry.indexOf("\t");
    if (i < 0 || !/^(?:100644|100755|120000) [a-f0-9]+ 0$/.test(entry.slice(0, i)))
      throw new Error("Submodules or unmerged paths need independent observations");
    const path = entry.slice(i + 1);
    paths.add(path);
    if (!entry.startsWith("120000 ")) tracked.add(path);
  }
  if (paths.size > 50000) throw new Error("Checkout exceeds dependency fingerprint file budget");
  const digest = createHash("sha256");
  const field = (value) => {
    const data = Buffer.from(value);
    digest.update(String(data.length)).update(":").update(data);
  };
  field(revision);
  field(index);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (const file of [...paths].sort()) {
    if (!pathName(file))
      throw new Error("Checkout contains a path outside the supported input format");
    field(file);
    const target = join(root, file);
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (!st) {
      field("absent");
      tracked.delete(file);
      continue;
    }
    if (realpathSync.native(dirname(target)) !== dirname(target))
      throw new Error("Dependency inputs under linked directories cannot be bound");
    if (st.isSymbolicLink()) {
      field("symlink");
      field(readlinkSync(target, { encoding: "buffer" }));
      tracked.delete(file);
      continue;
    }
    total += st.size;
    if (!st.isFile() || st.size > 64 * 1024 * 1024 || total > 512 * 1024 * 1024)
      throw new Error("Checkout exceeds the regular-file fingerprint budget");
    field(String(st.mode & 0o111));
    field(String(st.size));
    const fd = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== st.dev ||
        opened.ino !== st.ino ||
        opened.size !== st.size
      )
        throw new Error("Dependency input changed while reading");
      let remaining = opened.size;
      while (remaining > 0) {
        const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
        if (!bytes) throw new Error("Dependency input changed while reading");
        digest.update(buffer.subarray(0, bytes));
        remaining -= bytes;
      }
      const after = fstatSync(fd);
      if (
        after.size !== opened.size ||
        after.ctimeMs !== opened.ctimeMs ||
        after.mtimeMs !== opened.mtimeMs
      )
        throw new Error("Dependency input changed while reading");
    } finally {
      closeSync(fd);
    }
  }
  return {
    tracked,
    state: {
      scheme: "git-working-files-v1",
      revision,
      fingerprint: digest.digest("hex"),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      environment: process.env.FORGE_TEST_ENVIRONMENT || null,
    },
  };
}

export function dependencyState(root) {
  return snapshot(root).state;
}

function pathName(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 4096 &&
    !/[\\\p{Cc}\p{Cf}]/u.test(s) &&
    !/^[A-Za-z]:|^[-/]/.test(s) &&
    s !== "." &&
    s !== ".." &&
    !s.startsWith("../") &&
    posix.normalize(s) === s
  );
}
const enrolled = (root) => privateWorkspaceFile(root, "test-dependencies-v1");

function readEvidence(root, input) {
  if (!isAbsolute(input))
    throw new Error("Choose an absolute dependency evidence path outside the checkout");
  // Refuse an in-project name, symlink or hard link even if it points at a trusted location.
  outsideWorkspace(root, input, "Dependency evidence must be outside the checkout");
  const path = join(realpathSync.native(dirname(input)), basename(input));
  return JSON.parse(readBounded(path, LIMIT).bytes.toString("utf8"));
}

function evidenceGraph(root, receipt) {
  if (
    receipt?.schemaVersion !== 1 ||
    typeof receipt.producer !== "string" ||
    !receipt.producer.trim() ||
    typeof receipt.runner !== "string" ||
    !receipt.runner.trim() ||
    !Array.isArray(receipt.tests) ||
    !receipt.tests.length ||
    !Array.isArray(receipt.dependencies) ||
    receipt.complete !== true ||
    !Array.isArray(receipt.unresolved) ||
    receipt.unresolved.length
  )
    throw new Error("Missing or incomplete dependency or test discovery evidence");
  const { state, tracked } = snapshot(root);
  if (!state.environment) throw new Error("The test environment has no protected identity");
  if (!Object.entries(state).every(([k, v]) => receipt.checkout?.[k] === v))
    throw new Error("Dependency evidence is stale or belongs to a different execution environment");
  const known = new Set(),
    tests = new Set(),
    reverse = new Map();
  function accept(file) {
    if (known.has(file)) return;
    if (!pathName(file) || !tracked.has(file))
      throw new Error("Dependency evidence references an untracked or invalid path");
    known.add(file);
  }
  for (const test of receipt.tests) {
    accept(test);
    if (tests.has(test)) throw new Error("Duplicate discovered test in dependency evidence");
    tests.add(test);
  }
  function connect(consumer, dependency) {
    accept(consumer);
    accept(dependency);
    if (!reverse.has(dependency)) reverse.set(dependency, new Set());
    reverse.get(dependency).add(consumer);
  }
  for (const pair of receipt.dependencies) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid dependency edge");
    connect(pair[0], pair[1]);
  }
  if (Object.hasOwn(receipt, "lcov")) {
    if (typeof receipt.lcov !== "string" || !receipt.lcov.trim())
      throw new Error("Invalid named LCOV data");
    let test,
      source,
      measured = false,
      hit = false,
      records = 0;
    for (const line of receipt.lcov.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("TN:")) {
        if (test || source || !tests.has(line.slice(3)))
          throw new Error("LCOV coverage needs a discovered test identity in each record");
        test = line.slice(3);
      } else if (line.startsWith("SF:")) {
        if (!test || source)
          throw new Error("LCOV coverage needs a named test and one source per record");
        source = line.slice(3);
        accept(source);
      } else if (line.startsWith("DA:")) {
        const match = /^DA:[1-9][0-9]*,([0-9]+)(?:,[^,]+)?$/.exec(line);
        if (!source || !match) throw new Error("Unusable LCOV line observation");
        measured = true;
        if (Number(match[1]) > 0) hit = true;
      } else if (line === "end_of_record") {
        if (!test || !source || !measured) throw new Error("Incomplete named LCOV record");
        records++;
        if (hit) connect(test, source);
        test = source = undefined;
        measured = hit = false;
      }
    }
    if (!records || test || source) throw new Error("Truncated LCOV observation");
  }
  return { state, tests, reverse, known };
}

export function registerDependencies(root, input) {
  const receipt = readEvidence(root, input);
  const { state, tests } = evidenceGraph(root, receipt);
  const path = enrolled(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return {
    schemaVersion: 1,
    checkout: state,
    runner: receipt.runner,
    tests: tests.size,
    producer: receipt.producer,
  };
}

export function measuredImpact(root, files, evidence = undefined, head = undefined) {
  const path = evidence ?? enrolled(root);
  if (!existsSync(path)) throw new Error("No checkout-bound test dependency evidence");
  const receipt = readEvidence(root, path);
  const { state, tests, reverse, known } = evidenceGraph(root, receipt);
  if (head !== undefined) {
    if (!head || head.startsWith("-")) throw new Error("Invalid comparison revision");
    const compared = gitRead(root, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
    if (compared !== state.revision)
      throw new Error("Comparison revision differs from the measured checkout");
  }

  // A root with no observed path to any test is uncertain even if another root is covered.
  const dependencies = new Map();
  for (const [dep, consumers] of reverse)
    for (const consumer of consumers) {
      if (!dependencies.has(consumer)) dependencies.set(consumer, new Set());
      dependencies.get(consumer).add(dep);
    }
  const closure = (seeds, graph) => {
    const seen = new Set(seeds);
    for (const current of seen) for (const next of graph.get(current) ?? []) seen.add(next);
    return seen;
  };
  const covered = closure(tests, dependencies);
  if (!files.length || files.some((f) => !known.has(f) || !covered.has(f)))
    throw new Error("At least one changed path lacks a measured path to a discovered test");
  const affected = closure(files, reverse);
  const selected = [...tests].filter((f) => affected.has(f)).sort();
  return {
    tests: selected,
    affected: [...affected].sort(),
    producer: receipt.producer,
    runner: receipt.runner,
    checkout: state,
    testUniverse: tests.size,
  };
}

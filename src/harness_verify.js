// Only a locally selected verification contract may run code. The default reads a
// signed, checkout-bound receipt. A model's answer never becomes an executable command.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { secretKind } from "../global/guards/protect-paths.mjs";
import { harnessChildPath, installedHarnessProgram } from "./harness_python.js";
import { createHarnessTools } from "./harness_tools.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { contentHash } from "./util.js";
import { planSuites, readVerifyEvents, verifyClaim, withVerificationGit } from "./verify.js";

const invoke = promisify(execFile);
const MAX_FILES = 6000,
  MAX_BYTES = 64 * 1024 * 1024,
  MAX_FILE = 4 * 1024 * 1024;
const commandText = (argv) => argv.map((s) => JSON.stringify(s)).join(" ");
function readBounded(path, limit) {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit || realpathSync.native(path) !== path)
      throw new Error("Verification input must be a bounded regular file");
    const bytes = Buffer.alloc(st.size);
    let pos = 0;
    while (pos < bytes.length) {
      const n = readSync(fd, bytes, pos, bytes.length - pos, null);
      if (!n) throw new Error("File changed during verification");
      pos += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null))
      throw new Error("File changed during verification");
    return { bytes, mode: st.mode & 0o111 ? 0o555 : 0o444 };
  } finally {
    closeSync(fd);
  }
}

function checkReceipt(root) {
  const dir = join(root, ".forge");
  for (const path of [dir, join(dir, "provenance.json"), join(dir, "verify-events.jsonl")])
    if (lstatSync(path).isSymbolicLink()) throw new Error("Refusing a linked verification receipt");
  const prov = JSON.parse(
    readBounded(join(dir, "provenance.json"), 8 * 1024 * 1024).bytes.toString("utf8"),
  );
  const history = lstatSync(join(dir, "verify-events.jsonl"));
  if (!history.isFile() || history.nlink !== 1 || history.size > 32 * 1024 * 1024)
    throw new Error("Verifier history must be a bounded regular file");
  const checked = verifyClaim({ provenance: prov }, { cwd: root });
  if (
    checked.verdict !== "CONFIRMED" ||
    checked.signature !== "VALID" ||
    checked.tree !== "MATCHED" ||
    !prov.codeState?.gitAvailable ||
    !prov.codeState?.dirtyHash ||
    prov.tests?.status !== "PASS"
  )
    throw new Error(
      `A signed PASS for this checkout's current tree is required (${checked.verdict})`,
    );
  const event = readVerifyEvents(root).find(
    (e) =>
      e.runId === prov.event?.runId &&
      e.inCheckout &&
      e.authScope === "event" &&
      e.status === "PASS" &&
      e.pre?.dirtyHash === prov.codeState.dirtyHash &&
      e.post?.dirtyHash === e.pre.dirtyHash &&
      e.pre.head === prov.codeState.head &&
      e.post.head === e.pre.head,
  );
  if (!event?.suites?.length || event.suites.some((s) => s.status !== "PASS" || s.exitCode !== 0))
    throw new Error("Missing authenticated, passing suite event for this checkout");
  return {
    ok: true,
    scope: "project-suites",
    command: "forge verify --claim",
    fingerprint: prov.codeState.dirtyHash,
    output: redactSecrets(
      `Authenticated run ${event.runId}\n${event.suites.map((s) => `${s.cwd} ${s.label} — ${s.status}, exit ${s.exitCode}`).join("\n")}`,
    ).slice(0, 10000),
  };
}

function checkAssertions(spec, { root, request, runId }) {
  if (
    !Array.isArray(spec.acceptance) ||
    !spec.acceptance.length ||
    !Array.isArray(spec.assertions) ||
    spec.acceptance.length > 32 ||
    spec.runId !== runId ||
    spec.task !== request.task ||
    JSON.stringify(spec.acceptance) !== JSON.stringify(request.acceptance) ||
    spec.assertions.length !== spec.acceptance.length
  )
    throw new Error(
      "The operator assertion contract must identify this run, task and every acceptance criterion",
    );
  const planned = planSuites(root);
  if (planned.suites.length || planned.coverage.truncated)
    throw new Error("Project suites require a signed receipt or isolated test command");
  const read = createHarnessTools().find((t) => t.name === "read_file");
  const seen = new Set(),
    results = [],
    observed = new Map();
  for (const a of spec.assertions) {
    const key = a.criterion;
    if (!Number.isInteger(key) || key < 0 || key >= spec.acceptance.length || seen.has(key))
      throw new Error("Expected exactly one assertion per acceptance criterion");
    seen.add(key);
    read.validate({ path: a.path }, { root, request });
    const path = join(root, a.path),
      data = readBounded(path, 131072).bytes,
      hash = createHash("sha256").update(data).digest("hex");
    if (observed.has(path) && observed.get(path) !== hash)
      throw new Error("Acceptance input changed during verification");
    observed.set(path, hash);
    const operations = ["sha256", "textEquals", "jsonPath"].filter((k) => Object.hasOwn(a, k));
    if (operations.length !== 1) throw new Error("Specify one exact file, text or JSON assertion");
    let ok = false;
    if (operations[0] === "sha256")
      ok = typeof a.sha256 === "string" && /^[a-f0-9]{64}$/.test(a.sha256) && hash === a.sha256;
    else if (operations[0] === "textEquals")
      ok = typeof a.textEquals === "string" && data.equals(Buffer.from(a.textEquals, "utf8"));
    else {
      if (!Array.isArray(a.jsonPath) || a.jsonPath.length > 32 || !Object.hasOwn(a, "equals"))
        throw new Error("Invalid JSON assertion");
      let value = JSON.parse(data.toString("utf8"));
      for (const field of a.jsonPath) {
        if (
          typeof field !== "string" ||
          !value ||
          typeof value !== "object" ||
          !Object.hasOwn(value, field)
        )
          throw new Error("Expected JSON member missing");
        value = value[field];
      }
      ok = JSON.stringify(value) === JSON.stringify(a.equals);
    }
    results.push(`criterion ${key + 1}: ${a.path} ${operations[0]} ${ok ? "PASS" : "FAIL"}`);
    if (!ok)
      return {
        ok: false,
        scope: "file-assertions",
        command: "forge harness file assertions",
        output: results.join("\n"),
      };
  }
  for (const [path, hash] of observed)
    if (createHash("sha256").update(readBounded(path, 131072).bytes).digest("hex") !== hash)
      throw new Error("File changed before the acceptance gate closed");
  return {
    ok: true,
    scope: "file-assertions",
    command: "forge harness file assertions",
    fingerprint: contentHash(JSON.stringify([...observed])),
    output: `Only the run-bound file assertions were verified.\n${results.join("\n")}`,
  };
}

function snapshot(root, dest, signal) {
  // Ignore rules are evaluated by git, not a project command. Only regular project
  // files can enter the container; git administration, credential files, ignored
  // dependencies and symlink targets never cross this boundary.
  const listing = execFileSync(
    installedHarnessProgram(root, "git"),
    ["-c", "core.fsmonitor=false", "ls-files", "-co", "--exclude-standard", "-z"],
    {
      cwd: root,
      env: { ...process.env, PATH: harnessChildPath(root) },
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const files = [...new Set(listing.split("\0").filter(Boolean))].sort();
  if (!files.length || files.length > MAX_FILES)
    throw new Error("Use a Git worktree with 1–6000 files for the isolated verifier");
  const hash = createHash("sha256");
  let total = 0,
    count = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const parts = file.split("/");
    if (
      parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || /[\p{Cc}:]/u.test(p))
    )
      throw new Error("Invalid project snapshot path");
    if (
      parts.some((p) =>
        [
          ".git",
          ".forge",
          ".ssh",
          ".aws",
          ".azure",
          ".kube",
          ".config",
          ".docker",
          ".gnupg",
          "node_modules",
          "harness",
          "secrets",
        ].includes(p.toLowerCase()),
      ) ||
      secretKind(file, { cwd: root }) ||
      parts.some((p) => /^(?:credentials?|secret)(?:[._-]|$)|\.(?:pfx|p12|kdbx)$/i.test(p))
    )
      continue;
    const path = join(root, file),
      st = lstatSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isFile() || st.nlink !== 1 || realpathSync.native(path) !== path)
      throw new Error(`Linked, nested or non-regular verification input: ${file}`);
    if ((total += st.size) > MAX_BYTES) throw new Error("Verification snapshot exceeds 64 MiB");
    const { bytes, mode } = readBounded(path, MAX_FILE);
    if (hasSecret(bytes.toString("utf8"), { entropy: false }))
      throw new Error(`Potential credential in verification input: ${file}`);
    hash
      .update(JSON.stringify([file, mode, bytes.length]))
      .update("\0")
      .update(bytes);
    if (dest) {
      const to = join(dest, file);
      mkdirSync(dirname(to), { mode: 0o755, recursive: true });
      writeFileSync(to, bytes, { flag: "wx", mode });
    }
    count++;
  }
  if (!count) throw new Error("Empty verification snapshot");
  return hash.digest("hex");
}

const FAIL_COMMAND = "forge harness verifier";
export function validateContainerVerifier(spec) {
  const { runtime, image, command } = spec;
  if (
    !["docker", "podman"].includes(runtime) ||
    typeof image !== "string" ||
    !/^[a-z0-9][a-z0-9./:_-]{0,180}@sha256:[a-f0-9]{64}$/.test(image) ||
    !Array.isArray(command) ||
    !command.length ||
    command.length > 40 ||
    command.some((s) => typeof s !== "string" || !s || s.includes("\0") || s.length > 4096)
  )
    throw new Error("Choose docker or podman, a digest-pinned image and an argv array");
  const timeout = spec.timeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000)
    throw new Error("Container timeout must be 100–120000 ms");
  return { mode: "container", runtime, image, command, timeoutMs: timeout };
}
async function runContainer(spec, { root, signal }) {
  const { runtime, image, command, timeoutMs: timeout } = validateContainerVerifier(spec);
  const bin = installedHarnessProgram(root, runtime),
    area = mkdtempSync(join(tmpdir(), "forge-harness-check-"));
  const name = `forge-harness-${randomUUID()}`;
  const env = {
    PATH: harnessChildPath(root),
    LANG: "C",
    HOME: area,
    DOCKER_CONFIG: join(area, "docker-config"),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  };
  const opts = {
    cwd: area,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 5000,
    windowsHide: true,
  };
  try {
    const source = join(area, "source");
    mkdirSync(source, { mode: 0o755 });
    chmodSync(source, 0o755);
    if (source.includes(","))
      throw new Error("Cannot mount a verifier snapshot under a comma-containing temp path");
    const before = snapshot(root, source, signal);
    const info = await invoke(
      bin,
      ["image", "inspect", "--format", "{{json .Config.Volumes}}", image],
      { ...opts, signal },
    );
    const vols = JSON.parse(String(info.stdout));
    if (vols && Object.keys(vols).length)
      throw new Error("Verifier images must not declare writable volumes");
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--pull=never",
      "--network=none",
      "--read-only",
      ...(runtime === "podman" ? ["--read-only-tmpfs=false"] : []),
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--log-driver=none",
      "--user=65534:65534",
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--pids-limit=64",
      "--shm-size=8m",
      "--ulimit=nofile=256:256",
      "--ulimit=fsize=67108864:67108864",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
      "--tmpfs",
      "/work:rw,nosuid,nodev,size=128m,mode=1777",
      "--mount",
      `type=bind,src=${source},dst=/input,readonly`,
      "--workdir=/work",
      "--env",
      "HOME=/tmp",
      "--entrypoint",
      "/bin/sh",
      image,
      "-ec",
      'mkdir /work/project; cd /work/project; cp -R /input/. .; chmod -R u+w .; exec "$@"',
      "forge-check",
      ...command,
    ];
    let result;
    try {
      result = await invoke(bin, args, { ...opts, signal, timeout, killSignal: "SIGKILL" });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const output = redactSecrets(`${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`);
      return {
        ok: false,
        scope: "isolated-command",
        command: commandText(command),
        fingerprint: before,
        output: `Isolated check failed (${e.killed ? "timeout/output limit" : e.code}).\n${output.slice(-9000)}`,
      };
    } finally {
      // Killing the CLI does not kill its daemon-side child.
      try {
        await invoke(bin, ["rm", "-f", name], opts);
      } catch {}
    }
    if (snapshot(root, null, signal) !== before)
      throw new Error("Workspace changed while isolated checks ran");
    return {
      ok: true,
      scope: "isolated-command",
      command: commandText(command),
      fingerprint: before,
      output: `Verified in ${image}, exit 0.\n${redactSecrets(`${String(result.stdout)}\n${String(result.stderr)}`).slice(-9000)}`,
    };
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
}

/** Options must come from the local operator. Request-file or MCP arguments cannot authorize a verifier command. */
export function createHarnessVerifier(options = { mode: "receipt" }) {
  const spec = structuredClone(options);
  return async function verify(input) {
    const root = realpathSync.native(input.root);
    try {
      input.signal?.throwIfAborted();
      if (spec.mode === "receipt") {
        const git = installedHarnessProgram(root, "git");
        return withVerificationGit(git, harnessChildPath(root), () => checkReceipt(root));
      }
      if (spec.mode === "assertions") {
        const git = installedHarnessProgram(root, "git");
        return withVerificationGit(git, harnessChildPath(root), () =>
          checkAssertions(spec, { ...input, root }),
        );
      }
      if (spec.mode === "container") return await runContainer(spec, { ...input, root });
      throw new Error("Unknown harness verification mode");
    } catch (e) {
      if (input.signal?.aborted) throw input.signal.reason;
      return {
        ok: false,
        command: FAIL_COMMAND,
        output: redactSecrets(String(e.message)).slice(0, 3000),
      };
    }
  };
}

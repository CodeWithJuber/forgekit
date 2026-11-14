// Personal opt-in for running a vetted integration install after a matching prompt.
// The worker receives an approved catalog ID. Private task text never enters files,
// subprocess arguments, or provider requests. Monotonic generation claims serialize concurrent automatic installs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stableVersion } from "./integrations.js";
import { readForgeConfig } from "./repo_config.js";
import { redactSecrets } from "./secrets.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { adoptionCatalog, installAdoption, matchAdoption } from "./tool_adoption.js";
import { contentHash, userStateDir } from "./util.js";

const BACKOFF = 10 * 60 * 1000;
const MAX_RUN = 180000;
const jobFile = "job.json";
const workerPath = fileURLToPath(import.meta.url);
const validId = (id) =>
  typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !(id in Object.prototype);
const fingerprint = (entry) =>
  contentHash(
    JSON.stringify([
      entry.id,
      entry.npm,
      entry.bin,
      entry.upstream,
      entry.terms,
      entry.permissions,
      entry.cost,
    ]),
  );

const errorText = (e) =>
  redactSecrets(String(e?.message ?? e))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .slice(0, 260);
function location(root) {
  const workspace = sourceWorkspaceRoot(root);
  const state = resolve(userStateDir());
  const rel = relative(workspace, state);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    throw new Error("Set FORGE_HOME outside the worktree for private installation policy");
  return { workspace, dir: join(state, "integrations-auto", contentHash(workspace)) };
}
function read(path) {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 32 * 1024) throw new Error("Oversized automatic installation state");
  return JSON.parse(readFileSync(path, "utf8"));
}
function write(path, value) {
  const tmp = join(dirname(path), `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
function policy(dir) {
  const value = read(join(dir, "policy.json"));
  if (!value) return { allowed: [], revision: null, bindings: {} };
  if (
    !Array.isArray(value.allowed) ||
    !value.allowed.every(validId) ||
    value.allowed.length > 66 ||
    !value.bindings ||
    typeof value.revision !== "string"
  )
    throw new Error("Invalid personal auto-install policy");
  return value;
}
const jobDir = (dir, slot) => join(dir, `slot-${slot}`);
const receipt = (dir, id) => join(dir, `installed-${id}.json`);
function jobStatus(dir, slot) {
  const job = read(join(jobDir(dir, slot), jobFile));
  if (!job) return null;
  if (["queued", "running"].includes(job.state) && Date.now() > job.deadline)
    return { ...job, state: "expired" };
  return job;
}

/** Replace this working tree's personal allowlist. Turning it off does not uninstall tools. */
export function configureAuto(root, action, ids = []) {
  if (action === "status" && !ids.length) return autoStatus(root);
  if (
    !Array.isArray(ids) ||
    !["on", "off"].includes(action) ||
    (action === "on" && !ids.length) ||
    (action === "off" && ids.length)
  )
    throw new Error("Use auto on <curated IDs>, off, or status");
  const { workspace, dir } = location(root);
  const catalog = action === "off" ? [] : adoptionCatalog(workspace);
  if (!ids.every((id) => validId(id) && catalog.some((entry) => entry.id === id)))
    throw new Error("Choose IDs from the reviewed personal or built-in tool catalog");
  const bindings = Object.fromEntries(
    catalog
      .filter((entry) => ids.includes(entry.id))
      .map((entry) => [entry.id, fingerprint(entry)]),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const allowed = [...new Set(ids)].sort();
  write(join(dir, "policy.json"), { allowed, bindings, revision: randomUUID() });
  return autoStatus(root);
}

function jobSequence(dir) {
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((n) => /^slot-\d+$/.test(n))
    .map((n) => Number(n.slice(5)))
    .sort((a, b) => b - a);
}
/** Read-only status. A never-configured repository has no policy or job files. */
export function autoStatus(root) {
  const { dir } = location(root);
  const { allowed } = policy(dir);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const slots = jobSequence(dir);
  return {
    enabled: allowed.length > 0,
    allowed,
    jobs: slots
      .slice(0, 6)
      .map((n) => jobStatus(dir, n))
      .filter(Boolean),
    installed: names
      .filter((n) => /^installed-[a-z0-9_-]{1,64}\.json$/.test(n))
      .map((n) => read(join(dir, n)))
      .filter(Boolean),
  };
}

function launch(workspace, id, slot, deadline) {
  const env = { ...process.env };
  // Node preloads inherited from an interactive tool are unnecessary in the installer.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(process.execPath, [workerPath, "--worker", id, String(slot)], {
    cwd: workspace,
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    env,
    timeout: Math.max(1, deadline - Date.now()),
    killSignal: "SIGKILL",
  });
  child.once("error", () => {}); // status ages the claim out if the subprocess cannot start.
  child.unref();
}
function existingInstall(root, id) {
  const cfg = readForgeConfig(root);
  if (cfg.corrupt) return { ready: true };
  if (!Array.isArray(cfg.mcp?.integrations) || !cfg.mcp.integrations.includes(id))
    return { ready: false };
  const version = cfg.mcp.versions?.[id];
  // Legacy presets run npx themselves. A checked-in pinned runner needs its private
  // package materialized independently on each machine that opens the checkout.
  if (!stableVersion(version)) return { ready: true };
  return {
    version,
    ready: existsSync(join(userStateDir(), "tool-packages", id, version, "receipt.json")),
  };
}
/** Called in-process by the hook. Do not await a registry, installation or model here. */
export function maybeAutoAdopt(root, task, { launchWorker = launch, now = Date.now() } = {}) {
  const { workspace, dir } = location(root);
  const auth = policy(dir);
  if (!auth.allowed.length || typeof task !== "string") return null;
  const matches = matchAdoption(task.slice(0, 6000), { root: workspace });
  const catalog = adoptionCatalog(workspace);
  const previous = jobSequence(dir);
  const prior = previous[0] ?? 0;
  if (prior) {
    const priorDir = jobDir(dir, prior);
    const job = read(join(priorDir, jobFile));
    // A scheduler can be interrupted before it writes job.json. Such a claim
    // self-expires too. No process needs to unlink a competing worker's mutex.
    const expires = job?.deadline ?? statSync(priorDir).mtimeMs + MAX_RUN;
    if ((!job || ["queued", "running"].includes(job.state)) && now < expires) return null;
  }
  const id = matches
    .map((m) => m.id)
    .find((id) => {
      if (
        !auth.allowed.includes(id) ||
        !catalog.some((entry) => entry.id === id && auth.bindings[id] === fingerprint(entry)) ||
        existingInstall(workspace, id).ready
      )
        return false;
      const failed = read(join(dir, `retry-${id}.json`));
      return !failed || now >= failed.after;
    });
  if (!id) return null;
  const slot = prior + 1,
    deadline = now + MAX_RUN;
  const claim = jobDir(dir, slot);
  try {
    mkdirSync(claim, { mode: 0o700 });
  } catch (e) {
    if (e.code === "EEXIST") return null;
    throw e;
  }
  const job = { id, slot, revision: auth.revision, queuedAt: now, deadline, state: "queued" };
  const path = join(claim, jobFile);
  write(path, job);
  try {
    launchWorker(workspace, id, slot, deadline);
  } catch (e) {
    job.state = "failed";
    write(join(dir, `retry-${id}.json`), { after: now + BACKOFF });
    write(path, { ...job, error: errorText(e) });
  }
  // Keep recent job diagnostics. Individual successful-install receipts are permanent.
  for (const name of readdirSync(dir)) {
    if (/^slot-\d+$/.test(name) && Number(name.slice(5)) < slot - 6)
      rmSync(join(dir, name), { force: true, recursive: true });
  }
  return { id, state: job.state };
}

// A worker checks its claim again even if started directly. The exclusive file also
// prevents duplicate invocations for a scheduled job. Lookup uses only the canonical ID.
export async function runAutoJob(
  root,
  id,
  slot,
  { install = installAdoption, now = Date.now } = {},
) {
  if (!validId(id) || !Number.isSafeInteger(slot)) return;
  const { workspace, dir } = location(root);
  const claim = jobDir(dir, slot);
  const path = join(claim, jobFile);
  const job = read(path);
  if (!job || job.id !== id || job.slot !== slot || job.state !== "queued") return;
  const authorized = () => {
    const auth = policy(dir);
    return (
      auth.revision === job.revision &&
      auth.allowed.includes(id) &&
      now() < job.deadline &&
      jobSequence(dir)[0] === slot &&
      adoptionCatalog(workspace).some((e) => e.id === id && fingerprint(e) === auth.bindings[id])
    );
  };
  try {
    writeFileSync(join(claim, "started"), "", { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code === "EEXIST") return;
    throw e;
  }
  const save = (state, other = {}) => write(path, { ...job, state, ...other });
  const installed = existingInstall(workspace, id);
  if (!authorized() || installed.ready) {
    save("cancelled");
    return;
  }
  save("running");
  const timer = setTimeout(() => process.exit(124), Math.max(1, job.deadline - now()));
  timer.unref();
  try {
    const result = await install(workspace, id, {
      version: installed.version,
      canRegister: () =>
        authorized() && existingInstall(workspace, id).version === installed.version,
    });
    if (!result.ok || !("version" in result) || !stableVersion(result.version))
      throw new Error(result.reason ?? "Integration installation failed");
    const done = { id, version: result.version, finishedAt: now() };
    write(receipt(dir, id), done);
    save(
      "adopted" in result && result.adopted === false ? "installed-with-collisions" : "installed",
      done,
    );
  } catch (e) {
    write(join(dir, `retry-${id}.json`), { after: now() + BACKOFF });
    save("failed", { error: errorText(e) });
  } finally {
    clearTimeout(timer);
  }
}

// Direct invocation can consume only a live, already-authorized claim in this directory.
if (
  process.argv[2] === "--worker" &&
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(workerPath)
) {
  runAutoJob(process.cwd(), process.argv[3], Number(process.argv[4])).catch(() => {
    process.exitCode = 1;
  });
}

// Version-controlled policy, local worktree activation. A different checkout cannot
// silently enable provider calls, background jobs or native supervision for this user.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readHarnessConfigData } from "./harness_config_data.js";
import { defaultHarnessPolicy } from "./harness_policy.js";
import { defaultHarnessRouting } from "./harness_router.js";
import { outsideWorkspace } from "./private_paths.js";
import { userStateDir } from "./util.js";

const names = ["policy", "routing", "budgets", "jobs"];
const hash = (s) => createHash("sha256").update(s).digest("hex");
function bindingPath(root) {
  const canonical = outsideWorkspace(
    root,
    userStateDir(),
    "Private state must be outside the project",
  );
  return join(canonical, "harness-activation", `${hash(realpathSync.native(root))}.json`);
}
function readBinding(root, path = bindingPath(root)) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2048 || realpathSync.native(path) !== path)
      throw new Error("Invalid harness activation file");
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (!v || !/^[a-f0-9]{64}$/.test(v.digest) || typeof v.supervised !== "boolean")
      throw new Error("Invalid harness activation");
    return v;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function defaults() {
  const budget = (turns, tokens, minutes, toolCalls) => ({
    turns,
    tokens,
    milliseconds: minutes * 60000,
    toolCalls,
    costUsd: 0,
    contextTokens: 8192,
    repairs: 3,
  });
  return {
    policy: {
      ...defaultHarnessPolicy(),
      nativeMode: "parallel",
      nativeProfile: "coder",
      hosts: [],
    },
    routing: defaultHarnessRouting(),
    budgets: {
      ceilings: { dailyUsd: 0, projectUsd: 0 },
      classes: {
        P0: budget(25, 400000, 60, 120),
        P1: budget(25, 200000, 30, 80),
        P2: budget(15, 120000, 20, 50),
        P3: budget(8, 60000, 10, 25),
      },
    },
    jobs: { jobs: [], triggers: [] },
    lockfile: { version: 1, extensions: [] },
  };
}
function controls(root) {
  const d = join(root, "harness");
  const c = Object.fromEntries(
    names.map((k) => [k, readHarnessConfigData(join(d, `${k}.yaml`), { root })]),
  );
  if (
    !["parallel", "supervised"].includes(c.policy.nativeMode) ||
    !c.policy.profiles?.[c.policy.nativeProfile] ||
    !Array.isArray(c.policy.hosts)
  )
    throw new Error("Invalid harness policy nativeMode, nativeProfile or hosts");
  if (
    !c.budgets.classes ||
    !c.budgets.ceilings ||
    !Array.isArray(c.jobs.jobs) ||
    !Array.isArray(c.jobs.triggers)
  )
    throw new Error("Invalid harness budget or job definitions");
  return {
    policy: c.policy,
    routing: c.routing,
    budgets: c.budgets,
    jobs: c.jobs,
    digest: hash(JSON.stringify(c)),
  };
}
export function trustHarness(root) {
  const config = controls(root),
    path = bindingPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (realpathSync.native(dirname(path)) !== dirname(path))
    throw new Error("Symlinked private activation directory");
  const temp = `${path}.${randomUUID()}`;
  writeFileSync(
    temp,
    JSON.stringify({
      digest: config.digest,
      supervised: config.policy.nativeMode === "supervised",
    }),
    { flag: "wx", mode: 0o600 },
  );
  renameSync(temp, path);
  return { digest: config.digest, mode: config.policy.nativeMode, root };
}
// Operator-owned verification programs never come from an MCP request or a job payload.
export async function localVerifier(root, update = undefined) {
  const path = `${bindingPath(root)}.verifier`;
  if (update === null) {
    rmSync(path, { force: true });
    return { mode: "receipt" };
  }
  if (update === undefined && !existsSync(path)) return { mode: "receipt" };
  const { validateContainerVerifier } = await import("./harness_verify.js");
  if (update !== undefined) {
    if (update.mode !== "container")
      throw new Error("Only a pinned container verifier can be shared by runs");
    const contract = validateContainerVerifier(update);
    loadHarnessConfig(root);
    const temp = `${path}.${randomUUID()}`;
    writeFileSync(temp, JSON.stringify(contract), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    return contract;
  }
  const st = lstatSync(path);
  if (!st.isFile() || st.nlink !== 1 || st.size > 65536 || realpathSync.native(path) !== path)
    throw new Error("Invalid stored verifier");
  return validateContainerVerifier(JSON.parse(readFileSync(path, "utf8")));
}
export function initHarness(root, { hosts = [], supervised = false } = {}) {
  const d = join(root, "harness");
  if (
    existsSync(d) &&
    (!lstatSync(d).isDirectory() ||
      realpathSync.native(d) !== join(realpathSync.native(root), "harness"))
  )
    throw new Error("Expected a project-local harness directory");
  const values = defaults();
  values.policy.hosts = hosts;
  if (supervised) values.policy.nativeMode = "supervised";
  mkdirSync(d, { recursive: true });
  const created = [];
  for (const [key, value] of Object.entries(values)) {
    const name = key + (key === "lockfile" ? ".json" : ".yaml");
    try {
      writeFileSync(join(d, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
      created.push(name);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  // Existing controls require explicit review even after an interrupted init. Never
  // grant ambient MCP or native access merely because somebody checked in a policy.
  const activated = created.length === 5 ? trustHarness(root) : null;
  return {
    root,
    created,
    activated,
    next: activated ? "forge harness routes" : "Review harness/ and run forge harness trust",
  };
}
export function loadHarnessConfig(root, { trusted = true } = {}) {
  const cfg = controls(root);
  if (trusted && readBinding(root)?.digest !== cfg.digest)
    throw new Error("Review harness/ and run forge harness trust in this worktree");
  return cfg;
}
export function nativeHarnessPolicy(cwd) {
  const dir = resolve(userStateDir(), "harness-activation");
  if (!existsSync(dir)) return null;
  let current;
  try {
    current = realpathSync.native(cwd);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  const roots = [];
  for (let at = current; ; at = dirname(at)) {
    roots.push(at);
    if (dirname(at) === at) break;
  }
  // The outermost supervised workspace owns nested packages and nested repositories.
  for (const root of roots.reverse()) {
    const path = join(dir, `${hash(root)}.json`);
    if (!existsSync(path)) continue;
    try {
      const binding = readBinding(root);
      if (binding?.supervised) return { root, policy: loadHarnessConfig(root).policy };
    } catch (e) {
      e.harnessRoot = root;
      throw e;
    }
  }
  return null;
}
export function harnessBudget(config, priority, override = {}) {
  if (!["P0", "P1", "P2", "P3"].includes(priority)) throw new Error("Expected P0–P3");
  const limits = config.budgets.classes[priority];
  if (!limits || !override || typeof override !== "object" || Array.isArray(override))
    throw new Error("Invalid budget");
  const result = {};
  for (const key of [
    "turns",
    "tokens",
    "milliseconds",
    "toolCalls",
    "costUsd",
    "repairs",
    "contextTokens",
  ]) {
    const cap = limits[key],
      n = Object.hasOwn(override, key) ? override[key] : cap;
    const min = key === "costUsd" || key === "repairs" ? 0 : 1;
    if (
      !Number.isFinite(cap) ||
      !Number.isFinite(n) ||
      n < min ||
      cap < min ||
      (key !== "costUsd" && (!Number.isSafeInteger(n) || !Number.isSafeInteger(cap)))
    )
      throw new Error(`Invalid budget cap ${key}`);
    result[key] = Math.min(n, cap);
  }
  return result;
}

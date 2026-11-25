// Bind the impact review to this session, exact intended edit, checkout and target bytes.
// Only hashes and relative names enter private storage. An impact plan is never passing test evidence.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { secretKind } from "../global/guards/protect-paths.mjs";
import { canonicalize } from "./ledger.js";
import { containsPath, outsideWorkspace, physicalPath, readBounded } from "./private_paths.js";
import { sourceWorkspaceRoot } from "./sources.js";
import { dependencyState } from "./test_dependencies.js";
import { contentHash } from "./util.js";
import { evidenceMac } from "./verify.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const digest = (value) => contentHash(canonicalize(value, (s) => s));
export const editIntent = (tool, input) => digest([tool, input]);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const changed = () =>
  new Error(
    "The checkout or an edit target changed. Retry the original tool call for a current review.",
  );

function storeFile(root, id, state) {
  if (!validId(id)) throw new Error("Expected the review ID printed by the edit hook.");
  const dir = privateWorkspaceFile(root, "pre-edit-v1").slice(0, -5);
  return outsideWorkspace(
    root,
    join(dir, `${id}.${state}.json`),
    "Keep impact reviews outside the workspace.",
  );
}

function readRecord(root, id, state) {
  try {
    return JSON.parse(
      readBounded(storeFile(root, id, state), 16 * 1024 * 1024).bytes.toString("utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function saveRecord(root, id, state, record) {
  const file = storeFile(root, id, state);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function targetState(root, path) {
  const file = resolve(root, path);
  if (file === root || !containsPath(root, file) || physicalPath(file) !== file || secretKind(file))
    throw new Error("Impact review needs an ordinary file inside this workspace.");
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.nlink !== 1)
    throw new Error("Impact review needs a regular, unlinked target file.");
  const fd = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || physicalPath(file) !== file) throw changed();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = before.size;
    while (remaining > 0n) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(remaining)), null);
      if (!count) throw changed();
      hash.update(buffer.subarray(0, count));
      remaining -= BigInt(count);
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(file, { bigint: true });
    if (before.ctimeNs !== after.ctimeNs || after.dev !== named.dev || after.ino !== named.ino)
      throw changed();
    return [after.mode.toString(), hash.digest("hex")];
  } finally {
    closeSync(fd);
  }
}

function fingerprint(root, files) {
  const targets = files.map((file) => [file, targetState(root, file)]);
  let checkout;
  try {
    checkout = { bound: true, ...dependencyState(root) };
  } catch {
    // A non-Git workspace, submodule or repository exceeding the snapshot budget
    // still has an exact target preimage and a conservative full-workspace scope.
    checkout = { bound: false, scheme: "target-content-v1" };
  }
  return { targets, checkout };
}

// Reverse reachability over all recorded edges. A partial static graph provides
// locators for inspection. Only the independently enrolled selector may narrow tests.
function observedDependents(atlas, targets) {
  const owner = new Map(atlas.nodes.map((node) => [node.id, node.file]));
  const callers = new Map();
  for (const edge of atlas.edges) {
    const dependency = owner.get(edge.target);
    const consumer = owner.get(edge.source);
    if (!dependency || !consumer || dependency === consumer) continue;
    if (!callers.has(dependency)) callers.set(dependency, new Set());
    callers.get(dependency).add(consumer);
  }
  const reached = new Set(targets);
  for (const file of reached) for (const caller of callers.get(file) ?? []) reached.add(caller);
  for (const target of targets) reached.delete(target);
  return {
    scope: "observed-static-dependencies",
    dependents: [...reached].sort(),
    unindexedTargets: targets.filter((file) => !Object.hasOwn(atlas.fileHashes, file)),
    omittedFiles: atlas.skippedFiles,
    backends: atlas.coverage.backends,
  };
}

async function impactPlan(root, files, checkout, inspectGraph = false) {
  const { selectTests } = await import("./test_select.js");
  const plan = checkout.bound
    ? await selectTests({ root, files })
    : {
        fullSuite: true,
        tests: [],
        typecheck: true,
        reason:
          "The complete Git checkout could not be fingerprinted. The whole workspace needs verification.",
      };
  /** @type {{ scope:string, dependents:string[], reason?:string, unindexedTargets?:string[], omittedFiles?:number, backends?:object }} */
  let impact = {
    scope: "whole-workspace",
    dependents: [],
    reason: "A bound static graph is unavailable for this callback.",
  };
  if (inspectGraph && checkout.bound) {
    try {
      const { build } = await import("./atlas.js");
      impact = observedDependents(build({ root, parser: "ast", persist: false }), files);
    } catch {
      // Even a graph that cannot be built still has a conservative upper bound.
    }
  }
  return { ...plan, impact };
}

/**
 * @param {{cwd:string, session?:string, paths:string[], intent:string}} event
 */
export async function checkPreEdit({ cwd, session, paths, intent }) {
  const base = realpathSync.native(cwd);
  const root = sourceWorkspaceRoot(base);
  if (
    !validId(intent) ||
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((p) => typeof p !== "string" || !p.trim())
  )
    throw new Error("The edit hook requires its complete operation and target paths.");
  const files = [
    ...new Set(
      paths.map((path) => {
        const target = resolve(base, path);
        if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error(
            "A symbolic-link edit has an ambiguous target. Use the resolved file path.",
          );
        const physical = physicalPath(target);
        if (!containsPath(root, physical))
          throw new Error("Impact review requires a target inside the workspace.");
        return relative(root, physical).split(sep).join("/");
      }),
    ),
  ].sort();
  const state = fingerprint(root, files);
  // Some clients omit session identity. Compute impact on each delivery without sharing an approval.
  if (typeof session !== "string" || !session.trim()) {
    const plan = await impactPlan(root, files, state.checkout);
    if (digest(state) !== digest(fingerprint(root, files))) throw changed();
    return { allow: true, files, plan };
  }
  const request = {
    version: 1,
    workspace: digest(root),
    session: digest(session),
    intent,
    files,
    state,
  };
  const id = digest(request);
  const approved = readRecord(root, id, "reviewed");
  if (
    approved?.request === id &&
    approved.plan &&
    typeof approved.signature === "string" &&
    approved.signature === evidenceMac(["pre-edit/v1", id, digest(approved.plan)])
  ) {
    if (approved.plan.fullSuite) return { allow: true, id, files, plan: approved.plan };
    // An independently enrolled observation can be replaced or revoked between callbacks.
    const current = await impactPlan(root, files, state.checkout);
    if (
      !current.fullSuite &&
      "checkout" in current &&
      digest(current.checkout) === digest(approved.plan.checkout) &&
      digest(current.tests) === digest(approved.plan.tests)
    )
      return { allow: true, id, files, plan: approved.plan };
  }
  saveRecord(root, id, "pending", request);
  return {
    allow: false,
    id,
    reason:
      "Review the affected test scope with forge impact --review " +
      id +
      " and retry the same edit.",
  };
}

export async function reviewPreEdit(cwd, id) {
  const root = sourceWorkspaceRoot(realpathSync.native(cwd));
  const request = readRecord(root, id, "pending");
  if (!request || request.workspace !== digest(root) || digest(request) !== id)
    throw new Error("No matching edit review is pending in this workspace.");
  const current = () => digest(fingerprint(root, request.files)) === digest(request.state);
  if (!current()) throw changed();
  const plan = await impactPlan(root, request.files, request.state.checkout, true);
  if (!current()) throw changed();
  const signature = evidenceMac(["pre-edit/v1", id, digest(plan)]);
  if (!signature)
    throw new Error("A private local signing key is required to record an edit review.");
  saveRecord(root, id, "reviewed", { request: id, plan, signature });
  return { id, files: request.files, plan };
}

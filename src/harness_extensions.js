// Harness extensions are data, never JavaScript imported from a checkout.
// A reviewed release contains a manifest and Markdown. Tools retrieve only
// that release's pinned references. Additional executables use the separate
// reviewed local MCP integration flow.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CRITICAL_HOOKS, HARNESS_HOOK_POINTS } from "./harness_hooks.js";
import { hasSecret } from "./secrets.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const LIMIT = 65536;
const ID = /^[a-z][a-z0-9-]{0,26}$/;
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/;
const REF = /^references\/[a-z0-9][a-z0-9._-]{0,90}\.md$/;
const digest = (s) => createHash("sha256").update(s).digest("hex");
const strings = (v, max = 64) =>
  Array.isArray(v) &&
  v.length <= 32 &&
  v.every((x) => typeof x === "string" && x.trim() && x.length <= max);
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function keys(obj, allowed) {
  check(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Object.keys(obj).every((k) => allowed.includes(k)),
    "Unexpected extension manifest fields",
  );
}
function safeDir(root, path) {
  const work = realpathSync.native(root),
    candidate = resolve(work, path);
  const rel = relative(work, candidate);
  check(
    rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "Extension must be a directory in the workspace",
  );
  let dir = work;
  for (const part of rel.split(sep)) {
    dir = join(dir, part);
    check(lstatSync(dir).isDirectory(), "Extension directory must not be a symlink");
  }
  return { dir, rel: rel.split(sep).join("/") };
}
function readFile(path, max = LIMIT) {
  const before = lstatSync(path);
  check(before.isFile() && before.size <= max, "Expected a bounded regular extension file");
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const after = fstatSync(fd);
    check(
      after.isFile() && after.size <= max && before.dev === after.dev && before.ino === after.ino,
      "Extension file changed during inspection",
    );
    const buffer = readFileSync(fd);
    check(buffer.length <= max && !buffer.includes(0), "Invalid extension file");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    closeSync(fd);
  }
}
function readPackage(root, path) {
  const { dir, rel } = safeDir(root, path);
  const files = new Map();
  const top = readdirSync(dir, { withFileTypes: true });
  check(top.length <= 4, "Unexpected extension files");
  for (const file of top) {
    if (file.isDirectory() && file.name === "references") {
      const refs = readdirSync(join(dir, file.name), { withFileTypes: true });
      check(refs.length <= 32, "Too many extension references");
      for (const ref of refs) {
        const key = `references/${ref.name}`;
        check(ref.isFile() && REF.test(key), "Invalid extension reference");
        files.set(key, readFile(join(dir, key), 16384));
      }
    } else {
      check(
        file.isFile() && ["plugin.json", "skill.json", "SKILL.md"].includes(file.name),
        "Only declarative manifests, SKILL.md and Markdown references are supported",
      );
      files.set(file.name, readFile(join(dir, file.name)));
    }
  }
  const kind = files.has("skill.json") ? "skill" : "plugin",
    manifest = `${kind}.json`;
  check(
    files.has(manifest) &&
      (kind === "skill"
        ? files.has("SKILL.md") && !files.has("plugin.json")
        : !files.has("SKILL.md")),
    "Expected one plugin.json or a skill.json with SKILL.md",
  );
  for (const value of files.values()) check(!hasSecret(value), "Possible credential in extension");
  const m = JSON.parse(files.get(manifest));
  keys(m, [
    "name",
    "version",
    "description",
    "source",
    "license",
    "triggers",
    "hosts",
    "tools",
    "hooks",
    "events",
  ]);
  check(
    typeof m.name === "string" &&
      ID.test(m.name) &&
      !(m.name in Object.prototype) &&
      !["core", "policy"].includes(m.name) &&
      typeof m.version === "string" &&
      m.version.length <= 48 &&
      VERSION.test(m.version),
    "Invalid extension name or version",
  );
  for (const field of ["description", "source", "license"])
    check(
      typeof m[field] === "string" &&
        m[field].trim() &&
        m[field].length <= 500 &&
        !/[\p{Cc}\p{Cf}]/u.test(m[field]),
      `Missing or invalid extension ${field}`,
    );
  check(
    strings(m.triggers ?? []) && strings(m.hosts ?? []) && (kind !== "skill" || m.triggers?.length),
    "Invalid extension triggers or hosts",
  );
  check(
    Array.isArray(m.tools ?? []) &&
      (m.tools ?? []).length <= 12 &&
      Array.isArray(m.hooks ?? []) &&
      (m.hooks ?? []).length <= 12 &&
      strings(m.events ?? []),
    "Invalid extension registrations",
  );
  for (const t of m.tools ?? []) {
    keys(t, ["name", "reference", "description"]);
    check(
      typeof t.name === "string" &&
        ID.test(t.name) &&
        typeof t.description === "string" &&
        t.description.trim() &&
        t.description.length <= 240 &&
        REF.test(t.reference) &&
        files.has(t.reference),
      "Invalid reference tool",
    );
  }
  check(
    new Set((m.tools ?? []).map((t) => t.name)).size === (m.tools ?? []).length,
    "Duplicate extension tool",
  );
  for (const h of m.hooks ?? []) {
    keys(h, ["point", "action", "value", "reason", "priority"]);
    check(
      HARNESS_HOOK_POINTS.includes(h.point) &&
        ["veto_contains", "require_field"].includes(h.action) &&
        typeof h.value === "string" &&
        h.value.trim() &&
        h.value.length <= 120 &&
        (h.action !== "require_field" || /^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(h.value)) &&
        (h.reason === undefined || (typeof h.reason === "string" && h.reason.length <= 200)) &&
        Number.isInteger(h.priority ?? 100) &&
        (h.priority ?? 100) >= 0 &&
        (h.priority ?? 100) < 500,
      "Invalid declarative hook",
    );
  }
  for (const e of m.events ?? [])
    check(/^(?:\*|[a-z][a-z0-9_]*\.(?:\*|[a-z][a-z0-9_]*))$/.test(e), "Invalid event subscription");
  const identity = digest(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : 1))));
  const report = {
    name: m.name,
    version: m.version,
    kind,
    directory: rel,
    source: m.source,
    license: m.license,
    description: m.description,
    digest: identity,
    files: [...files.keys()].sort(),
    triggers: m.triggers ?? [],
    hosts: m.hosts ?? [],
    tools: (m.tools ?? []).map((t) => t.name),
    hooks: (m.hooks ?? []).map((h) => h.point),
    events: m.events ?? [],
    screening: {
      format: "declarative",
      externalCode: false,
      network: false,
      credentialScan: "passed",
    },
  };
  return { manifest: m, files, report };
}
export function inspectHarnessExtension(root, directory) {
  return readPackage(root, directory).report;
}

function lockPath(root, create = false) {
  const work = realpathSync.native(root),
    dir = join(work, "harness");
  if (create) mkdirSync(dir, { recursive: true });
  if (existsSync(dir)) check(lstatSync(dir).isDirectory(), "Invalid harness directory");
  return join(dir, "lockfile.json");
}
function readLock(root) {
  let raw;
  try {
    raw = JSON.parse(readFile(lockPath(root), 128 * 1024));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  keys(raw, ["version", "extensions"]);
  check(
    (raw.version ?? 1) === 1 &&
      Array.isArray(raw.extensions ?? []) &&
      (raw.extensions ?? []).length <= 64,
    "Invalid harness lockfile",
  );
  const list = raw.extensions ?? [],
    names = new Set();
  for (const row of list) {
    keys(row, ["name", "version", "directory", "digest"]);
    check(
      typeof row.name === "string" &&
        ID.test(row.name) &&
        !names.has(row.name) &&
        typeof row.version === "string" &&
        VERSION.test(row.version) &&
        typeof row.directory === "string" &&
        SHA.test(row.digest),
      "Invalid locked extension",
    );
    names.add(row.name);
  }
  return list;
}
function saveAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
function updateLock(root, change) {
  const path = lockPath(root, true),
    mark = `${path}.updating`;
  try {
    mkdirSync(mark);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error("Extension lockfile busy; inspect its .updating directory before retrying");
    throw e;
  }
  try {
    const rows = change(readLock(root));
    saveAtomic(path, { version: 1, extensions: rows.sort((a, b) => a.name.localeCompare(b.name)) });
  } finally {
    rmdirSync(mark);
  }
}
function receiptPath(root, name, hash, type) {
  check(ID.test(name) && SHA.test(hash), "Invalid extension receipt");
  // The active approval is keyed by name so an older version cannot be
  // reactivated by rolling back the project lockfile.
  const location = type === "approved" ? "approval" : hash;
  return privateWorkspaceFile(root, `harness-extensions/${name}/${location}/${type}`);
}
function receipt(root, row, type) {
  try {
    return JSON.parse(readFile(receiptPath(root, row.name, row.digest, type), 2048));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function pinHarnessExtension(root, directory, reviewedDigest) {
  const report = inspectHarnessExtension(root, directory);
  check(
    report.digest === reviewedDigest,
    "Review the current digest with extensions inspect before pinning it",
  );
  const { name, version, digest: hash } = report,
    row = { name, version, directory: report.directory, digest: hash };
  updateLock(root, (rows) => {
    check(rows.some((r) => r.name === name) || rows.length < 64, "Too many pinned extensions");
    saveAtomic(receiptPath(root, name, hash, "approved"), {
      digest: hash,
      generation: randomUUID(),
      at: new Date().toISOString(),
    });
    // An explicit re-review of this exact release clears its quarantine.
    try {
      unlinkSync(receiptPath(root, name, hash, "quarantined"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return [...rows.filter((r) => r.name !== name), row];
  });
  return report;
}
export function removeHarnessExtension(root, name) {
  check(ID.test(name), "Invalid extension name");
  updateLock(root, (rows) => {
    const row = rows.find((r) => r.name === name);
    // Revoke the local approval even if the project lock was manually edited.
    try {
      unlinkSync(receiptPath(root, name, row?.digest ?? "0".repeat(64), "approved"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return rows.filter((r) => r.name !== name);
  });
  return { removed: name };
}
export function listHarnessExtensions(root) {
  return readLock(root).map((row) => {
    const approval = receipt(root, row, "approved"),
      approved = approval?.digest === row.digest;
    const lastUsedAt = receipt(root, row, "usage")?.at ?? null;
    const reviewAge = approved ? Date.now() - Date.parse(approval.at) : Infinity;
    const idleAge = Date.now() - Date.parse(lastUsedAt ?? approval?.at);
    return {
      ...row,
      approved,
      reviewedAt: approved ? approval.at : null,
      lastUsedAt,
      reviewDue: reviewAge >= 30 * 86400000,
      unused60Days: idleAge >= 60 * 86400000,
      quarantine: receipt(root, row, "quarantined"),
    };
  });
}

/** Load reviewed, matching releases into this run's isolated hook registry. */
export function loadHarnessExtensions({
  root,
  task = "",
  host = undefined,
  hooks,
  policy = /** @type {any} */ ({}),
}) {
  const active = new Map(),
    skipped = [];
  function unload(name) {
    if (!active.has(name)) return;
    hooks.removeSource(name);
    active.delete(name);
    hooks.emit("plugin.unloaded", { name });
  }
  for (const row of listHarnessExtensions(root)) {
    if (!row.approved || row.quarantine) {
      skipped.push({
        name: row.name,
        reason: row.quarantine ? "quarantined" : "local review required",
      });
      continue;
    }
    try {
      const { manifest: m, files, report } = readPackage(root, row.directory);
      check(
        report.digest === row.digest && m.name === row.name && m.version === row.version,
        "Pinned content changed",
      );
      if (
        (m.hosts?.length && !m.hosts.includes(host)) ||
        (m.triggers?.length &&
          !m.triggers.some((t) => String(task).toLowerCase().includes(t.toLowerCase())))
      )
        continue;
      const trust = policy.trustedHooks?.[row.name];
      for (const h of m.hooks ?? [])
        check(
          !CRITICAL_HOOKS.includes(h.point) || (Array.isArray(trust) && trust.includes(h.point)),
          `Policy does not trust ${row.name} for ${h.point}`,
        );
      const info = { name: m.name, version: m.version, source: m.source, digest: row.digest };
      const state = {
        info,
        tools: [],
        skill: report.kind === "skill" ? { ...info, instructions: files.get("SKILL.md") } : null,
        events: 0,
      };
      const approval = receipt(root, row, "approved");
      check(approval?.digest === row.digest, "Local approval changed before activation");
      const generation = approval.generation;
      check(
        typeof generation === "string" && /^[a-f0-9-]{36}$/.test(generation),
        "Re-review this extension to refresh its approval",
      );
      active.set(row.name, state);
      function onFailure(details) {
        // Exclusive marker creation counts strikes across parallel processes
        // and runs. A fresh review starts a fresh strike generation.
        for (let n = 1; n <= 3; n++) {
          const path = receiptPath(root, row.name, row.digest, `strike-${generation}-${n}`);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          try {
            writeFileSync(path, JSON.stringify({ point: details.point, reason: details.reason }), {
              flag: "wx",
              mode: 0o600,
            });
            if (n < 3) return;
            break;
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
          }
        }
        unload(row.name);
        const record = {
          at: new Date().toISOString(),
          point: details.point,
          reason: details.reason,
        };
        saveAtomic(receiptPath(root, row.name, row.digest, "quarantined"), record);
        hooks.emit("plugin.quarantined", { ...info, ...record });
      }
      for (const h of m.hooks ?? []) {
        hooks.on(
          h.point,
          (payload) => {
            if (h.action === "require_field" && (!payload || !Object.hasOwn(payload, h.value)))
              throw new Error("Unexpected hook payload");
            if (h.action === "veto_contains" && JSON.stringify(payload).includes(h.value))
              return { veto: h.reason || `Blocked by ${m.name}` };
            return payload;
          },
          {
            source: m.name,
            priority: h.priority ?? 100,
            trusted: Array.isArray(trust) && trust.includes(h.point),
            onFailure,
          },
        );
      }
      for (const pattern of m.events ?? [])
        hooks.subscribe(
          pattern,
          () => {
            state.events++;
          },
          { source: m.name },
        );
      for (const t of m.tools ?? [])
        state.tools.push({
          name: `ext_${m.name.replaceAll("-", "_")}__${t.name.replaceAll("-", "_")}`,
          description: t.description,
          risk: "read",
          timeoutMs: 1000,
          outputCap: 16384,
          idempotency: "safe",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: (args) => {
            check(active.get(m.name) === state, "Extension registration was unloaded");
            check(
              args && typeof args === "object" && !Array.isArray(args) && !Object.keys(args).length,
              "Reference tool accepts no arguments",
            );
            return files.get(t.reference);
          },
        });
      saveAtomic(receiptPath(root, row.name, row.digest, "usage"), {
        at: new Date().toISOString(),
      });
      hooks.emit("plugin.loaded", info);
    } catch (e) {
      unload(row.name);
      skipped.push({ name: row.name, reason: e.message });
      hooks.emit("plugin.rejected", { name: row.name, reason: e.message });
    }
  }
  return {
    unload,
    skipped,
    get active() {
      return [...active.values()].map((x) => ({ ...x.info, events: x.events }));
    },
    get tools() {
      return [...active.values()].flatMap((x) => x.tools);
    },
    get skills() {
      return [...active.values()].flatMap((x) => (x.skill ? [{ ...x.skill }] : []));
    },
  };
}

// Review the installed npm dependency graph. Only exact releases sourced from the public
// registry are eligible. A missing source or partial lookup is recorded in the result.
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DEFAULT_TIMEOUT_MS, EXISTS_URLS, osvRecords } from "./depgate.js";
import { customRegistries, exact, SPEC_PARSERS } from "./depgate_sources.js";

const source = "https://api.osv.dev/v1/query";
const npmRegistry = "https://registry.npmjs.org";

function inventory(doc) {
  const packages = [];
  if (
    doc.lockfileVersion === 1 &&
    doc.dependencies &&
    typeof doc.dependencies === "object" &&
    !Array.isArray(doc.dependencies)
  ) {
    const pending = Object.entries(doc.dependencies);
    while (pending.length) {
      const [name, item] = pending.pop();
      packages.push({ name, item });
      if (item?.dependencies && typeof item.dependencies === "object")
        for (const entry of Object.entries(item.dependencies)) pending.push(entry);
    }
  } else if (
    [2, 3].includes(doc.lockfileVersion) &&
    doc.packages &&
    typeof doc.packages === "object" &&
    !Array.isArray(doc.packages)
  ) {
    for (const [location, item] of Object.entries(doc.packages)) {
      if (!location) continue;
      const name = item?.name || location.split("node_modules/").pop();
      packages.push({ name, item });
    }
  } else throw new Error("Unsupported npm lockfile format");
  return packages;
}

function registryName(row) {
  try {
    const url = new URL(row.item.resolved);
    if (url.origin !== npmRegistry || url.username || url.password) return null;
    const tarballPath = decodeURIComponent(url.pathname).slice(1);
    const cut = tarballPath.indexOf("/-/");
    const name = cut > 0 ? tarballPath.slice(0, cut) : "";
    if (SPEC_PARSERS.npm(name)?.name === name) return name;
  } catch {}
  return null;
}

// SemVer precedence, including numeric prerelease identifiers and ignored build metadata.
function compare(a, b) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(v);
  const x = parse(a),
    y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const n = BigInt(x[i]),
      m = BigInt(y[i]);
    if (n !== m) return n < m ? -1 : 1;
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const left = x[4].split("."),
    right = y[4].split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const n = left[i],
      m = right[i];
    if (n === m) continue;
    if (n === undefined || m === undefined) return n === undefined ? -1 : 1;
    const num = /^\d+$/.test(n),
      other = /^\d+$/.test(m);
    if (num !== other) return num ? -1 : 1;
    return num ? (BigInt(n) < BigInt(m) ? -1 : 1) : n < m ? -1 : 1;
  }
  return 0;
}

function advisory(record, name, version) {
  const repairs = new Set();
  for (const affected of record.affected || []) {
    if (affected.package?.name !== name || affected.package?.ecosystem !== "npm") continue;
    for (const range of affected.ranges || []) {
      if (range.type !== "SEMVER") continue;
      let started = false;
      for (const event of range.events || []) {
        if (event.introduced) {
          const cmp = compare(version, event.introduced);
          started = event.introduced === "0" || (cmp !== null && cmp >= 0);
        }
        if (event.fixed && started && compare(version, event.fixed) === -1)
          repairs.add(event.fixed);
        if (event.fixed || event.last_affected || event.limit) started = false;
      }
    }
  }
  return {
    id: record.id,
    aliases: (record.aliases || []).filter((a) => typeof a === "string"),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(record.id)}`,
    fixedVersions: [...repairs].sort((a, b) => compare(a, b) || 0),
  };
}

/** @param {string} path @param {{fetchImpl?:typeof fetch, env?:NodeJS.ProcessEnv, home?:string, now?:Date}} options */
export async function vetLockfile(
  path,
  { fetchImpl = fetch, env = process.env, home, now = new Date() } = {},
) {
  const root = dirname(resolve(path));
  const report = {
    schema: 1,
    lockfile: basename(path),
    ecosystem: "npm",
    asOf: now.toISOString(),
    source,
    registry: npmRegistry,
    coverage: { assessed: 0, affected: 0, unknown: 0 },
    status: "unknown",
    packages: [],
    reason: null,
  };
  let rows;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error("Expected a regular npm lockfile under 32 MiB");
    rows = inventory(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    report.reason =
      "Missing, unreadable or unsupported npm lockfile. Supply package-lock.json or npm-shrinkwrap.json.";
    return report;
  }
  const custom = customRegistries({ cwd: root, env, home });
  const entries = new Map();
  for (const row of rows) {
    const item = row.item || {};
    const actual = registryName(row);
    const name = actual || String(row.name);
    const version = typeof item.version === "string" ? item.version : null;
    const reason =
      custom.npm || custom.npmScopes.includes(name.split("/")[0])
        ? "custom registry"
        : item.link || !actual
          ? "local, workspace or unconfirmed registry source"
          : !exact(version)
            ? "exact installed version unavailable"
            : null;
    const license = typeof item.license === "string" ? item.license : null;
    const key = JSON.stringify([name, version, license, reason]);
    if (!entries.has(key))
      entries.set(key, {
        name,
        version,
        license,
        occurrences: 0,
        status: "unknown",
        reason,
        advisories: [],
      });
    entries.get(key).occurrences++;
  }
  report.packages = [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)),
  );
  const queue = report.packages.filter((row) => !row.reason);
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const row = queue[next++];
      try {
        const registry = await fetchImpl(EXISTS_URLS.npm(row.name)[0].url, {
          method: "HEAD",
          redirect: "error",
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (registry.status !== 200) {
          row.reason = "Public registry did not confirm this package";
          continue;
        }
        const records = await osvRecords(
          { ecosystem: "npm", name: row.name, version: row.version.replace(/^v/, "") },
          (url, init) =>
            fetchImpl(url, { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }),
        );
        row.advisories = records.map((v) => advisory(v, row.name, row.version.replace(/^v/, "")));
        row.status = records.length ? "affected" : "clear";
      } catch {
        row.reason = "OSV advisory evidence unavailable or incomplete";
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  for (const row of report.packages) {
    if (row.status === "unknown") report.coverage.unknown++;
    else report.coverage.assessed++;
    if (row.status === "affected") report.coverage.affected++;
  }
  report.status = report.packages.some((p) => p.status === "affected")
    ? "affected"
    : report.packages.length && report.packages.every((p) => p.status === "clear")
      ? "clear"
      : "unknown";
  if (!report.packages.length) report.reason = "No locked packages to assess";
  return report;
}

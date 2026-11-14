// Local task matching sends only pinned catalog package names to public services.
// Resolution checks the publisher's canonical repo before a private, script-free npm install.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { vetPackages } from "./depgate.js";
import { addIntegration, stableVersion } from "./integrations.js";
import { researchPointers } from "./public_research.js";
import { heuristicScan } from "./skillgate.js";
import { userStateDir } from "./util.js";

const CATALOG = [
  {
    id: "context7",
    npm: "@upstash/context7-mcp",
    upstream: "https://github.com/upstash/context7",
    bin: "context7-mcp",
    terms: [
      "context7",
      "sdk documentation",
      "library docs",
      "framework documentation",
      "api docs",
      "latest documentation",
      "library documentation",
      "framework docs",
      "versioned documentation",
    ],
    cost: "Local Node process; upstream API quotas and plan may apply.",
    permissions: "Sends library searches and document queries to Context7.",
  },
  {
    id: "playwright",
    npm: "@playwright/mcp",
    upstream: "https://github.com/microsoft/playwright-mcp",
    bin: "playwright-mcp",
    terms: [
      "playwright",
      "browser automation",
      "browser testing",
      "e2e",
      "end to end tests",
      "accessibility snapshot",
      "browser test",
      "screenshot",
      "UI tests",
    ],
    cost: "Local browser CPU, memory and storage; browser binaries may require a separate install.",
    permissions: "Controls an isolated browser; can navigate sites and interact with page content.",
  },
];
const inside = (dir, path) => {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
};
const stateDir = () => resolve(userStateDir());
const privateCatalog = () => join(stateDir(), "tool-catalog.json");
const norm = (s) =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const text = (s, max) =>
  typeof s === "string" && s.trim() && s.length <= max && !/[\p{Cc}\p{Cf}]/u.test(s);
function canonical(path) {
  let parent = path;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return join(realpathSync(parent), relative(parent, path));
}
function checkPersonalTools(additions) {
  if (!Array.isArray(additions) || additions.length > 64)
    throw new Error("Expected up to 64 personal catalog tools");
  const ids = new Set(CATALOG.map((c) => c.id));
  for (const c of additions) {
    if (
      !c ||
      !text(c.id, 64) ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(c.id) ||
      c.id in Object.prototype ||
      c.id === "forge-cortex" ||
      ids.has(c.id) ||
      !text(c.npm, 160) ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(c.npm) ||
      !text(c.bin, 100) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(c.bin) ||
      !text(c.upstream, 220) ||
      !/^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9.-]*\/[a-zA-Z0-9_][a-zA-Z0-9._-]*$/.test(
        c.upstream,
      ) ||
      !Array.isArray(c.terms) ||
      !c.terms.length ||
      c.terms.length > 32 ||
      !c.terms.every((t) => text(t, 80) && norm(t)) ||
      !text(c.cost, 400) ||
      !text(c.permissions, 400) ||
      Object.keys(c).some(
        (k) => !["id", "npm", "upstream", "terms", "bin", "cost", "permissions"].includes(k),
      )
    ) {
      throw new Error("Invalid personal tool catalog entry");
    }
    ids.add(c.id);
  }
}

const MAX_CATALOG_BYTES = 64 * 1024;
function readPersonalCatalog(root, path) {
  if (!existsSync(path)) return { tools: [] };
  if (inside(realpathSync(root), realpathSync(path)))
    throw new Error("Keep tool-catalog.json outside the repository");
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Expected a regular personal catalog file");
  if (stat.size > MAX_CATALOG_BYTES) throw new Error("Tool catalog exceeds 64 KiB");
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  checkPersonalTools(catalog?.tools);
  return catalog;
}

export function adoptionCatalog(root = process.cwd()) {
  return [...CATALOG, ...readPersonalCatalog(root, privateCatalog()).tools];
}

// Serialize read/modify/write between CLI processes. Readers see the old or new
// complete snapshot. An interrupted writer can leave a lock but cannot corrupt the
// catalog or let a later process silently discard another developer's entry.
function editPersonalCatalog(root, id, edit) {
  if (CATALOG.some((tool) => tool.id === id))
    throw new Error(`Built-in integration '${id}' cannot be replaced or unregistered`);
  if (
    typeof id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) ||
    id in Object.prototype ||
    id === "forge-cortex"
  )
    throw new Error("Invalid personal integration ID");
  const path = privateCatalog();
  if (inside(realpathSync(root), canonical(dirname(path))))
    throw new Error("Keep tool-catalog.json outside the repository");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 2000;
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() >= deadline)
        throw new Error(
          `Catalog is locked. Retry, or remove the stale lock at ${lock} after checking for an active writer.`,
        );
      Atomics.wait(delay, 0, 0, 10);
    }
  }
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Refusing to replace a symlinked personal catalog");
    const catalog = readPersonalCatalog(root, path);
    const changed = edit(catalog.tools);
    if (changed) {
      checkPersonalTools(catalog.tools);
      const data = `${JSON.stringify(catalog, null, 2)}\n`;
      if (Buffer.byteLength(data) > MAX_CATALOG_BYTES)
        throw new Error("Tool catalog exceeds 64 KiB");
      writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    }
    return { ok: true, id, changed, catalogPath: path };
  } finally {
    try {
      rmSync(tmp, { force: true });
    } finally {
      rmdirSync(lock);
    }
  }
}

export function registerCatalogTool(root, descriptor) {
  return editPersonalCatalog(root, descriptor?.id, (tools) => {
    const existing = tools.find((tool) => tool.id === descriptor.id);
    if (existing) {
      if (isDeepStrictEqual(existing, descriptor)) return false;
      throw new Error(
        `A different personal integration is already registered as '${descriptor.id}'`,
      );
    }
    tools.push(descriptor);
    return true;
  });
}

export function unregisterCatalogTool(root, id) {
  return editPersonalCatalog(root, id, (tools) => {
    const index = tools.findIndex((tool) => tool.id === id);
    if (index < 0) return false;
    tools.splice(index, 1);
    return true;
  });
}

// npm already ships node-semver. Resolve from the npm installation paired with the
// current Node executable, never from project-controlled node_modules or PATH.
function npmCliPath() {
  const dir = dirname(process.execPath);
  const paths = [
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(dir, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ];
  const path = paths.find((p) => existsSync(p));
  if (!path) throw new Error("Install npm alongside the Node executable");
  return realpathSync(path);
}
function nodeFits(range, runtime) {
  if (!range || range === "*") return true;
  const npmRequire = createRequire(npmCliPath());
  return npmRequire("semver").satisfies(runtime, range);
}

function repoURL(raw) {
  return String(raw?.url ?? raw ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

// Node 20's fetch does not honor standard corporate proxy variables. curl is optional,
// called without a shell, and sees only fixed public registry / advisory URLs and names.
/** @type {typeof fetch} */
const registryFetch = async (input, init = {}) => {
  const curl =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe")
      : "/usr/bin/curl";
  if ((!process.env.HTTPS_PROXY && !process.env.https_proxy) || !existsSync(curl))
    return fetch(input, init);
  const url = String(input);
  const method = init.method ?? "GET";
  const args = [
    "-q",
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--proto",
    "=https",
    "--write-out",
    "\n%{http_code}",
  ];
  if (method === "HEAD") args.push("--head");
  if (method === "POST")
    args.push(
      "--request",
      "POST",
      "--header",
      "Content-Type: application/json",
      "--data-raw",
      String(init.body),
    );
  args.push("--", url);
  return new Promise((accept, reject) => {
    execFile(
      curl,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal: init.signal },
      (err, out) => {
        if (err?.code === "ENOENT") {
          fetch(input, init).then(accept, reject);
          return;
        }
        if (err) {
          reject(new Error("Public registry or advisory request failed"));
          return;
        }
        const cut = out.lastIndexOf("\n");
        accept(
          new Response(method === "HEAD" ? null : out.slice(0, cut), {
            status: Number(out.slice(cut + 1)),
          }),
        );
      },
    );
  });
};
async function resolveCandidate(tool, opts) {
  const pkg = encodeURIComponent(tool.npm);
  const registry = `https://registry.npmjs.org/${pkg}/${opts.version ?? "latest"}`;
  if (opts.version !== undefined && !stableVersion(opts.version))
    throw new Error("Specify an exact stable version");
  if (opts.offline ?? (process.env.FORGE_NO_CATALOG_FETCH === "1" && !opts.fetchImpl))
    throw new Error("Registry lookup is offline");
  const res = await (opts.fetchImpl ?? registryFetch)(registry, {
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(15000, opts.timeoutMs ?? 15000))),
  });
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Registry metadata exceeds 1 MiB");
    chunks.push(chunk);
  }
  const m = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    m.name !== tool.npm ||
    !stableVersion(m.version) ||
    (opts.version && opts.version !== m.version) ||
    repoURL(m.repository) !== tool.upstream.toLowerCase()
  )
    throw new Error(
      "Registry name, stable version or upstream repository did not match the catalog",
    );
  if (m.deprecated) throw new Error("Upstream marks this release deprecated");
  if (!nodeFits(m.engines?.node, opts.nodeVersion ?? process.versions.node))
    throw Object.assign(
      new Error(
        `${tool.npm}@${m.version} requires Node ${m.engines.node}; use a compatible Node or an exact --version`,
      ),
      { version: m.version, engine: m.engines.node },
    );
  if (
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(m.dist?.integrity ?? "") ||
    new URL(m.dist.tarball).origin !== "https://registry.npmjs.org"
  )
    throw new Error("Expected an npm-hosted tarball with SHA-512 integrity");
  const bin =
    typeof m.bin === "string" && tool.bin === tool.npm.split("/").at(-1)
      ? m.bin
      : m.bin?.[tool.bin];
  if (
    typeof bin !== "string" ||
    !/^(?:\.\/)?[a-zA-Z0-9@_][a-zA-Z0-9@_./-]*$/.test(bin) ||
    bin.split("/").includes("..")
  )
    throw new Error("Expected MCP executable missing from release");
  if (!text(m.license, 120) || ["UNLICENSED", "SEE LICENSE"].some((x) => m.license.startsWith(x)))
    throw new Error("Review package license before installation");
  return {
    version: m.version,
    license: m.license,
    engine: m.engines?.node ?? null,
    integrity: m.dist.integrity,
    binPath: bin,
    tarball: m.dist.tarball,
    registry,
  };
}

function matchesFor(task, options) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Supply a developer task");
  const query = ` ${norm(task.slice(0, 10000))} `;
  return adoptionCatalog(options.root ?? process.cwd())
    .map((tool) => {
      const terms = [...new Set([tool.id, ...tool.terms].map(norm))].filter((t) =>
        query.includes(` ${t} `),
      );
      return { tool, terms, score: terms.reduce((n, t) => n + t.split(" ").length, 0) };
    })
    .filter((m) => m.score)
    .sort((a, b) => b.score - a.score || a.tool.id.localeCompare(b.tool.id))
    .slice(0, 3);
}
/** Local task selection for a hook. Nothing leaves the process. */
export function matchAdoption(task, options = {}) {
  return matchesFor(task, options).map(({ tool, score }) => ({ id: tool.id, score }));
}
/** Local scored candidates with the matched catalog terms. */
export function matchAdoptions(task, root = process.cwd()) {
  return matchesFor(task, { root }).map(({ tool, terms, score }) => ({
    id: tool.id,
    score,
    reason: terms.join(", "),
  }));
}
export async function findAdoption(task, options = {}) {
  const candidates = await Promise.all(
    matchesFor(task, options).map(async ({ tool, terms, score }) => {
      const base = {
        id: tool.id,
        name: tool.id,
        package: tool.npm,
        upstream: tool.upstream,
        cost: tool.cost,
        permissions: tool.permissions,
        score,
        reason: terms.join(", "),
      };
      try {
        return { ...base, ...(await resolveCandidate(tool, options)), status: "candidate" };
      } catch (e) {
        return {
          ...base,
          version: e.version ?? null,
          engine: e.engine ?? null,
          status: "review",
          warning: e.message,
        };
      }
    }),
  );
  return {
    checkedAt: new Date().toISOString(),
    candidates,
    furtherResearch: researchPointers(task),
    catalogPath: privateCatalog(),
  };
}

function location(root, id, version) {
  const state = canonical(stateDir());
  const dir = canonical(join(stateDir(), "tool-packages", id, version));
  if (!inside(state, dir) || inside(realpathSync(root), state) || inside(realpathSync(root), dir))
    throw new Error("Keep private tool installations outside the repository");
  return dir;
}
function readReceipt(dir, tool, version, integrity = undefined) {
  const r = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  if (
    r.id !== tool.id ||
    r.package !== tool.npm ||
    r.version !== version ||
    r.upstream !== tool.upstream ||
    r.bin !== tool.bin ||
    (integrity && integrity !== r.integrity)
  )
    throw new Error("Private installation receipt does not match");
  const pkgDir = realpathSync(join(dir, "node_modules", ...tool.npm.split("/")));
  if (!inside(realpathSync(dir), pkgDir))
    throw new Error("Installed package resolves outside tool directory");
  const p = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const bin = typeof p.bin === "string" ? p.bin : p.bin?.[tool.bin];
  const entry = realpathSync(resolve(pkgDir, bin));
  if (
    p.name !== tool.npm ||
    p.version !== version ||
    repoURL(p.repository) !== tool.upstream.toLowerCase() ||
    !inside(pkgDir, entry)
  )
    throw new Error("Installed executable does not match receipt");
  return entry;
}

function npmInstall(stage, spec) {
  // An isolated cwd ignores the project's .npmrc, manifest, workspaces, and scripts.
  // Resolve npm-cli from this Node distribution on Windows, where npm.cmd needs a shell.
  const npm = process.execPath;
  const args = [npmCliPath()];
  args.push(
    "install",
    "--ignore-scripts",
    "--engine-strict",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "--package-lock=true",
    "--workspaces=false",
    "--registry=https://registry.npmjs.org/",
    spec,
  );
  // A user's private scope mapping must not replace the public package we verified.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)),
  );
  const npmrc = join(stage, "registry.npmrc");
  writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n", { mode: 0o600 });
  args.push(`--userconfig=${npmrc}`, `--globalconfig=${join(stage, "global.npmrc")}`);
  return new Promise((accept, reject) => {
    const child = spawn(npm, args, {
      cwd: stage,
      env,
      stdio: "ignore",
      timeout: 120000,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept(undefined)
        : reject(
            new Error(
              `npm install failed (exit ${code ?? "signal"}). Check Node engine, registry access and npm availability.`,
            ),
          ),
    );
  });
}

/** Materialize an exact release, then register the existing per-target managed config. */
export async function installAdoption(root, id, options = {}) {
  try {
    const tool = adoptionCatalog(root).find((t) => t.id === id);
    if (!tool) throw new Error("Unknown tool; add a reviewed entry to the private catalog");
    const m = await resolveCandidate(tool, options);
    const spec = {
      eco: /** @type {const} */ ("npm"),
      name: tool.npm,
      version: m.version,
      via: "adoption",
    };
    const [v] = await vetPackages([spec], {
      fetchImpl: options.fetchImpl ?? registryFetch,
      timeoutMs: 15000,
    });
    if (
      v.judgment.level !== "ok" ||
      !Array.isArray(v.evidence.advisories) ||
      v.evidence.advisories.length ||
      !Array.isArray(v.evidence.malicious)
    )
      throw new Error(
        `Package check requires review: ${v.judgment.reasons.join(", ") || "missing registry or OSV advisory evidence"}`,
      );
    if (
      heuristicScan(
        JSON.stringify({ command: "forge", args: ["integrations", "run", id, m.version] }),
      ).length
    )
      throw new Error("Integration command requires review");
    const dir = location(root, id, m.version);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    if (!existsSync(dir)) {
      const stage = mkdtempSync(join(dirname(dir), ".stage-"));
      try {
        writeFileSync(
          join(stage, "package.json"),
          '{"name":"forge-private-tool","version":"0.0.0","private":true}\n',
          { mode: 0o600 },
        );
        await (options.installPackage ?? npmInstall)(stage, `${tool.npm}@${m.version}`);
        const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
        const artifact = lock.packages?.[`node_modules/${tool.npm}`];
        if (
          !artifact ||
          artifact.integrity !== m.integrity ||
          artifact.version !== m.version ||
          artifact.resolved !== m.tarball
        )
          throw new Error("Installed tarball differs from verified release");
        for (const [path, p] of Object.entries(lock.packages)) {
          if (!path) continue;
          if (
            typeof p.resolved !== "string" ||
            !p.resolved.startsWith("https://registry.npmjs.org/") ||
            !/^sha(512|1)-/.test(p.integrity ?? "")
          )
            throw new Error("Dependency resolution outside the npm registry requires review");
        }
        writeFileSync(
          join(stage, "receipt.json"),
          JSON.stringify({
            id,
            package: tool.npm,
            upstream: tool.upstream,
            version: m.version,
            bin: tool.bin,
            integrity: m.integrity,
          }),
          { mode: 0o600 },
        );
        readReceipt(stage, tool, m.version, m.integrity);
        try {
          renameSync(stage, dir);
        } catch (e) {
          if (!existsSync(dir)) throw e;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    readReceipt(dir, tool, m.version, m.integrity);
    if (options.canRegister && !options.canRegister())
      throw new Error("Installation policy changed; integration was not registered");
    const result = addIntegration(id, { targetRoot: root, version: m.version });
    return { ...result, id, version: m.version, packagePath: dir };
  } catch (e) {
    return { ok: false, id, reason: e.message };
  }
}

/** Resolve only known IDs with an exact version and a private install receipt. Own stdio belongs to MCP. */
export async function runAdoption(id, version) {
  if (!stableVersion(version)) throw new Error("Expected exact stable version");
  const tool = adoptionCatalog().find((t) => t.id === id);
  if (!tool) throw new Error("Unknown private tool");
  const dir = location(process.cwd(), id, version);
  if (!existsSync(join(dir, "receipt.json")))
    throw new Error(
      `Materialize this pinned release with forge integrations install ${id} --version ${version}`,
    );
  const entry = readReceipt(dir, tool, version);
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [entry, ...(id === "playwright" ? ["--isolated"] : [])], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? accept(undefined) : reject(new Error(`MCP exited: ${code ?? signal}`)),
    );
  });
}

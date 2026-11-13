// forge dep-gate, part 1 — WHICH packages is this action about to fetch? Pure text in, package
// specs out; no network, no judgment (that is src/depgate.js). Everything here is DATA so that
// widening coverage is adding a row, never another branch:
//
//   SPEC_PARSERS  one word → the registry package it names        (per ecosystem)
//   FLAGS         which flags eat a value / leave the registry / pin a version (per ecosystem)
//   COMMANDS      the install grammar of every package manager     (tool, subcommand path, mode)
//   MANIFESTS     dependency files and how to list what they declare
//   *_REGISTRY_CONFIG  config files and env vars that point an ecosystem at another registry
//
// Three ways a dependency arrives are covered: an install command that NAMES it
// (`npm install x`, `go get …`, `composer require …`), an edit that ADDS it to a manifest
// (`package.json`, `pyproject.toml`, `pom.xml` …), and an install that reads a manifest
// (`npm install` with no names, `pip install -r file`). Conservative by design: a word the
// shell must compute, a path, a URL, a git source or an unknown subcommand yields nothing, so
// the gate only ever examines a name it read literally.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { shellSegments } from "../global/guards/protect-paths.mjs";

/** @typedef {"npm"|"pypi"|"cargo"|"go"|"maven"|"nuget"|"rubygems"|"packagist"|"pub"} Eco */
/** @typedef {{eco: Eco, name: string, version: string|null, via: string}} PkgSpec */
/** @typedef {{name: string, version: string|null}} Spec */
/** @typedef {(p: string) => string|null} ReadText */

/** @param {string} path @returns {string|null} */
export const readTextSafe = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

// ── One word → the package it names ────────────────────────────────────────────────────────

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
/** An exact version, or null — a range (`^1.2`, `>=2`) names no single release to look up.
 *  @param {string|undefined|null} v */
export const exact = (v) => (v && EXACT_VERSION.test(v) ? v : null);
const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
/** Not a registry name: a path, a URL, a git source, a tarball, a workspace/alias protocol. */
const NPM_NOT_REGISTRY =
  /^(?:\.|\/|~|file:|link:|workspace:|portal:|patch:|catalog:|git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:)|\.(?:tgz|tar\.gz|tar)$/i;
const SIMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One install-line word (or manifest entry) → the registry package it names, or null when it
 * names none or something we cannot verify. Per ecosystem, pure.
 * @type {Record<Eco, (raw: string) => Spec|null>}
 */
export const SPEC_PARSERS = {
  npm(raw) {
    let s = raw;
    // `alias@npm:real@1.2.3` installs `real`.
    const alias = s.indexOf("@npm:");
    if (alias > 0) s = s.slice(alias + 5);
    if (NPM_NOT_REGISTRY.test(s) || s.includes("://")) return null;
    const at = s.lastIndexOf("@");
    const name = at > 0 ? s.slice(0, at) : s;
    // `user/repo` is GitHub shorthand, not a registry name; the name grammar rejects it.
    if (!NPM_NAME.test(name)) return null;
    return { name, version: exact(at > 0 ? s.slice(at + 1) : "") };
  },
  pypi(raw) {
    const s = raw.split(";")[0].trim();
    if (/^(?:\.|\/|~)|:\/\/|^git\+|\.(?:whl|zip|tar\.gz|tar\.bz2)$/i.test(s) || /[\\/]/.test(s))
      return null;
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
    if (!m) return null;
    if (m[2].startsWith("@")) return null; // `name @ https://…` — a direct reference
    const pin = /^===?\s*([\w.!+-]+)$/.exec(m[2]);
    // PEP 503: names compare case-insensitively with runs of `-_.` folded to one `-`.
    const name = m[1].toLowerCase().replace(/[-_.]+/g, "-");
    return { name, version: pin && !pin[1].includes("*") ? pin[1] : null };
  },
  cargo(raw) {
    const at = raw.indexOf("@");
    const name = at > 0 ? raw.slice(0, at) : raw;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return null;
    return { name, version: exact(at > 0 ? raw.slice(at + 1) : "") };
  },
  go(raw) {
    const at = raw.indexOf("@");
    const path = (at > 0 ? raw.slice(0, at) : raw).replace(/\/\.\.\.$/, "");
    // A module path starts with a host (`github.com/…`, `golang.org/x/…`); `./cmd`, `all` and
    // `std` are local patterns.
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[A-Za-z0-9._~-]+)+$/.test(path)) return null;
    return { name: path, version: exact(at > 0 ? raw.slice(at + 1) : "") };
  },
  maven(raw) {
    const m = /^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^:@\s]+))?/.exec(raw);
    return m ? { name: `${m[1]}:${m[2]}`, version: exact(m[3]) } : null;
  },
  nuget(raw) {
    const [name, version] = raw.split("@");
    return SIMPLE_NAME.test(name) ? { name, version: exact(version) } : null;
  },
  rubygems(raw) {
    const [name, version] = raw.split(":");
    return SIMPLE_NAME.test(name) ? { name, version: exact(version) } : null;
  },
  packagist(raw) {
    // `vendor/package[:constraint]`; `php`, `ext-json` and a bare constraint word are not packages.
    const m = /^([a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:[_.-]?[a-z0-9]+)*)(?::(.+))?$/i.exec(raw);
    return m ? { name: m[1].toLowerCase(), version: exact(m[2]) } : null;
  },
  pub(raw) {
    const [name, version] = raw.replace(/^(?:dev|override):/, "").split(":");
    return /^[a-z_][a-z0-9_]*$/.test(name) ? { name, version: exact(version) } : null;
  },
};

// ── Flags, per ecosystem ───────────────────────────────────────────────────────────────────

/** @param {string} words */
const set = (words) => new Set(words.split(/\s+/).filter(Boolean));

/**
 * `value`: flags that consume the NEXT word, so a flag's value is never read as a package (an
 * unlisted `--flag` is boolean, `--flag=value` is self-contained). `custom`: flags that point
 * the install away from the public registry — nothing we can verify. `pkg`: flags whose value
 * IS a package (`npx -p pkg cmd`). `pin`: flags whose value is the version. `file`: flags
 * whose value is a manifest to read (`pip install -r requirements.txt`).
 * @type {Record<Eco, {value: Set<string>, custom: Set<string>, pkg: Set<string>, pin: Set<string>, file: Set<string>}>}
 */
export const FLAGS = {
  npm: {
    value: set(
      "--registry --prefix -C --dir --filter -F -w --workspace --tag --otp --cache --userconfig --globalconfig --loglevel --cwd --modules-folder --omit --include --install-strategy --before --script-shell --node-options -c --call --shell -p --package",
    ),
    custom: set("--registry"),
    pkg: set("-p --package"),
    pin: set(""),
    file: set(""),
  },
  pypi: {
    value: set(
      "-r --requirement -c --constraint -e --editable -i --index-url --extra-index-url -f --find-links -t --target --prefix --root --python -p --platform --python-version --implementation --abi --only-binary --no-binary --progress-bar --src --upgrade-strategy --cache-dir --trusted-host --proxy --cert --client-cert -C --config-settings --global-option --log --retries --timeout --exists-action --report --group -G --extra -E --optional --source --markers --branch --tag --rev --index --default-index --directory --project --config-file --suffix --pip-args --from --with --spec",
    ),
    custom: set("-i --index-url --extra-index-url -f --find-links --index --default-index"),
    pkg: set("--from --with --spec"),
    pin: set(""),
    file: set("-r --requirement"),
  },
  cargo: {
    value: set(
      "--features -F --git --branch --tag --rev --path --registry --index --rename --package -p --manifest-path --target --version --vers --root --profile --jobs -j --color --config -Z --target-dir --bin --example --lockfile-path",
    ),
    custom: set("--git --path --registry --index"),
    pkg: set(""),
    pin: set("--version --vers"),
    file: set(""),
  },
  go: {
    value: set(
      "-C -ldflags -gcflags -asmflags -tags -mod -modfile -o -p -buildmode -compiler -installsuffix -overlay -pkgdir -toolexec",
    ),
    custom: set(""),
    pkg: set(""),
    pin: set(""),
    file: set(""),
  },
  maven: { value: set(""), custom: set(""), pkg: set(""), pin: set(""), file: set("") },
  nuget: {
    value: set(
      "-v --version -s --source -f --framework --package-directory -n --interactive-timeout -Version -Source -OutputDirectory -o -ConfigFile --configfile -Framework",
    ),
    custom: set("-s --source -Source"),
    pkg: set(""),
    pin: set("-v --version -Version"),
    file: set(""),
  },
  rubygems: {
    value: set(
      "-v --version -i --install-dir -n --bindir --platform -P --trust-policy -g --file -s --source --group --require --git --github --path --branch --ref --glob -p --http-proxy",
    ),
    custom: set("-s --source --git --github --path"),
    pkg: set(""),
    pin: set("-v --version"),
    file: set(""),
  },
  packagist: {
    value: set("-d --working-dir --repository --repository-url"),
    custom: set("--repository --repository-url"),
    pkg: set(""),
    pin: set(""),
    file: set(""),
  },
  pub: {
    value: set("--sdk --git-url --git-ref --git-path --hosted-url --path -C --directory"),
    custom: set("--git-url --hosted-url --path --sdk"),
    pkg: set(""),
    pin: set(""),
    file: set(""),
  },
};

// ── The install grammar of every package manager ───────────────────────────────────────────

/**
 * `add` — every positional is a package. `run` — the FIRST positional is a package fetched and
 * executed (npx, uvx). `create` — the first positional names a `create-*` initializer.
 * `manifest` — no names: the install reads the project's manifest.
 * @typedef {"add"|"run"|"create"|"manifest"} Mode
 * @typedef {{tool: RegExp, path: string[][], mode: Mode, eco: Eco}} CommandRule
 */

/** `rule("yarn", "global add", "add", "npm")`: tool alternation, subcommand path, mode, eco.
 *  A path step is an alternation (`install|i`); `*?` is "at most one arbitrary word".
 *  @param {string} tools @param {string} path @param {Mode} mode @param {Eco} eco
 *  @returns {CommandRule} */
const rule = (tools, path, mode, eco) => ({
  tool: new RegExp(`^(?:${tools})$`),
  path: path
    .split(/\s+/)
    .filter(Boolean)
    .map((step) => step.split("|")),
  mode,
  eco,
});

/** First match wins, so a longer path sits above its prefix. @type {CommandRule[]} */
export const COMMANDS = [
  rule("npm", "install|i|add|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall", "add", "npm"),
  rule("npm", "ci|clean-install|install-clean|ic|install-ci-test|cit", "manifest", "npm"),
  rule("npm", "exec|x", "run", "npm"),
  rule("npm", "create|init|innit", "create", "npm"),
  rule("pnpm", "add|install|i", "add", "npm"),
  rule("pnpm", "dlx", "run", "npm"),
  rule("pnpm", "create", "create", "npm"),
  rule("yarn", "global add", "add", "npm"),
  rule("yarn", "add", "add", "npm"),
  rule("yarn", "install", "manifest", "npm"),
  rule("yarn", "dlx", "run", "npm"),
  rule("yarn", "create", "create", "npm"),
  rule("yarn", "", "manifest", "npm"),
  rule("bun", "add|a|install|i", "add", "npm"),
  rule("bun", "x", "run", "npm"),
  rule("bun", "create", "create", "npm"),
  rule("npx|bunx|pnpx", "", "run", "npm"),
  rule("pip(?:3(?:\\.\\d+)?)?", "install", "add", "pypi"),
  rule("uv", "pip install", "add", "pypi"),
  rule("uv", "tool install", "add", "pypi"),
  rule("uv", "tool run", "run", "pypi"),
  rule("uv", "add", "add", "pypi"),
  rule("uvx", "", "run", "pypi"),
  rule("poetry|pdm", "add", "add", "pypi"),
  rule("pipx", "install", "add", "pypi"),
  rule("pipx", "run", "run", "pypi"),
  rule("cargo", "add|install|binstall", "add", "cargo"),
  rule("go", "get|install", "add", "go"),
  rule("gem", "install|i", "add", "rubygems"),
  rule("bundle|bundler", "add", "add", "rubygems"),
  rule("composer(?:\\.phar)?", "global require|req|r", "add", "packagist"),
  rule("composer(?:\\.phar)?", "require|req|r", "add", "packagist"),
  rule("dotnet", "add *? package", "add", "nuget"),
  rule("nuget", "install", "add", "nuget"),
  rule("dart|flutter", "pub add", "add", "pub"),
];

/** `/usr/bin/NPM.cmd` → `npm`. @param {string} t */
const toolName = (t) =>
  (t.replaceAll("\\", "/").split("/").pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "");

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "time", "nohup", "nice"]);
/** A word the splitter could not resolve to literal text: a variable, a substitution, a glob. */
const UNRESOLVED = /[$`*?]/;

/**
 * Match one simple command against the grammar.
 * @param {string} tool @param {string[]} args
 * @returns {{rule: CommandRule, rest: string[], words: string[]}|null}
 */
function matchCommand(tool, args) {
  for (const r of COMMANDS) {
    if (!r.tool.test(tool)) continue;
    const { value } = FLAGS[r.eco];
    let i = 0;
    let ok = true;
    /** The subcommand words as typed — the label a verdict carries. @type {string[]} */
    const words = [];
    for (let step = 0; step < r.path.length && ok; step++) {
      // Flags (and a listed flag's value) may sit between subcommand words.
      while (i < args.length && args[i].startsWith("-")) {
        if (!args[i].includes("=") && value.has(args[i])) i++;
        i++;
      }
      const word = args[i];
      if (r.path[step][0] === "*?") {
        // At most one arbitrary word (`dotnet add [project] package`): skip it only when it
        // is not already the next step.
        if (word !== undefined && !r.path[step + 1]?.includes(word)) i++;
        continue;
      }
      if (word === undefined || !r.path[step].includes(word)) ok = false;
      else {
        words.push(word);
        i++;
      }
    }
    if (!ok) continue;
    const rest = args.slice(i);
    // A bare-tool manifest rule (`yarn` alone) must not swallow `yarn build`.
    if (r.mode === "manifest" && !r.path.length && rest.some((w) => !w.startsWith("-"))) continue;
    return { rule: r, rest, words };
  }
  return null;
}

/** `vite` → `create-vite`; `@scope` → `@scope/create`; `@scope/app@1` → `@scope/create-app@1`.
 *  @param {string} raw */
function initializerSpec(raw) {
  const at = raw.lastIndexOf("@");
  const [name, tag] = at > 0 ? [raw.slice(0, at), raw.slice(at)] : [raw, ""];
  if (!name.startsWith("@")) return `create-${name}${tag}`;
  const slash = name.indexOf("/");
  return slash < 0
    ? `${name}/create${tag}`
    : `${name.slice(0, slash)}/create-${name.slice(slash + 1)}${tag}`;
}

/** Walk from `dir` to the filesystem root. @param {string} dir @returns {string[]} */
function ancestors(dir) {
  const out = [];
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * Every registry package a Bash command line would fetch.
 * @param {string} command
 * @param {{cwd?: string, exists?: (p: string) => boolean, readText?: ReadText}} [opts]
 * @returns {{packages: PkgSpec[], custom: Eco[]}} `custom` lists ecosystems the line pointed
 *   at a non-default registry by FLAG (their packages are left out of `packages`).
 */
export function parseInstalls(
  command,
  { cwd = process.cwd(), exists = existsSync, readText = readTextSafe } = {},
) {
  /** @type {Map<string, PkgSpec>} */
  const found = new Map();
  /** @type {Set<Eco>} */
  const custom = new Set();
  /** @param {Eco} eco @param {Spec|null} spec @param {string} via */
  const add = (eco, spec, via) => {
    if (spec && !found.has(`${eco}:${spec.name}`))
      found.set(`${eco}:${spec.name}`, { eco, name: spec.name, version: spec.version, via });
  };
  /** @type {ReturnType<typeof shellSegments>} */
  let segments;
  try {
    segments = shellSegments(String(command ?? ""));
  } catch {
    return { packages: [], custom: [] };
  }
  for (const seg of segments) {
    const words = seg.words.map((w) => w.text);
    // Leading `VAR=x`, `sudo`, `env -i` … are not the command.
    let start = 0;
    while (
      start < words.length &&
      (ASSIGNMENT.test(words[start]) ||
        WRAPPERS.has(toolName(words[start])) ||
        (start > 0 && WRAPPERS.has(toolName(words[start - 1])) && words[start].startsWith("-")))
    )
      start++;
    if (start >= words.length) continue;
    let tool = toolName(words[start]);
    let args = words.slice(start + 1);
    // `python -m pip install …` is `pip install …`.
    const viaPython = /^py(?:thon(?:\d(?:\.\d+)?)?)?$/.test(tool) ? args.indexOf("-m") : -1;
    if (viaPython >= 0 && args[viaPython + 1] === "pip") {
      tool = "pip";
      args = args.slice(viaPython + 2);
    }
    const hit = matchCommand(tool, args);
    if (!hit) continue;
    const { eco, mode } = hit.rule;
    const flags = FLAGS[eco];
    const via = [tool, ...hit.words].join(" ");
    /** @type {string[]} */
    const positionals = [];
    /** @type {string[]} */
    const named = [];
    /** @type {string[]} */
    const files = [];
    let offRegistry = false;
    let pinned = "";
    let workdir = cwd;
    let literal = false;
    for (let i = 0; i < hit.rest.length; i++) {
      const w = hit.rest[i];
      if (literal || !w.startsWith("-")) {
        positionals.push(w);
        // `npx pkg --its-own-flags …`: everything after the package belongs to the package.
        if (mode === "run" || mode === "create") break;
        continue;
      }
      if (w === "--") {
        literal = true;
        continue;
      }
      const eq = w.indexOf("=");
      const flag = eq > 0 ? w.slice(0, eq) : w;
      const takesNext = eq < 0 && flags.value.has(flag);
      const value = eq > 0 ? w.slice(eq + 1) : takesNext ? (hit.rest[i + 1] ?? "") : "";
      if (flags.custom.has(flag)) offRegistry = true;
      if (flags.pkg.has(flag) && value) named.push(value);
      if (flags.pin.has(flag)) pinned = value;
      if (flags.file.has(flag) && value) files.push(value);
      if (eco === "npm" && value && /^(?:--prefix|-C|--dir|--cwd)$/.test(flag))
        workdir = isAbsolute(value) ? value : join(cwd, value);
      if (takesNext) i++;
    }
    if (offRegistry) {
      custom.add(eco);
      continue;
    }

    // An install that reads a manifest: `pip install -r file`, `npm install` with no names.
    for (const file of files) {
      if (UNRESOLVED.test(file)) continue;
      const text = readIncluded(isAbsolute(file) ? file : join(cwd, file), readText);
      for (const spec of (text && manifestDeps(basename(file), text, eco)) || [])
        add(eco, spec, `${via} -r ${basename(file)}`);
    }
    if (eco === "npm" && (mode === "manifest" || (mode === "add" && !positionals.length))) {
      const text = readText(join(workdir, "package.json"));
      for (const spec of (text && manifestDeps("package.json", text)) || []) {
        // Only what this install will newly FETCH: a dependency already in node_modules was
        // vetted (or predates the gate) and is not re-asked on every install.
        const installed = ancestors(workdir).some((d) =>
          exists(join(d, "node_modules", ...spec.name.split("/"), "package.json")),
        );
        if (!installed) add(eco, spec, `${via} (package.json)`);
      }
      continue;
    }
    if (mode === "manifest") continue;

    // `npx -p pkg cmd` / `uvx --from pkg cmd`: the flag names the package, the positional is
    // the command inside it.
    let raws = mode === "add" ? positionals : named.length ? named : positionals.slice(0, 1);
    if (mode === "create") raws = raws.map(initializerSpec);
    for (const raw of raws) {
      if (!raw || UNRESOLVED.test(raw)) continue;
      const spec = SPEC_PARSERS[eco](raw);
      if (!spec) continue;
      // `npx tsc` with a local `node_modules/.bin/tsc` never touches the registry.
      const localBin =
        mode === "run" &&
        eco === "npm" &&
        !named.length &&
        ancestors(cwd).some((d) => exists(join(d, "node_modules", ".bin", spec.name)));
      if (localBin) continue;
      add(eco, { name: spec.name, version: spec.version ?? exact(pinned) }, via);
    }
  }
  return { packages: [...found.values()], custom: [...custom] };
}

// ── Manifests: what does a dependency file declare? ────────────────────────────────────────

/** Every `"…"` / `'…'` string in a fragment. @param {string} s @returns {string[]} */
const quoted = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

/** Lines grouped under `[section]` / `[[section]]` headers (TOML, minimally).
 *  @param {string} text @returns {{section: string, lines: string[]}[]} */
function tomlSections(text) {
  /** @type {{section: string, lines: string[]}[]} */
  const out = [{ section: "", lines: [] }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    const head = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
    if (head) out.push({ section: head[1].replace(/["']/g, ""), lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function packageJsonDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  const doc = JSON.parse(text);
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [name, range] of Object.entries(doc?.[field] ?? {})) {
      if (typeof range !== "string") continue;
      if (range.startsWith("npm:")) {
        const real = SPEC_PARSERS.npm(range.slice(4));
        if (real) out.push(real);
      } else if (!NPM_NOT_REGISTRY.test(range) && !/^[\w.-]+\/[\w.-]+/.test(range)) {
        if (NPM_NAME.test(name)) out.push({ name, version: exact(range) });
      }
    }
  }
  return out;
}

const REQUIREMENTS_INCLUDE = /^\s*(?:-r|--requirement)[=\s]\s*(\S+)\s*$/;
/** How deep `-r` includes are followed; real projects nest one or two levels. */
export const MAX_INCLUDE_DEPTH = 4;

/**
 * A requirements file with its `-r other.txt` lines replaced by the files they name (paths are
 * relative to the including file). Bounded and cycle-safe; an include that cannot be read is
 * dropped, never guessed.
 * @param {string} path @param {ReadText} readText @param {Set<string>} [seen] @param {number} [depth]
 * @returns {string|null}
 */
export function readIncluded(path, readText, seen = new Set(), depth = 0) {
  if (seen.has(path) || depth > MAX_INCLUDE_DEPTH) return "";
  seen.add(path);
  const text = readText(path);
  if (text === null) return depth ? "" : null;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = REQUIREMENTS_INCLUDE.exec(line);
      if (!m || UNRESOLVED.test(m[1])) return line;
      const target = isAbsolute(m[1]) ? m[1] : join(dirname(path), m[1]);
      return readIncluded(target, readText, seen, depth + 1) ?? "";
    })
    .join("\n");
}

/** @param {string} text @returns {Spec[]|null} */
function requirementsDeps(text) {
  // The file itself points pip at another index: nothing in it can be verified publicly.
  if (/^\s*(?:-i|--index-url|--extra-index-url|-f|--find-links)\b/m.test(text)) return null;
  /** @type {Spec[]} */
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?:^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const spec = SPEC_PARSERS.pypi(line.split(/\s+--hash/)[0]);
    if (spec) out.push(spec);
  }
  return out;
}

const PYPROJECT_INDEX =
  /^\s*\[\[tool\.(?:uv\.index|poetry\.source)\]\]|^\s*(?:extra-)?index-url\s*=/m;

/** @param {string} text @returns {Spec[]|null} */
function pyprojectDeps(text) {
  if (PYPROJECT_INDEX.test(text)) return null;
  /** @type {Spec[]} */
  const out = [];
  for (const { section, lines } of tomlSections(text)) {
    if (
      /^tool\.poetry\.(?:dev-)?dependencies$|^tool\.poetry\.group\..+\.dependencies$/.test(section)
    ) {
      for (const line of lines) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line);
        if (!m || m[1] === "python" || /\b(?:git|path|url|source)\s*=/.test(m[2])) continue;
        const spec = SPEC_PARSERS.pypi(m[1]);
        if (spec) out.push({ name: spec.name, version: exact(quoted(m[2])[0]) });
      }
      continue;
    }
    // PEP 621 / PEP 735 arrays: `dependencies = [ "a>=1", … ]`, optional groups, build requires.
    const arrays =
      section === "project"
        ? /^dependencies$/
        : section === "build-system"
          ? /^requires$/
          : section === "tool.uv"
            ? /^dev-dependencies$/
            : /^(?:project\.optional-dependencies|dependency-groups)$/.test(section)
              ? /./
              : null;
    if (!arrays) continue;
    let open = false;
    for (const line of lines) {
      let body = line;
      if (!open) {
        const m = /^\s*([\w-]+)\s*=\s*\[(.*)$/.exec(line);
        if (!m || !arrays.test(m[1])) continue;
        open = true;
        body = m[2];
      }
      for (const item of quoted(body)) {
        const spec = SPEC_PARSERS.pypi(item);
        if (spec) out.push(spec);
      }
      if (body.includes("]")) open = false;
    }
  }
  return out;
}

const CARGO_DEPS =
  /^(?:workspace\.)?(?:dev-|build-)?dependencies$|^target\..+\.(?:dev-|build-)?dependencies$/;
const CARGO_DEP_TABLE =
  /^(?:(?:workspace\.)?(?:dev-|build-)?dependencies|target\..+\.(?:dev-|build-)?dependencies)\.([A-Za-z0-9_-]+)$/;
const OFF_CRATES_IO = /\b(?:path|git|registry)\s*=/;

/** @param {string} text @returns {Spec[]|null} */
function cargoTomlDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  for (const { section, lines } of tomlSections(text)) {
    const table = CARGO_DEP_TABLE.exec(section);
    if (table) {
      // `[dependencies.foo]` — one crate spread over a table.
      const body = lines.join("\n");
      if (OFF_CRATES_IO.test(body)) continue;
      const real = /^\s*package\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? table[1];
      out.push({ name: real, version: exact(/^\s*version\s*=\s*"([^"]+)"/m.exec(body)?.[1]) });
      continue;
    }
    if (!CARGO_DEPS.test(section)) continue;
    for (const line of lines) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      // `name.workspace = true` inherits; a path/git/registry source is not crates.io.
      if (!m || OFF_CRATES_IO.test(m[2])) continue;
      const real = /\bpackage\s*=\s*"([^"]+)"/.exec(m[2])?.[1] ?? m[1];
      const version = /\bversion\s*=\s*"([^"]+)"/.exec(m[2])?.[1] ?? quoted(m[2])[0];
      out.push({ name: real, version: exact(version) });
    }
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function goModDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  let block = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) block = true;
    else if (line === ")") block = false;
    else {
      const m = block ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
      const spec = m && SPEC_PARSERS.go(`${m[1]}@${m[2]}`);
      if (spec) out.push(spec);
    }
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function gemfileDeps(text) {
  // Another gem source for the whole file: rubygems.org is not where these come from.
  if (/^\s*source\s+["'](?!https?:\/\/rubygems\.org)/m.test(text)) return null;
  /** @type {Spec[]} */
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*gem\s+["']([^"']+)["'](.*)$/.exec(line.replace(/\s+#.*$/, ""));
    if (!m || /\b(?:git|github|path|source)\s*:|:(?:git|github|path|source)\s*=>/.test(m[2]))
      continue;
    const spec = SPEC_PARSERS.rubygems(m[1]);
    if (spec) out.push({ name: spec.name, version: exact(quoted(m[2])[0]) });
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function composerDeps(text) {
  const doc = JSON.parse(text);
  // Custom repositories (VCS, private Packagist): packagist.org is not the only source.
  const repos = doc?.repositories;
  if (repos && (Array.isArray(repos) ? repos.length : Object.keys(repos).length)) return null;
  /** @type {Spec[]} */
  const out = [];
  for (const field of ["require", "require-dev"]) {
    for (const [name, range] of Object.entries(doc?.[field] ?? {})) {
      const spec = SPEC_PARSERS.packagist(name);
      if (spec) out.push({ name: spec.name, version: exact(String(range)) });
    }
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function pubspecDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  let active = false;
  /** @type {{name: string, version: string|null, hosted: boolean}|null} */
  let pending = null;
  const flush = () => {
    if (pending?.hosted) out.push({ name: pending.name, version: pending.version });
    pending = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      flush();
      active = /^(?:dependencies|dev_dependencies|dependency_overrides):\s*$/.test(line);
      continue;
    }
    if (!active) continue;
    const entry = /^ {2}([a-z_][a-z0-9_]*):\s*(.*)$/.exec(line);
    if (entry) {
      flush();
      const value = entry[2].replace(/["']/g, "").trim();
      pending = { name: entry[1], version: exact(value), hosted: !value.startsWith("{") };
    } else if (pending && /^\s+(?:sdk|path|git|hosted)\s*:/.test(line)) {
      // `flutter: {sdk: flutter}`, a path or a git source — not a pub.dev package.
      pending.hosted = false;
    }
  }
  flush();
  return out;
}

/** @param {string} xml @param {string} tag */
const xmlTag = (xml, tag) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(xml)?.[1] ?? "";

/** @param {string} text @returns {Spec[]|null} */
function pomDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of xml.matchAll(/<(dependency|plugin|parent)>([\s\S]*?)<\/\1>/g)) {
    const [group, artifact] = [xmlTag(m[2], "groupId"), xmlTag(m[2], "artifactId")];
    // A coordinate built from a property (`${project.groupId}`) cannot be read literally.
    if (!group || !artifact || /\$\{/.test(group + artifact)) continue;
    const spec = SPEC_PARSERS.maven(`${group}:${artifact}`);
    if (spec) out.push({ name: spec.name, version: exact(xmlTag(m[2], "version")) });
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function gradleDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const coordinate = /["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?::([^"':@\s]+))?(?:@\w+)?["']/;
  const patterns = [
    // `implementation "g:a:v"`, `api("g:a:v")`, `classpath 'g:a:v'`, `id("…")` is not one.
    new RegExp(`\\b[a-z][A-Za-z]*\\s*\\(?\\s*(?:platform\\s*\\(\\s*)?${coordinate.source}`, "g"),
    // Version catalogs: `module = "g:a"`, and the short form `alias = "g:a:v"`.
    new RegExp(`\\bmodule\\s*=\\s*${coordinate.source}`, "g"),
    new RegExp(`^\\s*[\\w.-]+\\s*=\\s*${coordinate.source}\\s*$`, "gm"),
  ];
  for (const re of patterns)
    for (const m of body.matchAll(re)) {
      const spec = SPEC_PARSERS.maven(`${m[1]}:${m[2]}`);
      if (spec) out.push({ name: spec.name, version: exact(m[3]) });
    }
  // Version catalogs, long form: `{ group = "g", name = "a", … }`.
  for (const m of body.matchAll(
    /\bgroup\s*=\s*["']([^"']+)["']\s*,\s*name\s*=\s*["']([^"']+)["']/g,
  )) {
    const spec = SPEC_PARSERS.maven(`${m[1]}:${m[2]}`);
    if (spec) out.push(spec);
  }
  return out;
}

/** @param {string} text @returns {Spec[]|null} */
function msbuildDeps(text) {
  /** @type {Spec[]} */
  const out = [];
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of xml.matchAll(/<(?:PackageReference|PackageVersion|package)\b([^>]*)>/g)) {
    const name = /\b(?:Include|Update|id)\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
    const spec = name && !name.includes("$(") ? SPEC_PARSERS.nuget(name) : null;
    if (spec)
      out.push({ name: spec.name, version: exact(/\b[Vv]ersion\s*=\s*"([^"]+)"/.exec(m[1])?.[1]) });
  }
  return out;
}

/**
 * Dependency files and how to list what they declare. `match` is tested against the file's
 * BASE name; `deps` returns null when the file itself points at a non-public source.
 * @type {{match: RegExp, eco: Eco, deps: (text: string) => Spec[]|null}[]}
 */
export const MANIFESTS = [
  { match: /^package\.json$/, eco: "npm", deps: packageJsonDeps },
  {
    match: /^[\w.-]*(?:requirements|constraints)[\w.-]*\.(?:txt|in)$/i,
    eco: "pypi",
    deps: requirementsDeps,
  },
  { match: /^pyproject\.toml$/, eco: "pypi", deps: pyprojectDeps },
  { match: /^Cargo\.toml$/, eco: "cargo", deps: cargoTomlDeps },
  { match: /^go\.mod$/, eco: "go", deps: goModDeps },
  { match: /^Gemfile$|^gems\.rb$/, eco: "rubygems", deps: gemfileDeps },
  { match: /^composer\.json$/, eco: "packagist", deps: composerDeps },
  { match: /^pubspec\.ya?ml$/, eco: "pub", deps: pubspecDeps },
  { match: /^pom\.xml$/, eco: "maven", deps: pomDeps },
  {
    match: /^(?:build|settings)\.gradle(?:\.kts)?$|^libs\.versions\.toml$/,
    eco: "maven",
    deps: gradleDeps,
  },
  {
    match: /\.(?:cs|fs|vb)proj$|^Directory\.Packages\.props$|^packages\.config$/i,
    eco: "nuget",
    deps: msbuildDeps,
  },
];

/**
 * What a manifest declares. Never throws: an unparseable file declares nothing.
 * @param {string} fileName base name, picks the dialect
 * @param {string} text
 * @param {Eco} [onlyEco] restrict to manifests of this ecosystem (`pip install -r <any name>`)
 * @returns {(Spec & {eco: Eco})[]|null} null = the file itself points at a non-public source
 */
export function manifestDeps(fileName, text, onlyEco) {
  const rule =
    MANIFESTS.find((m) => m.match.test(fileName) && (!onlyEco || m.eco === onlyEco)) ??
    // `pip install -r deps.txt`: whatever it is called, it is a requirements file.
    (onlyEco === "pypi" ? MANIFESTS.find((m) => m.deps === requirementsDeps) : undefined);
  if (!rule) return [];
  try {
    const specs = rule.deps(text);
    if (specs === null) return null;
    /** @type {Map<string, Spec & {eco: Eco}>} */
    const unique = new Map();
    for (const s of specs) if (!unique.has(s.name)) unique.set(s.name, { ...s, eco: rule.eco });
    return [...unique.values()];
  } catch {
    return [];
  }
}

/**
 * The packages an Edit / Write / MultiEdit ADDS to a manifest: declared(after) − declared(before).
 * When the edit cannot be applied to the file as it stands, nothing is claimed.
 * @param {{toolName?: string, toolInput?: any, cwd?: string, readText?: ReadText}} edit
 * @returns {PkgSpec[]}
 */
export function editAdditions({
  toolName,
  toolInput,
  cwd = process.cwd(),
  readText = readTextSafe,
}) {
  const file = String(toolInput?.file_path ?? "");
  const name = basename(file.replaceAll("\\", "/"));
  if (!file || !MANIFESTS.some((m) => m.match.test(name))) return [];
  const before = readText(isAbsolute(file) ? file : join(cwd, file)) ?? "";
  /** @type {string|null} */
  let after = null;
  /** @param {string} text @param {any} e @returns {string|null} */
  const apply = (text, e) => {
    const [from, to] = [String(e?.old_string ?? ""), String(e?.new_string ?? "")];
    if (!from) return text ? null : to;
    if (!text.includes(from)) return null;
    return e?.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
  };
  if (toolName === "Write")
    after = typeof toolInput?.content === "string" ? toolInput.content : null;
  else if (toolName === "Edit") after = apply(before, toolInput);
  else if (toolName === "MultiEdit" && Array.isArray(toolInput?.edits)) {
    after = before;
    for (const e of toolInput.edits) after = after === null ? null : apply(after, e);
  }
  if (after === null) return [];
  const declared = manifestDeps(name, after);
  if (!declared) return [];
  // New = a name the manifest did not declare, or a declared name moved to another exact
  // release (that release has its own advisories). A widened range changes nothing checkable.
  const had = new Map((manifestDeps(name, before) ?? []).map((d) => [d.name, d.version]));
  return declared
    .filter((d) => !had.has(d.name) || (d.version !== null && had.get(d.name) !== d.version))
    .map((d) => ({ eco: d.eco, name: d.name, version: d.version, via: `edit ${name}` }));
}

// ── Is a non-default registry configured? (then a 404 on the public one proves nothing) ────

const DEFAULT_HOSTS =
  /^https?:\/\/(?:registry\.npmjs\.org|pypi\.org\/simple|proxy\.golang\.org|pub\.dev|rubygems\.org|api\.nuget\.org\/v3\/index\.json|repo\.packagist\.org)\/?$/i;
/** @param {unknown} v */
const elsewhere = (v) => Boolean(v) && !DEFAULT_HOSTS.test(String(v));

/**
 * Environment variables that choose a registry, per ecosystem. `any: true` means the variable
 * being SET is enough (GOPRIVATE names private module prefixes — its presence is the signal).
 * @type {{env: string, eco: Eco, any?: boolean}[]}
 */
export const ENV_REGISTRY_CONFIG = [
  { env: "npm_config_registry", eco: "npm" },
  { env: "NPM_CONFIG_REGISTRY", eco: "npm" },
  { env: "PIP_INDEX_URL", eco: "pypi" },
  { env: "PIP_EXTRA_INDEX_URL", eco: "pypi" },
  { env: "UV_INDEX_URL", eco: "pypi" },
  { env: "UV_INDEX", eco: "pypi" },
  { env: "UV_DEFAULT_INDEX", eco: "pypi" },
  { env: "PUB_HOSTED_URL", eco: "pub" },
  { env: "GOPRIVATE", eco: "go", any: true },
  { env: "GONOPROXY", eco: "go", any: true },
  { env: "GONOSUMDB", eco: "go", any: true },
];

// Patterns that mean "a registry is chosen here", one per config dialect. Only these keys are
// matched — never a credential.
const YARN_REGISTRY = /^\s*(?:npmRegistryServer|npmScopes)\s*:/m;
const BUN_REGISTRY = /^\s*registry\s*=|^\s*\[install\.scopes\]/m;
const PIP_INDEX = /^\s*(?:extra-)?index-url\s*=/m;
const UV_INDEX = /^\s*\[\[index\]\]|^\s*(?:extra-)?index-url\s*=/m;
const CARGO_REGISTRY = /^\s*\[registries[.\]]|^\s*replace-with\s*=/m;
const NUGET_SOURCE = /<add\s[^>]*value\s*=\s*"(?!https:\/\/api\.nuget\.org\/)[^"]+"/i;
const COMPOSER_REPOSITORIES = /"repositories"\s*:\s*[[{]\s*[^\s\]}]/;
const GEM_SOURCES = /^\s*:?sources\s*:/m;
const BUNDLE_MIRROR = /^\s*BUNDLE_MIRROR__/m;
const MAVEN_MIRROR = /<(?:mirror|repository)>/;

/**
 * Config files that point a package manager at another registry: a file name, the pattern
 * that decides, the ecosystem it speaks for. PROJECT files are looked up in every directory
 * from the cwd to the root; USER files under the home directory.
 * @type {{file: string, re: RegExp, eco: Eco}[]}
 */
export const PROJECT_REGISTRY_CONFIG = [
  { file: ".yarnrc.yml", re: YARN_REGISTRY, eco: "npm" },
  { file: "bunfig.toml", re: BUN_REGISTRY, eco: "npm" },
  { file: "pyproject.toml", re: PYPROJECT_INDEX, eco: "pypi" },
  { file: "uv.toml", re: UV_INDEX, eco: "pypi" },
  { file: "pip.conf", re: PIP_INDEX, eco: "pypi" },
  { file: join(".cargo", "config.toml"), re: CARGO_REGISTRY, eco: "cargo" },
  { file: "nuget.config", re: NUGET_SOURCE, eco: "nuget" },
  { file: "NuGet.Config", re: NUGET_SOURCE, eco: "nuget" },
  { file: "composer.json", re: COMPOSER_REPOSITORIES, eco: "packagist" },
  { file: join(".bundle", "config"), re: BUNDLE_MIRROR, eco: "rubygems" },
];
/** @type {{file: string, re: RegExp, eco: Eco}[]} */
export const USER_REGISTRY_CONFIG = [
  { file: ".yarnrc.yml", re: YARN_REGISTRY, eco: "npm" },
  { file: ".bunfig.toml", re: BUN_REGISTRY, eco: "npm" },
  { file: join(".config", "pip", "pip.conf"), re: PIP_INDEX, eco: "pypi" },
  { file: join(".pip", "pip.conf"), re: PIP_INDEX, eco: "pypi" },
  { file: join(".config", "uv", "uv.toml"), re: UV_INDEX, eco: "pypi" },
  { file: join(".cargo", "config.toml"), re: CARGO_REGISTRY, eco: "cargo" },
  { file: join(".nuget", "NuGet", "NuGet.Config"), re: NUGET_SOURCE, eco: "nuget" },
  { file: join(".config", "composer", "config.json"), re: COMPOSER_REPOSITORIES, eco: "packagist" },
  { file: ".gemrc", re: GEM_SOURCES, eco: "rubygems" },
  { file: join(".bundle", "config"), re: BUNDLE_MIRROR, eco: "rubygems" },
  { file: join(".m2", "settings.xml"), re: MAVEN_MIRROR, eco: "maven" },
];

/**
 * Registry overrides in effect: environment, `.npmrc` (`registry=` and `@scope:registry=` —
 * never a token line) and the config files in the tables above. When one is in play the
 * public registry is not where the install will look, so a 404 there proves nothing and a
 * private name must not be sent to it.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, home?: string, readText?: ReadText}} [opts]
 * @returns {Record<Eco, boolean> & {npmScopes: string[]}}
 */
export function customRegistries({
  cwd = process.cwd(),
  env = process.env,
  home = homedir(),
  readText = readTextSafe,
} = {}) {
  /** @type {Set<string>} */
  const scopes = new Set();
  /** @type {Record<Eco, boolean>} */
  const custom = {
    npm: false,
    pypi: false,
    cargo: false,
    go: false,
    maven: false,
    nuget: false,
    rubygems: false,
    packagist: false,
    pub: false,
  };
  for (const { env: key, eco, any } of ENV_REGISTRY_CONFIG)
    if (any ? Boolean(env[key]) : elsewhere(env[key])) custom[eco] = true;
  // GOPROXY may list several proxies; only the default pair leaves the public proxy in charge.
  if (env.GOPROXY && !/^https:\/\/proxy\.golang\.org(?:[,|]direct)?$/.test(env.GOPROXY))
    custom.go = true;

  /** @param {string} file */
  const npmrc = (file) => {
    for (const line of (readText(file) ?? "").split(/\r?\n/)) {
      const m = /^\s*(@[^:\s]+:)?registry\s*=\s*(\S+)/.exec(line);
      if (!m || !elsewhere(m[2])) continue;
      if (m[1]) scopes.add(m[1].slice(0, -1).toLowerCase());
      else custom.npm = true;
    }
  };
  /** @param {string} file @param {RegExp} re @param {Eco} eco */
  const chooses = (file, re, eco) => {
    if (!custom[eco] && re.test(readText(file) ?? "")) custom[eco] = true;
  };
  for (const dir of ancestors(cwd)) {
    npmrc(join(dir, ".npmrc"));
    for (const c of PROJECT_REGISTRY_CONFIG) chooses(join(dir, c.file), c.re, c.eco);
  }
  if (home) {
    npmrc(join(home, ".npmrc"));
    for (const u of USER_REGISTRY_CONFIG) chooses(join(home, u.file), u.re, u.eco);
  }
  if (env.PIP_CONFIG_FILE) chooses(env.PIP_CONFIG_FILE, PIP_INDEX, "pypi");
  return { ...custom, npmScopes: [...scopes] };
}

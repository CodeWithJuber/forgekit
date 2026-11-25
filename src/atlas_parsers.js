// Optional parser workers receive bounded source batches over stdin. They never load a project.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessChildPath, installedHarnessPython } from "./harness_python.js";
import { containsPath } from "./private_paths.js";

const file = (name) => fileURLToPath(new URL(name, import.meta.url));
const maxBatch = 2 * 1024 * 1024;

export function syntaxLanguage(path) {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "typescript";
  if (path.endsWith(".py")) return "python";
  return null;
}

export function createAtlasParsers(root) {
  const runners = new Map();
  const env = {
    PATH: harnessChildPath(root),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  for (const kind of ["typescript", "python"]) {
    try {
      let bin, args, provider;
      if (kind === "typescript") {
        const custom = process.env.FORGE_TYPESCRIPT_PATH;
        if (custom && !isAbsolute(custom)) throw new Error("Choose an absolute compiler path");
        provider = realpathSync.native(
          custom || file("../node_modules/typescript/lib/typescript.js"),
        );
        if (containsPath(realpathSync.native(root), provider))
          throw new Error("Choose a compiler installed outside the indexed workspace");
        bin = process.execPath;
        args = ["--max-old-space-size=192", file("./atlas_typescript_worker.mjs"), provider];
      } else {
        bin = provider = installedHarnessPython(root);
        args = ["-I", "-S", "-X", "utf8", file("./atlas_python_worker.py")];
      }
      const st = statSync(provider);
      // Include the physical executable/provider identity in the private cache only.
      runners.set(kind, {
        bin,
        args,
        identity: [kind, provider, st.size, st.mtimeMs].join(":"),
        batch: [],
        bytes: 0,
      });
    } catch {
      // The build records the unavailable provider on every affected source.
    }
  }
  // Whole-program symbols depend on every module, including cached syntax rows.
  // Release the snapshot as soon as the compiler budget is exceeded.
  const inputs = [];
  let size = 0;
  let limited = false;
  function flush(kind) {
    const r = runners.get(kind);
    if (!r?.batch.length) return;
    const batch = r.batch;
    r.batch = [];
    r.bytes = 0;
    const input = JSON.stringify(batch.map(({ file, text }) => ({ file, text })));
    const result = spawnSync(r.bin, r.args, {
      env,
      input,
      encoding: "utf8",
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
    let answers;
    if (result.status === 0) {
      try {
        answers = JSON.parse(result.stdout);
      } catch {
        /* handled below */
      }
    }
    for (const [i, row] of batch.entries())
      row.receive(
        answers?.[i] ?? {
          reason:
            /** @type {NodeJS.ErrnoException} */ (result.error)?.code === "ETIMEDOUT"
              ? "parser-timeout"
              : "parser-worker-failed",
        },
      );
  }
  return {
    identity: (kind) => runners.get(kind)?.identity ?? "unavailable",
    add(kind, path, text, receive) {
      const r = runners.get(kind);
      if (!r) {
        receive({ reason: "parser-unavailable" });
        return;
      }
      const bytes = Buffer.byteLength(text);
      if (r.bytes + bytes > maxBatch || r.batch.length >= 48) flush(kind);
      r.batch.push({ file: path, text, receive });
      r.bytes += bytes;
    },
    observe(path, text) {
      if (limited || !runners.has("typescript")) return;
      size += Buffer.byteLength(text);
      if (size > maxBatch || inputs.length >= 512) {
        limited = true;
        inputs.length = 0;
      } else inputs.push({ file: path, text });
    },
    compiler(aliases) {
      const r = runners.get("typescript");
      if (!r || limited || !inputs.length)
        return {
          status: "unavailable",
          reason: limited
            ? "compiler-input-limit"
            : !r
              ? "compiler-unavailable"
              : "no-compiler-input",
        };
      const result = spawnSync(r.bin, [r.args[0], file("./atlas_semantic_worker.mjs"), r.args[2]], {
        env,
        input: JSON.stringify({ files: inputs, aliases }),
        encoding: "utf8",
        timeout: 10000,
        killSignal: "SIGKILL",
        maxBuffer: 12 * 1024 * 1024,
      });
      if (result.status === 0) {
        try {
          const answer = JSON.parse(result.stdout);
          if (Array.isArray(answer.sites)) return { status: "available", ...answer };
        } catch {
          /* failed or truncated output */
        }
      }
      return {
        status: "unavailable",
        reason:
          /** @type {NodeJS.ErrnoException} */ (result.error)?.code === "ETIMEDOUT"
            ? "compiler-timeout"
            : "compiler-worker-failed",
      };
    },
    finish() {
      for (const kind of runners.keys()) flush(kind);
    },
  };
}

export function syntaxGraph(facts, file, moduleName, builtins) {
  const mod = { id: `module:${moduleName}`, name: moduleName, kind: "module", file, line: 1 };
  const ids = new Map();
  const nodes = [];
  for (const { name, kind, line, endLine, parent } of facts.defs) {
    const base = `${file}:${name}:${line}`;
    const ordinal = (ids.get(base) ?? 0) + 1;
    ids.set(base, ordinal);
    nodes.push({
      id: ordinal === 1 ? base : `${base}#${ordinal}`,
      qname: `${nodes[parent]?.qname ?? moduleName}.${name}`,
      name,
      kind,
      file,
      line,
      endLine,
      ...(parent >= 0 ? { local: true } : {}),
    });
  }
  const owner = (index) => nodes[index]?.id ?? mod.id;
  const edges = facts.defs.map((d, i) => ({
    source: owner(d.parent),
    target: nodes[i].id,
    kind: "contains",
    confidence: 1,
    line: d.line,
  }));
  for (const { owner: index, ...ref } of facts.refs) {
    if (ref.kind === "calls" && builtins.has(ref.target)) continue;
    edges.push({ source: owner(index), confidence: ref.kind === "imports" ? 1 : 0.85, ...ref });
  }
  return { symbols: nodes, nodes: [mod, ...nodes], edges };
}

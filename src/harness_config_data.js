// Parse operator-maintained policy as data. Default JSON needs no optional package.
// YAML uses a bounded SafeLoader in isolation. Both paths reject ambiguous mappings.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedHarnessPython } from "./harness_python.js";
import { readWorkspaceText } from "./reuse_symbols.js";
import { sourceWorkspaceRoot } from "./sources.js";

const reader = fileURLToPath(new URL("./harness_config_data.py", import.meta.url));

// JSON.parse validates the full grammar before this scan. In valid JSON a string
// followed by a colon is always an object key. Check its decoded spelling so
// duplicate keys and escaped prototype names get the same verdict as in YAML.
function parseJson(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Harness configuration must be one mapping");
  const stack = [];
  let lastString = "";
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const [token] of text.matchAll(tokens)) {
    if (token === "{" || token === "[") {
      if (stack.length >= 49) throw new Error("Harness configuration nesting exceeds 48");
      stack.push(token === "{" ? new Set() : null);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === ":") {
      const key = JSON.parse(lastString);
      if (["__proto__", "constructor", "prototype", "<<"].includes(key))
        throw new Error("Invalid harness configuration key");
      const keys = stack[stack.length - 1];
      if (keys.has(key)) throw new Error("Duplicate harness configuration key");
      keys.add(key);
    } else if (token[0] === '"') {
      lastString = token;
    } else if (!Number.isFinite(Number(token))) {
      throw new Error("Harness configuration requires finite numeric values");
    }
  }
  return result;
}

/** @param {string} path @param {{root?:string}} options */
export function readHarnessConfigData(path, { root = undefined } = {}) {
  const absolute = root === undefined ? resolve(path) : resolve(root, path);
  root ??= dirname(absolute);
  const base = realpathSync.native(root);
  const rel = relative(resolve(root), absolute);
  const text = readWorkspaceText(base, rel, 256 * 1024);
  if (text === null) throw new Error(`Missing, unsafe or oversized harness config: ${path}`);
  const json = parseJson(text.replace(/^\uFEFF/u, ""));
  if (json !== undefined) return json;
  const bin = installedHarnessPython(sourceWorkspaceRoot(base));
  const parsed = spawnSync(bin, ["-I", "-B", reader], {
    cwd: dirname(reader),
    input: text,
    encoding: "utf8",
    timeout: 4000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (parsed.error || parsed.status !== 0)
    throw new Error("Harness configuration parser failed or exceeded its limits");
  const response = JSON.parse(parsed.stdout);
  if (response.error) throw new Error(response.error);
  return response.value;
}

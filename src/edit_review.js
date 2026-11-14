// Verify only the regular file a successful edit touched. Never execute the file or a
// project test from a post-edit hook. The Stop gate owns full verification receipts.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { secretKind } from "../global/guards/protect-paths.mjs";
import { BRAND } from "./brand.js";
import { classifyPath } from "./gate.js";
import { failureQuery } from "./hook_evidence.js";
import { readWorkspaceText } from "./reuse_symbols.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { IGNORE_DIRS } from "./util.js";

const MAX_BYTES = 128 * 1024;

// Identify only existing, same-workspace test paths. No recursive test-directory scans.
function nearbyTests(root, file) {
  const dir = dirname(file);
  const ext = extname(file);
  const name = basename(file, ext);
  const candidates = [];
  if (/^\.(?:[cm]?[jt]sx?)$/.test(ext))
    for (const e of new Set([ext, ".js", ".ts"])) {
      for (const variant of ["test", "spec"])
        for (const folder of [dir, join(dir, "__tests__"), "test", "tests"])
          candidates.push(join(folder, `${name}.${variant}${e}`));
    }
  else if (ext === ".py")
    candidates.push(join(dir, `test_${name}${ext}`), join("tests", `test_${name}${ext}`));
  else if (ext === ".go") candidates.push(join(dir, `${name}_test.go`));
  else if (ext === ".rs") candidates.push(join("tests", name + ext));
  return [...new Set(candidates)]
    .filter((path) => {
      try {
        const full = join(root, path);
        return realpathSync(full) === full && statSync(full).isFile();
      } catch {
        return false;
      }
    })
    .slice(0, 2);
}

// The shell and editor can spell the workspace root differently (macOS /var and
// /private/var). Resolve the root alias only. readWorkspaceText still rejects
// symlinks anywhere in the relative file path.
function relativeEditPath(base, file) {
  if (file.length > 4096) return "";
  const full = resolve(base, file);
  const direct = relative(base, full);
  if (!isAbsolute(direct) && direct !== ".." && !direct.startsWith(`..${sep}`)) return direct;
  for (let parent = dirname(full); parent !== dirname(parent); parent = dirname(parent)) {
    try {
      if (realpathSync(parent) === base) return relative(parent, full);
    } catch {
      return "";
    }
  }
  return "";
}

/** Check a bounded snapshot of the current file, within a fixed per-file budget.
 * A parser exit is syntax evidence only. The project may use a different compiler.
 * @param {string} root @param {any} hook */
export function editReview(root, hook) {
  if (typeof hook?.tool_input?.file_path !== "string" || failureQuery(hook)) return "";
  let base;
  try {
    base = realpathSync(root);
  } catch {
    return "";
  }
  const rel = relativeEditPath(base, hook.tool_input.file_path);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.split(sep).some((part) => IGNORE_DIRS.has(part)) ||
    secretKind(rel)
  )
    return "";
  const type = classifyPath(rel);
  if (!["code", "config", "test", "ui"].includes(type)) return "";
  const display = JSON.stringify(redactSecrets(rel)).slice(0, 225);
  const text = readWorkspaceText(base, rel, MAX_BYTES);
  if (text === null || text.includes("\0")) return "";
  const checks = [
    hasSecret(text) ? "credential scan found a possible secret" : "credential scan found no match",
    /^(?:<<<<<<<(?:[ \t]|$)|>>>>>>>(?:[ \t]|$))/m.test(text)
      ? "merge-conflict marker found"
      : "no merge-conflict markers",
  ];
  const ext = extname(rel);
  if (ext === ".json") {
    try {
      JSON.parse(text.replace(/^\uFEFF/, ""));
      checks.push("JSON parsed");
    } catch {
      checks.push("invalid JSON");
    }
  } else if (ext === ".mjs" || ext === ".cjs") {
    // No project NODE_OPTIONS/loader or cwd lookup; --check reads stdin without evaluating it.
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const parsed = spawnSync(
      process.execPath,
      ["--check", `--input-type=${ext === ".mjs" ? "module" : "commonjs"}`, "-"],
      { input: text, encoding: "utf8", env, timeout: 1000, stdio: ["pipe", "ignore", "ignore"] },
    );
    checks.push(
      parsed.error || parsed.signal
        ? "Node syntax check unavailable"
        : parsed.status === 0
          ? "Node syntax parsed"
          : "Node syntax check failed",
    );
  }
  const tests = type === "test" ? [rel] : nearbyTests(base, rel);
  const next = tests.length
    ? ` Suggested tests: ${tests.map((t) => JSON.stringify(redactSecrets(t)).slice(0, 225)).join(", ")}.`
    : "";
  return `${BRAND.brand} edit review ${display}: ${checks.join(", ")}. This check did not run tests.${next}`;
}

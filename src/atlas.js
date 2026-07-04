// forge atlas — a portable, precomputed symbol index. `build` scans the repo ONCE
// and writes .forge/atlas.json; queries read that artifact (token-cheap, and any
// tool can read it via `forge atlas` or plain jq — no MCP needed to consume).
//
// lean: v1 indexes symbol DEFINITIONS (where-is-X) + membership (hallucination
// check) via per-language regex. The richer "what-calls-Z" call graph is the
// documented upgrade — back it with an LSP/serena export when that's needed.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, extname } from "node:path";

const IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "__pycache__",
  ".forge",
  "coverage",
  ".venv",
  "vendor",
]);

const JS = [
  {
    re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
  },
  { re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  {
    re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    kind: "const",
  },
];
const RULES = {
  ".js": JS,
  ".jsx": JS,
  ".ts": JS,
  ".tsx": JS,
  ".mjs": JS,
  ".cjs": JS,
  ".py": [
    { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
  ".go": [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  ".rs": [
    { re: /\bfn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /\b(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
  ".java": [
    { re: /\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/, kind: "type" },
  ],
};

function walk(dir, files, cap) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, files, cap);
    else if (RULES[extname(name)] && files.length < cap) files.push(path);
  }
}

function extractFile(path, root) {
  const rules = RULES[extname(path)];
  const out = [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  const rel = relative(root, path);
  text.split("\n").forEach((line, i) => {
    for (const { re, kind } of rules) {
      const m = re.exec(line);
      if (m) out.push({ name: m[1], kind, file: rel, line: i + 1 });
    }
  });
  return out;
}

export function build({ root = process.cwd(), cap = 20000 } = {}) {
  const files = [];
  walk(root, files, cap);
  const symbols = [];
  for (const f of files) symbols.push(...extractFile(f, root));
  const atlas = {
    version: 1,
    files: files.length,
    symbols,
    capped: files.length >= cap,
  };
  mkdirSync(join(root, ".forge"), { recursive: true });
  writeFileSync(join(root, ".forge", "atlas.json"), JSON.stringify(atlas));
  return atlas;
}

export function load(root = process.cwd()) {
  const p = join(root, ".forge", "atlas.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function query(atlas, term) {
  const t = String(term).toLowerCase();
  return atlas.symbols.filter((s) => s.name.toLowerCase().includes(t));
}

export function has(atlas, name) {
  return atlas.symbols.some((s) => s.name === name);
}

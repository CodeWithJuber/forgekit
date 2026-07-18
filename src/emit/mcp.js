// Emit the managed MCP server set into each tool's MCP config, in that tool's REAL
// format (all verified 2026-07). Non-destructive by construction (RA-03, RA-21):
// every write is scoped to an entry/block/file forge OWNS — a name in the persistent
// managed∪adopted record (see integrations.js) or a region carrying a forge marker.
// Anything else is user-owned and is reported, never rewritten. JSON tools differ only
// by their top-level key; Codex is TOML (forge-marked blocks) and Continue gets one
// forge-marked YAML file per managed server. (Windsurf is global-only — nothing to emit.)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRAND } from "../brand.js";
import { hashContent, isManaged, readIfExists, writeManaged, yamlHeader } from "./_shared.js";

const JSON_TARGETS = [
  { tool: "Claude Code", file: ".mcp.json", key: "mcpServers" },
  { tool: "Cursor", file: ".cursor/mcp.json", key: "mcpServers" },
  { tool: "Gemini CLI", file: ".gemini/settings.json", key: "mcpServers" },
  { tool: "Roo Code", file: ".roo/mcp.json", key: "mcpServers" },
  { tool: "Zed", file: ".zed/settings.json", key: "context_servers" },
  { tool: "VS Code / Copilot", file: ".vscode/mcp.json", key: "servers" },
];

const CONTINUE_DIR = join(".continue", "mcpServers");
const LEGACY_CONTINUE_FILE = "forge-mcp.yaml"; // pre-RA-03 combined file
const CODEX_FILE = join(".codex", "config.toml");

const adoptHint = (name) => `adopt with: ${BRAND.cli} integrations add ${name} --adopt`;

/** Per-server Continue file name. Servers already namespaced `forge-*` keep their name. */
export const continueFileFor = (name) =>
  name.startsWith("forge-") ? `${name}.yaml` : `forge-${name}.yaml`;

// ---------------------------------------------------------------------------
// JSON targets — entry-level ownership (RA-21).
// ---------------------------------------------------------------------------

function mergeJson(path, key, servers, owned) {
  let obj = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { action: "skipped", note: "invalid JSON — left as-is" };
    }
  }
  const bucket = obj[key] || (obj[key] = {});
  // Ownership rules: absent → write; present + owned → refresh on drift; present +
  // NOT owned → leave byte-identical and say so (the entry is the user's — a same-name
  // server they configured themselves must never be silently replaced).
  let changed = 0;
  const skipped = [];
  for (const [name, def] of Object.entries(servers)) {
    const cur = bucket[name];
    if (cur === undefined) {
      bucket[name] = def;
      changed += 1;
    } else if (JSON.stringify(cur) !== JSON.stringify(def)) {
      if (owned.has(name)) {
        bucket[name] = def;
        changed += 1;
      } else {
        skipped.push(name);
      }
    }
  }
  const skipNote = skipped.length
    ? `skipped ${skipped.join(", ")}: user-owned — ${adoptHint(skipped[0])}`
    : "";
  if (!changed) {
    return skipped.length
      ? { action: "skipped", note: skipNote }
      : { action: "unchanged", note: "present" };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  const note = `${changed} server(s) written/updated${skipNote ? `; ${skipNote}` : ""}`;
  return { action: "written", note };
}

/** Delete one server entry from a JSON target. Never touches anything else in the file. */
function removeFromJson(path, key, name) {
  if (!existsSync(path)) return { action: "unchanged", note: "absent" };
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { action: "skipped", note: "invalid JSON — left as-is" };
  }
  const bucket = obj?.[key];
  if (!bucket || bucket[name] === undefined) return { action: "unchanged", note: "absent" };
  delete bucket[name];
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { action: "written", note: `${name} removed` };
}

// ---------------------------------------------------------------------------
// Codex TOML — forge-marked managed blocks.
// ---------------------------------------------------------------------------

const codexBegin = (name) => `# forge:managed:${name} begin`;
const codexEnd = (name) => `# forge:managed:${name} end`;

function codexBlock(name, def) {
  const args = (def.args || []).map((a) => JSON.stringify(a)).join(", ");
  return `${codexBegin(name)}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(def.command)}\nargs = [${args}]\n${codexEnd(name)}\n`;
}

/** What the pre-marker emitter wrote for this server — the migration fingerprint. A
 *  byte-identical unmarked block is provably a past forge emission, safe to claim. */
function legacyCodexBlock(name, def) {
  const args = (def.args || []).map((a) => JSON.stringify(a)).join(", ");
  return `[mcp_servers.${name}]\ncommand = ${JSON.stringify(def.command)}\nargs = [${args}]\n`;
}

/** The extent [start, end) of a forge-marked region for `name`, or null. */
function markedRegion(text, name) {
  const start = text.indexOf(codexBegin(name));
  if (start < 0) return null;
  const endMarker = codexEnd(name);
  const endAt = text.indexOf(endMarker, start);
  if (endAt < 0) return { start, end: -1 }; // damaged: begin without end
  let end = endAt + endMarker.length;
  if (text[end] === "\n") end += 1;
  return { start, end };
}

/** The extent [start, end) of an UNMARKED `[mcp_servers.<name>]` block: from its header
 *  line to the next `[`-table or forge marker at line start (or EOF), or null. */
function unmarkedRegion(text, name) {
  const header = `[mcp_servers.${name}]`;
  let idx = -1;
  for (const m of text.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)) {
    if (m[1] === name) {
      idx = m.index;
      break;
    }
  }
  if (idx < 0) return null;
  if (text.slice(0, idx).trimEnd().endsWith(codexBegin(name))) return null; // it's marked
  const rest = text.slice(idx + header.length);
  const next = rest.search(/^\[|^# forge:managed:/m);
  const end = next < 0 ? text.length : idx + header.length + next;
  return { start: idx, end };
}

function emitCodexToml(path, servers, owned) {
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  let changed = 0;
  const notes = [];
  for (const [name, def] of Object.entries(servers)) {
    const block = codexBlock(name, def);
    const marked = markedRegion(text, name);
    if (marked) {
      if (marked.end < 0) {
        notes.push(`${name}: begin marker without end — left as-is`);
        continue;
      }
      const cur = text.slice(marked.start, marked.end);
      if (cur !== block) {
        text = text.slice(0, marked.start) + block + text.slice(marked.end);
        changed += 1;
      }
      continue;
    }
    const unmarked = unmarkedRegion(text, name);
    if (unmarked) {
      const cur = text.slice(unmarked.start, unmarked.end);
      // Migration/ownership for a pre-existing plain block: claim it only when the name
      // is in the owned record OR the block byte-matches a past forge emission. Anything
      // else is the user's TOML — leave it byte-identical.
      if (owned.has(name) || cur.trimEnd() === legacyCodexBlock(name, def).trimEnd()) {
        text = text.slice(0, unmarked.start) + block + text.slice(unmarked.end);
        changed += 1;
        notes.push(`${name}: adopted unmarked block (forge markers added)`);
      } else {
        notes.push(`skipped ${name}: user-owned — ${adoptHint(name)}`);
      }
      continue;
    }
    text += `${text && !text.endsWith("\n\n") ? "\n" : ""}${block}`;
    changed += 1;
  }
  if (!changed) {
    const skippedOnly = notes.length && notes.every((n) => n.startsWith("skipped"));
    return {
      action: skippedOnly ? "skipped" : "unchanged",
      note: notes.join("; ") || "present",
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return {
    action: "written",
    note: [`${changed} managed block(s)`, ...notes].join("; "),
  };
}

/** Remove the forge-marked Codex block for `name`. Unmarked blocks are never touched. */
function removeCodexBlock(path, name) {
  if (!existsSync(path)) return { action: "unchanged", note: "absent" };
  const text = readFileSync(path, "utf8");
  const marked = markedRegion(text, name);
  if (!marked || marked.end < 0) return { action: "unchanged", note: "no forge-marked block" };
  writeFileSync(path, text.slice(0, marked.start) + text.slice(marked.end));
  return { action: "written", note: `${name} block removed` };
}

// ---------------------------------------------------------------------------
// Continue — one forge-marked YAML file per managed server (never a combined file).
// ---------------------------------------------------------------------------

function continueBody(name, def) {
  const lines = [
    `name: ${continueFileFor(name).replace(/\.yaml$/, "")}`,
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
    `  - name: ${name}`,
    "    type: stdio",
    `    command: ${def.command}`,
    "    args:",
  ];
  for (const a of def.args || []) lines.push(`      - ${JSON.stringify(a)}`);
  return lines.join("\n");
}

function emitContinueServer(dir, name, def) {
  const path = join(dir, continueFileFor(name));
  const existing = readIfExists(path);
  if (existing !== null && !isManaged(existing))
    return { action: "skipped", note: "existing unmanaged file" };
  const body = continueBody(name, def);
  const action = writeManaged(path, yamlHeader(hashContent(body)), body);
  return { action, note: "per-server YAML" };
}

/** Migrate away the pre-RA-03 combined forge-mcp.yaml once per-server files exist.
 *  Deleted only when it is provably forge's: it carries the forge marker, or it is the
 *  old emitter's exact fingerprint (`name: Forge MCP` header + `schema: v1`, which the
 *  old generator always wrote and never marked). A file that matches neither is the
 *  user's and stays. */
function migrateLegacyContinue(dir) {
  const path = join(dir, LEGACY_CONTINUE_FILE);
  const existing = readIfExists(path);
  if (existing === null) return null;
  const oldFingerprint =
    existing.startsWith("name: Forge MCP\n") && existing.includes("schema: v1");
  if (!isManaged(existing) && !oldFingerprint)
    return { action: "skipped", note: "unmanaged legacy file left in place" };
  rmSync(path, { force: true });
  return {
    action: "written",
    note: "legacy combined file removed (now per-server files)",
  };
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/**
 * Emit `servers` (the full managed set) into every target. `owned` is the set of names
 * forge may OVERWRITE when a same-name entry already exists and drifted — the persistent
 * managed∪adopted record plus the built-in registry names. Absent entries are always
 * written; entries outside `owned` are preserved and reported.
 * @param {{targetRoot:string, servers:Record<string,{command:string,args?:string[]}>,
 *   owned?:Set<string>}} opts
 */
export function emitMcp({ targetRoot, servers, owned = new Set(Object.keys(servers)) }) {
  const rows = JSON_TARGETS.map((t) => {
    const r = mergeJson(join(targetRoot, t.file), t.key, servers, owned);
    return {
      tool: `${t.tool} MCP`,
      target: t.file,
      action: r.action,
      note: r.note,
    };
  });
  const codex = emitCodexToml(join(targetRoot, CODEX_FILE), servers, owned);
  rows.push({
    tool: "Codex MCP",
    target: ".codex/config.toml",
    action: codex.action,
    note: codex.note,
  });
  const dir = join(targetRoot, CONTINUE_DIR);
  for (const [name, def] of Object.entries(servers)) {
    const r = emitContinueServer(dir, name, def);
    rows.push({
      tool: "Continue MCP",
      target: `.continue/mcpServers/${continueFileFor(name)}`,
      action: r.action,
      note: r.note,
    });
  }
  const legacy = migrateLegacyContinue(dir);
  if (legacy) {
    rows.push({
      tool: "Continue MCP",
      target: `.continue/mcpServers/${LEGACY_CONTINUE_FILE}`,
      action: legacy.action,
      note: legacy.note,
    });
  }
  return rows;
}

/**
 * Reverse one server's emission. JSON entries are deleted only when `removeJsonEntry`
 * says forge owns them (adopted, or byte-identical to forge's own spec); the Codex block
 * only when forge-marked; the Continue file only when forge-managed. Idempotent.
 * @param {{targetRoot:string, name:string,
 *   removeJsonEntry:(current:any)=>boolean}} opts
 */
export function removeMcp({ targetRoot, name, removeJsonEntry }) {
  const rows = [];
  for (const t of JSON_TARGETS) {
    const path = join(targetRoot, t.file);
    let r;
    let current;
    if (existsSync(path)) {
      try {
        current = JSON.parse(readFileSync(path, "utf8"))?.[t.key]?.[name];
      } catch {
        current = undefined;
      }
    }
    if (current !== undefined && !removeJsonEntry(current)) {
      r = {
        action: "skipped",
        note: `${name} left in place: user-owned entry`,
      };
    } else {
      r = removeFromJson(path, t.key, name);
    }
    rows.push({
      tool: `${t.tool} MCP`,
      target: t.file,
      action: r.action,
      note: r.note,
    });
  }
  const codex = removeCodexBlock(join(targetRoot, CODEX_FILE), name);
  rows.push({
    tool: "Codex MCP",
    target: ".codex/config.toml",
    action: codex.action,
    note: codex.note,
  });
  const contPath = join(targetRoot, CONTINUE_DIR, continueFileFor(name));
  const existing = readIfExists(contPath);
  let cont;
  if (existing === null) cont = { action: "unchanged", note: "absent" };
  else if (!isManaged(existing)) cont = { action: "skipped", note: "unmanaged file left in place" };
  else {
    rmSync(contPath, { force: true });
    cont = { action: "written", note: "per-server file removed" };
  }
  rows.push({
    tool: "Continue MCP",
    target: `.continue/mcpServers/${continueFileFor(name)}`,
    action: cont.action,
    note: cont.note,
  });
  return rows;
}

/** True when any JSON target or the Codex TOML already holds a same-name entry that
 *  differs from forge's spec — i.e. an entry forge did NOT just create and must not
 *  claim without --adopt. Drives add-time auto-ownership in integrations.js. */
export function hasForeignEntry(targetRoot, name, def) {
  for (const t of JSON_TARGETS) {
    const path = join(targetRoot, t.file);
    if (!existsSync(path)) continue;
    try {
      const cur = JSON.parse(readFileSync(path, "utf8"))?.[t.key]?.[name];
      if (cur !== undefined && JSON.stringify(cur) !== JSON.stringify(def)) return true;
    } catch {
      // invalid JSON: mergeJson will skip the file entirely — not a claimable entry
    }
  }
  const codexPath = join(targetRoot, CODEX_FILE);
  const text = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
  const unmarked = unmarkedRegion(text, name);
  if (unmarked) {
    const cur = text.slice(unmarked.start, unmarked.end);
    if (cur.trimEnd() !== legacyCodexBlock(name, def).trimEnd()) return true;
  }
  return false;
}

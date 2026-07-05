// Emit the canonical MCP server set (source/mcp.json) into each tool's MCP config,
// in that tool's REAL format (all verified 2026-07). Always MERGE — never clobber a
// user's own servers. JSON tools differ only by their top-level key; Codex is TOML and
// Continue is a YAML block file. (Windsurf is global-only — no per-repo file to emit.)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const JSON_TARGETS = [
  { tool: "Claude Code", file: ".mcp.json", key: "mcpServers" },
  { tool: "Cursor", file: ".cursor/mcp.json", key: "mcpServers" },
  { tool: "Gemini CLI", file: ".gemini/settings.json", key: "mcpServers" },
  { tool: "Roo Code", file: ".roo/mcp.json", key: "mcpServers" },
  { tool: "Zed", file: ".zed/settings.json", key: "context_servers" },
  { tool: "VS Code / Copilot", file: ".vscode/mcp.json", key: "servers" },
];

function mergeJson(path, key, servers) {
  let obj = {};
  if (existsSync(path)) {
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { action: "skipped", note: "invalid JSON — left as-is" };
    }
  }
  const bucket = obj[key] || (obj[key] = {});
  let added = 0;
  for (const [name, def] of Object.entries(servers)) {
    if (!bucket[name]) {
      bucket[name] = def;
      added += 1;
    }
  }
  if (!added) return { action: "unchanged", note: "present" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  return { action: "written", note: `+${added} server(s)` };
}

function emitCodexToml(path, servers) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let blocks = "";
  for (const [name, def] of Object.entries(servers)) {
    if (existing.includes(`[mcp_servers.${name}]`)) continue;
    const args = (def.args || []).map((a) => JSON.stringify(a)).join(", ");
    blocks += `\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(def.command)}\nargs = [${args}]\n`;
  }
  if (!blocks) return { action: "unchanged", note: "present" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, existing + blocks);
  return { action: "written", note: "TOML block appended" };
}

function emitContinueYaml(dir, servers) {
  const path = join(dir, "forge-mcp.yaml");
  const lines = [
    "name: Forge MCP",
    "version: 0.0.1",
    "schema: v1",
    "mcpServers:",
  ];
  for (const [name, def] of Object.entries(servers)) {
    lines.push(
      `  - name: ${name}`,
      "    type: stdio",
      `    command: ${def.command}`,
      "    args:",
    );
    for (const a of def.args || []) lines.push(`      - ${JSON.stringify(a)}`);
  }
  const content = lines.join("\n") + "\n";
  if (existsSync(path) && readFileSync(path, "utf8") === content)
    return { action: "unchanged", note: "present" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
  return { action: "written", note: "YAML block file" };
}

export function emitMcp({ targetRoot, servers }) {
  const rows = JSON_TARGETS.map((t) => {
    const r = mergeJson(join(targetRoot, t.file), t.key, servers);
    return {
      tool: `${t.tool} MCP`,
      target: t.file,
      action: r.action,
      note: r.note,
    };
  });
  const codex = emitCodexToml(
    join(targetRoot, ".codex", "config.toml"),
    servers,
  );
  rows.push({
    tool: "Codex MCP",
    target: ".codex/config.toml",
    action: codex.action,
    note: codex.note,
  });
  const cont = emitContinueYaml(
    join(targetRoot, ".continue", "mcpServers"),
    servers,
  );
  rows.push({
    tool: "Continue MCP",
    target: ".continue/mcpServers/forge-mcp.yaml",
    action: cont.action,
    note: cont.note,
  });
  return rows;
}

// forge cortex MCP — a minimal, zero-dependency MCP server (JSON-RPC 2.0 over stdio,
// newline-delimited) that exposes this repo's LEARNED LESSONS to any MCP-capable tool
// (Cursor, Codex, Gemini, Zed…). Claude gets lessons live via hooks; this is how the other
// tools query them on demand. Launched as `forge cortex-mcp`, so the path resolves anywhere.
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lessonsForContext, summary } from "./cortex.js";

const root = process.env.FORGE_ROOT || process.cwd();
const today = () => Math.floor(Date.now() / 86400000);

const TOOLS = [
  {
    name: "cortex_lessons",
    description:
      "Lessons Forge Cortex learned from past mistakes on THIS repo, for the given files/symbols. Background context — verify before acting, don't blindly obey.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "file paths in play",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "symbol names in play",
        },
      },
    },
  },
  {
    name: "cortex_status",
    description: "Summary of learned lessons on this repo (counts by state, top by confidence).",
    inputSchema: { type: "object", properties: {} },
  },
];

function callTool(name, args = {}) {
  if (name === "cortex_lessons") {
    const files = args.files ?? [];
    const symbols = args.symbols ?? [];
    const { block } = lessonsForContext(
      root,
      { files, symbols, keywords: [...files, ...symbols] },
      { nowDay: today() },
    );
    return block || "No lessons recorded for these files/symbols yet.";
  }
  if (name === "cortex_status") return JSON.stringify(summary(root, today()), null, 2);
  return null;
}

/** Handle one JSON-RPC message; returns a response object, or null for notifications. */
export function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || String(method).startsWith("notifications/")) return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "forge-cortex", version: "0.1.0" },
      },
    };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const text = callTool(params?.name, params?.arguments);
    if (text === null) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${params?.name}` },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }] },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method: ${method}` },
  };
}

export function serve(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore malformed frames
    }
    const res = handle(msg);
    if (res) output.write(`${JSON.stringify(res)}\n`);
  });
}

// Only start the server when run directly (`forge cortex-mcp` / `node src/cortex_mcp.js`),
// not when imported by tests.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) serve();

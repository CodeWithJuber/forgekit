// forge cortex MCP — a minimal, zero-dependency MCP server (JSON-RPC 2.0 over stdio,
// newline-delimited) that exposes this repo's LEARNED LESSONS to any MCP-capable tool
// (Cursor, Codex, Gemini, Zed…). Claude gets lessons live via hooks; this is how the other
// tools query them on demand. Launched as `forge cortex-mcp`, so the path resolves anywhere.
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lessonsForContext, summary } from "./cortex.js";
import { assessTask, clarifyBlock, preflightRepo } from "./preflight.js";
import { routeTask } from "./route.js";
import { decompose } from "./scope.js";
import { predictImpact, substrateCheck } from "./substrate.js";

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
  {
    name: "preflight_check",
    description:
      "BEFORE starting a task, check what it names that the repo doesn't define — the things you'd otherwise ASSUME. Returns a clarify list or an all-clear. Ask instead of assuming.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "the task/prompt" } },
      required: ["task"],
    },
  },
  {
    name: "route_task",
    description:
      "Recommend the cheapest CAPABLE model for a task by code-task complexity (files, fan-out, churn, past mistakes, ambiguity). Advisory — don't burn a top model on a trivial task.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
  },

  {
    name: "assumption_gate",
    description:
      "Score specification completeness before work starts. Returns shouldAsk, risk, missing dimensions, and concrete questions.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "the task/prompt" } },
      required: ["task"],
    },
  },
  {
    name: "predict_impact",
    description:
      "Predict blast radius for a symbol or file using Forge atlas reverse-dependency traversal.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "symbol name, qualified name, or file" },
        threshold: { type: "number", description: "confidence threshold, default 0.1" },
      },
      required: ["target"],
    },
  },
  {
    name: "substrate_check",
    description:
      "Full Forge cognitive-substrate pre-action check: assumption gate, route, impact, scope, memory, minimality, and verification checklist.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "the task/prompt" } },
      required: ["task"],
    },
  },
  {
    name: "scope_files",
    description:
      "Decompose files into INDEPENDENT clusters (run as separate sessions) vs coupled, and surface coupled files you didn't name (the 'forgot the related module' guard).",
    inputSchema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "string" } } },
      required: ["files"],
    },
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
  if (name === "preflight_check") {
    const r = preflightRepo(root, String(args.task ?? ""));
    return clarifyBlock(r) || "All clear — everything this task names is grounded in the codebase.";
  }
  if (name === "route_task") {
    const rec = routeTask(root, String(args.task ?? ""));
    return `Recommended: ${rec.model.name} (${rec.tier}). complexity ${rec.score.toFixed(2)}${rec.reasons.length ? ` — ${rec.reasons.join(", ")}` : ""}.`;
  }

  if (name === "assumption_gate")
    return JSON.stringify(assessTask(String(args.task ?? "")), null, 2);
  if (name === "predict_impact")
    return JSON.stringify(
      predictImpact(root, String(args.target ?? ""), { threshold: Number(args.threshold ?? 0.1) }),
      null,
      2,
    );
  if (name === "substrate_check")
    return JSON.stringify(substrateCheck(root, String(args.task ?? "")), null, 2);
  if (name === "scope_files") {
    const d = decompose(root, args.files ?? []);
    return JSON.stringify(d, null, 2);
  }
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

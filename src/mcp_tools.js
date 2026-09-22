// forge mcp tools — the MCP tool REGISTRY as pure data (name/description/schema).
// Handlers stay in cortex_mcp.js (dispatch by name); keeping the registry data-only
// lets docs_check.js reconcile documented tools against it without importing the
// server (which imports doctor.js — that import cycle cost every doctor run the
// whole tool tree's startup and was one require-order bug away from breaking).

export const TOOLS = [
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
        target: {
          type: "string",
          description: "symbol name, qualified name, or file",
        },
        threshold: {
          type: "number",
          description: "confidence threshold, default 0.1",
        },
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
  {
    name: "forge_cost",
    description:
      "Cost report — measured stage factors (gate, cache, route, context) from .forge/metrics.jsonl with multiplicative composition.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_dash_data",
    description:
      "Dashboard JSON payload — ledger stats, metrics, atlas info. Same data forge dash serves at /api/data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_dash_summary",
    description:
      "Lightweight dashboard health check — just counts (claims, tombstoned, contested, atlas built, metric events). Cheaper than forge_dash_data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_brain",
    description: "Project memory index — list all remembered facts stored in .forge/brain/.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_ledger_query",
    description:
      "Query the proof-carrying memory ledger with a natural language query. Returns ranked matching claims.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "what you are about to do or looking for",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "forge_diagnose",
    description:
      "Doom-loop check — record a failure and check if the same signature has recurred (3x = escalation). Prevents thrashing.",
    inputSchema: {
      type: "object",
      properties: {
        errorText: { type: "string", description: "the error message" },
        file: { type: "string", description: "file where the error occurred" },
        symbol: { type: "string", description: "symbol involved" },
        task: {
          type: "string",
          description:
            "the task this failure came out of (same text given to forge_route) — lets the escalation directive name the tier routing already flagged instead of 'one tier'",
        },
      },
      required: ["errorText"],
    },
  },
  {
    name: "forge_doctor",
    description:
      "Health check — verify installed tools, guards, MCP auth, config drift, and system state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_provider_status",
    description:
      "Provider detection — which API provider is active (auto-detected or configured), env vars set, and health checks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forge_remember",
    description:
      "Store a durable fact in this repo's portable memory (.forge/brain/). Use for non-obvious, lasting knowledge (env quirks, decisions, gotchas).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "short slug for the fact (used as filename)",
        },
        body: { type: "string", description: "the fact content (markdown)" },
      },
      required: ["name", "body"],
    },
  },
  {
    name: "forge_ledger_ratify",
    description:
      "Propose a ratification of a ledger claim as agent:mcp (never as the human) — mints a decision claim and does NOT change the claim's confidence. Only a human ratifies, with `forge ledger ratify <id>`.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "claim ID or an unambiguous prefix (≥2 chars; an ambiguous prefix is refused)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "collide_check",
    description:
      "Parallel-session conflict radar — which recent teammate/agent sessions touched the files (or their import neighbors) you are about to edit, from the team-merged Forge ledger. Advisory: coordinate before editing high-risk files.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "files in play (default: the working diff)",
        },
      },
    },
  },
  {
    name: "rank_code",
    description:
      "Which code is load-bearing and dangerous to touch — PageRank centrality over the Forge atlas graph joined with past-incident history from the evidence ledger, plus circular-dependency clusters and chokepoint files whose removal disconnects the import graph.",
    inputSchema: {
      type: "object",
      properties: {
        top: {
          type: "number",
          description: "how many files/symbols to return (default 15)",
        },
      },
    },
  },
  {
    name: "forge_ledger_retract",
    description:
      "Propose retracting one ledger claim, named by its full 64-char id, as agent:mcp — the claim stays live with unchanged confidence until a human runs `forge ledger retract <full id> --reason …`. Prefixes are refused; the pending proposal shows in ledger query/stats.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "the claim's full 64-character id (forge_ledger_query returns it)",
        },
        reason: {
          type: "string",
          description: "why the claim should be retracted",
        },
      },
      required: ["id", "reason"],
    },
  },
];

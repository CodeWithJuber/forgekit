// forge cortex MCP — a minimal, zero-dependency MCP server (JSON-RPC 2.0 over stdio,
// newline-delimited) that exposes this repo's LEARNED LESSONS to any MCP-capable tool
// (Cursor, Codex, Gemini, Zed…). Claude gets lessons live via hooks; this is how the other
// tools query them on demand. Launched as `forge cortex-mcp`, so the path resolves anywhere.
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lessonsForContext, summary } from "./cortex.js";
import { report as costReport } from "./cost_report.js";
import { dashData, dashSummary } from "./dash.js";
import { diagnose } from "./diagnose.js";
import { doctor } from "./doctor.js";
import { assessTask, clarifyBlock, preflightRepo } from "./preflight.js";
import { routeTask } from "./route.js";
import { decompose } from "./scope.js";
import { predictImpact, substrateCheck } from "./substrate.js";
import { epochDay } from "./util.js";

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const root = process.env.FORGE_ROOT || process.cwd();
const today = epochDay;

// The tool registry lives in mcp_tools.js as pure data — docs_check.js reconciles
// docs against it without importing this server. Re-exported for compatibility.
import { TOOLS } from "./mcp_tools.js";

export { TOOLS };

async function callTool(name, args = {}) {
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
      predictImpact(root, String(args.target ?? ""), {
        threshold: Number(args.threshold ?? 0.1),
      }),
      null,
      2,
    );
  if (name === "substrate_check")
    return JSON.stringify(substrateCheck(root, String(args.task ?? "")), null, 2);
  if (name === "scope_files") {
    const d = decompose(root, args.files ?? []);
    return JSON.stringify(d, null, 2);
  }
  if (name === "forge_cost") return JSON.stringify(costReport(root), null, 2);
  if (name === "forge_dash_data") return JSON.stringify(dashData(root), null, 2);
  if (name === "forge_dash_summary") return JSON.stringify(dashSummary(root), null, 2);
  if (name === "forge_brain") {
    try {
      const { brainStore, list, buildIndex } = await import("./brain.js");
      const store = brainStore(root);
      const idx = buildIndex(store);
      const items = list(store);
      return JSON.stringify({ items, indexed: idx.indexed, overflow: idx.overflow }, null, 2);
    } catch {
      return "No brain store found — run `forge remember` to start.";
    }
  }
  if (name === "forge_ledger_query") {
    try {
      const { loadClaims, repoLedger, retractionProposals } = await import("./ledger_store.js");
      const { retrieve, claimText } = await import("./ledger.js");
      const { claimSim, simLabel } = await import("./embed.js");
      const dir = repoLedger(root);
      const q = String(args.query ?? "");
      const claims = loadClaims(dir);
      const sim = claimSim(root, q, claims, claimText);
      const ranked = retrieve(q, claims, { nowDay: today(), budget: 8, sim });
      const pending = retractionProposals(claims);
      return JSON.stringify(
        {
          sim: simLabel(sim),
          results: ranked.map((r) => ({
            id: r.claim.id,
            kind: r.claim.kind,
            score: r.score,
            text: claimText(r.claim).slice(0, 200),
            // An agent proposed retracting this claim; it stays live until a human confirms.
            ...(pending.has(r.claim.id)
              ? { pendingRetraction: pending.get(r.claim.id).map((p) => p.reason) }
              : {}),
          })),
        },
        null,
        2,
      );
    } catch {
      return "No ledger claims found.";
    }
  }
  if (name === "forge_diagnose") {
    const r = diagnose(root, {
      errorText: String(args.errorText ?? ""),
      file: args.file,
      symbol: args.symbol,
      task: args.task,
    });
    return JSON.stringify(r, null, 2);
  }
  if (name === "forge_doctor") {
    const { results, failed } = doctor({ targetRoot: root });
    return JSON.stringify({ results, failed }, null, 2);
  }
  if (name === "forge_provider_status") {
    const { activeProvider, providerStatus, listDetectedProviders } = await import(
      "./providers.js"
    );
    const prov = activeProvider(root);
    const status = providerStatus(root);
    const detected = listDetectedProviders();
    return JSON.stringify(
      {
        active: {
          name: prov.name,
          type: prov.type,
          label: prov.label || prov.name,
          baseUrl: prov.baseUrl,
          autoDetected: Boolean(prov._autoDetected),
          source: prov._source || null,
        },
        checks: status.checks,
        availableProviders: detected,
        envScan: status.envScan,
      },
      null,
      2,
    );
  }
  if (name === "forge_remember") {
    const { brainStore, remember } = await import("./brain.js");
    const store = brainStore(root);
    // Report what the store actually did: it REFUSES secret-shaped content, and saying
    // "Remembered" over a refusal taught the caller a fact that was never stored.
    const r = remember(store, String(args.name ?? ""), String(args.body ?? ""));
    if (!r.ok) return `Not remembered — ${r.reason ?? "the store refused the write"}.`;
    return `Remembered "${args.name}" in ${store}.`;
  }
  if (name === "collide_check") {
    const { collideReport } = await import("./collide.js");
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    return JSON.stringify(collideReport(root, { files }), null, 2);
  }
  if (name === "rank_code") {
    const { rankReport } = await import("./rank.js");
    return JSON.stringify(rankReport(root, { top: Number(args.top ?? 15) || 15 }), null, 2);
  }
  // The two agent-callable ledger WRITES act as the agent, never as the human: both are
  // stamped `agent:mcp` (not gitAuthor()), neither changes any claim's confidence, and
  // neither is final — a human ratifies or retracts with `forge ledger ratify|retract`.
  if (name === "forge_ledger_ratify") {
    const { ratify, repoLedger, MCP_AUTHOR } = await import("./ledger_store.js");
    const r = ratify(repoLedger(root), String(args.id ?? ""), {
      author: MCP_AUTHOR,
      agent: "mcp",
      note: "agent-proposed via MCP — not a human ratification",
      t: today(),
    });
    if (!r.ok) return `No claim matching "${args.id}" (unknown or ambiguous prefix).`;
    return `Recorded an agent-proposed ratification of ${r.ratifies} as decision ${r.decisionId} (author ${MCP_AUTHOR}). This is not a human ratification and does not change the claim's confidence — a human ratifies with \`forge ledger ratify <id>\`.`;
  }
  if (name === "forge_ledger_retract") {
    const { proposeRetraction, repoLedger, FULL_ID_RE } = await import("./ledger_store.js");
    const id = String(args.id ?? "").trim();
    if (!FULL_ID_RE.test(id))
      return `Refused: forge_ledger_retract needs one full 64-character claim id (got "${id}") — prefixes are never accepted, so a retraction can't land on a claim nobody named. forge_ledger_query returns full ids.`;
    const r = proposeRetraction(repoLedger(root), id, {
      reason: String(args.reason ?? ""),
      t: today(),
    });
    if (!r.ok) return `No claim matching "${id}".`;
    return `Proposed retraction of claim ${id} (proposal ${r.proposalId}, author agent:mcp): ${args.reason}. The claim stays live until a human confirms with \`forge ledger retract ${id} --reason "…"\`.`;
  }
  return null;
}

/** Handle one JSON-RPC message; returns a response object, or null for notifications. */
export async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || String(method).startsWith("notifications/")) return null;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "forge-cortex", version: PKG_VERSION },
      },
    };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    let text;
    try {
      text = await callTool(params?.name, params?.arguments);
    } catch (err) {
      // A throwing handler (unwritable .forge, corrupt store, …) must still ANSWER — a
      // request with no reply leaves the MCP client waiting until its own timeout.
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `tool ${params?.name} failed: ${String(err?.message ?? err).slice(0, 300)}`,
        },
      };
    }
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
    handle(msg)
      .then((res) => {
        if (res) output.write(`${JSON.stringify(res)}\n`);
      })
      .catch((err) => {
        // Last line of defence: anything handle() itself throws still gets a reply for a
        // request (id present); notifications stay silent per JSON-RPC.
        if (msg?.id === undefined) return;
        output.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: String(err?.message ?? err).slice(0, 300) },
          })}\n`,
        );
      });
  });
}

// Only start the server when run directly (`forge cortex-mcp` / `node src/cortex_mcp.js`),
// not when imported by tests.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) serve();

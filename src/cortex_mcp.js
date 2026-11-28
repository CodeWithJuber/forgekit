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
import { EVIDENCE_TOOLS, evidenceTool } from "./evidence_tools.js";
import { mcpInstructions } from "./orient.js";
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

/** The tools this server lists: all of them, or only the harness pair in a supervised project. */
async function listedTools() {
  const { nativeHarnessPolicy } = await import("./harness_config.js");
  return nativeHarnessPolicy(root)
    ? TOOLS.filter((t) => t.name === "forge_harness_run" || t.name === "forge_harness_status")
    : TOOLS;
}

async function callTool(name, args = {}, host = undefined) {
  if (name === "forge_harness_run" || name === "forge_harness_status") {
    const { harnessMcp } = await import("./harness_mcp.js");
    return harnessMcp(root, name, args, host);
  }
  const { nativeHarnessPolicy } = await import("./harness_config.js");
  if (nativeHarnessPolicy(root))
    throw new Error("Supervised project: use forge_harness_run or forge_harness_status");
  if (EVIDENCE_TOOLS.some((tool) => tool.name === name)) return evidenceTool(root, name, args);
  if (name === "forge_memory_decide") {
    const { jevMemoryTool } = await import("./jev_memory_tools.js");
    return jevMemoryTool(root, name, args);
  }
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
    // routeTask names a tier; the concrete id is resolved here, as `forge route` does, so an
    // agent is told the model it would actually call rather than the shipped snapshot.
    // Best-effort: the resolver falls back to the snapshot when no catalog answers.
    let model = rec.model.name;
    try {
      const { describeResolution, resolveTierModel } = await import("./model_tiers.js");
      const { activeProvider } = await import("./providers.js");
      const resolved = resolveTierModel(rec.key, { root, provider: activeProvider(root) });
      if (resolved) model = `${resolved.id} (${describeResolution(resolved)})`;
    } catch {}
    return `Recommended: ${model} (${rec.tier}). complexity ${rec.score.toFixed(2)}${rec.reasons.length ? ` — ${rec.reasons.join(", ")}` : ""}.`;
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
      const { loadClaims, recordUse, repoLedger, retractionProposals } = await import(
        "./ledger_store.js"
      );
      const { retrieve, claimText } = await import("./ledger.js");
      const { claimSim, simLabel } = await import("./embed.js");
      const dir = repoLedger(root);
      const q = String(args.query ?? "");
      const claims = loadClaims(dir);
      const sim = claimSim(root, q, claims, claimText);
      const ranked = retrieve(q, claims, { nowDay: today(), budget: 8, sim });
      recordUse(
        dir,
        ranked.map((r) => r.claim.id),
        { via: "mcp.query", t: today() },
      );
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
    const { brainStore } = await import("./brain.js");
    const { rememberVerified } = await import("./jev_memory.js");
    const store = brainStore(root);
    // Report what the store actually did: it REFUSES secret-shaped content, and saying
    // "Remembered" over a refusal taught the caller a fact that was never stored. Jev's
    // semantic layer (opt-in) may also refuse a one-off or skip a duplicate — say so too.
    const r = rememberVerified(root, String(args.name ?? ""), String(args.body ?? ""), {
      force: args.force === true,
    });
    if (!r.ok)
      return r.refused
        ? `Not remembered — ${r.reason}. Call again with force: true to store it anyway.`
        : `Not remembered — ${r.reason ?? "the store refused the write"}.`;
    if (r.duplicate) return `Not stored again — ${r.reason}.`;
    const other = r.superseded ?? r.contradicts;
    const note = r.superseded
      ? ` Archived the contradicted fact "${other.name ?? other.id.slice(0, 8)}".`
      : r.contradicts
        ? ` It contradicts "${other.name ?? other.id.slice(0, 8)}", which was kept because ${r.kept}.`
        : "";
    return `Remembered "${args.name}" in ${store}.${note}`;
  }
  if (name === "collide_check") {
    const { collideReport } = await import("./collide.js");
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    return JSON.stringify(collideReport(root, { files }), null, 2);
  }
  if (name === "rank_code") {
    const { rankReport } = await import("./rank.js");
    return JSON.stringify(
      rankReport(root, { top: Number(args.top ?? 15) || 15, task: args.task }),
      null,
      2,
    );
  }
  if (name === "dep_check") {
    const { depgateDecision, parseVetArg, vetPackages } = await import("./depgate.js");
    if (typeof args.command === "string" && args.command.trim()) {
      // An explicit question always gets an answer, even with the guard switched off.
      const env = { ...process.env, FORGE_DEPGATE: "1" };
      const d = await depgateDecision({ command: args.command, cwd: root, env, cache: null });
      return JSON.stringify(d, null, 2);
    }
    const asked = Array.isArray(args.packages) ? args.packages.map(String) : [];
    const specs = asked.map(parseVetArg);
    const results = await vetPackages(specs.filter((s) => s !== null));
    const notPackages = asked.filter((_, i) => !specs[i]);
    return JSON.stringify({ results, notPackages }, null, 2);
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

// MCP revisions this server speaks. From 2026-07-28 the protocol is stateless: there is no
// `initialize` handshake and no session, and each request names its revision, client and
// capabilities in `_meta`. Earlier revisions open with the handshake. The specification's
// compatibility matrix gives "modern client, legacy server" as a failure, so a server that
// answered only the handshake would stop working for hosts that drop it. Both are served.
export const MODERN_VERSIONS = ["2026-07-28"];
// 2025-03-26 is absent on purpose: that revision obliges a server to accept JSON-RPC batches,
// which this line-per-message server does not. A client asking for it gets the fallback.
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
const LEGACY_FALLBACK = "2024-11-05";
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
// -32020..-32099 is the range the specification reserves for itself.
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// Cache hints every modern list and discovery result must carry. The listed tools follow
// this checkout's harness activation, which can change between two calls, and this server
// pushes no change notice: 0 ("stale at once") is the only freshness it can promise.
// "private" because the answer depends on the local user's checkout.
const NO_CACHE = { ttlMs: 0, cacheScope: "private" };

/** Host identity is a compatibility hint only. It grants no permissions. */
function hostOf(clientName) {
  const client = String(clientName ?? "").toLowerCase();
  return /^(kimi|codex|claude|gemini|cursor|copilot)(?:$|[- _])/i.exec(client)?.[1];
}

/** When to reach for which tool. Hosts that defer tool schemas show the model only the tool
 *  names and this text. Discovery never fails over it: unreadable harness state means no
 *  instructions here, and tools/list reports the problem. */
async function serverInstructions() {
  try {
    return mcpInstructions((await listedTools()).map((t) => t.name));
  } catch {
    return "";
  }
}

/** Handle one JSON-RPC message; returns a response object, or null for notifications. */
export async function handle(msg, session = { host: undefined }) {
  const { id, method, params } = msg;
  if (id === undefined || String(method).startsWith("notifications/")) return null;
  const meta =
    params && typeof params === "object" && !Array.isArray(params) && params._meta
      ? params._meta
      : undefined;
  const declared = meta && typeof meta === "object" ? meta[META_VERSION] : undefined;
  // A request is modern when it names its revision, or is the one method only a modern
  // client sends. Everything else keeps the handshake-era behaviour byte for byte.
  const modern = declared !== undefined || method === "server/discover";
  if (declared !== undefined && !MODERN_VERSIONS.includes(declared)) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: SUPPORTED_VERSIONS, requested: String(declared).slice(0, 64) },
      },
    };
  }
  // No session exists in the modern protocol, so the host hint is read off each request.
  const host = modern ? hostOf(meta?.[META_CLIENT]?.name) : session.host;
  const done = modern ? { resultType: "complete" } : {};

  if (method === "server/discover") {
    const instructions = await serverInstructions();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        ...done,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        _meta: { [META_SERVER]: { name: "forge-cortex", version: PKG_VERSION } },
        ...(instructions ? { instructions } : {}),
        ...NO_CACHE,
      },
    };
  }
  if (method === "initialize") {
    session.host = hostOf(params?.clientInfo?.name);
    const instructions = await serverInstructions();
    // The handshake rule: answer with the revision asked for when it is one this server
    // speaks, otherwise with one it does. The fallback is the oldest, which every client
    // that still performs a handshake accepts.
    const asked = params?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "forge-cortex", version: PKG_VERSION },
        ...(instructions ? { instructions } : {}),
      },
    };
  }
  // The handshake-era liveness check. 2026-07-28 removed it, so a modern request for it
  // falls through to "unknown method" like any other.
  if (method === "ping" && !modern) return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    // TOOLS is a fixed table, so the order is the same on every call. The specification
    // asks for that so a host's prompt cache survives a re-list.
    const tools = await listedTools();
    return {
      jsonrpc: "2.0",
      id,
      result: modern ? { ...done, tools, ...NO_CACHE } : { tools },
    };
  }
  if (method === "tools/call") {
    let text;
    try {
      text = await callTool(params?.name, params?.arguments, host);
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
      result: { ...done, content: [{ type: "text", text }] },
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
  const session = { host: undefined };
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore malformed frames
    }
    handle(msg, session)
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

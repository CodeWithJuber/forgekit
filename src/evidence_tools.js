// The agent may request narrower reads than the automatic hook packet. Never let
// tool arguments select an arbitrary disk path, upstream URL or credential variable.
const str = (description) => ({ type: "string", description });
const sourceId = str("Source ID in this user's configuration for the current working tree");
const tool = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

export const EVIDENCE_TOOLS = [
  tool(
    "forge_hikmah_recall",
    "Retrieve verified, public and uncontested lessons from the kernel explicitly bound to this workspace.",
    { query: str("Local recall query"), limit: { type: "integer", minimum: 1, maximum: 10 } },
    ["query"],
  ),
  tool(
    "forge_mirror_get",
    "Read a configured source's cached manifest, item metadata, or one cited chunk.",
    {
      sourceId,
      id: str("Optional item ID from the manifest"),
      chunk: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1 },
    },
    ["sourceId"],
  ),
  tool(
    "forge_mirror_sql",
    "Run a bounded read-only SQL SELECT on items and chunks in one authorized local source snapshot.",
    {
      sourceId,
      sql: str("One read-only SELECT on items/chunks or explicitly selected local tables"),
      tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: str("Alias for the table"),
            path: str("Relative path in this source"),
            sheet: str("Optional sheet"),
          },
          required: ["name", "path"],
          additionalProperties: false,
        },
      },
    },
    ["sourceId", "sql"],
  ),
  tool(
    "forge_develop",
    "Plan a change from existing code and live research through implementation, security review and verification. Returns observed evidence and planned steps.",
    {
      task: str("Development task or recent failure"),
      web: str("Optional separate public search terms"),
    },
    ["task"],
  ),
  {
    ...tool(
      "forge_tool_install",
      "Install a selected, reviewed MCP tool and record its exact version for this workspace. Run when the user requests installation.",
      {
        id: str("Approved catalog ID"),
        version: str("Optional exact stable version, otherwise resolve current release"),
      },
      ["id"],
    ),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  tool(
    "forge_team_plan",
    "Plan independent read-only specialist assignments for a complex task. Leaves paid execution to the host or explicit CLI.",
    {
      task: str("Task for the lead"),
      maxWorkers: { type: "integer", minimum: 1, maximum: 6 },
      decomposition: {
        type: "object",
        description:
          "Optional scoped team brief: mode, owner, merge and 2–3 streams with id, role, paths, estimatedMinutes and acceptance; or mode review.",
      },
    },
    ["task"],
  ),
  tool(
    "forge_tool_find",
    "Resolve current compatible tool candidates for this task from the reviewed local catalog.",
    { task: str("Task or capability needed") },
    ["task"],
  ),
  tool(
    "forge_evidence",
    "Find relevant code, private source excerpts and research leads for a coding task or failure.",
    {
      task: str("Task or error for local retrieval"),
      web: str(
        "Optional separate public search terms. Never include private prompt text, source identifiers or credentials.",
      ),
    },
    ["task"],
  ),
  tool(
    "forge_source_search",
    "Search authorized snapshots across configured projects, team folders, and document sources. Returns timestamped citations.",
    {
      query: str("Local search terms"),
      sourceId,
      budget: { type: "integer", minimum: 1, maximum: 8192 },
    },
    ["query"],
  ),
  tool(
    "forge_source_read",
    "Read one current Jira issue, Confluence page or GitLab issue/MR from a configured source's REST API.",
    {
      sourceId,
      recordId: str("Issue key, page ID or project-local GitLab IID"),
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 16000 },
    },
    ["sourceId", "recordId"],
  ),
  tool(
    "forge_source_route",
    "Choose a cache, provider MCP or REST route. A live provider MCP call is made by the host.",
    {
      sourceId,
      operation: { type: "string", enum: ["read", "search", "bulk", "write"] },
      fresh: { type: "boolean" },
      probe: {
        type: "boolean",
        description: "Discover the configured record-read tool on its MCP endpoint",
      },
      mcpAvailable: {
        type: "boolean",
        description:
          "True only if a connected provider tool can perform this operation on this instance",
      },
    },
    ["sourceId", "operation"],
  ),
  tool(
    "forge_table_aggregate",
    "Compute an aggregate from the complete local CSV/TSV/XLS/XLSX table and return groups and counts.",
    {
      sourceId,
      path: str("Relative file under the configured source root"),
      sheet: str("Worksheet"),
      column: str("Header of the numeric or counted field"),
      groupBy: str("Grouping column header"),
      operation: { type: "string", enum: ["sum", "avg", "count", "min", "max"] },
    },
    ["sourceId", "path", "operation"],
  ),
];

export async function evidenceTool(root, name, args) {
  if (name === "forge_hikmah_recall")
    return JSON.stringify(
      await (await import("./hikmah_recall.js")).recallHikmah(root, args.query, {
        limit: args.limit,
      }),
    );
  if (name === "forge_mirror_get" || name === "forge_mirror_sql") {
    const { mirrorGet, mirrorSql } = await import("./source_mirror.js");
    const { sourceId, ...options } = args;
    return JSON.stringify(
      name === "forge_mirror_get"
        ? await mirrorGet(root, sourceId, options)
        : await mirrorSql(root, sourceId, options.sql, { tables: options.tables }),
    );
  }
  if (name === "forge_develop") {
    const { runEvidence } = await import("./evidence.js");
    const report = await runEvidence(args.task, { root, web: args.web });
    return JSON.stringify({
      development: report.development,
      evidence: report.text,
      examples: report.web?.examples?.results ?? [],
    });
  }
  if (name === "forge_tool_install") {
    const { installAdoption } = await import("./tool_adoption.js");
    const { sourceWorkspaceRoot } = await import("./sources.js");
    return JSON.stringify(
      await installAdoption(sourceWorkspaceRoot(root), args.id, { version: args.version }),
    );
  }
  if (name === "forge_team_plan") {
    const { buildEvidence } = await import("./evidence.js");
    const { teamPlan } = await import("./evidence_team.js");
    return JSON.stringify(
      teamPlan(args.task, {
        root,
        maxWorkers: args.maxWorkers,
        decomposition: args.decomposition,
        evidence: buildEvidence(args.task, { root }),
      }),
    );
  }
  if (name === "forge_tool_find") {
    const { findAdoption } = await import("./tool_adoption.js");
    return JSON.stringify(await findAdoption(args.task, { root }));
  }
  if (name === "forge_evidence") {
    const { runEvidence } = await import("./evidence.js");
    return (await runEvidence(args.task, { root, web: args.web })).text;
  }
  const { searchSources, readSourceRecord, getSource } = await import("./sources.js");
  if (name === "forge_source_search") {
    if (typeof args.query !== "string" || !args.query.trim())
      throw new Error("Supply a search query");
    return JSON.stringify(
      searchSources(root, args.query, { sourceId: args.sourceId, budget: args.budget }),
    );
  }
  if (name === "forge_source_read")
    return JSON.stringify(
      await readSourceRecord(root, args.sourceId, args.recordId, {
        offset: args.offset,
        limit: args.limit,
      }),
    );
  if (name === "forge_source_route")
    return JSON.stringify(await sourceRoute(root, args.sourceId, args.operation, args));
  const source = getSource(root, args.sourceId);
  if (source.provider !== "local") throw new Error("Select a local source for a table aggregate");
  const { aggregateLocalTable } = await import("./source_local.js");
  const { path, sheet, column, groupBy, operation } = args;
  return JSON.stringify(
    await aggregateLocalTable(source, { path, sheet, column, groupBy, operation }),
  );
}

/** Resolve the source and actual cache state; the MCP client knows the connected provider tools. */
export async function sourceRoute(
  root,
  id,
  operation,
  { fresh = false, mcpAvailable = false, probe = false } = {},
) {
  const { getSource, sourcesStatus } = await import("./sources.js");
  const source = getSource(root, id);
  if (source.provider === "local")
    throw new Error("Use search, sync or aggregate for a local folder");
  if (
    typeof operation !== "string" ||
    typeof fresh !== "boolean" ||
    typeof mcpAvailable !== "boolean" ||
    typeof probe !== "boolean"
  )
    throw new Error("Invalid route arguments");
  const { routeSource } = await import("./source_remote.js");
  const cached = sourcesStatus(root).sources.find((entry) => entry.id === id)?.status === "ready";
  let capability = null;
  if (probe && operation === "read") {
    const { probeSourceMcp } = await import("./source_mcp.js");
    try {
      capability = await probeSourceMcp(source);
    } catch (err) {
      capability = { available: false, error: err.message };
    }
    mcpAvailable = capability.available;
  } else if (probe)
    throw new Error(
      "MCP probing checks the configured record-read tool; use route <id> read --probe",
    );
  const route = routeSource({ operation, cacheAvailable: cached, fresh, mcpAvailable });
  const next =
    route === "cache"
      ? "forge_source_search"
      : route === "mcp"
        ? `Use the connected ${source.provider} tool for this instance and scope.`
        : operation === "write"
          ? "Use the provider's authenticated client for the intended change."
          : operation === "read"
            ? "forge_source_read"
            : `forge sources sync ${id}`;
  return {
    id,
    provider: source.provider,
    operation,
    route,
    next,
    ...(capability ? { capability } : {}),
    scope: source.space ?? source.project,
  };
}

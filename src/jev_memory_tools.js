// forge jev memory — the MCP tool definition (data, imported by mcp_tools.js without the
// server) and the one dry-run entry point both the tool and `forge memory` read from.
// Domain modules load lazily, so importing this file costs nothing at registry time.

export const JEV_MEMORY_TOOLS = [
  {
    name: "forge_memory_decide",
    description:
      "Ask a Jev memory layer what it would decide, as a dry run with probabilities — working (which memory to admit for a task, with full vs admitted tokens), episodic (which prior session to replay), semantic (is a fact durable, duplicate or contradicting), procedural (which repeated verified work becomes a skill) or forgetting (what to archive). Nothing is stored or changed; with Jev off each layer reports its rubric.",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: ["working", "episodic", "semantic", "procedural", "forgetting"],
          description: "which memory layer to ask",
        },
        task: { type: "string", description: "the task (working, episodic)" },
        fact: { type: "string", description: "the fact to verify (semantic)" },
        name: { type: "string", description: "the name the fact would be stored under (semantic)" },
      },
      required: ["layer"],
      additionalProperties: false,
    },
  },
];

/**
 * One layer's decision as plain data — no store is changed (procedural with `apply`, and
 * the caller of a forgetting plan, are the only writers, and only `forge memory` passes
 * them).
 * @param {string} root
 * @param {string} layer
 * @param {{task?: string, fact?: string, name?: string, llm?: boolean, budget?: number,
 *   apply?: boolean}} [opts]
 */
export async function memoryDryRun(
  root,
  layer,
  { task = "", fact = "", name = "", llm, budget, apply = false } = {},
) {
  const { epochDay } = await import("./util.js");
  const nowDay = epochDay();
  if (layer === "working") {
    if (!task.trim()) return { layer, error: "working needs a task" };
    const { assemble } = await import("./context.js");
    const { load: loadAtlas } = await import("./atlas.js");
    const r = assemble(root, task, {
      atlas: loadAtlas(root),
      nowDay,
      llm,
      measure: true,
      ...(budget ? { budget } : {}),
    });
    return {
      layer,
      memory: r.memory,
      tokens: r.tokens,
      budget: r.budget,
      tokenEstimate: r.tokenEstimate,
      selection: r.selection,
    };
  }
  if (layer === "episodic") {
    if (!task.trim()) return { layer, error: "episodic needs a task" };
    const { DEJA_REL_FLOOR, dejaFromLedger } = await import("./deja.js");
    const { chooseReplay, memoryText } = await import("./jev_memory.js");
    const hits = dejaFromLedger(root, task, { nowDay, budget: 3 });
    return {
      layer,
      floor: DEJA_REL_FLOOR,
      hits: hits.map((h) => ({
        id: h.claim.id,
        rel: h.rel,
        score: h.score,
        text: memoryText(h.claim),
      })),
      rubric: { index: hits[0] && hits[0].rel >= DEJA_REL_FLOOR ? 0 : -1 },
      jev: chooseReplay(task, hits, { root, llm, floor: DEJA_REL_FLOOR }),
    };
  }
  if (layer === "semantic") {
    if (!fact.trim()) return { layer, error: "semantic needs a fact" };
    const { verifyFact } = await import("./jev_memory.js");
    return { layer, ...verifyFact(root, { name, text: fact }, { llm, nowDay }) };
  }
  if (layer === "procedural") {
    const { promoteSkills } = await import("./jev_skills.js");
    const { DEJA_REL_FLOOR } = await import("./deja.js");
    return { layer, ...promoteSkills(root, { llm, nowDay, apply, tau: DEJA_REL_FLOOR }) };
  }
  if (layer === "forgetting") {
    const { judgeForgetting } = await import("./jev_memory.js");
    const { retentionPlan } = await import("./ledger_retention.js");
    const { loadClaims, readUses, repoLedger } = await import("./ledger_store.js");
    const dir = repoLedger(root);
    const claims = loadClaims(dir);
    const uses = readUses(dir);
    const plan = retentionPlan(claims, uses, nowDay);
    const judged = judgeForgetting(claims, plan, uses, nowDay, { root, llm });
    return {
      layer,
      archive: judged.archive.map((a) => ({
        id: a.id,
        cause: a.cause,
        reason: a.reason,
        ...(a.survivor ? { survivor: a.survivor } : {}),
      })),
      rubricArchive: plan.archive.length,
      judged: judged.judged ?? null,
    };
  }
  return {
    layer,
    error: `unknown layer "${layer}" — working | episodic | semantic | procedural | forgetting`,
  };
}

/** MCP dispatch: null for a name this module does not own. */
export async function jevMemoryTool(root, name, args = {}) {
  if (name !== "forge_memory_decide") return null;
  return JSON.stringify(
    await memoryDryRun(root, String(args.layer ?? ""), {
      task: String(args.task ?? ""),
      fact: String(args.fact ?? ""),
      name: String(args.name ?? ""),
    }),
    null,
    2,
  );
}

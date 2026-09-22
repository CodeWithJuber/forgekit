// Shared stubs for the model-catalog tests: a scripted, synchronous transport in place of the
// real network (the suite is hermetic — no test may open a socket), plus catalog-shaped bodies.

/**
 * A scripted transport: the first route whose key is a substring of the URL answers; unmatched
 * URLs get `null` (a network failure). Every request is recorded, headers included.
 * @param {Record<string, any>} routes url-substring → response | (req) => response
 */
export function stubTransport(routes) {
  const calls = [];
  const fetchImpl = (req) => {
    calls.push(req);
    for (const [match, respond] of Object.entries(routes)) {
      if (req.url.includes(match)) return typeof respond === "function" ? respond(req) : respond;
    }
    return null;
  };
  return { fetchImpl, calls };
}

/** A 200 JSON response with the given response headers. */
export const ok = (body, headers = {}) => ({ status: 200, headers, body: JSON.stringify(body) });

/** An Anthropic Models API page: rows are [id, created_at, display_name?]. */
export function anthropicPage(rows, { hasMore = false } = {}) {
  return {
    data: rows.map(([id, created_at, display_name]) => ({
      type: "model",
      id,
      display_name: display_name ?? id,
      created_at,
    })),
    has_more: hasMore,
    first_id: rows[0]?.[0] ?? null,
    last_id: rows.at(-1)?.[0] ?? null,
  };
}

/** An OpenRouter /api/v1/models body: rows are [id, promptPerToken, completionPerToken, created?]. */
export function openRouterBody(rows) {
  return {
    data: rows.map(([id, prompt, completion, created]) => ({
      id,
      name: id,
      created: created ?? 1_700_000_000,
      pricing: { prompt, completion },
    })),
  };
}

// Tool-capable Chat Completions transport. Each dispatch reserves its prompt, output and
// maximum configured price. An ambiguous failure consumes that reservation before fallback.
import { createHash } from "node:crypto";
import { reserveHarnessSpend } from "./harness_spend.js";

export { harnessSpend } from "./harness_spend.js";

const ROUTE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const STRONG_STEPS = new Set(["security", "approval", "decide", "review"]);
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 32;

export function defaultHarnessRouting() {
  return {
    routes: [
      {
        id: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen2.5-coder:7b",
        steps: ["*"],
        strength: 1,
        inputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
        maxOutputTokens: 1024,
      },
    ],
  };
}

function positiveInt(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function validateRoute(route) {
  if (
    !route ||
    typeof route.id !== "string" ||
    !ROUTE_ID.test(route.id) ||
    typeof route.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(route.model)
  )
    throw new Error("Invalid route id or model");
  const url = new URL(route.baseUrl);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use a clean HTTPS model URL or a loopback HTTP URL");
  const steps = route.steps ?? ["*"];
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    steps.length > 50 ||
    steps.some((s) => typeof s !== "string" || (s !== "*" && !ROUTE_ID.test(s)))
  )
    throw new Error("Invalid route step list");
  const strength = route.strength ?? 1;
  const maxOutputTokens = route.maxOutputTokens ?? 1024;
  const timeoutMs = route.timeoutMs ?? 30000;
  const limitField = route.limitField ?? "max_tokens";
  if (
    !positiveInt(strength, 10) ||
    !positiveInt(maxOutputTokens, 1000000) ||
    !positiveInt(timeoutMs, 300000) ||
    !["max_tokens", "max_completion_tokens"].includes(limitField)
  )
    throw new Error("Invalid route limits");
  for (const key of ["inputUsdPerMillion", "outputUsdPerMillion"])
    if (!Number.isFinite(route[key]) || route[key] < 0 || route[key] > 1e6)
      throw new Error("Set both model price ceilings per million tokens");
  if (route.apiKeyEnv !== undefined && !/^[A-Z][A-Z_0-9]{0,95}$/.test(route.apiKeyEnv))
    throw new Error("Invalid API credential variable name");
  return {
    id: route.id,
    model: route.model,
    baseUrl: url.href.replace(/\/+$/, ""),
    apiKeyEnv: route.apiKeyEnv ?? null,
    steps: [...new Set(steps)].sort(),
    strength,
    maxOutputTokens,
    timeoutMs,
    limitField,
    inputUsdPerMillion: route.inputUsdPerMillion,
    outputUsdPerMillion: route.outputUsdPerMillion,
  };
}

function fingerprint(route) {
  return createHash("sha256").update(JSON.stringify(route)).digest("hex");
}

export function harnessRouteFingerprint(route) {
  return fingerprint(validateRoute(route));
}

function routeList(routing) {
  if (!Array.isArray(routing?.routes) || !routing.routes.length || routing.routes.length > 32)
    throw new Error("Configure between one and 32 model routes");
  const list = routing.routes.map(validateRoute);
  if (new Set(list.map((r) => r.id)).size !== list.length)
    throw new Error("Duplicate model route id");
  return list;
}

const DEFAULT = validateRoute(defaultHarnessRouting().routes[0]);

function requiresPin(route) {
  const isLocal = new URL(route.baseUrl).hostname;
  // Project-controlled URLs can deliver private context to a remote endpoint (including
  // local forwarding services), or attach arbitrary environment credentials.
  if (
    isLocal === "127.0.0.1" &&
    route.baseUrl === DEFAULT.baseUrl &&
    route.model === DEFAULT.model &&
    route.apiKeyEnv === null &&
    route.inputUsdPerMillion === 0 &&
    route.outputUsdPerMillion === 0
  )
    return false;
  return true;
}

export function describeHarnessRoutes(routing = defaultHarnessRouting()) {
  return routeList(routing).map((route) => ({
    ...route,
    fingerprint: fingerprint(route),
    requiresPin: requiresPin(route),
  }));
}

function wireTools(tools) {
  return tools.map((t) => {
    const name = t.name;
    if (!TOOL_NAME.test(name)) throw new Error("Invalid model tool name");
    return {
      type: "function",
      function: {
        name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    };
  });
}

function wireMessages(messages) {
  return messages.map((m) => {
    if (!["system", "user", "assistant", "tool"].includes(m.role))
      throw new Error("Invalid message role");
    if (m.role === "tool") {
      const id = m.toolCallId ?? m.tool_call_id;
      if (typeof id !== "string" || !id.length) throw new Error("Tool message needs a call id");
      return { role: "tool", tool_call_id: id, content: String(m.content) };
    }
    if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
    if (typeof m.content !== "string") throw new Error("Model messages require text content");
    return { role: m.role, content: m.content };
  });
}

function price(route, input, output) {
  return (input * route.inputUsdPerMillion + output * route.outputUsdPerMillion) / 1e6;
}

function limits(route, input, tokens, usd) {
  const inputCost = price(route, input, 0);
  if (tokens <= input || inputCost > usd) return null;
  let output = Math.min(tokens - input, route.maxOutputTokens);
  if (route.outputUsdPerMillion > 0)
    output = Math.min(output, Math.floor(((usd - inputCost) * 1e6) / route.outputUsdPerMillion));
  return output > 0
    ? { input, output, tokens: input + output, costUsd: price(route, input, output) }
    : null;
}

async function readJson(response) {
  if (Number(response.headers.get("content-length")) > MAX_REPLY_BYTES) {
    await response.body?.cancel();
    throw new Error("oversize_reply");
  }
  if (!response.body) throw new Error("empty_reply");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_REPLY_BYTES) throw new Error("oversize_reply");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function message(reply, step) {
  const choice = reply?.choices?.[0];
  if (!choice || ["length", "content_filter"].includes(choice.finish_reason))
    throw new Error("incomplete_reply");
  const m = choice.message;
  if (typeof m !== "object" || m === null) throw new Error("invalid_reply");
  const calls = m.tool_calls;
  if (calls !== undefined && (!Array.isArray(calls) || calls.length > MAX_CALLS))
    throw new Error("invalid_tool_calls");
  if (calls?.length) {
    const ids = new Set();
    return {
      toolCalls: calls.map((c) => {
        if (
          c?.type !== "function" ||
          !TOOL_NAME.test(c.function?.name ?? "") ||
          typeof c.id !== "string" ||
          !ROUTE_ID.test(c.id) ||
          ids.has(c.id) ||
          typeof c.function.arguments !== "string"
        )
          throw new Error("invalid_tool_call");
        ids.add(c.id);
        const args = JSON.parse(c.function.arguments);
        if (!args || Array.isArray(args) || typeof args !== "object")
          throw new Error("invalid_tool_arguments");
        return { id: c.id, name: c.function.name, args };
      }),
    };
  }
  const content = Array.isArray(m.content)
    ? m.content
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("")
    : m.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("empty_reply");
  if (step === "code" && content.trimStart().startsWith("{")) {
    let envelope;
    try {
      envelope = JSON.parse(content);
    } catch {
      /* An ordinary answer may contain code. */
    }
    if (
      envelope &&
      Object.hasOwn(envelope, "answer") &&
      Object.hasOwn(envelope, "memoryProposals")
    ) {
      const proposals = envelope.memoryProposals;
      if (
        typeof envelope.answer !== "string" ||
        !envelope.answer.trim() ||
        !Array.isArray(proposals) ||
        proposals.length > 12 ||
        proposals.some(
          (p) =>
            !p ||
            typeof p.text !== "string" ||
            !p.text.trim() ||
            p.text.length > 2000 ||
            !["L1", "L2", "L3"].includes(p.level) ||
            !["episodic", "semantic", "procedural"].includes(p.layer),
        )
      )
        throw new Error("invalid_memory_proposals");
      return {
        finalText: envelope.answer,
        proposals: proposals.map(({ text, level, layer }) => ({ text, level, layer })),
      };
    }
  }
  return { finalText: content };
}

function usageFor(report, route, reserved) {
  const input = report?.prompt_tokens,
    output = report?.completion_tokens;
  if (
    !Number.isSafeInteger(input) ||
    input <= 0 ||
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    !Number.isSafeInteger(input + output) ||
    (report.total_tokens !== undefined && report.total_tokens !== input + output)
  ) {
    return { tokens: reserved.tokens, costUsd: reserved.costUsd, estimated: true };
  }
  return {
    tokens: input + output,
    costUsd: price(route, input, output),
    estimated: false,
    exceeded: input > reserved.input || output > reserved.output,
  };
}

function failure(code, used, attempts) {
  return Object.assign(new Error(code), { code, usage: { ...used }, routeAttempts: attempts });
}

/** Construct the only model-calling adapter. Remote credentials are resolved only after a
 * route fingerprint matches the operator's private trust list. Chains keep operator order.
 * @param {any} [routing]
 * @param {{env?:NodeJS.ProcessEnv,fetchImpl?:typeof fetch,onRoute?:Function,trustedFingerprints?:string[],root?:string,ceilings?:{dailyUsd:number,projectUsd:number}}} [options]
 */
export function createHarnessModel(
  routing = defaultHarnessRouting(),
  { env = process.env, fetchImpl = fetch, onRoute, trustedFingerprints = [], root, ceilings } = {},
) {
  const routes = routeList(routing);
  const pins = new Set([
    ...trustedFingerprints,
    ...(env.FORGE_HARNESS_TRUSTED_ROUTES ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ]);
  const stats = new Map();
  for (const r of routes)
    stats.set(r.id, { calls: 0, failures: 0, latencyMs: 0, costUsd: 0, runs: 0, verified: 0 });
  const chain = routing.chains ?? {};
  for (const names of Object.values(chain)) {
    if (
      !Array.isArray(names) ||
      !names.length ||
      new Set(names).size !== names.length ||
      names.some((n) => !routes.some((r) => r.id === n))
    )
      throw new Error("Routing chain references an unknown or duplicate route");
  }
  const model = async ({
    messages,
    tools = [],
    maxTokens,
    maxCostUsd,
    signal,
    step = "code",
    authorRoute,
    pin,
    pinReason,
  }) => {
    if (
      !positiveInt(maxTokens, Number.MAX_SAFE_INTEGER) ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd < 0
    )
      throw new Error("A token and spend limit is required for each model call");
    const used = { tokens: 0, costUsd: 0 };
    const attempts = [];
    const schemas = wireTools(tools);
    const history = wireMessages(messages);
    // UTF-8 bytes upper-bound byte-level tokenisation; reserve additional per-message
    // chat template tokens. Custom providers must honour the configured pricing ceiling.
    const input =
      Buffer.byteLength(JSON.stringify({ messages: history, tools: schemas })) +
      128 +
      32 * (history.length + schemas.length);
    const declared = Object.hasOwn(chain, step) ? chain[step] : undefined;
    let eligible = declared
      ? declared.map((id) => routes.find((r) => r.id === id))
      : routes
          .filter((r) => r.steps.includes("*") || r.steps.includes(step))
          .sort((a, b) => price(a, input, 128) - price(b, input, 128));
    if (STRONG_STEPS.has(step) && eligible.length) {
      const highest = Math.max(...eligible.map((r) => r.strength));
      eligible = eligible.filter((r) => r.strength === highest);
    }
    if (step === "review" && authorRoute) {
      const author = routes.find((r) => r.id === authorRoute);
      if (!author) throw failure("unknown_author_route", used, attempts);
      eligible = eligible.filter((r) => r.model !== author.model);
    }
    if (pin) {
      if (!pinReason?.trim()) throw failure("model_pin_needs_reason", used, attempts);
      eligible = eligible.filter((r) => r.id === pin);
    }
    let reason = "no_eligible_route";
    let estimated = false;
    for (const route of eligible) {
      if (signal?.aborted) throw failure("model_cancelled", used, attempts);
      const budget = limits(route, input, maxTokens - used.tokens, maxCostUsd - used.costUsd);
      const authorized = !requiresPin(route) || pins.has(fingerprint(route));
      const key = authorized && route.apiKeyEnv && env[route.apiKeyEnv];
      if (!authorized || (route.apiKeyEnv && !key) || !budget) {
        reason = !authorized
          ? "route_not_trusted"
          : route.apiKeyEnv && !key
            ? "route_credential_missing"
            : "model_budget_exhausted";
        attempts.push({ route: route.id, status: reason, tokens: 0, costUsd: 0, latencyMs: 0 });
        continue;
      }
      let reservation;
      if (budget.costUsd > 0) {
        if (!root || !ceilings) {
          reason = "project_spend_ceiling";
          attempts.push({ route: route.id, status: reason, tokens: 0, costUsd: 0, latencyMs: 0 });
          continue;
        }
        try {
          reservation = reserveHarnessSpend(root, ceilings, budget.costUsd);
        } catch {
          throw failure("spend_ledger_unavailable", used, attempts);
        }
        if (reservation.reason) {
          reason = reservation.reason;
          attempts.push({ route: route.id, status: reason, tokens: 0, costUsd: 0, latencyMs: 0 });
          continue;
        }
      }
      const started = Date.now();
      const row = stats.get(route.id);
      row.calls++;
      const headers = {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      };
      const timer = AbortSignal.timeout(route.timeoutMs);
      const control = signal ? AbortSignal.any([signal, timer]) : timer;
      let charge = {
        tokens: budget.tokens,
        costUsd: budget.costUsd,
        estimated: true,
        exceeded: false,
      };
      let result;
      let status = "ok";
      try {
        const res = await fetchImpl(`${route.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          redirect: "error",
          signal: control,
          body: JSON.stringify({
            model: route.model,
            messages: history,
            ...(schemas.length ? { tools: schemas } : {}),
            [route.limitField]: budget.output,
          }),
        });
        if (!res.ok) {
          await res.body?.cancel();
          // Invalid input/auth and rate limiting are rejected before generation.
          if ([400, 401, 403, 404, 422, 429].includes(res.status))
            charge = { tokens: 0, costUsd: 0, estimated: false, exceeded: false };
          throw new Error(`http_${res.status}`);
        }
        const data = await readJson(res);
        charge = { ...charge, ...usageFor(data.usage, route, budget) };
        if (charge.exceeded) throw new Error("provider_usage_exceeded_reservation");
        result = message(data, step);
      } catch (err) {
        const safe =
          /^(http_\d{3}|invalid_\w+|empty_reply|oversize_reply|incomplete_reply|provider_usage_exceeded_reservation)$/;
        status = control.aborted
          ? "timeout_or_cancelled"
          : safe.test(err.message)
            ? err.message
            : "invalid_reply_or_transport";
        row.failures++;
      }
      used.tokens += charge.tokens;
      used.costUsd += charge.costUsd;
      estimated ||= charge.estimated;
      const latencyMs = Date.now() - started;
      row.latencyMs += latencyMs;
      row.costUsd += charge.costUsd;
      const attempt = {
        route: route.id,
        status,
        tokens: charge.tokens,
        costUsd: charge.costUsd,
        estimated: charge.estimated,
        latencyMs,
      };
      attempts.push(attempt);
      if (reservation) {
        try {
          reservation.settle(charge.costUsd, charge.estimated);
        } catch {
          throw failure("spend_settlement_unavailable", used, attempts);
        }
      }
      onRoute?.(attempt);
      if (charge.exceeded) throw failure(status, used, attempts);
      if (result)
        return {
          ...result,
          ...used,
          usageEstimated: estimated,
          route: route.id,
          routeAttempts: attempts,
          ...(pin ? { pin, pinReason } : {}),
        };
      reason = status;
    }
    throw failure(reason, used, attempts);
  };
  model.statistics = () => Object.fromEntries([...stats].map(([id, v]) => [id, { ...v }]));
  model.recordVerification = (ok, ids) => {
    for (const id of new Set(ids)) {
      const s = stats.get(id);
      if (s) {
        s.runs++;
        if (ok) s.verified++;
      }
    }
  };
  // Only a single content-addressed model provides a stable identity for earned trust.
  if (
    routes.length === 1 &&
    /@sha256:[a-f0-9]{64}$/.test(routes[0].model) &&
    (!requiresPin(routes[0]) || pins.has(fingerprint(routes[0])))
  )
    model.trustIdentity = fingerprint(routes[0]);
  return model;
}

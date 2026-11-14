// The executable callbacks registered here are trusted harness code. Third-party
// manifests use the bounded declarative interpreter in harness_extensions.js.
import { performance } from "node:perf_hooks";

export const HARNESS_HOOK_POINTS = Object.freeze([
  "chat.input",
  "agent.system_prompt",
  "agent.messages",
  "provider.before_call",
  "provider.after_call",
  "agent.tool.before",
  "agent.tool.after",
  "agent.response",
  "chat.output",
  "api.request",
  "api.response",
  "memory.before_store",
  "memory.after_query",
]);
export const CRITICAL_HOOKS = Object.freeze([
  "agent.tool.before",
  "provider.before_call",
  "memory.before_store",
]);
const isPattern = (p) =>
  typeof p === "string" && /^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.\*)?)$/.test(p);
const matches = (pattern, name) =>
  pattern === "*" ||
  pattern === name ||
  (pattern.endsWith(".*") && name.startsWith(pattern.slice(0, -1)));

function veto(point, source, reason) {
  return Object.assign(new Error(reason), { code: "HOOK_VETO", point, source });
}

/** Keep payload data in the caller's trace. The event bus stores disposable copies. */
export function createHarnessHooks({
  timeoutMs = 250,
  historyLimit = 128,
  onEvent = undefined,
} = {}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    !Number.isSafeInteger(historyLimit) ||
    historyLimit < 1 ||
    historyLimit > 2000
  )
    throw new Error("Invalid hook limits");
  const chains = new Map(),
    listeners = new Set(),
    history = [];

  function record(name, data) {
    const event = { name, at: new Date().toISOString(), data: structuredClone(data) };
    history.push(event);
    if (history.length > historyLimit) history.shift();
    onEvent?.(structuredClone(event));
    return event;
  }
  function emit(name, data = {}) {
    if (!isPattern(name) || name.includes("*")) throw new Error("Invalid event name");
    const event = record(name, data);
    for (const row of [...listeners]) {
      if (!matches(row.pattern, name) || row.queuedOnce) continue;
      if (row.once) row.queuedOnce = true;
      queueMicrotask(async () => {
        if (!listeners.has(row)) return;
        if (row.once) listeners.delete(row);
        try {
          await row.handle(structuredClone(event));
        } catch {
          record("listener.failed", { source: row.source, name });
        }
      });
    }
  }
  function subscribe(pattern, handle, { source = "core", once = false } = {}) {
    if (!isPattern(pattern) || typeof handle !== "function")
      throw new Error("Invalid event listener");
    const row = { pattern, handle, source, once, queuedOnce: false };
    listeners.add(row);
    return () => listeners.delete(row);
  }
  function on(
    point,
    handle,
    {
      source = "core",
      priority = source === "core" ? 900 : source === "policy" ? 700 : 100,
      trusted = false,
      onFailure = undefined,
    } = {},
  ) {
    if (!HARNESS_HOOK_POINTS.includes(point) || typeof handle !== "function")
      throw new Error("Invalid harness hook registration");
    if (
      !Number.isInteger(priority) ||
      priority < 0 ||
      (source === "core"
        ? priority < 900
        : source === "policy"
          ? priority < 700 || priority >= 900
          : priority >= 500)
    )
      throw new Error("Hook priority outside source range");
    if (source !== "core" && source !== "policy" && CRITICAL_HOOKS.includes(point) && !trusted)
      throw new Error(`Explicit trust required for ${point}`);
    const row = { source, priority, handle, onFailure };
    const chain = chains.get(point) ?? [];
    chain.push(row);
    chain.sort((a, b) => b.priority - a.priority);
    chains.set(point, chain);
    return () => {
      const idx = chain.indexOf(row);
      if (idx >= 0) chain.splice(idx, 1);
    };
  }
  function removeSource(source) {
    for (const chain of chains.values())
      for (let i = chain.length - 1; i >= 0; i--)
        if (chain[i].source === source) chain.splice(i, 1);
    for (const row of listeners) if (row.source === source) listeners.delete(row);
  }
  async function apply(point, payload) {
    if (!HARNESS_HOOK_POINTS.includes(point)) throw new Error(`Unknown hook point: ${point}`);
    const chain = chains.get(point) ?? [];
    for (const row of [...chain]) {
      if (!chain.includes(row)) continue;
      let timer;
      const controller = new AbortController(),
        started = performance.now();
      try {
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Hook timed out")), timeoutMs);
        });
        const current = structuredClone(payload);
        const next = await Promise.race([
          deadline,
          Promise.resolve().then(() => row.handle(current, controller.signal)),
        ]);
        if (performance.now() - started > timeoutMs) throw new Error("Hook timed out");
        if (next === null || (typeof next === "object" && typeof next.veto === "string")) {
          const reason = String(next?.veto ?? "Blocked by hook").slice(0, 240);
          emit("hook.veto", { point, source: row.source });
          throw veto(point, row.source, reason);
        }
        if (next === undefined) throw new Error("Hook returned no payload");
        payload = structuredClone(next);
      } catch (error) {
        if (error?.code === "HOOK_VETO") throw error;
        const details = {
          point,
          source: row.source,
          reason: error?.message === "Hook timed out" ? "timeout" : "handler error",
        };
        emit("hook.failed", details);
        row.onFailure?.(details);
        if (CRITICAL_HOOKS.includes(point))
          throw veto(point, row.source, `Hook ${details.reason} at ${point}`);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    return payload;
  }
  return {
    on,
    apply,
    emit,
    subscribe,
    removeSource,
    history: () => structuredClone(history),
    registrations: (source) => ({
      hooks: [...chains.values()].flat().filter((r) => r.source === source).length,
      listeners: [...listeners].filter((r) => r.source === source).length,
    }),
  };
}

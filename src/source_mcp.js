// Probe a trusted, manually configured enterprise MCP HTTP endpoint. Only these
// handshake/discovery operations are issued. Provider record IDs never enter the probe.
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_PAGES = 12;
const MAX_TOOLS = 1000;
const TOOL_NAME = /^[\w.-]{1,128}$/;

/** Validate a Streamable HTTP address before probing it or emitting a client config. */
export function validatedMcpUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\p{Cc}\p{Cf}$\\{}]/u.test(value))
    throw new Error("Invalid MCP endpoint");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid MCP endpoint");
  }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error("Set mcp.url to an HTTPS endpoint without credentials, query or fragment");
  return url.href;
}

function endpoint(config, env) {
  const url = validatedMcpUrl(config?.url);
  const tool = config.tool ?? null;
  if (tool !== null && (typeof tool !== "string" || !TOOL_NAME.test(tool)))
    throw new Error("Invalid configured MCP tool name");
  const headers = new Headers({ Accept: "application/json, text/event-stream" });
  if (config.tokenEnv !== undefined) {
    if (typeof config.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.tokenEnv))
      throw new Error("Set mcp.tokenEnv to an environment variable name");
    const token = Object.hasOwn(env, config.tokenEnv) ? env[config.tokenEnv] : null;
    if (typeof token !== "string" || !token || /[^!-~]/.test(token))
      throw new Error("Missing or invalid credential for mcp.tokenEnv");
    headers.set("Authorization", `Bearer ${token}`);
  }
  return { url, headers, tool };
}

function message(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid MCP JSON");
  }
}

function resultOf(packet, id) {
  if (packet?.jsonrpc !== "2.0" || packet.id !== id)
    throw new Error("MCP response ID or version mismatch");
  if (packet.error) throw new Error("MCP server returned a protocol error");
  if (!packet.result || typeof packet.result !== "object" || Array.isArray(packet.result))
    throw new Error("Invalid MCP response result");
  return packet.result;
}

function sseMessage(frame) {
  const data = [];
  let event = "message";
  for (const line of frame.split(/\r\n|[\r\n]/)) {
    const split = line.indexOf(":");
    const field = split < 0 ? line : line.slice(0, split);
    const value = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (event !== "message" || !data.length || !data.join("\n").trim()) return null;
  return message(data.join("\n"));
}

async function readResult(response, id) {
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing MCP response body");
  const decoder = new TextDecoder();
  let size = 0;
  let buffer = "";
  try {
    if (type !== "application/json" && type !== "text/event-stream")
      throw new Error("Unsupported MCP response media type");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new Error("MCP page exceeded size limit");
      buffer += decoder.decode(value, { stream: true });
      if (type === "text/event-stream") {
        // A server may keep its stream open after returning our reply. Exit as soon
        // as the matching response is complete. Notifications and keepalives are ignored.
        let delimiter = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        while (delimiter) {
          const packet = sseMessage(buffer.slice(0, delimiter.index));
          buffer = buffer.slice(delimiter.index + delimiter[0].length);
          if (packet?.id === id && !packet.method) return resultOf(packet, id);
          delimiter = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        }
      }
    }
    if (type === "application/json") return resultOf(message(buffer + decoder.decode()), id);
    throw new Error("MCP stream ended before the response");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Discover tools on the configured endpoint without invoking any tool. Availability
 * refers only to the exact configured name under the credential used for discovery.
 * @param {any} source Trusted source config from getSource()
 * @param {{env?:Record<string,string>,fetchImpl?:typeof fetch,timeoutMs?:number}} [options]
 */
export async function probeSourceMcp(source, options = {}) {
  if (!["jira", "confluence", "gitlab"].includes(source?.provider) || !source?.mcp?.url)
    throw new Error("Configure an enterprise source with mcp.url");
  return probeMcpEndpoint(source.mcp, options);
}

/** @param {any} config Explicitly configured HTTP endpoint and optional token name
 * @param {{env?:Record<string,string>,fetchImpl?:typeof fetch,timeoutMs?:number}} [options] */
export async function probeMcpEndpoint(
  config,
  { env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {},
) {
  const { url, headers, tool } = endpoint(config, env);
  const signal = AbortSignal.timeout(
    Number.isInteger(timeoutMs) ? Math.min(20000, Math.max(1, timeoutMs)) : 8000,
  );
  let nextId = 0;
  let stateful = false;
  async function send(method, params, notification = false) {
    const id = ++nextId;
    const payload = {
      jsonrpc: "2.0",
      method,
      ...(notification ? {} : { id }),
      ...(params ? { params } : {}),
    };
    const reqHeaders = new Headers(headers);
    reqHeaders.set("Content-Type", "application/json");
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify(payload),
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch {
      throw new Error(signal.aborted ? "MCP probe timed out" : "MCP connection failed");
    }
    if (!response.ok || (notification && response.status !== 202)) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      throw Object.assign(new Error(`MCP ${method} returned HTTP ${status}`), { status });
    }
    if (method === "initialize") {
      const session = response.headers.get("Mcp-Session-Id");
      if (session !== null) {
        if (!/^[!-~]{1,512}$/.test(session)) {
          await response.body?.cancel().catch(() => {});
          throw new Error("Invalid MCP session header");
        }
        headers.set("Mcp-Session-Id", session);
        stateful = true;
      }
    }
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    return readResult(response, id);
  }
  try {
    const init = await send("initialize", {
      protocolVersion: VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "forgekit-source-probe", version: "1" },
    });
    if (!VERSIONS.includes(init.protocolVersion))
      throw new Error("Unsupported negotiated MCP version");
    headers.set("MCP-Protocol-Version", init.protocolVersion);
    await send("notifications/initialized", null, true);
    const tools = new Set();
    if (init.capabilities?.tools) {
      const cursors = new Set();
      let cursor;
      do {
        if (cursors.size >= MAX_PAGES) throw new Error("MCP tool page limit exceeded");
        const page = await send("tools/list", cursor ? { cursor } : {});
        if (!Array.isArray(page.tools) || page.tools.length > MAX_TOOLS)
          throw new Error("Invalid or oversized MCP tool list");
        for (const entry of page.tools) {
          if (typeof entry?.name !== "string" || !TOOL_NAME.test(entry.name))
            throw new Error("Invalid advertised MCP tool name");
          tools.add(entry.name);
        }
        if (tools.size > MAX_TOOLS) throw new Error("MCP tool limit exceeded");
        cursor = page.nextCursor;
        if (
          cursor !== undefined &&
          (typeof cursor !== "string" || !cursor || cursor.length > 2048 || cursors.has(cursor))
        )
          throw new Error("Invalid or repeated MCP cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return {
      available: tool !== null && tools.has(tool),
      configuredTool: tool,
      tools: [...tools].sort(),
      protocolVersion: init.protocolVersion,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    if (signal.aborted) throw new Error("MCP probe timed out");
    throw e;
  } finally {
    if (stateful) {
      // DELETE is session termination, not a provider operation. A server may return
      // 405. Cleanup should never hide discovery failure or send a token to a redirect.
      try {
        const end = await fetchImpl(url, {
          method: "DELETE",
          headers,
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(800),
        });
        await end.body?.cancel();
      } catch {}
    }
  }
}

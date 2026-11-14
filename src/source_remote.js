// Read complete, bounded evidence snapshots from scoped provider APIs. Credentials come
// only from the caller's trusted personal configuration. Hook/search paths never fetch.
import { contentHash, stripTrailingSlashes } from "./util.js";

const PAGE_SIZE = 50;
const PAGE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_BYTES = 32 * 1024 * 1024;

function envValue(env, name, field) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Set ${field} to an environment variable name`);
  }
  if (!Object.hasOwn(env, name) || !env[name]) throw new Error(`Missing credential for ${field}`);
  return env[name];
}

function connection(source, env) {
  const { provider, deployment } = source;
  if (!["jira", "confluence", "gitlab"].includes(provider))
    throw new Error("Unknown remote provider");
  if (!["cloud", "self-hosted"].includes(deployment)) throw new Error("Unknown deployment");
  let url;
  try {
    url = new URL(source.baseUrl);
  } catch {
    throw new Error("Invalid source baseUrl");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Set baseUrl to the HTTPS site root, including any context path");
  }
  const base = stripTrailingSlashes(url.href);
  const value = provider === "confluence" ? source.space : source.project;
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(
      provider === "confluence"
        ? "Set the Confluence space key"
        : "Set the project key, path or ID",
    );
  }
  const scope = String(value).trim();
  if (
    provider === "gitlab" &&
    scope.split("/").some((part) => !part || part === "." || part === ".." || /[%\\?#]/.test(part))
  ) {
    throw new Error("Set a GitLab numeric project ID or namespace/project path");
  }
  const resource = provider === "gitlab" ? (source.resource ?? "issues") : "";
  if (provider === "gitlab" && !["issues", "merge_requests"].includes(resource))
    throw new Error("Unsupported GitLab resource");
  const token = envValue(env, source.tokenEnv, "tokenEnv");
  const basic = deployment === "cloud" && provider !== "gitlab";
  const email = basic ? envValue(env, source.emailEnv, "emailEnv") : "";
  const auth =
    provider === "gitlab"
      ? { "PRIVATE-TOKEN": token }
      : {
          Authorization: basic
            ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
            : `Bearer ${token}`,
        };
  return { provider, deployment, base, scope, resource, auth };
}

/** Opaque partition for private cached data. A credential change starts an empty partition. */
export function remoteScope(source, env = process.env) {
  return contentHash(JSON.stringify(connection(source, env)));
}

/** Pick a transport. Live writes are delegated to the signed-in host or its provider client. */
export function routeSource({
  operation = "read",
  fresh = false,
  cacheAvailable = false,
  mcpAvailable = false,
} = {}) {
  if (operation === "bulk") return "api";
  if (!["search", "read", "write"].includes(operation)) throw new Error("Unknown source operation");
  if (operation !== "write" && !fresh && cacheAvailable) return "cache";
  return mcpAvailable ? "mcp" : "api";
}

function initialPage({ provider, deployment, base, scope, resource }) {
  const literal = JSON.stringify(scope);
  if (provider === "jira") {
    const path = deployment === "cloud" ? "rest/api/3/search/jql" : "rest/api/2/search";
    const query = new URLSearchParams({
      jql: `project = ${literal} ORDER BY key ASC`,
      fields: "summary,description,status,updated",
      maxResults: String(PAGE_SIZE),
    });
    return new URL(`${base}/${path}?${query}`);
  }
  if (provider === "confluence") {
    const query = new URLSearchParams({
      cql: `type = page AND space = ${literal} ORDER BY title ASC`,
      expand: "body.storage,version",
      limit: String(PAGE_SIZE),
    });
    return new URL(`${base}/rest/api/content/search?${query}`);
  }
  const query = new URLSearchParams({
    scope: "all",
    state: "all",
    order_by: "created_at",
    sort: "asc",
    per_page: String(PAGE_SIZE),
    page: "1",
  });
  return new URL(`${base}/api/v4/projects/${encodeURIComponent(scope)}/${resource}?${query}`);
}

// Only copy the pagination parameter onto the known request URL. A provider-supplied
// absolute link, including one outside the instance, is never an authenticated destination.
function pagination(connection, body, headers, page, count) {
  const { provider, deployment } = connection;
  if (provider === "jira" && deployment === "cloud") {
    if (body.nextPageToken) return ["nextPageToken", String(body.nextPageToken)];
    if (body.isLast !== true) throw new Error("Jira search omitted its completion marker");
    return null;
  }
  if (provider === "jira") {
    const start = Number(page.searchParams.get("startAt") || 0);
    if (!Number.isSafeInteger(body.total) || body.total < 0 || (body.startAt ?? start) !== start)
      throw new Error("Invalid Jira pagination");
    if (start + count >= body.total) return null;
    if (!count) throw new Error("Incomplete Jira pagination");
    return ["startAt", String(start + count)];
  }
  if (provider === "confluence") {
    if (!body._links?.next) return null;
    const next = new URL(body._links.next, page);
    for (const key of ["cursor", "start"]) {
      const value = next.searchParams.get(key);
      if (value) return [key, value];
    }
    throw new Error("Unknown Confluence pagination");
  }
  const nextPage = headers.get("x-next-page");
  if (nextPage === "") return null;
  const link = headers.get("link") ?? "";
  const nextLink = link.match(/<([^>]+)>\s*;\s*rel="next"/i);
  const next = nextPage ?? (nextLink && new URL(nextLink[1], page).searchParams.get("page"));
  const current = Number(page.searchParams.get("page"));
  if (next) {
    if (!/^\d+$/.test(next) || Number(next) <= current)
      throw new Error("Invalid GitLab pagination");
    return ["page", next];
  }
  // Some proxies omit GitLab's pagination headers. A full page requires another read.
  return count >= PAGE_SIZE ? ["page", String(current + 1)] : null;
}

function adfText(node) {
  if (typeof node === "string") return node;
  if (!node) return "";
  if (node.type === "text") return String(node.text ?? "");
  if (node.type === "hardBreak") return "\n";
  return Array.isArray(node.content)
    ? node.content.map(adfText).join(node.type === "paragraph" ? "" : "\n")
    : "";
}

function storageText(html) {
  // Storage XHTML wraps code blocks in CDATA. Keep the code verbatim, even when it
  // contains literal tags; drop markup only in the surrounding storage document.
  return String(html ?? "")
    .split(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/<[^<>]*>/g, " ")
            .replace(
              /&(amp|lt|gt|quot|apos|nbsp);/g,
              (_match, entity) =>
                ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity],
            )
            .replace(/\s+/g, " "),
    )
    .join("")
    .trim();
}

function documentOf({ provider, base, scope, resource }, row) {
  if (typeof row?.id !== "string" && typeof row?.id !== "number")
    throw new Error("Provider returned a record without an ID");
  const id = String(row.id);
  if (provider === "jira") {
    if (!row.key || typeof row.fields?.summary !== "string")
      throw new Error("Incomplete Jira record");
    const fields = row.fields;
    return {
      id,
      recordId: String(row.key),
      title: `${row.key} ${fields.summary}`,
      text: [fields.status?.name, adfText(fields.description)].filter(Boolean).join("\n"),
      url: `${base}/browse/${encodeURIComponent(row.key)}`,
      updatedAt: fields.updated ?? null,
    };
  }
  if (typeof row.title !== "string") throw new Error("Incomplete provider record");
  if (provider === "confluence") {
    if (typeof row.body?.storage?.value !== "string")
      throw new Error("Confluence did not return the expanded page body");
    return {
      id,
      recordId: id,
      title: row.title,
      text: storageText(row.body.storage.value),
      url: `${base}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`,
      updatedAt: row.version?.when ?? null,
    };
  }
  if (row.iid == null) throw new Error("GitLab did not return a project-local ID");
  // Prefer the canonical URL for numeric project IDs; never put returned credentials or
  // an external host in an evidence citation.
  let url;
  try {
    url = new URL(row.web_url);
  } catch {}
  if (
    !url ||
    url.origin !== new URL(base).origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    if (/^\d+$/.test(scope)) throw new Error("Missing canonical GitLab web URL");
    url = new URL(
      `${base}/${scope.split("/").map(encodeURIComponent).join("/")}/-/${resource}/${encodeURIComponent(row.iid)}`,
    );
  }
  return {
    id,
    recordId: String(row.iid),
    title: `${resource === "issues" ? "#" : "!"}${row.iid} ${row.title}`,
    text: [row.state, row.description].filter(Boolean).join("\n"),
    url: url.href,
    updatedAt: row.updated_at ?? null,
  };
}

async function pageJson(response) {
  if (!response.ok) {
    const retry = response.status === 429 && Number(response.headers.get("retry-after"));
    const error = new Error(
      `Source returned HTTP ${response.status}${retry > 0 ? ` (retry in ${retry}s)` : ""}`,
    );
    await response.body?.cancel().catch(() => {});
    throw Object.assign(error, { status: response.status });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > PAGE_BYTES) throw new Error("Source page exceeds the size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Source returned invalid JSON");
  }
}

async function requestJson(url, conn, fetchImpl) {
  const response = await fetchImpl(url.href, {
    headers: { Accept: "application/json", ...conn.auth },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  return { body: await pageJson(response), headers: response.headers };
}

/** Read a single live record with the configured project's credentials. Jira accepts a
 *  key or ID, Confluence a page ID, GitLab a project-local issue or MR IID.
 * @param {any} source @param {string|number} recordId
 * @param {{env?:Record<string,string>, fetchImpl?:typeof fetch}} [options]
 */
export async function fetchRemoteRecord(
  source,
  recordId,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const conn = connection(source, env);
  const id = String(recordId);
  const valid = conn.provider === "jira" ? /^(?:[A-Z][A-Z0-9_]*-)?[0-9]+$/i : /^[0-9]+$/;
  if (id.length > 128 || !valid.test(id)) throw new Error("Invalid record ID for this source");
  const missing = () =>
    Object.assign(new Error("Record unavailable in configured source"), { status: 404 });
  const url = initialPage(conn);
  let row;
  if (conn.provider === "confluence") {
    // Page IDs are tenant-wide. Combine the ID with the configured space in the
    // supported CQL endpoint so another space's page body never crosses the wire.
    url.searchParams.set(
      "cql",
      `type = page AND space = ${JSON.stringify(conn.scope)} AND id = ${id}`,
    );
    url.searchParams.set("limit", "1");
    url.searchParams.set("expand", "space,version,body.storage");
    const { body } = await requestJson(url, conn, fetchImpl);
    row = body?.results?.[0];
    if (String(row?.id) !== id || row?.space?.key !== conn.scope) throw missing();
  } else if (conn.provider === "jira") {
    const version = conn.deployment === "cloud" ? "3" : "2";
    const target = new URL(`${conn.base}/rest/api/${version}/issue/${encodeURIComponent(id)}`);
    target.searchParams.set("fields", "project,summary,description,status,updated");
    row = (await requestJson(target, conn, fetchImpl)).body;
    const project = row?.fields?.project;
    if (
      String(project?.id) !== conn.scope &&
      project?.key?.toUpperCase() !== conn.scope.toUpperCase() &&
      project?.name !== conn.scope
    )
      throw missing();
  } else {
    url.pathname += `/${id}`;
    url.search = "";
    row = (await requestJson(url, conn, fetchImpl)).body;
    if (String(row?.iid) !== id) throw missing();
    if (/^\d+$/.test(conn.scope) && String(row?.project_id) !== conn.scope) throw missing();
  }
  return { ...documentOf(conn, row), fetchedAt: new Date().toISOString() };
}

/**
 * Get a full per-credential snapshot in provider pages. A failed or truncated traversal
 * never returns partial documents. checkpoint is the local observation time, not a remote
 * transaction ID. A full replacement reconciles permission changes and deletions.
 * @param {any} source trusted, user-owned provider config
 * @param {{env?:Record<string,string>, fetchImpl?:typeof fetch, maxPages?:number}} [options]
 */
export async function fetchRemoteSource(
  source,
  { env = process.env, fetchImpl = fetch, maxPages = 100 } = {},
) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Invalid page limit");
  const conn = connection(source, env);
  const page = initialPage(conn);
  const checkpoint = new Date().toISOString();
  const documents = new Map();
  const visited = new Set();
  let size = 0;
  while (true) {
    if (visited.has(page.href)) throw new Error("Source repeated a page");
    if (visited.size >= maxPages)
      throw new Error("Source page limit reached; narrow the configured project or space");
    visited.add(page.href);
    const { body, headers } = await requestJson(page, conn, fetchImpl);
    const rows =
      conn.provider === "jira"
        ? body?.issues
        : conn.provider === "confluence"
          ? body?.results
          : body;
    if (!Array.isArray(rows)) throw new Error("Invalid provider result collection");
    for (const row of rows) {
      const doc = documentOf(conn, row);
      size += Buffer.byteLength(JSON.stringify(doc));
      if (size > SNAPSHOT_BYTES) throw new Error("Source snapshot exceeds the size limit");
      documents.set(doc.id, doc);
    }
    const next = pagination(conn, body, headers, page, rows.length);
    if (!next) return { documents: [...documents.values()], mode: "full", checkpoint };
    page.searchParams.set(next[0], next[1]);
  }
}

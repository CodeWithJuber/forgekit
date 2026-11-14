// Live requests take only the closed-vocabulary terms produced by the hook or a separate
// user-supplied public query. The transport attaches no cookies or credentials.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasSecret } from "./secrets.js";
import { userStateDir } from "./util.js";

const POINTERS = [
  [
    /\b(jira|confluence|atlassian)\b/i,
    "Atlassian MCP",
    "Look up the cloud connector and its permissions.",
    "https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/",
  ],
  [
    /\b(jira|confluence|atlassian)\b/i,
    "mcp-atlassian",
    "Check community support for the installed Server or Data Center version.",
    "https://github.com/sooperset/mcp-atlassian",
  ],
  [
    /\bgitlab\b/i,
    "GitLab MCP server",
    "Check tool availability and prerequisites for this GitLab instance.",
    "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  ],
  [
    /\b(pdf|ocr|spreadsheet|xlsx?|csv|docx|parsing documents?)\b/i,
    "Docling",
    "Evaluate an existing document parser against a representative file.",
    "https://github.com/docling-project/docling",
  ],
  [
    /\b(rust|cargo|crates?)\b/i,
    "crates.io",
    "Compare published Rust crates and inspect release history.",
    "https://crates.io/",
  ],
  [
    /\b(golang|go modules?|go sdk)\b|\bGo\b/,
    "Go Packages",
    "Check Go module documentation and published versions.",
    "https://pkg.go.dev/",
  ],
  [
    /\b(mcp|plugins?|skills?)\b/i,
    "MCP Registry",
    "Find a published server and verify its upstream repository.",
    "https://modelcontextprotocol.io/registry/about",
  ],
  [
    /\b(refactor|symbols?|references|repos?|codebase|rename)\b/i,
    "Serena",
    "Look up symbols and references using language servers.",
    "https://github.com/oraios/serena",
  ],
  [
    /\b(debug|errors?|fail(?:s|ed|ures?)?|bugs?|root cause)\b/i,
    "Superpowers",
    "Inspect the systematic debugging skill and reproduce the failure.",
    "https://github.com/obra/superpowers",
  ],
  [
    /\b(dependenc(?:y|ies)|librar(?:y|ies)|framework|sdk|version|docs?|api|upgrade)\b/i,
    "Context7",
    "Find documentation and examples for the installed version.",
    "https://github.com/upstash/context7",
  ],
  [
    /\b(reuse|examples?|implement|github|patterns?|code search)\b/i,
    "Grep",
    "Search public code patterns and check the original source and license.",
    "https://vercel.com/blog/grep-a-million-github-repositories-via-mcp",
  ],
];

/** A short, offline reading list. None of these services receives the task. */
export function researchPointers(task) {
  const text = String(task ?? "").slice(0, 10000);
  return POINTERS.filter(([pattern]) => /** @type {RegExp} */ (pattern).test(text))
    .slice(0, 4)
    .map(([, name, purpose, url]) => ({
      name: String(name),
      purpose: String(purpose),
      url: String(url),
    }));
}

const MAX_BYTES = 512 * 1024;
const clean = (v, limit = 160) =>
  typeof v === "string"
    ? v
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .trim()
        .slice(0, limit)
    : "";
const date = (v) => {
  if (!v) return null;
  const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).valueOf())
    ? new Date(ms).toISOString()
    : null;
};

// A long-lived MCP server and independently spawned hooks share service-requested
// cooldowns. The marker stores only the deadline, independent of project and query.
function pendingCooldown(file) {
  try {
    const delta = Number(readFileSync(file, "utf8")) - Date.now();
    return Number.isFinite(delta) ? Math.max(0, Math.ceil(delta / 1000)) : 0;
  } catch {
    return 0;
  }
}

function storeCooldown(folder, file, seconds) {
  if (!Number.isFinite(seconds) || seconds <= pendingCooldown(file)) return;
  const temp = `${file}.${randomUUID()}`;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(temp, String(Date.now() + 1000 * seconds), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // The response still carries its retry guidance on read-only machines.
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

// Count streamed bytes even when Transfer-Encoding is chunked or a compressed body expands.
async function readPage(fetchImpl, url, signal, onCooldown) {
  const rsp = await fetchImpl(url, {
    signal,
    redirect: "error",
    credentials: "omit",
    headers: { Accept: "application/json", "User-Agent": "forgekit-research" },
  });
  if (!rsp.ok) {
    await rsp.body?.cancel();
    const retry = clean(rsp.headers.get("retry-after"), 40);
    if (retry) {
      const seconds = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
      onCooldown(seconds);
    }
    throw new Error(`HTTP ${rsp.status}${retry ? ` (retry-after ${retry})` : ""}`);
  }
  const reader = rsp.body?.getReader();
  if (!reader) throw new Error("empty response");
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new Error("response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const providers = [
  {
    name: "GitHub",
    endpoint: "https://api.github.com/search/repositories",
    params: (query, n) => ({ q: `${query} archived:false is:public`, per_page: n }),
    rows: (page) => page.items,
    parse: (item) => {
      const name = clean(item.full_name);
      if (
        !/^[\w.-]+\/[\w.-]+$/.test(name) ||
        name.split("/").some((part) => /^\.{1,2}$/.test(part)) ||
        item.archived ||
        item.private
      )
        return null;
      const url = `https://github.com/${name}`;
      return {
        title: name,
        url,
        summary: clean(item.description, 240),
        updatedAt: date(item.pushed_at),
        license: clean(item.license?.spdx_id) || null,
        version: null,
        releasesUrl: `${url}/releases`,
        stars: Number.isFinite(item.stargazers_count) ? item.stargazers_count : null,
      };
    },
  },
  {
    name: "Stack Overflow",
    endpoint: "https://api.stackexchange.com/2.3/search/advanced",
    params: (query, n) => ({
      q: query,
      site: "stackoverflow",
      accepted: "True",
      sort: "relevance",
      pagesize: n,
    }),
    rows: (page) => page.items,
    parse: (item) => {
      if (!Number.isSafeInteger(item.question_id) || item.question_id <= 0) return null;
      const answer = item.accepted_answer_id;
      return {
        title: clean(item.title),
        url: `https://stackoverflow.com/questions/${item.question_id}`,
        updatedAt: date(item.last_activity_date),
        license: clean(item.content_license) || null,
        version: null,
        acceptedAnswerUrl:
          Number.isSafeInteger(answer) && answer > 0
            ? `https://stackoverflow.com/a/${answer}`
            : null,
      };
    },
  },
  {
    name: "npm",
    endpoint: "https://registry.npmjs.org/-/v1/search",
    params: (query, n) => ({ text: query, size: n }),
    rows: (page) => page.objects,
    parse: (item) => {
      const pkg = item.package;
      const name = clean(pkg?.name, 214);
      if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name)) return null;
      return {
        title: name,
        url: `https://www.npmjs.com/package/${name}`,
        summary: clean(pkg.description, 240),
        updatedAt: date(pkg.date),
        license: clean(pkg.license) || null,
        version: clean(pkg.version, 80) || null,
      };
    },
  },
];

/** Public metadata and source links, never executable snippets. Missing metadata stays null.
 * @param {string} query Approved public terms or a short query independently authored for publication.
 * @param {{fetchImpl?:typeof fetch, limit?:number, timeoutMs?:number}} [options]
 */
export async function researchPublic(
  query,
  { fetchImpl = fetch, limit = 3, timeoutMs = 10000 } = {},
) {
  const checkedAt = new Date().toISOString();
  const empty = (warning) => ({ checkedAt, results: [], warnings: [warning] });
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(query)
  )
    return empty("Supply a single-line public query of 1 to 200 characters.");
  if (hasSecret(query))
    return empty("The public query contains credential-like text; no request was made.");
  if (process.env.FORGE_NO_CATALOG_FETCH === "1" && fetchImpl === fetch)
    return empty("Public research is offline (FORGE_NO_CATALOG_FETCH=1).");
  const n = Math.min(5, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 3));
  const signal = AbortSignal.timeout(
    Math.min(10000, Math.max(1, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 10000)),
  );
  const responses = await Promise.allSettled(
    providers.map(async (provider) => {
      const folder = join(userStateDir(), "public-research");
      const url = new URL(provider.endpoint);
      const cooldownFile = join(folder, `${url.hostname}.backoff`);
      const wait = pendingCooldown(cooldownFile);
      if (wait) return { results: [], warnings: [`${provider.name}: retry after ${wait} seconds`] };
      const onCooldown = (seconds) => storeCooldown(folder, cooldownFile, seconds);
      for (const [k, v] of Object.entries(provider.params(query.trim(), n)))
        url.searchParams.set(k, String(v));
      const page = await readPage(fetchImpl, url, signal, onCooldown);
      const rows = provider.rows(page);
      if (!Array.isArray(rows)) throw new Error("unexpected response shape");
      const results = rows
        .slice(0, n)
        .filter(Boolean)
        .map((item) => provider.parse(item))
        .filter(Boolean)
        .map((row) => ({ provider: provider.name, ...row }));
      const warnings = [];
      if (page.incomplete_results === true)
        warnings.push(`${provider.name}: partial search results`);
      if (Number.isSafeInteger(page.backoff) && page.backoff > 0) {
        onCooldown(page.backoff);
        warnings.push(`${provider.name}: wait ${page.backoff} seconds before searching again`);
      }
      return { results, warnings };
    }),
  );
  const results = [];
  const warnings = [];
  for (const [idx, response] of responses.entries()) {
    if (response.status === "fulfilled") {
      results.push(...response.value.results);
      warnings.push(...response.value.warnings);
    } else {
      // Do not echo URLs, request/query strings, arbitrary remote JSON or response bodies.
      const reason = String(response.reason?.message ?? "");
      const detail =
        /^(HTTP \d{3}(?: \(retry-after [\w ,:-]+\))?|response exceeded size limit|empty response|unexpected response shape)$/.test(
          reason,
        )
          ? reason
          : signal.aborted
            ? "timed out"
            : "request or JSON response failed";
      warnings.push(`${providers[idx].name}: ${detail}`);
    }
  }
  return { checkedAt, results, warnings };
}

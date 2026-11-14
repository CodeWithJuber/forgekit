// Fetch short, attributable samples from candidates already found for *public* terms.
// Every URL is constructed from a validated provider identifier. Examples are data.
import { researchPublic } from "./public_research.js";
import { hasSecret } from "./secrets.js";

const MAX_BYTES = 300 * 1024;
const STOP = new Set(
  "a an how to for the and of in or on use with best code examples example library libraries implement community github search".split(
    " ",
  ),
);
const tokens = (s) =>
  [...new Set(s.toLowerCase().match(/[\p{L}\p{N}+#._-]+/gu) ?? [])].filter((t) => !STOP.has(t));
const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/gi, (all, v) => {
    const chars = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (v[0] !== "#") return chars[v.toLowerCase()];
    const n = v[1]?.toLowerCase() === "x" ? Number.parseInt(v.slice(2), 16) : Number(v.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });

// Cap decompressed bytes even when the server omits or understates Content-Length.
async function json(get, url, signal) {
  let response;
  try {
    response = await get(url, {
      signal,
      credentials: "omit",
      redirect: "error",
      headers: { Accept: "application/json", "User-Agent": "forgekit-code-examples" },
    });
  } catch {
    throw new Error(signal.aborted ? "deadline reached" : "request failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("response exceeded size limit");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function bestExcerpt(blocks, query, identity) {
  const terms = tokens(query);
  let best;
  for (const block of blocks) {
    const lines = block.code.split("\n");
    if (!lines.some((x) => x.trim()) || lines.length > 1500) continue;
    const lower = block.code.toLowerCase(),
      nearby = block.context.toLowerCase();
    const score = terms.reduce(
      (n, t) => n + (lower.includes(t) ? 4 : 0) + (nearby.includes(t) ? 2 : 0),
      0,
    );
    // Prefer usage over installer/CLI snippets. A search hit supplies relevance only
    // when its repo/title actually matches a public query term.
    if (!score && !terms.some((t) => identity.toLowerCase().includes(t))) continue;
    const cli = /^\s*(?:\$\s*)?(?:pip|npm|yarn|pnpm|cargo|go get|git clone|curl|brew)\b/i.test(
      block.code,
    );
    const priority = score + (cli ? -3 : 1);
    if (best && best.priority >= priority) continue;
    const first = lines.findIndex((line) => terms.some((t) => line.toLowerCase().includes(t)));
    const start = Math.max(0, first - 1);
    // Short verbatim contiguous excerpt. Avoid partial statements cut mid-line.
    const output = [];
    for (const line of lines.slice(start, start + 8)) {
      if (output.join("\n").length + line.length + 1 > 640) break;
      output.push(line);
    }
    const snippet = output.join("\n");
    if (
      !snippet.trim() ||
      /[\p{Cf}\p{Cc}]/u.test(snippet.replace(/[\t\n]/g, "")) ||
      hasSecret(snippet)
    )
      continue;
    best = {
      priority,
      snippet,
      line: block.line + start,
      end: block.line + start + output.length - 1,
    };
  }
  return best;
}

function usageBlocks(text, rst) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  if (rst) {
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\.\. (?:code|code-block|sourcecode)::(?:\s|$)/.test(lines[i])) continue;
      const heading = i;
      let first = i + 1;
      while (first < lines.length && (!lines[first].trim() || /^\s+:\w[\w-]*:/.test(lines[first])))
        first++;
      let end = first;
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
      if (end > first)
        out.push({
          line: first + 1,
          code: lines.slice(first, end).join("\n"),
          context: lines
            .slice(Math.max(0, heading - 3), heading)
            .join(" ")
            .slice(-420),
        });
      i = end - 1;
    }
    return out;
  }
  let block = null;
  for (const [i, line] of lines.entries()) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (block) {
      if (
        mark &&
        mark[1][0] === block.fence[0] &&
        mark[1].length >= block.fence.length &&
        !mark[2].trim()
      ) {
        out.push({ line: block.line, code: block.lines.join("\n"), context: block.context });
        block = null;
      } else block.lines.push(line);
    } else if (mark) {
      block = {
        fence: mark[1],
        line: i + 2,
        lines: [],
        context: lines
          .slice(Math.max(0, i - 4), i)
          .join(" ")
          .slice(-420),
      };
    }
  }
  return out;
}

const repoId = (row) => {
  if (
    row.provider !== "GitHub" ||
    typeof row.title !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(row.title) ||
    row.title.split("/").some((v) => /^\.{1,2}$/.test(v))
  )
    return null;
  return row.url === `https://github.com/${row.title}` ? row.title : null;
};
const safePath = (p) =>
  typeof p === "string" &&
  p.length <= 300 &&
  p.split("/").every((v) => v && !/^\.{1,2}$/.test(v) && !/[\p{Cc}\p{Cf}\\]/u.test(v));
async function github(row, query, get, signal) {
  const name = repoId(row);
  const root = `https://api.github.com/repos/${name}`;
  const commits = await json(get, `${root}/commits?per_page=1`, signal);
  const sha = commits?.[0]?.sha;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error("missing revision");
  const [readme, license] = await Promise.all([
    json(get, `${root}/readme?ref=${sha}`, signal),
    json(get, `${root}/license?ref=${sha}`, signal).catch(() => null),
  ]);
  const pointer = {
    provider: "GitHub",
    title: name,
    author: name.split("/")[0],
    url: `${row.url}/tree/${sha}`,
    revision: sha,
    license: null,
    licenseUrl: null,
    snippet: null,
    line: null,
    path: null,
  };
  if (!safePath(readme?.path)) return pointer;
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
  pointer.path = readme.path;
  pointer.url = `${row.url}/blob/${sha}/${encodePath(readme.path)}`;
  const spdx = license?.license?.spdx_id;
  if (
    !(typeof spdx === "string" && /^[\w.+-]{1,70}$/.test(spdx)) ||
    ["NOASSERTION", "NONE"].includes(spdx) ||
    !safePath(license?.path)
  )
    return pointer;
  pointer.license = spdx;
  pointer.licenseUrl = `${row.url}/blob/${sha}/${encodePath(license.path)}`;
  if (
    readme.encoding !== "base64" ||
    typeof readme.content !== "string" ||
    readme.content.length > MAX_BYTES ||
    readme.size > MAX_BYTES
  )
    return pointer;
  const best = bestExcerpt(
    usageBlocks(
      Buffer.from(readme.content, "base64").toString("utf8"),
      /\.rst$/i.test(readme.path),
    ),
    query,
    name,
  );
  return best
    ? {
        ...pointer,
        snippet: best.snippet,
        line: best.line,
        url: `${pointer.url}#L${best.line}-L${best.end}`,
      }
    : pointer;
}

const answerId = (row) =>
  row.provider === "Stack Overflow" &&
  /^https:\/\/stackoverflow\.com\/a\/([1-9]\d{0,14})$/.exec(row.acceptedAnswerUrl ?? "")?.[1];
async function stack(rows, query, get, signal) {
  const ids = rows.map(answerId);
  const api = new URL(`https://api.stackexchange.com/2.3/answers/${ids.join(";")}`);
  api.search = new URLSearchParams({ site: "stackoverflow", filter: "withbody" }).toString();
  const page = await json(get, api.href, signal);
  if (!Array.isArray(page.items)) throw new Error("unexpected answer collection");
  const results = [];
  for (const a of page.items.slice(0, ids.length)) {
    const i = ids.indexOf(String(a?.answer_id));
    if (i < 0 || !a.is_accepted || typeof a.body !== "string") continue;
    const row = rows[i];
    const by =
      typeof a.owner?.display_name === "string"
        ? decode(a.owner.display_name)
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .slice(0, 100)
        : null;
    const version = /^CC BY-SA (2\.5|3\.0|4\.0)$/.exec(a.content_license ?? "");
    const pointer = {
      provider: "Stack Overflow",
      url: row.acceptedAnswerUrl,
      title: String(row.title ?? "Accepted answer")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .slice(0, 160),
      author: by,
      license: version ? a.content_license : null,
      licenseUrl: version ? `https://creativecommons.org/licenses/by-sa/${version[1]}/` : null,
      revision: null,
      snippet: null,
      path: null,
      line: null,
    };
    if (by && version) {
      const blocks = Array.from(
        a.body.matchAll(/<pre>\s*<code(?:\s[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi),
        (m) => ({
          line: 1,
          code: decode(m[1].replace(/<[^>]*>/g, "")).replace(/\r\n/g, "\n"),
          context: "",
        }),
      );
      pointer.snippet = bestExcerpt(blocks, query, pointer.title)?.snippet ?? null;
    }
    results.push(pointer);
  }
  return results;
}

/** Look up a few verbatim, attributable usage examples. Pass upstream researchPublic
 * results to share discovery. Results with missing license/provenance are links only.
 * @param {string} publicQuery
 * @param {{repositories?:any[],fetchImpl?:typeof fetch,timeoutMs?:number,limit?:number}} [opts]
 */
export async function findCodeExamples(
  publicQuery,
  { repositories, fetchImpl = fetch, timeoutMs = 10000, limit = 2 } = {},
) {
  const checkedAt = new Date().toISOString(),
    warnings = [];
  if (
    typeof publicQuery !== "string" ||
    !publicQuery.trim() ||
    publicQuery.length > 200 ||
    /[\p{Cc}\p{Cf}]/u.test(publicQuery) ||
    hasSecret(publicQuery)
  )
    return {
      checkedAt,
      results: [],
      warnings: ["Supply a short public query without sensitive text."],
      manualGoogleUrl: null,
    };
  const google = new URL("https://www.google.com/search");
  google.searchParams.set("q", `${publicQuery.trim()} code examples`);
  const manualGoogleUrl = google.href;
  if (process.env.FORGE_NO_CATALOG_FETCH === "1" && fetchImpl === fetch)
    return {
      checkedAt,
      results: [],
      warnings: ["Public example search is offline."],
      manualGoogleUrl,
    };
  const ms = Math.max(1, Math.min(20000, Number.isSafeInteger(timeoutMs) ? timeoutMs : 10000));
  const started = Date.now(),
    cap = Math.max(1, Math.min(3, Number.isSafeInteger(limit) ? limit : 2));
  if (repositories === undefined) {
    const discovery = await researchPublic(publicQuery, { limit: cap, timeoutMs: ms, fetchImpl });
    repositories = discovery.results;
    warnings.push(...discovery.warnings);
  }
  const remaining = ms - (Date.now() - started);
  if (remaining <= 0)
    return {
      checkedAt,
      results: [],
      warnings: [...warnings, "Example lookup deadline reached."],
      manualGoogleUrl,
    };
  const signal = AbortSignal.timeout(remaining);
  const rows = Array.isArray(repositories) ? repositories.filter(Boolean).slice(0, 30) : [];
  const repos = rows.filter(repoId).slice(0, Math.min(cap, 2)),
    answers = rows.filter(answerId).slice(0, cap);
  const jobs = repos.map((row) => ({
    name: row.title,
    run: async () => [await github(row, publicQuery, fetchImpl, signal)],
  }));
  if (answers.length)
    jobs.push({
      name: "Stack Overflow",
      run: () => stack(answers, publicQuery, fetchImpl, signal),
    });
  const responses = await Promise.allSettled(jobs.map((j) => j.run()));
  const results = [];
  for (const [i, response] of responses.entries()) {
    if (response.status === "fulfilled") results.push(...response.value);
    else {
      const msg = String(response.reason?.message);
      const reason =
        /^(HTTP \d{3}|response exceeded size limit|missing revision|unexpected answer collection)$/.test(
          msg,
        )
          ? msg
          : signal.aborted
            ? "deadline reached"
            : "lookup failed";
      warnings.push(`${jobs[i].name}: ${reason}`);
    }
  }
  return {
    checkedAt,
    results: results.sort((a, b) => Number(!!b.snippet) - Number(!!a.snippet)).slice(0, cap),
    warnings,
    manualGoogleUrl,
  };
}

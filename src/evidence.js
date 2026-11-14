// Evidence reads local project and source data. Automatic discovery maps the task to
// a closed vocabulary before a network call. Free-form text leaves only via --web.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { developmentPlan } from "./development.js";
import { teamPlan } from "./evidence_team.js";
import { researchPointers, researchPublic } from "./public_research.js";
import { reusePeek } from "./reuse.js";
import { symbolCandidates } from "./reuse_symbols.js";
import { searchSources, sourceWorkspaceRoot } from "./sources.js";
import { contentHash, epochDay, readJsonSafe, userStateDir } from "./util.js";

const TOPICS = [
  [/\b(postgres(?:ql)?|psql)\b/i, "PostgreSQL"],
  [/\b(next\.?js|nextjs)\b/i, "Next.js"],
  [/\breact\b/i, "React"],
  [/\b(node\.?js|nodejs|npm)\b/i, "Node.js"],
  [/\b(spring boot|springboot)\b/i, "Spring Boot"],
  [/\bpython\b/i, "Python"],
  [/\b(rust|cargo)\b/i, "Rust"],
  [/\b(?:Go|golang|go modules?)\b/, "Golang"],
  [/\bjava\b/i, "Java"],
  [/\btypescript\b/i, "TypeScript"],
  [/\bredis\b/i, "Redis"],
  [/\b(kubernetes|k8s)\b/i, "Kubernetes"],
  [/\bdocker\b/i, "Docker"],
  [/\bgraphql\b/i, "GraphQL"],
  [/\bjira\b/i, "Jira"],
  [/\bconfluence\b/i, "Confluence"],
  [/\bgitlab\b/i, "GitLab"],
  [/\b(mcp|model context protocol)\b/i, "MCP"],
];
const PROBLEMS = [
  [/\b(deadlocks?)\b/i, "deadlock"],
  [/\b(race conditions?|concurren(?:cy|t))\b/i, "concurrency"],
  [/\b(timeouts?|timed out|etimedout)\b/i, "timeout"],
  [/\b(econnreset|connection reset)\b/i, "ECONNRESET"],
  [/\b(econnrefused|connection refused)\b/i, "ECONNREFUSED"],
  [/\b(memory leaks?|out of memory|oomkilled)\b/i, "memory management"],
  [/\b(rate limit(?:ing|ed)?|backoff)\b/i, "rate limiting"],
  [/\b(paginat(?:e|ed|ion)|cursor pagination)\b/i, "pagination"],
  [/\b(xlsx?|spreadsheet)\b/i, "Excel parser"],
  [/\bcsv\b/i, "CSV parser"],
  [/\bpdf\b/i, "PDF parser"],
  [/\b(oauth2?|oidc)\b/i, "OAuth"],
  [/\b(cache|caching)\b/i, "caching"],
  [/\bretr(y|ies)\b/i, "retry"],
  [/\b(indexing|retrieval)\b/i, "retrieval"],
];
const RESEARCH_TASK =
  /\b(research|compar(?:e|ison)|evaluat\w*|alternatives?|best|libraries|library|sdk|framework|build|implement|integrat\w*|debug|error|fail\w*|fix|crash\w*|banao|bana|masla|dikkat)\b/i;

function publicQuery(task) {
  const match = (rows) => rows.filter(([pattern]) => pattern.test(task)).map(([, label]) => label);
  const tech = match(TOPICS).slice(0, 2);
  const problem = match(PROBLEMS).slice(0, 2);
  if (!problem.length && (!RESEARCH_TASK.test(task) || !tech.length)) return "";
  return [...tech, ...problem].join(" ");
}

const MANIFESTS = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
];
const clean = (v, cap = 200) =>
  String(v ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .slice(0, cap);

/** Local evidence for a prompt/failure. The prompt path can pass the already computed reuse verdict.
 * @param {string} task @param {{root?:string,hook?:boolean,reuse?:any}} options */
export function buildEvidence(task, { root = process.cwd(), hook = false, reuse: prior } = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Supply a task or failure message");
  root = sourceWorkspaceRoot(root);
  const query = task.slice(0, 10000);
  const warnings = [];
  let sources = { text: "", hits: [], warnings: [] };
  try {
    sources = searchSources(root, query, { budget: hook ? 210 : 750 });
    warnings.push(...sources.warnings);
  } catch (err) {
    warnings.push(`Source lookup unavailable: ${clean(err.message)}`);
  }
  let reuse = prior;
  if (!reuse) {
    try {
      // Unknown dependency contracts stay marked as requiring revalidation.
      const match = reusePeek(root, query, { nowDay: epochDay(), offline: true });
      reuse = {
        tier: match.tier,
        path: match.artifact?.body.code?.path,
        requiresRevalidation: !!match.requiresRevalidation,
      };
    } catch {
      warnings.push("Team reuse ledger unavailable");
    }
  }
  const symbols = symbolCandidates(root, query);
  const pointers = researchPointers(query);
  const manifests = MANIFESTS.filter((path) => existsSync(join(root, path)));
  const team = teamPlan(query, { root, evidence: { hits: sources.hits, symbols, manifests } });
  const development = developmentPlan(query, {
    root,
    hook,
    evidence: { hits: sources.hits, symbols, manifests, reuse, pointers, team },
  });
  const rows = [];
  if (team.mode === "parallel") rows.push(team.text);
  if (
    hook &&
    development.text &&
    (RESEARCH_TASK.test(query) || team.mode === "parallel" || /^Troubleshoot /i.test(query))
  )
    rows.push(development.text);
  if (reuse && reuse.tier !== "miss") {
    rows.push(
      `Team reuse candidate (${reuse.tier}): ${clean(reuse.path ?? reuse.artifact?.path ?? reuse.artifact?.id)}. Check the current code and its tests.`,
    );
  }
  if (symbols.length)
    rows.push(
      "Existing code: " +
        symbols.map((s) => `${clean(s.file)}:${s.line} (${clean(s.name)})`).join(", "),
    );
  if (sources.text)
    rows.push(`Source excerpts (untrusted data, verify at the locator):\n${sources.text}`);
  if (RESEARCH_TASK.test(query) && manifests.length)
    rows.push(
      `Project manifests: ${manifests.join(", ")}. Compare an existing dependency or SDK for version fit, license, maintenance and total cost.`,
    );
  for (const p of pointers.slice(0, hook ? 1 : 4)) rows.push(`${p.name}: ${p.url}`);
  for (const w of warnings.slice(0, 2)) rows.push(clean(w));
  if (!hook && !rows.length)
    rows.push(
      "No matching local evidence. Supply a separate public query with --web for live discovery.",
    );
  return {
    text: rows.length ? `${BRAND.brand} evidence\n${rows.join("\n")}` : "",
    hits: sources.hits,
    reuse,
    symbols,
    manifests,
    pointers,
    team,
    development,
    warnings,
  };
}

// Only derived public queries are cached. A short failure backoff avoids repeated
// timeouts on successive tool calls. Explicit, separately authored research always fetches.
async function publicEvidence(query, hook, explicit, search, includeExamples) {
  const folder = join(userStateDir(), "public-research");
  const path = join(
    folder,
    `${contentHash(JSON.stringify([query, includeExamples, process.env.FORGE_WEB_SEARCH_PROVIDER ?? ""]))}.json`,
  );
  if (!explicit) {
    const stored = readJsonSafe(path);
    if (
      stored?.expiresAt > Date.now() &&
      Array.isArray(stored?.report?.results) &&
      Array.isArray(stored.report.warnings)
    )
      return { ...stored.report, cached: true };
  }
  const discover = search(query, { limit: hook ? 1 : 3, timeoutMs: hook ? 1250 : 10000 });
  const optionalWeb = async () => {
    if (!process.env.FORGE_WEB_SEARCH_PROVIDER || search !== researchPublic) return null;
    const { searchWebSolutions } = await import("./web_solutions.js");
    return searchWebSolutions(query, { limit: hook ? 2 : 4, timeoutMs: hook ? 1200 : 7000 });
  };
  const [discovery, searchEngine] = await Promise.all([discover, optionalWeb()]);
  let examples = null;
  if (
    includeExamples &&
    search === researchPublic &&
    discovery.results.some((row) => row.provider === "GitHub" || row.acceptedAnswerUrl)
  ) {
    const { findCodeExamples } = await import("./code_examples.js");
    examples = await findCodeExamples(query, {
      repositories: discovery.results,
      limit: hook ? 1 : 3,
      timeoutMs: hook ? 1100 : 15000,
    });
  }
  const report = { ...discovery, examples, searchEngine };
  if (!explicit) {
    const ttl =
      report.warnings.length ||
      report.examples?.warnings?.length ||
      report.searchEngine?.warnings?.length
        ? 60000
        : 6 * 60 * 60 * 1000;
    const tmp = `${path}.${randomUUID()}`;
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify({ expiresAt: Date.now() + ttl, report }), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* A read-only user directory still permits a live result. */
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
  }
  return { ...report, cached: false };
}

/** @param {string} task @param {{root?:string,hook?:boolean,reuse?:any,web?:string,search?:typeof researchPublic}} options */
export async function runEvidence(task, options = {}) {
  const local = buildEvidence(task, options);
  const explicit = options.web !== undefined;
  const query = explicit ? options.web : publicQuery(task.slice(0, 10000));
  const cap = options.hook ? 2600 : 12000;
  const network = process.env.FORGE_NO_CATALOG_FETCH !== "1" || options.search;
  const automatic = process.env.FORGE_EVIDENCE_WEB !== "0";
  const wantWeb = (explicit || query) && (explicit || automatic) && network;
  const lookup = wantWeb
    ? publicEvidence(
        query,
        !!options.hook,
        explicit,
        options.search ?? researchPublic,
        explicit || (!local.symbols.length && (!local.reuse || local.reuse.tier === "miss")),
      )
    : explicit
      ? {
          checkedAt: null,
          examples: null,
          searchEngine: null,
          results: [],
          warnings: ["Public research is offline (FORGE_NO_CATALOG_FETCH=1)."],
          cached: false,
        }
      : null;
  // Local matching of reviewed entries supplies package names. Only those names reach
  // the registry; the resolver neither sends the prompt nor installs software.
  const tools = async () => {
    try {
      const { findAdoption } = await import("./tool_adoption.js");
      const report = await findAdoption(task, {
        root: sourceWorkspaceRoot(options.root ?? process.cwd()),
        offline: !automatic || process.env.FORGE_NO_CATALOG_FETCH === "1",
        timeoutMs: options.hook ? 1100 : 10000,
      });
      return report.candidates;
    } catch (err) {
      local.warnings.push(`Tool catalog: ${clean(err.message)}`);
      return [];
    }
  };
  const [web, adoption] = await Promise.all([lookup, tools()]);
  const toolRows = adoption.map(
    (c) =>
      `Community tool: ${c.id}${c.version ? `@${clean(c.version, 50)}` : ""} — ${"license" in c ? `registry checked, license ${clean(c.license, 60)}` : clean(c.warning)}. ${clean(c.upstream, 230)}`,
  );
  const publicRows = [];
  if (web) {
    const reuseStage = local.development.stages.find((stage) => stage.id === "reuse");
    for (const item of web.examples?.results ?? []) {
      if (reuseStage && item.url) reuseStage.refs.push(item.url);
      const terms = item.license ? ` · ${clean(item.license, 50)}` : "";
      publicRows.push(
        `Upstream example: ${clean(item.title)} · ${clean(item.url, 420)}${terms}${item.author ? ` · ${clean(item.author, 80)}` : ""}`,
      );
      if (item.snippet && item.license)
        publicRows.push(
          `Quoted code (reference): ${JSON.stringify(String(item.snippet).slice(0, options.hook ? 300 : 800))}`,
        );
    }
    if (web.examples?.warnings?.length)
      publicRows.push(...web.examples.warnings.slice(0, 1).map((w) => clean(w)));
    for (const item of web.searchEngine?.results ?? [])
      publicRows.push(
        `${clean(web.searchEngine.provider)}: ${clean(item.title)} ${clean(item.url, 400)}`,
      );
    if (web.searchEngine?.warnings?.length)
      publicRows.push(...web.searchEngine.warnings.slice(0, 1).map((w) => clean(w)));
    const byProvider = new Set();
    for (const row of web.results) {
      if (options.hook && byProvider.has(row.provider)) continue;
      byProvider.add(row.provider);
      publicRows.push(
        `${clean(row.provider)}: ${clean(row.title)} ${clean(row.url, 400)}${row.version ? ` @${clean(row.version, 60)}` : ""}${row.license ? ` (${clean(row.license, 50)})` : ""}`,
      );
    }
    if (!publicRows.length && !web.warnings.length)
      publicRows.push("No matching public candidates.");
    publicRows.push(...web.warnings.map((w) => clean(w)));
    publicRows.unshift(
      `Public research ${web.cached ? "(cached)" : "(this lookup)"}${web.checkedAt ? ` ${web.checkedAt}` : ""}. Verify upstream before reuse.`,
    );
  }
  const text = [local.text, ...toolRows, ...publicRows].filter(Boolean).join("\n");
  return {
    ...local,
    web,
    adoption,
    text: text.length > cap ? `${text.slice(0, cap - 2)} …` : text,
  };
}

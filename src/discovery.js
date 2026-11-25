// Public task vocabulary and candidate advice. Retrieved material never supplies executable setup.
import { chooseAdvice } from "./decisions.js";
import { advisorSettings } from "./discovery_config.js";
import { stableVersion } from "./integrations.js";
import { lookupPublic } from "./public_lookup.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { detectStack } from "./stack.js";
import { adoptionCatalog, findAdoption } from "./tool_adoption.js";
import { contentHash } from "./util.js";

const TOPICS = [
  [/\b(postgres(?:ql)?|psql)\b/i, "PostgreSQL"],
  [/\b(next\.?js|nextjs)\b/i, "Next.js"],
  [/\breact\b/i, "React"],
  [/\bvue\b/i, "Vue"],
  [/\bsvelte\b/i, "Svelte"],
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
  [/\bdeadlocks?\b/i, "deadlock"],
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
  [/\b(browser|playwright|end.to.end|e2e)\b/i, "browser testing"],
  [/\b(accessibility|wcag|a11y)\b/i, "accessibility"],
  [/\b(lint|linting|pre.commit|formatting)\b/i, "linting"],
  [
    /\b(security|vulnerabilit\w*|owasp|pentest\w*|penetration testing|ethical hacking|stealer)\b/i,
    "security",
  ],
  [/\b(unit tests?|testing|test coverage)\b/i, "testing"],
  [/\b(deploy|deployment|ci\/cd)\b/i, "deployment"],
];
export const RESEARCH_TASK =
  /\b(research|compar(?:e|ison)|evaluat\w*|alternatives?|best|libraries|library|sdk|framework|build|implement|integrat\w*|debug|error|fail\w*|fix|crash\w*|banao|bana|masla|dikkat|find|suggest|recommend|skills?|plugins?|hooks?|tools?)\b/i;
const match = (rows, text) => rows.filter(([p]) => p.test(text)).map(([, label]) => label);

/** Only labels authored above leave the machine. Package names and paths never enter queries. */
export function publicQuery(task, root) {
  if (
    /\b(typo|spelling|punctuation)\b/i.test(task) &&
    !/\b(implement|debug|integrate)\b/i.test(task)
  )
    return "";
  let tech = match(TOPICS, task).slice(0, 2);
  const problem = match(PROBLEMS, task).slice(0, 2);
  if (!problem.length && !RESEARCH_TASK.test(task)) return "";
  if (!tech.length && root) {
    try {
      const stack = detectStack(root);
      tech = match(TOPICS, [...stack.frameworks, ...stack.languages].join(" ")).slice(0, 2);
    } catch {
      // Missing stack evidence is not a reason to send raw manifest data.
    }
  }
  const labels = [...tech, ...problem];
  const query = labels
    .filter((label) => !labels.some((other) => other !== label && other.includes(label)))
    .join(" ");
  return query || (/\b(skills?|plugins?|hooks?|tools?|mcp)\b/i.test(task) ? "coding agent" : "");
}

const KINDS = {
  skill: {
    query: "agent skill",
    setup:
      "Read the upstream SKILL.md, supported agent hosts and dependencies; add the reviewed skill through that host's skill setup.",
  },
  plugin: {
    query: "plugin",
    setup:
      "Confirm the supported host or build system and version, then follow the upstream plugin installation and configuration guide.",
  },
  tool: {
    query: "tool",
    setup:
      "Check the upstream runtime, supported versions and permissions; follow its documented CLI or MCP configuration.",
  },
  hook: {
    query: "hooks",
    setup:
      "Review the hook's events and commands; register it through the supported host or Git hook configuration and test on a small change.",
  },
};
const clean = (v, max = 200) =>
  redactSecrets(String(v ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ")).slice(0, max);
const tokens = (text) => [
  ...new Set(
    String(text)
      .toLowerCase()
      .match(/[a-z][a-z0-9]+/g) ?? [],
  ),
];
function link(value) {
  try {
    if (
      typeof value !== "string" ||
      value.length > 1000 ||
      /[\p{Cc}\p{Cf}]/u.test(value) ||
      hasSecret(value)
    )
      return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}
function kindOf(text, provider) {
  if (/\b(pre.commit|git hooks?|lifecycle hooks?|agent hooks?|claude.{0,20}hooks?)\b/i.test(text))
    return "hook";
  if (/\bskills?\b|SKILL\.md/i.test(text)) return "skill";
  if (/\b(plugins?|extensions?)\b/i.test(text)) return "plugin";
  if (provider === "npm" || /\b(tools?|mcp|sdk|parser|library|server|cli)\b/i.test(text))
    return "tool";
  return null;
}
const knownDate = (value) => {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n <= Date.now() ? new Date(n).toISOString() : null;
};

/** Rank only observed candidates. The model may select a known ID or abstain.
 * @param {string} query @param {any[]} rows
 * @param {{root?:string,hook?:boolean,adoption?:any[],jevCall?:(payload:object)=>object}} options */
export function rankCandidates(
  query,
  rows,
  { root = process.cwd(), hook = false, adoption = [], jevCall } = {},
) {
  const terms = tokens(query).filter(
    (s) => !["js", "tool", "tools", "skill", "skills", "plugin", "plugins", "hooks"].includes(s),
  );
  const topic = match(TOPICS, query);
  const purposes = match(PROBLEMS, query);
  const purposeTerms = tokens(purposes.join(" "));
  const catalog = adoptionCatalog(root);
  const reviewed = adoption.filter((c) =>
    catalog.some((t) => t.id === c.id && t.upstream === c.upstream),
  );
  const candidates = new Map();
  const all = [
    ...reviewed.map((c) => ({
      ...c,
      title: c.name,
      summary: `${c.reason} MCP tool`,
      url: c.upstream,
      provider: "Reviewed catalog",
      catalogId: c.id,
    })),
    ...rows.slice(0, 100),
  ];
  for (const row of all) {
    if (!row || typeof row !== "object") continue;
    const url = link(row.url);
    const title = clean(row.title, 120);
    const summary = clean(row.summary ?? row.snippet, 320);
    const text = `${title} ${summary}`;
    const kind = kindOf(text, row.provider);
    const matches = terms.filter((term) => tokens(text).includes(term));
    if (!url || !title || !kind || !matches.length || row.provider === "Stack Overflow") continue;
    // A component library mentioning its own tests is not a developer testing tool.
    if (
      purposes.includes("testing") &&
      kind === "tool" &&
      /\b(?:hooks?|component) librar(?:y|ies)\b/i.test(text)
    )
      continue;
    const candidatePurposes = match(PROBLEMS, text);
    if (purposes.length && candidatePurposes.includes("security") && !purposes.includes("security"))
      continue;
    const otherTopics = match(TOPICS, text).filter((t) => t !== "MCP");
    if (topic.length && otherTopics.length && !otherTopics.some((t) => topic.includes(t))) continue;
    const updatedAt = knownDate(row.updatedAt);
    const checkedAt = knownDate(row.checkedAt);
    const stale = updatedAt && Date.now() - Date.parse(updatedAt) > 365 * 86400000;
    const license = clean(row.license, 60) || null;
    const fromCatalog = reviewed.find((c) => c.id === row.catalogId && c.upstream === url);
    const installable = fromCatalog?.status === "candidate" && stableVersion(fromCatalog.version);
    const score =
      matches.reduce((sum, term) => sum + (purposeTerms.includes(term) ? 4 : 1), 0) +
      matches.filter((term) => purposeTerms.includes(term) && tokens(title).includes(term)).length *
        2 +
      (license ? 1 : 0) +
      (updatedAt ? (stale ? -3 : 1) : -1) +
      (installable ? 2 : 0);
    const entry = {
      id: `candidate_${contentHash(url).slice(0, 12)}`,
      title,
      kind,
      url,
      summary,
      score,
      matches,
      license,
      updatedAt,
      checkedAt,
      cached: row.cached === true,
      provider: clean(row.provider, 60),
      reason: `Matches ${matches.join(", ")}${installable ? "; reviewed catalog metadata available" : ""}`,
      limitations: [
        ...(!license ? ["License unknown"] : []),
        ...(!updatedAt
          ? ["Maintenance unknown"]
          : stale
            ? ["No observed update within one year"]
            : []),
        ...(!installable ? ["Host/version compatibility and installation not verified"] : []),
        ...(fromCatalog?.warning ? ["Catalog release metadata could not be verified"] : []),
      ],
      setup: {
        url,
        steps: KINDS[kind].setup,
        command: installable
          ? `forge integrations install ${fromCatalog.id} --version ${fromCatalog.version}`
          : null,
      },
    };
    if (!candidates.has(url) || candidates.get(url).score < score) candidates.set(url, entry);
  }
  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, 12);
  const decision = ranked.length
    ? chooseAdvice({
        root,
        call: jevCall,
        timeoutMs: hook ? 800 : 5000,
        state: { publicQuery: query, candidates: ranked.map(({ setup, ...c }) => c) },
        choices: Object.fromEntries([
          ["none", "No candidate is adequately supported for this task."],
          ...ranked.map((c) => [c.id, `${c.kind}: ${c.reason}; ${c.limitations.join("; ")}`]),
        ]),
        fallback: ranked[0].id,
      })
    : {
        choice: "none",
        reason: "No relevant observed candidates.",
        source: "deterministic",
        confidence: null,
      };
  const best = ranked.find((c) => c.id === decision.choice) ?? null;
  if (best) ranked.splice(0, ranked.length, best, ...ranked.filter((c) => c !== best));
  const selected = ranked.slice(0, hook ? 1 : 5);
  const text = [
    best
      ? `Best observed fit (${decision.source}; source data, verify upstream):`
      : "No supported best fit found.",
    ...selected.map((c) =>
      hook
        ? `${JSON.stringify(c.title)} ${c.url} · license ${c.license ?? "unknown"} · checked ${c.checkedAt ?? "unknown"}`
        : [
            `${JSON.stringify(c.title)} [${c.kind}] — ${c.reason}. ${c.url} ${JSON.stringify(c.summary)}`,
            `Source: ${c.provider}; checked ${c.checkedAt ?? "unknown"}${c.cached ? " (cached)" : ""}; license ${c.license ?? "unknown"}; updated ${c.updatedAt ?? "unknown"}.`,
            `Setup: ${c.setup.command ?? c.setup.steps}`,
            c.limitations.join("; "),
          ]
            .filter(Boolean)
            .join(" "),
    ),
  ].join("\n");
  return { best, candidates: ranked, decision, text };
}

/** Live artifact lookup; automatic queries are derived, explicit public queries are never cached.
 * @param {string} task
 * @param {{root?:string,hook?:boolean,fresh?:boolean,web?:string,seed?:any,adoption?:any[]|Promise<any[]>,
 * search?:typeof import("./public_research.js").researchPublic,webSearch?:typeof import("./web_solutions.js").searchWebSolutions,
 * jevCall?:(payload:object)=>object}} options */
export async function discoverTools(task, options = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("Supply a developer task");
  const root = options.root ?? process.cwd();
  const settings = advisorSettings(root);
  const query = options.web ?? publicQuery(task.slice(0, 10000), root);
  const enabled = options.fresh || options.web !== undefined || settings.recommendations;
  const network = process.env.FORGE_NO_CATALOG_FETCH !== "1" || options.search;
  const empty = {
    best: null,
    candidates: [],
    decision: null,
    text: "",
    warnings: settings.warnings,
    queries: [],
  };
  if (!enabled) return { ...empty, status: "disabled" };
  if (
    options.web !== undefined &&
    (typeof options.web !== "string" ||
      !options.web.trim() ||
      options.web.length > 180 ||
      /[\p{Cc}\p{Cf}]/u.test(options.web) ||
      hasSecret(options.web))
  )
    return {
      ...empty,
      status: "invalid-query",
      warnings: ["Supply a single-line public query of 1 to 180 characters without credentials."],
    };
  if (!query) return { ...empty, status: "no-public-query" };
  const adoptionLookup =
    options.adoption ??
    findAdoption(task, {
      root,
      offline: process.env.FORGE_NO_CATALOG_FETCH === "1",
      timeoutMs: options.hook ? 1100 : 10000,
    })
      .then((report) => report.candidates.map((c) => ({ ...c, checkedAt: report.checkedAt })))
      .catch(() => []);
  const requested = Object.keys(KINDS).filter((k) => new RegExp(`\\b${k}s?\\b`, "i").test(task));
  const kinds = requested.length
    ? requested
    : options.fresh
      ? Object.keys(KINDS)
      : /\b(lint|linting|pre.commit|formatting)\b/i.test(task)
        ? ["hook", "plugin"]
        : ["skill", "tool"];
  const queries = kinds.slice(0, options.hook ? 2 : 4).map((k) => {
    // Broaden artifact discovery without losing task-fit filtering during ranking.
    const context =
      options.web !== undefined
        ? query
        : k === "skill"
          ? (match(TOPICS, query)[0] ?? query)
          : k === "tool"
            ? (match(PROBLEMS, query)[0] ?? query)
            : query;
    return `${context} ${KINDS[k].query}`.slice(0, 200);
  });
  const reports = network
    ? await Promise.all(
        queries.map((q) =>
          lookupPublic(q, {
            root,
            hook: options.hook,
            fresh: !!options.fresh || options.web !== undefined,
            limit: options.hook ? 2 : 4,
            search: options.search,
            webSearch: options.webSearch,
          }),
        ),
      )
    : [];
  const warnings = [...settings.warnings, ...(!network ? ["Public discovery is offline."] : [])];
  const rows = [];
  const seed = await options.seed;
  for (const report of [...reports, ...(seed ? [seed] : [])]) {
    warnings.push(...report.warnings, ...(report.searchEngine?.warnings ?? []));
    rows.push(
      ...report.results.map((r) => ({ ...r, checkedAt: report.checkedAt, cached: report.cached })),
    );
    rows.push(
      ...(report.searchEngine?.results ?? []).map((r) => ({
        ...r,
        provider: report.searchEngine.provider,
        checkedAt: report.searchEngine.checkedAt,
        cached: report.cached,
      })),
    );
  }
  return {
    ...rankCandidates(query, rows, { ...options, root, adoption: await adoptionLookup }),
    status: network ? "searched" : "offline",
    queries: network ? queries : [],
    warnings: [...new Set(warnings)],
  };
}

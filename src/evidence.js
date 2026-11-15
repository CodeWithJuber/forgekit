// Evidence reads local project and source data. Automatic discovery maps the task to
// a closed vocabulary before a network call. Free-form text leaves only via --web.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "./brand.js";
import { developmentPlan } from "./development.js";
import { activePromptProfile, profileGuidance } from "./development_profile.js";
import { discoverTools, publicQuery, RESEARCH_TASK } from "./discovery.js";
import { advisorSettings } from "./discovery_config.js";
import { teamPlan } from "./evidence_team.js";
import { lookupPublic } from "./public_lookup.js";
import { researchPointers, researchPublic } from "./public_research.js";
import { reusePeek } from "./reuse.js";
import { symbolCandidates } from "./reuse_symbols.js";
import { searchSources, sourceWorkspaceRoot } from "./sources.js";
import { epochDay } from "./util.js";

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
 * @param {string} task @param {{root?:string,hook?:boolean,reuse?:any,jevCall?:(payload:object)=>object}} options */
export function buildEvidence(
  task,
  { root = process.cwd(), hook = false, reuse: prior, jevCall } = {},
) {
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
  const selectedProfile = activePromptProfile(root);
  const team = teamPlan(query, {
    root,
    profile: selectedProfile,
    evidence: { hits: sources.hits, symbols, manifests },
  });
  const development = developmentPlan(query, {
    root,
    hook,
    jevCall,
    evidence: { hits: sources.hits, symbols, manifests, reuse, pointers, team },
  });
  const profile = profileGuidance(selectedProfile, query, { hits: sources.hits, symbols });
  const rows = [];
  if (profile) rows.push(profile.text);
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
    ...(profile ? { promptProfile: profile } : {}),
    warnings,
  };
}

/** @param {string} task @param {{root?:string,hook?:boolean,reuse?:any,web?:string,search?:typeof researchPublic,
 * jevCall?:(payload:object)=>object}} options */
export async function runEvidence(task, options = {}) {
  options = { ...options, root: sourceWorkspaceRoot(options.root ?? process.cwd()) };
  const local = buildEvidence(task, options);
  const explicit = options.web !== undefined;
  const query = explicit ? options.web : publicQuery(task.slice(0, 10000), options.root);
  const cap = options.hook ? 2600 : 12000;
  const network = process.env.FORGE_NO_CATALOG_FETCH !== "1" || options.search;
  const automatic = advisorSettings(options.root).recommendations;
  const wantWeb = (explicit || query) && (explicit || automatic) && network;
  const lookup = wantWeb
    ? lookupPublic(query, {
        root: options.root,
        hook: !!options.hook,
        fresh: explicit,
        search: options.search ?? researchPublic,
        examples:
          explicit || (!local.symbols.length && (!local.reuse || local.reuse.tier === "miss")),
      })
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
      return report.candidates.map((c) => ({ ...c, checkedAt: report.checkedAt }));
    } catch (err) {
      local.warnings.push(`Tool catalog: ${clean(err.message)}`);
      return [];
    }
  };
  const kernel = async () => {
    try {
      const { recallHikmah } = await import("./hikmah_recall.js");
      return await recallHikmah(options.root ?? process.cwd(), task);
    } catch {
      return { enabled: false, hits: [], warning: "Hikmah memory unavailable" };
    }
  };
  const adoptionLookup = tools();
  const discoveries = discoverTools(task, { ...options, seed: lookup, adoption: adoptionLookup });
  const [web, adoption, hikmah, recommendations] = await Promise.all([
    lookup,
    adoptionLookup,
    kernel(),
    discoveries,
  ]);
  const lessons = hikmah.hits.map(
    (h) => "Verified public Hikmah lesson (source data): " + JSON.stringify(h),
  );
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
  const text = [
    recommendations.best ? recommendations.text.slice(0, options.hook ? 1000 : 6000) : "",
    local.text,
    ...lessons,
    ...toolRows,
    ...publicRows,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ...local,
    web,
    adoption,
    hikmah,
    recommendations,
    text: text.length > cap ? `${text.slice(0, cap - 2)} …` : text,
  };
}

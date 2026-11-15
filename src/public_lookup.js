// One bounded, shared cache for task-derived public queries. Explicit queries fetch afresh.
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advisorSettings } from "./discovery_config.js";
import { researchPublic } from "./public_research.js";
import { contentHash, readJsonSafe, userStateDir } from "./util.js";
import { searchWebSolutions } from "./web_solutions.js";

/** @param {string} query
 * @param {{root?:string,hook?:boolean,fresh?:boolean,examples?:boolean,limit?:number,
 * search?:typeof researchPublic,webSearch?:typeof searchWebSolutions}} options */
export async function lookupPublic(query, options = {}) {
  const { root, hook = false, fresh = false, examples = false, search = researchPublic } = options;
  const provider = advisorSettings(root).search;
  const limit = options.limit ?? (hook ? 1 : 3);
  const folder = join(userStateDir(), "public-research");
  const path = join(
    folder,
    `${contentHash(JSON.stringify([query, examples, provider, limit]))}.json`,
  );
  if (!fresh) {
    const stored = readJsonSafe(path);
    if (
      stored?.expiresAt > Date.now() &&
      Array.isArray(stored?.report?.results) &&
      Array.isArray(stored.report.warnings)
    )
      return { ...stored.report, cached: true };
  }
  const webSearch = options.webSearch ?? searchWebSolutions;
  const [discovery, searchEngine] = await Promise.all([
    search(query, { limit, timeoutMs: hook ? 1250 : 10000 }).catch(() => ({
      checkedAt: new Date().toISOString(),
      results: [],
      warnings: ["Public discovery unavailable."],
    })),
    provider !== "off" && (search === researchPublic || options.webSearch)
      ? webSearch(query, {
          env: { ...process.env, FORGE_WEB_SEARCH_PROVIDER: provider },
          limit: hook ? 2 : 4,
          timeoutMs: hook ? 1200 : 7000,
        }).catch(() => ({ checkedAt: null, results: [], warnings: ["Web search unavailable."] }))
      : null,
  ]);
  let codeExamples = null;
  if (
    examples &&
    search === researchPublic &&
    discovery.results.some((r) => r.provider === "GitHub" || r.acceptedAnswerUrl)
  ) {
    const { findCodeExamples } = await import("./code_examples.js");
    codeExamples = await findCodeExamples(query, {
      repositories: discovery.results,
      limit: hook ? 1 : 3,
      timeoutMs: hook ? 1100 : 15000,
    });
  }
  const report = { ...discovery, examples: codeExamples, searchEngine };
  if (!fresh) {
    const failed =
      report.warnings.length || codeExamples?.warnings?.length || searchEngine?.warnings?.length;
    const tmp = `${path}.${randomUUID()}`;
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmp,
        JSON.stringify({ expiresAt: Date.now() + (failed ? 60000 : 6 * 60 * 60 * 1000), report }),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(tmp, path);
    } catch {
      // Read-only user storage still permits a live result.
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
  }
  return { ...report, cached: false };
}

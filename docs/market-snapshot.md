# Developer tooling activity on 25 November 2026

The six projects below were selected in the 23 November review. At approximately 03:42 UTC on 25 November, GitHub’s public Trending pages showed strong interest in reusable skills, plan review, agent memory and browser tooling. Trending position measures attention. It does not establish adoption, retention, problem prevalence or willingness to pay. [GitHub Trending](https://github.com/trending)

## Current public measurements

The first numeric column is the lifetime star total returned by GitHub’s repository API on 25 November. The next four count public `WatchEvent` rows visible in ClickHouse’s `github_events` dataset. The 365-, 30- and 7-day windows all end at 00:00 UTC on 25 November, excluding that instant. The final column spans 00:00 to 03:00 UTC on 25 November, also excluding the endpoint. The dataset’s latest event was at 02:59:59 UTC when queried. Each complete window overlaps the longer windows. [Repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository) · [GitHub event definition](https://docs.github.com/en/rest/using-the-rest-api/github-event-types#watchevent) · [Queryable dataset](https://play.clickhouse.com/play?user=play) · [GH Archive](https://www.gharchive.org/)

| Repository | Lifetime GitHub stars | Observed 365 days | Observed 30 days | Observed 7 days | Observed today to 03:00 UTC |
|---|---:|---:|---:|---:|---:|
| [obra/superpowers](https://github.com/obra/superpowers) | 325,916 | 44,329 | 260 | 80 | 1 |
| [anthropics/skills](https://github.com/anthropics/skills) | 200,049 | 33,678 | 235 | 46 | 1 |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 119,591 | 18,984 | 258 | 22 | 0 |
| [github/spec-kit](https://github.com/github/spec-kit) | 151,296 | 14,189 | 105 | 13 | 0 |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | 59,237 | 7,137 | 75 | 15 | 0 |
| [backnotprop/plannotator](https://github.com/backnotprop/plannotator) | 14,921 | 1,601 | 82 | 31 | 0 |

GitHub’s stargazer-history endpoint returned HTTP 403 for the integration used for this refresh. The public event archive offers a different measure and materially undercounts recent activity relative to GitHub’s displayed figures. For example, it yielded 31 events for Plannotator over the complete week while GitHub’s weekly Trending card displayed 1,956 stars. The two windows also have different boundaries. A zero in the partial-day column means the query returned zero rows. These event counts cannot extend the 23 November stargazer series or support year-over-year growth estimates. [Stargazer-history API](https://docs.github.com/en/rest/activity/starring#list-stargazers) · [Weekly Trending results](https://github.com/trending?since=weekly)

## GitHub Trending as displayed at retrieval

| GitHub window | Observed cohort ranks and stars displayed on GitHub |
|---|---|
| [Daily](https://github.com/trending?since=daily) | #2 obra/superpowers, 1,003 stars today |
| [Weekly](https://github.com/trending?since=weekly) | #1 backnotprop/plannotator, 1,956 stars this week. #6 ChromeDevTools/chrome-devtools-mcp, 1,258 |
| [Monthly](https://github.com/trending?since=monthly) | #5 anthropics/skills, 16,946 stars this month. #6 thedotmack/claude-mem, 17,462. #8 backnotprop/plannotator, 5,292 |

The pages change over time. GitHub defines its own ranking and window boundaries. One project can rank above another with a larger displayed gain. Additional entries on those pages included cursor/plugins at #5 daily, modern-web-guidance-src at #3 weekly, security-audit-skill at #2 monthly and agent-browser at #19 monthly. These projects provide comparison points for plugin packaging, freshness, supply-chain review and browser acceptance. [Cursor Plugins](https://github.com/cursor/plugins) · [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance-src) · [Cloudflare Security Audit Skill](https://github.com/cloudflare/security-audit-skill) · [Agent Browser](https://github.com/vercel-labs/agent-browser)

## Product experiments suggested by the evidence

| User question | Comparison to run | Measure |
|---|---|---|
| Can a new agent resume my approved plan? | Switch hosts midway through the same held-out task with a scoped evidence packet, a plain summary and the project’s existing instructions. | Missing approved decisions, tokens to first correct edit, elapsed resume time |
| Can I reuse community work safely? | Give teams an inspectable skill or snippet with commit, license and fixture evidence. Compare against manually selecting candidate projects. | Time to verified reuse, stale candidates, integration failures, explicit rejections |
| Did the interface actually improve? | Compare screenshot-only review with an independently authored keyboard and accessible-role journey over the same user interaction. | Seeded defects detected by class, false alarms and blocked journeys |
| Will developers share project memory with a dashboard? | Compare local-only operation with explicit enrollment after users inspect the outbound manifest and revocation flow. | Successful onboarding, opted-in workspaces, corrections after preview and revocation success |

Pre-register these comparisons and keep user cohorts, tasks, failures and confidence intervals visible. A trending project supplies a candidate implementation to study. A documented user failure or controlled outcome supplies evidence for prioritization.

## Reproducing the event column

Use the public ClickHouse playground, select the `github_events` table and run this query. The service reported its server timezone as UTC. Fixed upper bounds preserve the historical windows, subject to later archive backfills. The current number of stars per project is separately available from `GET https://api.github.com/repos/{owner}/{repo}`. [ClickHouse playground](https://play.clickhouse.com/play?user=play)

```sql
SELECT
    repo_name,
    countIf(created_at < '2026-11-25') AS days_365,
    countIf(created_at >= '2026-10-26' AND created_at < '2026-11-25') AS days_30,
    countIf(created_at >= '2026-11-18' AND created_at < '2026-11-25') AS days_7,
    countIf(created_at >= '2026-11-25') AS partial_day
FROM github_events
WHERE event_type = 'WatchEvent'
  AND created_at >= '2025-11-25 00:00:00'
  AND created_at < '2026-11-25 03:00:00'
  AND repo_name IN ('obra/superpowers', 'anthropics/skills', 'thedotmack/claude-mem',
                    'github/spec-kit', 'ChromeDevTools/chrome-devtools-mcp', 'backnotprop/plannotator')
GROUP BY repo_name
ORDER BY days_365 DESC
```

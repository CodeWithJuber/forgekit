# Research protocol — vetting a candidate library (rung 6)

Only reach this file when rungs 1–5 failed and a new dependency is genuinely on
the table. Never skip straight here.

## Mandatory live checks

Run these before recommending. Stale memory is the failure mode this protocol
exists to prevent.

| Check | Source | Red flag |
|---|---|---|
| Last commit / release | GitHub releases or npm/PyPI page | > 12 months with open issues |
| Open CVEs | `npm audit` / `pip-audit` / Snyk DB / GitHub advisories | Any unpatched critical/high |
| Maintenance signal | Issue tracker, PR merge cadence | Dozens of unanswered issues, no maintainer response in months |
| Download trend | npm trends, PyPI stats | Steep decline or flatline vs. competitors |
| License compatibility | `package.json` / `setup.cfg` license field | Copyleft (GPL) in an MIT project, or no license |
| Bundle size (frontend) | bundlephobia.com or `import-cost` | > 50 kB gzipped for a single utility |
| Peer / transitive deps | `npm ls` / `pip show` | Pulls in a heavy tree for a small task |

## Green flags (not required, but strengthen the case)

- Active maintainer with a history of responding to security reports.
- TypeScript types shipped (not DefinitelyTyped-only).
- Used by well-known projects (check dependents on GitHub).
- Clear migration path if abandoned (small API surface, stdlib fallback exists).

## Decision template (one per candidate)

```
Library: <name@version>
Rung: 6 (new dependency)
Replaces: <what hand-rolled code or older dep>
Last release: <date>  |  Weekly downloads: <N>  |  License: <X>
CVEs: <none | list>
Bundle impact: <+N kB gzipped> (frontend only)
Verdict: adopt / skip / ask user
Reason (1–2 sentences): ...
```

Include this block in the final answer when recommending a new dependency. Keep it
short — the user needs the decision, not the research log.

# Support

forgekit is one brain for every AI coding agent — the cognitive substrate (memory, foresight,
guardrails) authored once and delivered as native config to every tool. Here's where to get help.

- **Questions / "how do I…"** → [Discussions](https://github.com/CodeWithJuber/forgekit/discussions)
- **Bugs** → open an issue with the bug template (include `forge doctor` output + `node --version`).
- **Feature ideas** → the feature-request template; for larger changes, start a Discussion first.
- **Security vulnerabilities** → **do not** open a public issue — see [SECURITY.md](./SECURITY.md).
- **Cognitive substrate questions** → start with
  [docs/cognitive-substrate/](./docs/cognitive-substrate/) and include
  `forge substrate "<task>" --json` output when reporting a bad ask/route/impact decision.

Before opening an issue: run `forge doctor`, search existing issues/discussions, and
confirm you're on the latest version (`forge --version` vs `npm view forgekit version`).

This is a small, maintainer-led project — responses are best-effort. See
[GOVERNANCE.md](./GOVERNANCE.md) for how decisions are made and [ROADMAP.md](./ROADMAP.md)
for direction.

## Support policy

- **Free / best-effort:** GitHub issues and Discussions. This is a maintainer-led project —
  there is **no paid tier and no SLA**. Please be patient and include a reproduction.
- **Response expectation:** we aim for a first response within about a week; security reports
  are prioritized (~72h acknowledgement — see [SECURITY.md](./SECURITY.md)).
- **Not supported:** debugging your specific third-party tool/MCP setup, or private 1:1 help.
  Keep it in public issues/discussions so the answer helps the next person.

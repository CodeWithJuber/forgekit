# Governance

forgekit is a maintainer-led open-source project, kept intentionally small and
dependency-free.

## Roles
- **Maintainer(s):** review and merge PRs, cut releases, set direction. Currently: @CodeWithJuber.
- **Contributors:** anyone who opens a PR or issue — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## How decisions are made
- **Small changes** (bug fixes, docs, tests): a maintainer reviews and merges once CI is green.
- **Larger changes** (new commands, scope changes, and *especially* any new runtime
  dependency): open a Discussion or issue first to agree on the approach **before** writing
  code. The zero-runtime-dependency rule is a hard constraint; changing it requires explicit
  maintainer sign-off.
- Disagreements are resolved by the maintainer(s), guided by the project's principles (see
  [ONBOARDING.md](./ONBOARDING.md)): reuse over rebuild, cross-tool over Claude-only, verify
  over assert, name the ceiling.

## Becoming a maintainer
Sustained, high-quality contributions and sound judgment in reviews. A maintainer invites
you; there's no formal application.

## Releases
Semantic versioning. `package.json` and `.claude-plugin/plugin.json` versions are bumped
together and tagged `vX.Y.Z`; release notes come from [CHANGELOG.md](./CHANGELOG.md).

## Contributor ladder

**User** → **Contributor** (a merged PR / triaged issues) → **Triager** (trusted to label and
close duplicates) → **Committer** (merge rights on reviewed PRs) → **Maintainer** (release +
direction). You move up through sustained, trusted contribution; a maintainer invites you.

## Bus factor

To avoid a single point of failure, the project aims for **at least two admins** with publish
rights and access to the release process (`NPM_TOKEN`). If you'd like to help maintain, say so
in a Discussion.

## Triage

Issues are triaged best-effort (see [SUPPORT.md](./SUPPORT.md) for the response expectation).
`good first issue` / `help wanted` mark entry points; `needs discussion` means an approach must
be agreed before code.

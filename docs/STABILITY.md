# Stability and support

What you can rely on today, what "beta" means for this project, and what would have to be true
to drop the label. The sections marked **proposed** are a maintainer decision that is not yet
final.

## What is stable now

- **Versions follow Semantic Versioning.** A breaking change to a stable interface ships only in
  a new major version. [`scripts/bump.mjs`](../scripts/bump.mjs) keeps every manifest on the same
  version.
- **Fourteen of 64 commands have a frozen interface.** They meet the production bar in
  [CLI-CONTRACTS.md](CLI-CONTRACTS.md): every flag is in their help and an unknown flag is
  refused, `--json` prints one document whose shape is versioned and checked in CI, and every
  exit status is listed. The other commands work and are tested, but their JSON can change in
  a minor release.
- **Text output is for people.** The form without `--json` can change in any release; scripts
  should read `--json`.
- **Security fixes go to the latest minor line.** See [SECURITY.md](../SECURITY.md).

## Deprecation policy (proposed)

1. A command, flag or contract field is deprecated in a minor release. Its help marks it, using
   it prints a warning on stderr that names the replacement, and the CHANGELOG lists it under
   **Deprecated**.
2. It keeps working until the next major release at the earliest, and is removed only there.
3. A contract field is never repurposed: a changed meaning is a new field.

## Support

Support is maintainer-led and best effort, with no paid tier and no SLA. The current response
expectations are in [SUPPORT.md](../SUPPORT.md): a first response within about a week, and
acknowledgement of a security report within about 72 hours. An SLA would need paid support
behind it; it is a separate decision from leaving beta and is not one of the criteria below.

## What "beta" means here, and when it ends (proposed)

"Beta" is about evidence and maturity, not about interface churn: the stable parts above already
follow Semantic Versioning. The label comes off when each of these holds, with public evidence
for each:

| Criterion | Where it stands |
| --- | --- |
| Every advertised command meets the production bar | 14 of 64 |
| A team outside the maintainer ran ForgeKit on its own repository for at least a month and published the result, including what did not work | not yet |
| Each supported host other than Claude Code has an end-to-end run in CI or a recorded pilot | Claude Code only |
| Each headline limit has a measured boundary: impact against a mutation oracle, the shell guard against a held-out bypass set, enforced memory against a held-out policy set | started on 2026-11-28; see [measured evidence](EVIDENCE.md#measured-evidence) |
| At least two people can cut a release, as recorded in [GOVERNANCE.md](../GOVERNANCE.md) | one |

Until then the README's **Honest limits** keeps the label, and this table is the place to see
how far each criterion has moved.

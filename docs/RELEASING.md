# Releasing forgekit

Releases are automatic, in two phases — no button, no manual bump. Two workflows do
everything:

1. [`bump.yml`](../.github/workflows/bump.yml) — runs on **every push to `master`**
   (and still available as **Actions → "Bump version" → Run workflow** for a manual
   bump). **Phase 1 (propose):** it runs the tests, computes the bump with `auto`,
   and — if something shippable landed — commits `chore(release): vX.Y.Z` to a
   `release/vX.Y.Z` branch and **opens a PR** (no auto-merge; the maintainer merges it,
   same Karo convention as every other PR). **Phase 2 (finalize):** the push that
   *merges* a release PR is detected via the merge commit's 2nd parent — the workflow
   tags the merge commit `vX.Y.Z` and kicks off the release workflow on the new tag.
2. [`release.yml`](../.github/workflows/release.yml) — runs on any `v*` tag: tests →
   npm publish (with provenance, via OIDC trusted publishing — no token) → GitHub Release with
   auto-generated notes.

The two phases exist because branch protection (required status checks,
`enforce_admins`) rejects direct pushes of the release commit to `master` (GH006) —
the release PR lets the required checks run first, and the merge is then an ordinary
protected-branch merge.

## Merge → release PR → merge → release (the default)

On a push to `master`, `bump.yml` first checks whether the push **merged a release PR**
(a merge commit whose 2nd parent is `chore(release): vX.Y.Z`):

- **Release-PR merge (phase 2):** tags the merge commit `vX.Y.Z`, deletes the release
  branch, and dispatches `release.yml` on the tag. Guards: the 2nd parent is re-verified
  in the job, an existing tag is never clobbered, and `package.json` on the merged tree
  must agree with the tag version.
- **Any other push (phase 1):** runs `scripts/bump.mjs auto`:
  - **Something shippable landed** (a `feat:`, `fix:`, `perf:`, or breaking `type!:` /
    `BREAKING CHANGE` commit since the last tag, **or** a hand-written `[Unreleased]`
    section): it bumps, rotates the CHANGELOG, commits `chore(release): vX.Y.Z` to
    `release/vX.Y.Z`, and opens (or updates) the release PR. Merge that PR and the
    release cuts itself.
  - **Nothing shippable** (only `chore`/`docs`/`test`/`ci`/`style`/`build`/`refactor`
    commits and an empty `[Unreleased]`): `bump.mjs` exits `3` and the workflow **skips
    cleanly** — no tag, no PR, no publish, CI stays green. So a docs-only or
    chore-only merge never spams the registry.
  - **No hand-written notes?** When `[Unreleased]` is empty but shippable commits exist,
    `bump.mjs` **synthesizes** the CHANGELOG body from the commit subjects
    (`feat:`→Added, `fix:`→Fixed, `perf`/`refactor`/`revert`→Changed, breaking flagged),
    so every auto-release still describes itself. Writing your own `[Unreleased]` entry
    as you work always beats the synthesized one — do that when you can.

The release PR carries the full CHANGELOG section in its body. If a newer shippable
merge lands while a release PR is still open, the bot force-pushes the updated release
commit to the same branch (the version is recomputed from *all* commits since the last
tag) and closes any superseded release PRs. There is no loop: branch pushes don't
re-trigger this workflow (it only listens on `master`), and pushes made with
`GITHUB_TOKEN` never trigger other workflows (GitHub's recursion guard).

## The manual flow (still supported)

Go to **Actions → Bump version → Run workflow** and pick a bump type:

| choice                      | effect                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`                      | derived from conventional commits since the last tag: `BREAKING CHANGE` / `type!:` → major, `feat:` → minor, anything else → patch. Falls back to the CHANGELOG `[Unreleased]` body (BREAKING → major, `### Added` → minor, other content → patch). |
| `patch` / `minor` / `major` | explicit                                                                                                                                                                                                                                            |

What happens, in order:

1. `npm ci && npm test` — a broken tree is never released.
2. `node scripts/bump.mjs <choice>` updates **every** version field:
   `package.json`, `package-lock.json` (both fields), `.claude-plugin/plugin.json`,
   `.codex-plugin/plugin.json`, `CITATION.cff` (version + release date), the landing
   page footer, and moves the CHANGELOG `[Unreleased]` section under
   `## [X.Y.Z] - <today>` (compare links included).
3. Commit `chore(release): vX.Y.Z` to branch `release/vX.Y.Z` and open (or update) the
   release PR — **no tag is created yet**. (The old flow committed + tagged directly
   to `master`; that is impossible under branch protection — GH006 rejects it.)
4. Merge the release PR and phase 2 takes over automatically: tag `vX.Y.Z` on the
   merge commit, then `gh workflow run release.yml --ref vX.Y.Z`. (This explicit
   dispatch exists because pushes made with the default `GITHUB_TOKEN` intentionally
   do **not** trigger other workflows — GitHub's recursion guard. A tag pushed by a
   human still triggers `release.yml` the normal way.)

`release.yml` then re-runs the tests, asserts the tag matches `package.json`, publishes
`@codewithjuber/forgekit@X.Y.Z` to public npm with provenance, and creates the GitHub
Release. Verify:

- npm: <https://www.npmjs.com/package/@codewithjuber/forgekit>
- releases: <https://github.com/CodeWithJuber/forgekit/releases>

## npm publishing setup (one-time)

The release job installs **npm 12.2.0** on **Node 22.23.3**. The npm 10 CLI bundled
with Node 22 cannot use trusted publishing. Publishing is always attempted and both
npm and GitHub artifacts must be verified; an absent token no longer silently skips npm.

### Recommended: OIDC trusted publishing

In [the package settings](https://www.npmjs.com/package/@codewithjuber/forgekit/access),
add a **GitHub Actions** trusted publisher with these exact, case-sensitive values:

| Setting | Value |
| --- | --- |
| Organization or user | `CodeWithJuber` |
| Repository | `forgekit` |
| Workflow filename | `release.yml` (filename only) |
| Environment | Leave blank (the job does not use a GitHub environment) |
| Allowed actions | Enable direct `npm publish` |

The workflow already grants `id-token: write` to the publishing job and uses a
GitHub-hosted runner. npm exchanges that identity for a short-lived publishing
credential; **no `NPM_TOKEN` or OTP is required**. Setting `id-token: write` alone
does not configure the package's trusted publisher.

New trust configurations must complete their first successful publish within two
days. If a dispatch initiated by `bump.yml` reports an OIDC workflow mismatch,
check the caller identity against npm's
[trusted publishing troubleshooting](https://docs.npmjs.com/trusted-publishers/#troubleshooting)
and use the manual recovery dispatch below, which runs `release.yml` directly.

### No token fallback — do NOT set NPM_TOKEN

There is intentionally **no token fallback**. When a bearer token is configured
(`NODE_AUTH_TOKEN` in the workflow or an `NPM_TOKEN` repo secret wired into it),
npm authenticates with the token and **never attempts the OIDC exchange** — and npm
now rejects 2FA-bypassing tokens for direct publishing (`EOTP`). A token therefore
does not help; it actively breaks publishing. If an `NPM_TOKEN` secret exists from
the old setup, **delete it** (repo Settings → Secrets and variables → Actions).

**`EOTP` is an authentication/configuration failure:** the registry is requiring
a one-time password, which means a token is still being sent or the package's
trusted publisher is misconfigured. Check that no token is wired into
`release.yml` and that the trusted publisher matches exactly (table above).
Do not disable account 2FA or save an authenticator code as a CI secret; it
expires and cannot support unattended releases.

Legacy **Automation** tokens were removed in November 2025. Direct publishing
with granular tokens is being restricted by npm, so OIDC trusted publishing is
the only supported path.
Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm CI/CD authentication](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/),
[npm access tokens](https://docs.npmjs.com/about-access-tokens/).

## Recover a failed existing release with the updated workflow

GitHub re-runs use the workflow at the original commit. Re-running the old
`v1.12.1` job therefore still uses npm 10 and the old token-only publishing step.

After merging the workflow fix and configuring npm authentication, select
**Actions → Release → Run workflow → master**, and set **release_tag** to
`v1.12.1`. The CLI equivalent is:

```bash
gh workflow run release.yml --ref master -f release_tag=v1.12.1
```

The resolver requires an existing `v*` tag, resolves its commit SHA, and passes
that same SHA to both the full quality gate and the publishing checkout. Release
notes and the tag/version assertion use the selected tag. The tag is not moved and
the package version is not bumped. A version already present on npm is skipped,
and a GitHub Release already present is retained, making recovery idempotent.
Recovery and tag-triggered runs share the same concurrency lock.
For provenance, the npm process receives the selected source SHA/ref while retaining
the actual workflow identity, so recovery attests the tagged source rather than master.

## Local / manual usage

```bash
npm run bump -- patch        # or minor / major / auto — edits files, prints new version
npm run bump -- auto --dry-run   # compute only, write nothing
node scripts/bump.mjs check  # assert all version fields agree (same guard CI runs)
npm pack --dry-run           # inspect exactly what would ship to npm
```

If you bump locally instead of via the Actions tab, finish the job by hand — push a
release branch and open the PR (branch protection rejects direct pushes to `master`):

```bash
V="v$(node -p "require('./package.json').version")"
git add -A && git commit -m "chore(release): $V"
git push origin "HEAD:release/$V"   # then open the PR, merge it — phase 2 tags + releases
```

If the release commit is already on `master` through a merged PR, tagging by hand is
safe and still works (a human-pushed tag _does_ trigger `release.yml`):

```bash
V="v$(node -p "require('./package.json').version")"
git tag -a "$V" -m "$V" && git push origin "$V"
```

## Guard rails

- **CI version-drift guard**: `node scripts/bump.mjs check` fails CI if `package.json`,
  `package-lock.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or
  `CITATION.cff` disagree about the version.
- **Tag/version assert**: `release.yml` refuses a tag that doesn't match `package.json`
  (hand-rolled tags that skipped the bump script fail fast with a clear error). The
  `bump.yml` finalize phase asserts the same thing before tagging, re-verifies the merge
  commit's 2nd parent really is the release commit, and refuses to clobber an existing
  tag.
- `scripts/bump.mjs` refuses to rotate the CHANGELOG onto a version that already has a
  section. When `auto` finds nothing shippable it exits `3` (a graceful skip the
  auto-release workflow keys off), not a hard error — so a no-op merge never fails CI.
- **Closed-loop verification**: `release.yml`'s final step asserts the tag produced BOTH
  a GitHub Release and an npm version, and **fails the job** if
  either is missing. The publish and release-create steps are idempotent, so recovering a
  wedged release uses the recovery dispatch above.

## Orphan tags (v0.22.2, v0.23.2, v0.24.0)

These three tags were cut before the closed-loop guard above existed and have **no
GitHub Release and no npm version** — the release workflow wedged after the tag landed
and nothing alerted. They are recorded here for transparency. To resolve one, either
use the recovery dispatch above (the idempotent steps will backfill the missing Release
and npm version) or delete the tag and note it here. This is
a repo-admin action, intentionally not automated.

## Related workflow secrets

- `NPM_TOKEN` — **must not exist**. A leftover secret from the old token setup will
  break OIDC publishing if it ever gets wired back into `release.yml`; delete it
  (repo Settings → Secrets and variables → Actions). OIDC needs no secret.
- `ADMIN_TOKEN` — only used by `repo-settings.yml` (repo description/topics/Discussions
  need a fine-grained PAT with _Administration: write_; the default `GITHUB_TOKEN`
  cannot get that scope). Missing = that workflow skips with a warning; the equivalent
  `gh` commands are in its header comment.

## Semver notes

`patch` = fixes, `minor` = new commands/flags (backward compatible), `major` = breaking
changes. Pre-`1.0`, breaking changes may ship in a `minor`. Consumers install with no
token: `npm install -g @codewithjuber/forgekit`.

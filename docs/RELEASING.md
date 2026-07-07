# Releasing Forge

Releases are one click. Two workflows do everything:

1. [`bump.yml`](../.github/workflows/bump.yml) — **Actions → "Bump version" → Run
   workflow**. It runs the tests, bumps every version field, rotates the CHANGELOG,
   commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, pushes both, and kicks off the
   release workflow on the new tag.
2. [`release.yml`](../.github/workflows/release.yml) — runs on any `v*` tag: tests →
   npm publish (with provenance, if `NPM_TOKEN` is set) → GitHub Release with
   auto-generated notes.

## The one-click flow

Go to **Actions → Bump version → Run workflow** and pick a bump type:

| choice  | effect                                                                       |
| ------- | ---------------------------------------------------------------------------- |
| `auto`  | derived from conventional commits since the last tag: `BREAKING CHANGE` / `type!:` → major, `feat:` → minor, anything else → patch. Falls back to the CHANGELOG `[Unreleased]` body (BREAKING → major, `### Added` → minor, other content → patch). |
| `patch` / `minor` / `major` | explicit                                                       |

What happens, in order:

1. `npm ci && npm test` — a broken tree is never tagged.
2. `node scripts/bump.mjs <choice>` updates **every** version field:
   `package.json`, `package-lock.json` (both fields), `.claude-plugin/plugin.json`,
   `.codex-plugin/plugin.json`, `CITATION.cff` (version + release date), the landing
   page footer, and moves the CHANGELOG `[Unreleased]` section under
   `## [X.Y.Z] - <today>` (compare links included).
3. Commit `chore(release): vX.Y.Z`, annotated tag `vX.Y.Z`, push commit + tag.
4. `gh workflow run release.yml --ref vX.Y.Z`. (This explicit dispatch exists because
   pushes made with the default `GITHUB_TOKEN` intentionally do **not** trigger other
   workflows — GitHub's recursion guard. A tag pushed by a human still triggers
   `release.yml` the normal way.)

`release.yml` then re-runs the tests, asserts the tag matches `package.json`, publishes
`@codewithjuber/forgekit@X.Y.Z` to public npm with provenance, and creates the GitHub
Release. Verify:

- npm: <https://www.npmjs.com/package/@codewithjuber/forgekit>
- releases: <https://github.com/CodeWithJuber/forgekit/releases>

## NPM_TOKEN setup (one-time, optional but recommended)

Publishing needs one repo secret:

1. Create an [npmjs.com](https://www.npmjs.com/) account that can publish to the
   `@codewithjuber` scope.
2. Generate an **Automation** access token (npm → Access Tokens → Generate → *Automation*).
3. Add it as a repo secret: **Settings → Secrets and variables → Actions → New repository
   secret**, name **`NPM_TOKEN`**.

**Soft-skip behavior:** if `NPM_TOKEN` is missing, `release.yml` does **not** fail — it
skips the npm publish with a loud warning and still creates the GitHub Release. Add the
token later and re-run the workflow from the release tag: `npm publish` refuses to
overwrite an existing version, so re-runs are safe and only the missing step takes effect.

## Local / manual usage

```bash
npm run bump -- patch        # or minor / major / auto — edits files, prints new version
npm run bump -- auto --dry-run   # compute only, write nothing
node scripts/bump.mjs check  # assert all version fields agree (same guard CI runs)
npm pack --dry-run           # inspect exactly what would ship to npm
```

If you bump locally instead of via the Actions tab, finish the job by hand — commit,
tag, push (a human-pushed tag *does* trigger `release.yml`):

```bash
V="v$(node -p "require('./package.json').version")"
git add -A && git commit -m "chore(release): $V"
git tag -a "$V" -m "$V"
git push origin master "$V"
```

## Guard rails

- **CI version-drift guard**: `node scripts/bump.mjs check` fails CI if `package.json`,
  `package-lock.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or
  `CITATION.cff` disagree about the version.
- **Tag/version assert**: `release.yml` refuses a tag that doesn't match `package.json`
  (hand-rolled tags that skipped the bump script fail fast with a clear error).
- `scripts/bump.mjs` refuses to rotate the CHANGELOG onto a version that already has a
  section, and errors when `auto` finds nothing to release.

## Related workflow secrets

- `NPM_TOKEN` (above) — npm publish; missing = publish skipped, release still cut.
- `ADMIN_TOKEN` — only used by `repo-settings.yml` (repo description/topics/Discussions
  need a fine-grained PAT with *Administration: write*; the default `GITHUB_TOKEN`
  cannot get that scope). Missing = that workflow skips with a warning; the equivalent
  `gh` commands are in its header comment.

## Semver notes

`patch` = fixes, `minor` = new commands/flags (backward compatible), `major` = breaking
changes. Pre-`1.0`, breaking changes may ship in a `minor`. Consumers install with no
token: `npm install -g @codewithjuber/forgekit`.

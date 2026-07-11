# Releasing forgekit

Releases are automatic. **Merge to `master` and the release cuts itself** — no button,
no manual bump. Two workflows do everything:

1. [`bump.yml`](../.github/workflows/bump.yml) — runs on **every push to `master`** (and
   still available as **Actions → "Bump version" → Run workflow** for a manual bump). It
   runs the tests, bumps every version field with `auto`, rotates the CHANGELOG, commits
   `chore(release): vX.Y.Z`, tags `vX.Y.Z`, pushes both, and kicks off the release
   workflow on the new tag.
2. [`release.yml`](../.github/workflows/release.yml) — runs on any `v*` tag: tests →
   npm publish (with provenance, if `NPM_TOKEN` is set) → GitHub Release with
   auto-generated notes.

## Merge → auto-release (the default)

On a push to `master`, `bump.yml` runs `scripts/bump.mjs auto`:

- **Something shippable landed** (a `feat:`, `fix:`, `perf:`, or breaking `type!:` /
  `BREAKING CHANGE` commit since the last tag, **or** a hand-written `[Unreleased]`
  section): it bumps, rotates the CHANGELOG, tags, publishes, and cuts the Release.
- **Nothing shippable** (only `chore`/`docs`/`test`/`ci`/`style`/`build`/`refactor`
  commits and an empty `[Unreleased]`): `bump.mjs` exits `3` and the workflow **skips
  cleanly** — no tag, no publish, CI stays green. So a docs-only or chore-only merge
  never spams the registry.
- **No hand-written notes?** When `[Unreleased]` is empty but shippable commits exist,
  `bump.mjs` **synthesizes** the CHANGELOG body from the commit subjects
  (`feat:`→Added, `fix:`→Fixed, `perf`/`refactor`/`revert`→Changed, breaking flagged),
  so every auto-release still describes itself. Writing your own `[Unreleased]` entry
  as you work always beats the synthesized one — do that when you can.

The bot's own `chore(release):` commit does **not** re-trigger a release (GitHub's
`GITHUB_TOKEN` recursion guard, plus an explicit actor/subject skip), so there's no loop.

## The manual flow (still supported)

Go to **Actions → Bump version → Run workflow** and pick a bump type:

| choice                      | effect                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`                      | derived from conventional commits since the last tag: `BREAKING CHANGE` / `type!:` → major, `feat:` → minor, anything else → patch. Falls back to the CHANGELOG `[Unreleased]` body (BREAKING → major, `### Added` → minor, other content → patch). |
| `patch` / `minor` / `major` | explicit                                                                                                                                                                                                                                            |

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
2. Generate an **Automation** access token (npm → Access Tokens → Generate → _Automation_).
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
tag, push (a human-pushed tag _does_ trigger `release.yml`):

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
  section. When `auto` finds nothing shippable it exits `3` (a graceful skip the
  auto-release workflow keys off), not a hard error — so a no-op merge never fails CI.

## Related workflow secrets

- `NPM_TOKEN` (above) — npm publish; missing = publish skipped, release still cut.
- `ADMIN_TOKEN` — only used by `repo-settings.yml` (repo description/topics/Discussions
  need a fine-grained PAT with _Administration: write_; the default `GITHUB_TOKEN`
  cannot get that scope). Missing = that workflow skips with a warning; the equivalent
  `gh` commands are in its header comment.

## Semver notes

`patch` = fixes, `minor` = new commands/flags (backward compatible), `major` = breaking
changes. Pre-`1.0`, breaking changes may ship in a `minor`. Consumers install with no
token: `npm install -g @codewithjuber/forgekit`.

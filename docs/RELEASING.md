# Releasing Forge

Releases are automated by [`.github/workflows/release.yml`](../.github/workflows/release.yml):
**push a `v*` tag → it runs the tests, publishes to public npm (with provenance), and
cuts a GitHub Release** with auto-generated notes.

## One-time setup (maintainer)

The workflow needs a single secret to publish:

1. Create an [npmjs.com](https://www.npmjs.com/) account and make sure it can publish to
   the `@codewithjuber` scope.
2. Generate an **Automation** access token (npm → Access Tokens → Generate → *Automation*).
3. Add it to the repo: **Settings → Secrets and variables → Actions → New repository
   secret**, name **`NPM_TOKEN`**.

That's the only manual step. Without it the publish step fails; everything else still runs.

## Cutting a release

```bash
# 1. bump the version (updates package.json + package-lock.json, no tag yet)
npm version minor --no-git-tag-version      # or: patch / major

# 2. move the [Unreleased] notes into a new dated section in CHANGELOG.md, then commit
git add -A && git commit -m "chore(release): v$(node -p "require('./package.json').version")"

# 3. tag and push — this is what triggers the release workflow
V="v$(node -p "require('./package.json').version")"
git tag -a "$V" -m "$V"
git push origin master "$V"
```

The workflow then publishes `@codewithjuber/forgekit@<version>` to npm and creates the
matching GitHub Release. Verify:

- npm: <https://www.npmjs.com/package/@codewithjuber/forgekit>
- releases: <https://github.com/CodeWithJuber/forgekit/releases>

## Notes

- **Semver**: `patch` = fixes, `minor` = new commands/flags (backward compatible),
  `major` = breaking changes. Pre-`1.0`, breaking changes may ship in a `minor`.
- Consumers install with no token: `npm install -g @codewithjuber/forgekit`.
- Re-running a failed release is safe — `npm publish` refuses to overwrite a version that
  already exists, so only the missing steps take effect.

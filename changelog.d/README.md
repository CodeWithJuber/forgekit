# Unreleased changes

Each change adds its own file here instead of editing `CHANGELOG.md`, so open pull requests
never conflict on the same lines. Name the file after your branch or change
(`changelog.d/runtime-map.md`) and write one or more Keep a Changelog sections:

```markdown
### Added

- **`forge impact --record`** runs each test file under V8 coverage and …
```

Sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Leave
`## [Unreleased]` in `CHANGELOG.md` empty: `forge docs check` refuses entries there while this
directory exists. When a release is cut, `scripts/bump.mjs` folds every file here into the new
version's section of `CHANGELOG.md` and deletes the files.

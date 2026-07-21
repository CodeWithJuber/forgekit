# Forge documentation site (Mintlify)

This folder is a self-contained [Mintlify](https://mintlify.com) documentation site for
Forge (`@codewithjuber/forgekit`). It is additive — it does not replace the Markdown docs
in `docs/`, `README.md`, `ARCHITECTURE.md`, or `ONBOARDING.md`, which remain the source
of truth. The site content is derived from those files.

## Layout

```
mintlify/
  docs.json            # Mintlify config: theme, colors, navigation
  favicon.svg          # brand favicon (ember on warm-black)
  logo/                # light.svg + dark.svg wordmarks
  introduction.mdx     # overview + the cognitive-substrate thesis
  quickstart.mdx       # install → init → first substrate check
  installation.mdx     # plugin / npm / github: / dev channels
  concepts/            # config compiler, PCM, pre-action gate, cross-session memory,
                       #   verification gates, model routing
  cli/                 # overview + one page per command GROUP
  guides/              # zero-config onboarding, team memory, radar deps
```

## Preview locally

Mintlify is a docs platform, **not** a runtime dependency — it is intentionally not in
`package.json`. Preview it with `npx` at call time (no install needed):

```bash
cd mintlify
npx mintlify dev          # local preview at http://localhost:3000
npx mintlify broken-links # check internal links
```

Requires Node.js — the same `>=20` the project already needs.

## How deploy works

Mintlify deploys via its **GitHub App**, not via CI. To publish:

1. Sign in at [mintlify.com](https://mintlify.com) and connect the
   `CodeWithJuber/forgekit` repository.
2. Point the project's docs path at this `mintlify/` folder (where `docs.json` lives).
3. Mintlify redeploys automatically on every push to the default branch.

There is deliberately **no deploy workflow** in `.github/workflows/` — the Mintlify App
handles deploys. The only CI added is an advisory broken-link check
(`.github/workflows/docs-links.yml`) that runs on PRs touching this folder.

## Editing

- Pages are MDX with `title` + `description` frontmatter.
- Navigation lives in `docs.json` under `navigation.tabs[].groups[].pages`; page ids are
  file paths relative to this folder, without the `.mdx` extension.
- Keep content grounded in the real repo docs — Forge has a "no mock data / metrics must
  be real" ethos. Do not add invented features or benchmark numbers.

## Localization

The site is **English-only**. It previously carried five hand-maintained translations
(`ar`, `hi`, `cn`, `zh-CN`, `zh-Hans`); those trees were removed because keeping parallel
prose in sync by hand was the main source of documentation drift — every English fix had
to be re-applied five times, and any miss left the site lagging the code.

If translations are wanted again, add them the automated way instead of hand-maintaining
parallel `.mdx` trees:

- **Mintlify auto-localization** — write English once, list the locale codes under
  `navigation.languages` in `docs.json`, and enable AI translation for the deployment in
  the Mintlify dashboard. Mintlify generates and refreshes the translated pages; there are
  no per-locale files to maintain in this repo.
- **Code→docs Workflow** — configure a Mintlify
  [Workflow](https://www.mintlify.com/docs/automations) (dashboard → Automations) so the
  site updates from the source repo automatically, rather than drifting until
  `forge docs check` catches it. The repo-side guard (`checkMintlify` in
  `src/docs_check.js`) stays as a backstop and is scoped to the English pages, so it keeps
  working regardless of how many display languages are enabled.

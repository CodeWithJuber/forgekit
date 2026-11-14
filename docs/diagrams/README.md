# Diagrams

Every diagram in this repository's docs, the docs site and the GitHub Pages site is
rendered by [Archify](https://github.com/tt-a1i/archify) from a typed JSON source in this
folder. Nobody hand-draws a diagram or hand-edits a rendered file. `forge docs check`
rejects a hand-written Mermaid block in any tracked Markdown or MDX file, and it rejects
an embed that names a diagram the manifest does not register.

**Browse them:** https://jubershaikh.com/forgekit/diagrams/. Each diagram opens as
an interactive page where you can pan, zoom and search (`/`). Press `?` for the guide, and
select a node to trace what it depends on and what depends on it.

## Layout

| Path | What it is | Edited by |
| --- | --- | --- |
| `src/<id>.<type>.json` | The source: one of Archify's five typed schemas (`architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`). | You |
| `<id>.svg` | The static export, embedded by the Markdown docs. It is dual-theme and follows the reader's light or dark preference. | `build` |
| `../../mintlify/images/diagrams/<id>.svg` | Byte-identical copies for the docs site, which can only serve files under `mintlify/`. Git stores each identical file once. | `build` / `sync` |
| `diagrams.json` | The manifest. For each diagram it records the id, type, title, the files that embed it (`usedIn`), and the receipt of its last verified render. | `build` (you edit `usedIn`) |

The interactive HTML pages are about 0.8 MB each and are not committed. The Pages workflow
renders them from the pinned Archify commit. A given source and commit always produce the
same bytes, so the workflow checks each page's sha256 against its receipt in
`diagrams.json`. It refuses to publish a page that differs, so the site serves exactly what
was validated here.

## Changing a diagram

1. Edit `src/<id>.<type>.json`. The schemas, examples and authoring rules are in the
   pinned checkout, under `archify/SKILL.md`, `archify/schemas/` and `archify/examples/`.
2. Render it:

   ```sh
   node scripts/diagrams.mjs build <id>
   ```

   This validates the source at Archify's showcase quality bar, renders it, exports the SVG
   through the viewer's own Export menu (in headless Chrome, using Archify's own driver),
   refreshes the docs-site copy and rewrites the receipt. The first run fetches the pinned
   Archify commit into `.cache/archify/`. To use an existing checkout of that commit, set
   `FORGE_ARCHIFY_DIR`. To choose the browser, set `ARCHIFY_CHROME`.
3. Commit the source, the SVG, any `mintlify/images/diagrams/` copy and `diagrams.json`
   together.

To add a diagram, create its source and add an entry `{ "id", "type", "usedIn": [] }` to
`diagrams.json`. Then run `build`, embed the SVG, and list each file that embeds it in
`usedIn`. The check verifies that every listed file really does embed the diagram.

## Facts bound to the code

Some labels state something the code decides: the guards each hook event runs, how many
tools get a native config, the reuse serve floor, the ledger's trust bands, the semantic
guard's kinds, dep-gate's thresholds and the supervised MCP tool names. `src/diagram_facts.js` binds each one to the code
(`FACTS`: a source, a marker that names exactly one line, a field, and a function of the
code). `forge docs render` rewrites a stale fact (that field only, every other byte as it
was) and names the diagrams to re-render; `forge docs check` lists the drift as a warning.

To bind a new fact, add a row to `FACTS`. A test fails if any bound label disagrees with
the code, or if a marker no longer names exactly one line.

## Automatic updates

`.github/workflows/docs-autoupdate.yml` checks generated documentation after every push to `master`. It can also be started manually.

1. `forge docs render` regenerates managed Markdown sections and the code-derived labels in diagram sources.
2. `node scripts/diagrams.mjs build --stale` renders figures with changed sources or SVGs. The workflow synchronizes and checks the Mintlify copies. The media renderer also checks the recorded inputs and outputs of CLI demo GIFs, README artwork, social cards and dashboard screenshots.
3. The **Docs auto-update** run summary identifies affected handwritten guides and line numbers for review, even when there is nothing to regenerate.
4. When generated files change, the workflow opens or updates one `docs/auto-update` PR and requests GitHub auto-merge for the verified commit. The repository must allow auto-merge and its required approvals and checks must pass. If auto-merge is unavailable, the proposal stays open. When generated output already matches the default branch, the workflow closes any stale proposal.

Look for **Approve workflows to run** if GitHub requests approval for checks on a bot-created PR. Administrators can configure the optional `FORGE_DOCS_TOKEN` for publication. The render steps use no publication credential. [Workflow](../../.github/workflows/docs-autoupdate.yml) · [Media inputs and regeneration](../assets/README.md) · [GitHub token event behavior](https://docs.github.com/en/actions/concepts/security/github_token)

## Embedding

- **Markdown (GitHub, npm):** link the SVG to its interactive page:

  ```md
  [![Alt text that says what the diagram shows](docs/diagrams/core-loop.svg)](https://jubershaikh.com/forgekit/diagrams/core-loop.html)
  ```

- **Docs site (Mintlify):** put the copy in a `<Frame>`, then add a link to the interactive
  page.
- **Generated diagrams are the exception.** The repository map in `ARCHITECTURE.md` stays
  Mermaid because `forge docs render` regenerates it from the live import graph. Archify
  lays out what an author specifies; it does not lay out a graph automatically. The check
  allows Mermaid inside `forge:render` markers.

## Checks

- `node scripts/diagrams.mjs check` runs offline in CI. It fails when any of these is true:
  - a source changed since its receipt was written
  - a source is not registered in the manifest
  - an SVG or a docs-site copy is missing or stale
  - a `usedIn` file no longer embeds its diagram
  - the receipts were written by an Archify commit other than the pinned one
- `node scripts/diagrams.mjs build --stale` re-renders only the diagrams whose source, receipt
  or SVG changed (every diagram after an Archify pin bump). The SVG hash catches manual edits even when the same edit was made to both copies.
- Add `--no-svg` to check the interactive HTML without Chromium. Recording a new receipt requires the full export.
- `node scripts/diagrams.mjs sync` refreshes the docs-site copies without rendering.
- `node scripts/diagrams.mjs site <dir>` is what the Pages workflow runs. It renders every
  page, verifies each against its receipt, and writes the gallery.

## Credits

- **Archify** is © tt-a1i and © Cocoon AI, under the MIT License. It is pinned by commit
  in `scripts/diagrams.mjs`; bumping the pin means re-running `build` for every diagram.
- The SVG exports embed subsets of **JetBrains Mono** (© The JetBrains Mono Project
  Authors), which is under the SIL Open Font License 1.1. Each export carries the license
  text in its font CSS.

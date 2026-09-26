# Diagrams

Every diagram in this repository's docs, the docs site and the GitHub Pages site is
rendered by [Archify](https://github.com/tt-a1i/archify) from a typed JSON source in this
folder. Nobody hand-draws a diagram or hand-edits a rendered file. `forge docs check`
rejects a hand-written Mermaid block in any tracked Markdown or MDX file, and it rejects
an embed that names a diagram the manifest does not register.

**Browse them:** https://codewithjuber.github.io/forgekit/diagrams/. Each diagram opens as
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
3. Commit the source, the SVG, its `mintlify/images/diagrams/` copy and `diagrams.json`
   together.

To add a diagram, create its source and add an entry `{ "id", "type", "usedIn": [] }` to
`diagrams.json`. Then run `build`, embed the SVG, and list each file that embeds it in
`usedIn`. The check verifies that every listed file really does embed the diagram.

## Embedding

- **Markdown (GitHub, npm):** link the SVG to its interactive page:

  ```md
  [![Alt text that says what the diagram shows](docs/diagrams/core-loop.svg)](https://codewithjuber.github.io/forgekit/diagrams/core-loop.html)
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
- `node scripts/diagrams.mjs sync` refreshes the docs-site copies without rendering.
- `node scripts/diagrams.mjs site <dir>` is what the Pages workflow runs. It renders every
  page, verifies each against its receipt, and writes the gallery.

## Credits

- **Archify** is © tt-a1i and © Cocoon AI, under the MIT License. It is pinned by commit
  in `scripts/diagrams.mjs`; bumping the pin means re-running `build` for every diagram.
- The SVG exports embed subsets of **JetBrains Mono** (© The JetBrains Mono Project
  Authors), which is under the SIL Open Font License 1.1. Each export carries the license
  text in its font CSS.

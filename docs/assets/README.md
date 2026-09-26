# Brand and image assets

| File | Used by | How it is made |
| --- | --- | --- |
| `favicon.svg`, `apple-touch-icon.png` | Every page of the Pages site; the Pages build serves them from the site root. | Vector mark |
| `hero-light.svg`, `hero-dark.svg` | The README hero, one per GitHub theme. | Vector |
| `og.svg` | The source of the social card: wordmark, headline and subline over `og-background.webp`. | Edited by hand |
| `og-background.webp` | The card's art: a girih lattice and khatam star on the right, leaving the left side empty for type. | Generated art, 2400×1260 |
| `og.jpg` | `og:image` and `twitter:image` on the landing and status pages. | `node scripts/og-card.mjs`. Never edit it directly. |

To change the card, edit `og.svg` and run `node scripts/og-card.mjs`. The script uses the
headless Chrome from the pinned Archify checkout (see `docs/diagrams/README.md`) and needs
the network once, to fetch the Inter and JetBrains Mono web fonts. It refuses to write the
card if a font did not load, if any line of text crosses into the art (x > 610 of 1200) or
out of the crop-safe margins, or if the JPEG exceeds the roughly 300 KB that link-preview
scrapers accept. `--check` measures the layout without writing anything.

The other generated art lives next to the page that uses it:

- `landing/media/evidence-bg.webp`: the landing page's evidence band. A 55% veil keeps its
  text at 5.4:1 contrast or better, and it is dropped under `prefers-contrast: more`.
- `mintlify/images/illustrations/*.webp`: the opening illustrations of seven docs-site
  pages.

All of this art was generated for this project in September 2026 as text-free geometric
illustration in the brand palette (`brand.json`). It contains no sacred script. It
illustrates ideas; it is not data. The diagrams are rendered from typed sources in
[`docs/diagrams`](../diagrams/README.md), and every number the site states comes from the
reports in the repository.

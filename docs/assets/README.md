# Brand and image assets

| File | Used by | How it is made |
| --- | --- | --- |
| `favicon.svg`, `apple-touch-icon.png` | Every page of the Pages site; the Pages build serves them from the site root. | Vector mark |
| `hero-light.svg`, `hero-dark.svg` | README overview for each GitHub theme. | Vector |
| `demo.gif` | The README and the Mintlify supervised-runs guide. | Live CLI capture. The renderer also writes `mintlify/images/supervised-setup.gif`. |
| `.github/assets/forgekit-{verify,precommit,memory}.gif` | README examples of a failing suite, a staged test credential and recall across two CLI invocations. | Live CLI capture |
| `mintlify/images/{adversarial-doctor,cost-governance}.gif` | Mintlify solution guides. | Live CLI capture |
| `mintlify/images/og-image.png`, `.github/assets/social-preview.png` | Mintlify share card and the card available for upload in GitHub social-preview settings. | `python3 scripts/make-social-images.py` |
| `og.svg` | The source of the social card: wordmark, headline and subline over `og-background.webp`. | Edited by hand |
| `og-background.webp` | The card's art: a girih lattice and khatam star on the right, leaving the left side empty for type. | Generated art, 2400×1260 |
| `og.jpg` | `og:image` and `twitter:image` on the landing and status pages. | `node scripts/og-card.mjs`. Never edit it directly. |

To change the card, edit `og.svg` and run `node scripts/og-card.mjs`. The script uses the
headless Chrome from the pinned Archify checkout (see `docs/diagrams/README.md`) and needs
the network once, to fetch the Inter and JetBrains Mono web fonts. It refuses to write the
card if a font did not load, if any line of text crosses into the art (x > 610 of 1200) or
out of the crop-safe margins, or if the JPEG exceeds the roughly 300 KB that link-preview
scrapers accept. `--check` measures the layout without writing anything.

## Rebuild the terminal demos

On Linux, use Node 20+, npm, Git, Bash, Python 3.11+ with SQLite, Pillow
and the DejaVu Sans and Mono fonts. Run from a ForgeKit checkout:

```sh
python3 scripts/make-demo-gif.py
python3 scripts/make-demo-gif.py setup
python3 scripts/make-social-images.py
```

The first command rebuilds the complete set. Pass `setup`, `verify`, `precommit`,
`memory`, `cost` or `doctor` to rebuild one example. Set `FORGE_DEMO_FONTS`
to the directory containing DejaVu's TrueType files if they are elsewhere.

Each recording uses a disposable Git repository with its own home and ForgeKit
state. The setup demo presents selected JSON fields as a table. The other
recordings show excerpts of the command output and the observed exit status.
A command change that removes an expected observation stops the render. The
setup sequence configures project files; Kimi still needs a user plugin install
and reload, and Codex needs project trust and hook review. The demos use no
production tenant, model or credentials.

## Illustrations

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
